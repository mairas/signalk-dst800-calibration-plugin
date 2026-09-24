import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type {
  DeviceKey,
  ImportItem,
  ImportPlan,
  ImportResult,
  ImportResultItem,
  Snapshot
} from '../../types.js'
import { describeFailure, request } from '../api.js'
import { sameKey } from '../format.js'
import { LightElement } from '../light-element.js'
import {
  TEMPERATURE_SOURCES,
  VIEWS,
  describeOutcome,
  describeValue,
  outcomeOf
} from '../settings.js'
import { SI, unitFor, type Units } from '../units.js'

/** Settings a snapshot holds that the console shows no row for. */
const OTHER_LABELS: Partial<Record<string, string>> = {
  productInformation: 'Product information'
}

const plural = (n: number, word: string) => `${String(n)} ${word}${n === 1 ? '' : 's'}`

type Loaded =
  | { state: 'reading'; name: string }
  | { state: 'refused'; name: string; reason: string }
  | { state: 'planned'; name: string; snapshot: Snapshot; plan: ImportPlan }
  | { state: 'applying'; name: string; snapshot: Snapshot; plan: ImportPlan }
  | { state: 'applied'; name: string; result: ImportResult }

/**
 * Save the sensor's settings to a file, and load one back.
 *
 * Loading shows the plugin's diff before anything is written; Apply writes
 * the settings that differ, in the plugin's order, until one fails, and each
 * setting then says what happened to it.
 */
@customElement('dst-snapshots')
export class SnapshotPanel extends LightElement {
  @property({ attribute: false }) selected: DeviceKey | null = null
  @property({ attribute: false }) units: Units = SI
  @property({ type: Boolean }) disabled = false

  @state() private saving = false
  @state() private saved: { tone: string; text: string; detail: string | null } | null = null
  @state() private loaded: Loaded | null = null

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    const previous = changed.get('selected') as DeviceKey | null | undefined
    if (changed.has('selected') && previous !== undefined && !sameKey(previous, this.selected)) {
      this.saved = null
      this.loaded = null
    }
  }

  private label(id: string, qualifier: number | null): string {
    if (qualifier !== null && id === 'temperatureOffset') {
      return TEMPERATURE_SOURCES.find((s) => s.qualifier === qualifier)?.label ?? id
    }
    return VIEWS[id]?.label ?? OTHER_LABELS[id] ?? id
  }

  private show(id: string, value: unknown): string {
    const view = VIEWS[id]
    if (view === undefined) {
      return JSON.stringify(value)
    }
    const unit = view.unit === undefined ? null : unitFor(this.units, view.unit)
    return describeValue(view.editor, unit, value)
  }

  private async save(): Promise<void> {
    this.saving = true
    this.saved = null
    try {
      const snapshot = await request<Snapshot>('GET', '/snapshot')
      const name = `dst-${String(snapshot.device.uniqueNumber)}-${snapshot.takenAt.slice(0, 10)}.json`
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' })
      )
      const link = document.createElement('a')
      link.href = url
      link.download = name
      link.click()
      URL.revokeObjectURL(url)
      const gaps = snapshot.unread.map(
        (gap) => `${this.label(gap.id, gap.qualifier)} (${gap.reason})`
      )
      this.saved = {
        tone: gaps.length === 0 ? 'success' : 'warning',
        text: `Saved ${name} with ${plural(snapshot.settings.length, 'setting')}.`,
        detail: gaps.length === 0 ? null : `Not in it: ${gaps.join(', ')}.`
      }
    } catch (cause) {
      this.saved = { tone: 'danger', text: `Not saved: ${describeFailure(cause)}`, detail: null }
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
      this.loaded = { state: 'planned', name, snapshot, plan }
    } catch (cause) {
      this.loaded = { state: 'refused', name, reason: describeFailure(cause) }
    }
  }

  private async apply(name: string, snapshot: Snapshot, plan: ImportPlan): Promise<void> {
    this.loaded = { state: 'applying', name, snapshot, plan }
    try {
      const result = await request<ImportResult>('POST', '/snapshot/import', snapshot)
      this.loaded = { state: 'applied', name, result }
    } catch (cause) {
      this.loaded = { state: 'refused', name, reason: describeFailure(cause) }
    }
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
        return html`<li
          class="list-group-item d-flex flex-wrap gap-2"
          data-item=${`${item.id}:${item.qualifier === null ? '' : String(item.qualifier)}`}
        >
          <span class="fw-semibold me-auto">${this.label(item.id, item.qualifier)}</span>
          <span class=${`small text-${tone}-emphasis`}>${text}</span>
        </li>`
      })}
    </ul>`
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
      case 'planned':
      case 'applying': {
        const { name, snapshot, plan } = loaded
        const changes = plan.items.filter((item) => item.action === 'write').length
        const other = !sameKey(plan.source, this.selected)
        return html`
          <p class="mb-2">
            ${name}, taken ${snapshot.takenAt.slice(0, 10)}.
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
    const busy = this.saving || this.loaded?.state === 'applying'
    return html`
      <div class="card-body">
        <p class="form-text mt-0">
          A snapshot is a file of every setting the sensor reports. Loading one shows what would
          change before anything is written. Simulate mode and the distance log are never applied.
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
                : 'Save snapshot'
            }
          </button>
          <label
            class=${`btn btn-sm btn-outline-secondary mb-0 ${this.disabled || busy ? 'disabled' : ''}`}
          >
            Load snapshot…
            <input
              type="file"
              accept=".json,application/json"
              hidden
              ?disabled=${this.disabled || busy}
              @change=${(event: Event) => this.load(event)}
            />
          </label>
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
