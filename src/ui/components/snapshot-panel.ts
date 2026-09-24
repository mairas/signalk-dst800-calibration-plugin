import { html, nothing } from 'lit'
import { customElement, property, query, state } from 'lit/decorators.js'
import type {
  DeviceKey,
  ImportItem,
  ImportPlan,
  ImportResult,
  ImportResultItem,
  Snapshot
} from '../../types.js'
import { ApiError, describeFailure, request } from '../api.js'
import { curveChanges, curveOf } from '../curve.js'
import { clause, sameKey } from '../format.js'
import { LightElement } from '../light-element.js'
import {
  VIEWS,
  describeOutcome,
  labelOf,
  outcomeOf,
  showValue,
  slotKey,
  unitOf
} from '../settings.js'
import { SI, type Units } from '../units.js'

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`

/** The YYYY-MM-DD an ISO timestamp falls on. */
const dayOf = (iso: string): string => iso.split('T')[0]

/** The plugin refused the file itself, not the request. */
const BAD_REQUEST = 400

type Loaded =
  | { state: 'reading'; name: string }
  /** The file is not a snapshot the plugin accepts. */
  | { state: 'refused'; name: string; reason: string }
  /** The file may be fine, but the plugin could not compare it with the sensor. */
  | { state: 'uncompared'; name: string; reason: string }
  | { state: 'planned'; name: string; snapshot: Snapshot; plan: ImportPlan }
  | { state: 'applying'; name: string; snapshot: Snapshot; plan: ImportPlan }
  /** The import request failed; some writes may have landed before it did. */
  | { state: 'unfinished'; name: string; snapshot: Snapshot; plan: ImportPlan; reason: string }
  | { state: 'applied'; name: string; result: ImportResult }

/**
 * Save the sensor's settings to a file, and load one back.
 *
 * Loading shows the plugin's diff before anything is written; Apply writes
 * the settings that differ, in the plugin's order, until one fails, and each
 * setting then says what happened to it. A result that arrives after the
 * console moved to another sensor is dropped: the plugin acts on whichever
 * sensor is selected, so a diff of one must never be applied to the other.
 */
@customElement('dst-snapshots')
export class SnapshotPanel extends LightElement {
  @property({ attribute: false }) selected: DeviceKey | null = null
  @property({ attribute: false }) units: Units = SI
  @property({ type: Boolean }) disabled = false

  @state() private saving = false
  @state() private saved: { tone: string; text: string; detail: string | null } | null = null
  @state() private loaded: Loaded | null = null

  @query('input[type="file"]') private picker!: HTMLInputElement

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    const previous = changed.get('selected') as DeviceKey | null | undefined
    if (changed.has('selected') && previous !== undefined && !sameKey(previous, this.selected)) {
      this.saved = null
      this.loaded = null
    }
  }

  /** Whether the console still follows `key`; each request awaits, and the user can move on. */
  private still(key: DeviceKey | null): boolean {
    return sameKey(this.selected, key)
  }

  private async save(): Promise<void> {
    const key = this.selected
    this.saving = true
    this.saved = null
    try {
      const snapshot = await request<Snapshot>('GET', '/snapshot')
      if (!this.still(key)) {
        return
      }
      const name = `dst-${String(snapshot.device.uniqueNumber)}-${dayOf(snapshot.takenAt)}.json`
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
      )
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      URL.revokeObjectURL(url)
      const gaps = snapshot.unread.map((gap) => `${labelOf(gap.id, gap.qualifier)} (${gap.reason})`)
      this.saved = {
        tone: gaps.length === 0 ? 'success' : 'warning',
        text: `Exported ${name} with ${plural(snapshot.settings.length, 'setting')}.`,
        detail: gaps.length === 0 ? null : `Not in it: ${gaps.join(', ')}.`
      }
    } catch (cause) {
      if (this.still(key)) {
        this.saved = {
          tone: 'danger',
          text: `Not exported: ${clause(describeFailure(cause))}.`,
          detail: null
        }
      }
    } finally {
      this.saving = false
    }
  }

  private async load(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    if (file === undefined) {
      return
    }
    const key = this.selected
    const name = file.name
    this.loaded = { state: 'reading', name }
    let snapshot: Snapshot
    try {
      snapshot = JSON.parse(await file.text()) as Snapshot
    } catch {
      this.loaded = { state: 'refused', name, reason: 'it is not JSON' }
      return
    } finally {
      // Choosing the same file again should load it again.
      input.value = ''
    }
    try {
      const plan = await request<ImportPlan>('POST', '/snapshot/diff', snapshot)
      if (this.still(key)) {
        this.loaded = { state: 'planned', name, snapshot, plan }
      }
    } catch (cause) {
      if (this.still(key)) {
        const reason = clause(describeFailure(cause))
        this.loaded =
          cause instanceof ApiError && cause.status === BAD_REQUEST
            ? { state: 'refused', name, reason }
            : { state: 'uncompared', name, reason }
      }
    }
  }

  private async apply(name: string, snapshot: Snapshot, plan: ImportPlan): Promise<void> {
    const key = this.selected
    this.loaded = { state: 'applying', name, snapshot, plan }
    try {
      const result = await request<ImportResult>('POST', '/snapshot/import', snapshot)
      if (this.still(key)) {
        this.loaded = { state: 'applied', name, result }
      }
    } catch (cause) {
      if (this.still(key)) {
        const reason = clause(describeFailure(cause))
        this.loaded = { state: 'unfinished', name, snapshot, plan, reason }
      }
    }
  }

  private show(id: string, value: unknown): string {
    return showValue(this.units, id, value)
  }

  /** The points a curve write changes, where both sides are curves. */
  private curveLines(item: ImportItem): string[] | null {
    if (item.action !== 'write' || VIEWS[item.id]?.editor.kind !== 'curve') {
      return null
    }
    const unit = unitOf(this.units, item.id)
    const from = item.current.status === 'answered' ? curveOf(item.current.value) : null
    const to = curveOf(item.value)
    return unit === null || from === null || to === null ? null : curveChanges(from, to, unit)
  }

  /** What the plan will do with one setting, or what the import did. */
  private itemText(item: ImportItem | ImportResultItem): { tone: string; text: string } {
    if ('outcome' in item) {
      if (item.outcome === 'notAttempted') {
        return { tone: 'secondary', text: 'Not attempted: an earlier change failed.' }
      }
      const outcome = outcomeOf('write', item.result)
      return outcome === null
        ? { tone: 'success', text: '✓ Stored.' }
        : describeOutcome(outcome, (value) => this.show(item.id, value), null)
    }
    switch (item.action) {
      case 'write': {
        const current =
          item.current.status === 'answered' ? this.show(item.id, item.current.value) : 'unknown'
        return { tone: 'primary', text: `${current} → ${this.show(item.id, item.value)}` }
      }
      case 'unchanged':
        return { tone: 'secondary', text: `Already set: ${this.show(item.id, item.value)}` }
      case 'excluded':
        return { tone: 'secondary', text: `Not applied: ${item.reason}.` }
      case 'unsupported':
        return { tone: 'secondary', text: `Not supported by this sensor: ${item.reason}.` }
      case 'missing':
        return { tone: 'warning', text: `Not in the snapshot: ${item.reason}.` }
    }
  }

  private items(items: readonly (ImportItem | ImportResultItem)[]) {
    return html`<ul class="list-group mb-2">
      ${items.map((item) => {
        const { tone, text } = this.itemText(item)
        const lines = 'outcome' in item ? null : this.curveLines(item)
        return html`<li class="list-group-item" data-item=${slotKey(item)}>
          <div class="d-flex flex-wrap gap-2">
            <span class="fw-semibold me-auto">${labelOf(item.id, item.qualifier)}</span>
            <span class=${`small text-${tone}-emphasis`}>${text}</span>
          </div>
          ${
            lines === null || lines.length === 0
              ? nothing
              : html`<ul class="small text-primary-emphasis mb-0 mt-1">
                  ${lines.map((line) => html`<li>${line}</li>`)}
                </ul>`
          }
        </li>`
      })}
    </ul>`
  }

  private planView(loaded: Extract<Loaded, { state: 'planned' | 'applying' | 'unfinished' }>) {
    const { name, snapshot, plan } = loaded
    const changes = plan.items.filter((item) => item.action === 'write').length
    const other = !sameKey(plan.source, this.selected)
    return html`
      <p class="mb-2">
        ${name}, taken ${dayOf(snapshot.takenAt)}.
        ${
          other
            ? html`<span class="text-warning-emphasis"
                >This snapshot was taken from another sensor.</span
              >`
            : nothing
        }
      </p>
      ${this.items(plan.items)}
      ${
        loaded.state === 'unfinished'
          ? html`<p class="text-danger-emphasis mb-2" role="alert">
              The import did not finish: ${loaded.reason}. Some settings may have been written. The
              list above is from before the import; the setting rows show what the sensor now holds.
            </p>`
          : nothing
      }
      ${
        changes === 0
          ? html`<p class="text-body-secondary mb-0">
              The sensor already holds everything in this snapshot.
            </p>`
          : html`<button
              type="button"
              class="btn btn-sm btn-primary"
              ?disabled=${this.disabled || loaded.state === 'applying'}
              @click=${() => this.apply(name, snapshot, plan)}
            >
              ${
                loaded.state === 'applying'
                  ? html`<span
                        class="spinner-border spinner-border-sm me-1"
                        aria-hidden="true"
                      ></span>
                      Applying…`
                  : `Apply ${plural(changes, 'change')}`
              }
            </button>`
      }
    `
  }

  private loadedView() {
    const loaded = this.loaded
    if (loaded === null) {
      return nothing
    }
    switch (loaded.state) {
      case 'reading':
        return html`<p class="text-body-secondary mb-0">
          <span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
          Comparing ${loaded.name} with the sensor…
        </p>`
      case 'refused':
        return html`<p class="text-danger-emphasis mb-0" role="alert">
          ${loaded.name} is not a snapshot: ${loaded.reason}.
        </p>`
      case 'uncompared':
        return html`<p class="text-danger-emphasis mb-0" role="alert">
          Could not compare ${loaded.name} with the sensor: ${loaded.reason}.
        </p>`
      case 'planned':
      case 'applying':
      case 'unfinished':
        return this.planView(loaded)
      case 'applied':
        return html`
          <p class="mb-2">${loaded.name}:</p>
          ${this.items(loaded.result.items)}
          <p
            class=${`mb-0 ${loaded.result.complete ? 'text-success-emphasis' : 'text-warning-emphasis'}`}
            role="status"
          >
            ${
              loaded.result.complete
                ? 'Every change was applied.'
                : 'The import stopped at the first change that failed.'
            }
          </p>
        `
    }
  }

  override render() {
    // One request at a time: a second comparison could answer before the first.
    const busy =
      this.saving || this.loaded?.state === 'reading' || this.loaded?.state === 'applying'
    return html`
      <div class="card-body">
        <p class="form-text mt-0">
          Export settings saves every setting the sensor reports to a file. Import settings compares
          a file with the sensor and lists what would change; nothing is written until Apply.
          Simulate mode and the distance log are never applied.
        </p>
        <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            ?disabled=${this.disabled || busy}
            @click=${() => this.save()}
          >
            ${
              this.saving
                ? html`<span
                      class="spinner-border spinner-border-sm me-1"
                      aria-hidden="true"
                    ></span>
                    Reading every setting…`
                : 'Export settings'
            }
          </button>
          <button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            ?disabled=${this.disabled || busy}
            @click=${() => {
              this.picker.click()
            }}
          >
            Import settings
          </button>
          <input
            type="file"
            accept=".json,application/json"
            hidden
            ?disabled=${this.disabled || busy}
            @change=${(event: Event) => this.load(event)}
          />
        </div>
        ${
          this.saved === null
            ? nothing
            : html`<p class=${`small text-${this.saved.tone}-emphasis`} role="status">
                ${this.saved.text} ${this.saved.detail ?? ''}
              </p>`
        }
        ${this.loadedView()}
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-snapshots': SnapshotPanel
  }
}
