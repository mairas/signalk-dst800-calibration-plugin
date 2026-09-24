import { html, nothing, type TemplateResult } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type { DeviceKey } from '../../types.js'
import { FACTORY_CURVE, checkCurve, curveOf, refusedAt, rowsOf, type CurveRow } from '../curve.js'
import { isRecord, sameKey } from '../format.js'
import { LightElement } from '../light-element.js'
import {
  describeOutcome,
  describeValue,
  descriptionLines,
  inWords,
  type Editor,
  type Outcome
} from '../settings.js'
import type { DisplayUnit } from '../units.js'
import './curve-csv.js'
import './curve-editor.js'
import type { RowsChange } from './curve-editor.js'

/** What the console knows about one setting of the selected sensor. */
export interface RowState {
  /** The last value the device reported, and when. */
  stored: { value: unknown; readAt: string } | null
  outcome: Outcome | null
  busy: 'read' | 'write' | null
}

export const EMPTY_ROW: RowState = { stored: null, outcome: null, busy: null }

/** Sent when the user saves `value`, in SI units. */
export type WriteRequest = CustomEvent<{ value: unknown }>

/** How long "Stored." stays before the row goes quiet again. */
const STORED_NOTICE_MS = 4000

/** A curve's fields, two per point, back into its rows. */
const pairs = (fields: readonly string[]): CurveRow[] =>
  Array.from({ length: Math.floor(fields.length / 2) }, (_, i) => [
    fields[2 * i],
    fields[2 * i + 1]
  ])

/**
 * One setting: its label and help, and its value as an editable control.
 *
 * The control shows the sensor's value until the user changes it. Editing
 * marks it dirty and offers Save and Cancel beside the sensor's own value.
 * Fires `read` and `write` (a `WriteRequest`); the panel talks to the plugin.
 */
@customElement('dst-setting-row')
export class SettingRow extends LightElement {
  @property() settingId = ''
  @property() label = ''
  @property() help = ''
  @property({ attribute: false }) editor: Editor = { kind: 'number' }
  @property({ attribute: false }) unit: DisplayUnit | null = null
  @property({ type: Boolean }) readable = true
  @property({ type: Boolean }) level1 = false
  @property({ attribute: false }) row: RowState = EMPTY_ROW
  /** The sensor is not on the bus. */
  @property({ type: Boolean }) disabled = false
  /** The sensor. An edit belongs to it, and its files are named for it. */
  @property({ attribute: false }) device: DeviceKey | null = null
  /** The unit a curve file names, or null when the server knows no such unit. */
  @property({ attribute: false }) resolveUnit: (name: string) => DisplayUnit | null = () => null

  /** What the user typed, per field; null while the control follows the sensor. */
  @state() private draft: string[] | null = null
  @state() private confirming = false
  @state() private understood = false
  @state() private storedNoticeGone = false
  private storedNoticeTimer: ReturnType<typeof setTimeout> | null = null

  private get inputId(): string {
    return `setting-${this.settingId}-${this.label.replace(/\W+/g, '-')}`
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    const device = changed.get('device') as DeviceKey | null | undefined
    if (device !== undefined && !sameKey(device, this.device)) {
      // An edit made for one sensor must not be saved to another.
      this.draft = null
      this.confirming = false
      this.understood = false
    }
    if (changed.has('draft') && this.editor.kind === 'curve' && this.dirty) {
      // The restore would drop the edit, and an export now would save the edit, not the sensor's curve.
      this.confirming = false
    }
    const previous = changed.get('row') as RowState | undefined
    if (previous === undefined || previous.outcome === this.row.outcome) {
      return
    }
    const kind = this.row.outcome?.kind
    // The sensor now holds what it holds; show that, not the attempt.
    if (
      kind === 'stored' ||
      kind === 'holdsRequested' ||
      kind === 'differs' ||
      kind === 'accepted'
    ) {
      this.draft = null
      this.confirming = false
      this.understood = false
    }
    this.storedNoticeGone = false
    if (this.storedNoticeTimer !== null) {
      clearTimeout(this.storedNoticeTimer)
    }
    if (kind === 'stored') {
      this.storedNoticeTimer = setTimeout(() => {
        this.storedNoticeGone = true
      }, STORED_NOTICE_MS)
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    if (this.storedNoticeTimer !== null) {
      clearTimeout(this.storedNoticeTimer)
    }
  }

  /** The sensor's value as the control's text, per field. */
  private storedFields(): string[] {
    const value = this.row.stored?.value
    switch (this.editor.kind) {
      case 'number':
        return [typeof value === 'number' && this.unit !== null ? this.unit.format(value) : '']
      case 'choice':
        return [typeof value === 'boolean' ? String(value) : '']
      case 'description':
        return descriptionLines(value)
      case 'curve': {
        const points = curveOf(value)
        return points === null || this.unit === null ? [] : rowsOf(points, this.unit).flat()
      }
      default:
        return []
    }
  }

  private get fields(): string[] {
    return this.draft ?? this.storedFields()
  }

  private get dirty(): boolean {
    const stored = this.storedFields()
    return (
      this.draft !== null &&
      (this.draft.length !== stored.length || this.draft.some((field, i) => field !== stored[i]))
    )
  }

  private get blocked(): boolean {
    return this.disabled || this.row.busy !== null
  }

  private edit(index: number, text: string): void {
    const next = [...this.fields]
    next[index] = text
    this.draft = next
  }

  private cancel(): void {
    this.draft = null
  }

  private emitWrite(value: unknown): void {
    this.dispatchEvent(new CustomEvent('write', { detail: { value }, bubbles: true }))
  }

  private emitRead(): void {
    this.dispatchEvent(new CustomEvent('read', { bubbles: true }))
  }

  /** The value to write for the current fields, or null while they cannot be written. */
  private pending(): unknown {
    const fields = this.fields
    switch (this.editor.kind) {
      case 'number':
        return this.unit?.parse(fields[0]) ?? null
      case 'choice':
        return fields[0] === 'true'
      case 'description':
        return { description1: fields[0], description2: fields[1] }
      case 'curve':
        return this.curveCheck()?.points ?? null
      default:
        return null
    }
  }

  private save(): void {
    const value = this.pending()
    if (this.dirty && value !== null && !this.blocked) {
      this.emitWrite(value)
    }
  }

  private keys(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      this.save()
    } else if (event.key === 'Escape') {
      this.cancel()
    }
  }

  /** A value as the user reads it, in a sentence. */
  private show(value: unknown): string {
    return describeValue(this.editor, this.unit, value)
  }

  private saveButtons() {
    if (!this.dirty && this.row.busy !== 'write') {
      return nothing
    }
    const writable = this.pending() !== null
    return html`
      <div class="d-flex flex-wrap align-items-center gap-2 mt-2">
        <button
          type="button"
          class="btn btn-sm btn-primary"
          ?disabled=${this.blocked || !writable}
          @click=${() => {
            this.save()
          }}
        >
          ${
            this.row.busy === 'write'
              ? html`<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
                  Saving…`
              : 'Save'
          }
        </button>
        <button
          type="button"
          class="btn btn-sm btn-link"
          ?disabled=${this.row.busy === 'write'}
          @click=${() => {
            this.cancel()
          }}
        >
          Cancel
        </button>
        ${
          this.row.stored === null || this.outcomeStatesValue()
            ? nothing
            : html`<span class="small text-body-secondary"
                >Sensor has ${this.show(this.row.stored.value)}</span
              >`
        }
        ${
          writable || this.editor.kind === 'curve'
            ? nothing
            : html`<span class="small text-danger-emphasis">Enter a number.</span>`
        }
      </div>
    `
  }

  /** The outcome message already names the sensor's value. */
  private outcomeStatesValue(): boolean {
    const outcome = this.row.outcome
    return (
      outcome?.kind === 'refused' ||
      outcome?.kind === 'holdsRequested' ||
      (outcome?.kind === 'noAnswer' && outcome.operation === 'write')
    )
  }

  private inputClass(): string {
    const failed = ['refused', 'notSent', 'invalid'].includes(this.row.outcome?.kind ?? '')
    return [
      'form-control',
      this.dirty ? 'border-primary' : '',
      this.dirty && failed ? 'is-invalid' : ''
    ].join(' ')
  }

  private numberControl() {
    return html`
      <div class="input-group dst-value-input">
        <input
          id=${this.inputId}
          type="text"
          inputmode="decimal"
          class=${this.inputClass()}
          .value=${this.fields[0] ?? ''}
          placeholder=${this.row.stored === null ? '—' : ''}
          ?readonly=${this.row.busy === 'write'}
          ?disabled=${this.disabled}
          @input=${(event: Event) => {
            this.edit(0, (event.target as HTMLInputElement).value)
          }}
          @keydown=${(event: KeyboardEvent) => {
            this.keys(event)
          }}
        />
        <span class="input-group-text">${this.unit?.symbol ?? ''}</span>
      </div>
      ${this.saveButtons()}
    `
  }

  /** Put back the curve the sensor left the factory with, after a confirmation. */
  private factoryControl() {
    if (!this.confirming) {
      return html`<div class="d-flex flex-wrap align-items-center gap-2 mt-2">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          ?disabled=${this.blocked || this.dirty}
          @click=${() => {
            this.confirming = true
          }}
        >
          Restore factory curve…
        </button>
        ${
          this.dirty
            ? html`<span class="small text-body-secondary">Save or cancel the edit first.</span>`
            : nothing
        }
      </div>`
    }
    return html`<div class="bg-warning-subtle border border-warning-subtle rounded p-3 mt-2">
      <p class="mb-2">
        This replaces the curve on the sensor with the one it left the factory with; the table then
        shows it. <a href="#snapshots">Export the settings</a> first to keep this one.
      </p>
      <button
        type="button"
        class="btn btn-sm btn-warning me-2"
        ?disabled=${this.blocked}
        @click=${() => {
          this.confirming = false
          this.emitWrite(FACTORY_CURVE)
        }}
      >
        Restore factory curve
      </button>
      <button
        type="button"
        class="btn btn-sm btn-link"
        @click=${() => {
          this.confirming = false
        }}
      >
        Cancel
      </button>
    </div>`
  }

  /** The curve the table holds and its problems, checked once per use. */
  private curveCheck(): ReturnType<typeof checkCurve> | null {
    return this.unit === null ? null : checkCurve(pairs(this.fields), this.unit)
  }

  private curveControl() {
    const rows = pairs(this.fields)
    const check = this.curveCheck()
    const problems = check?.problems ?? []
    const outcome = this.row.outcome
    const refused =
      this.dirty && outcome?.kind === 'refused'
        ? outcome.fields.map((f) => refusedAt(f.field)).filter((at) => at !== null)
        : []
    const invalid = new Set(
      [...problems, ...refused]
        .filter((p) => p.point !== null && p.field !== null)
        .map((p) => `${String(p.point)}:${String(p.field)}`)
    )
    const stored = this.storedFields()
    return html`
      <dst-curve-editor
        .rows=${rows}
        .stored=${this.row.stored === null ? null : pairs(stored)}
        .speedSymbol=${this.unit?.symbol ?? ''}
        .invalid=${invalid}
        ?disabled=${this.disabled}
        ?readonly=${this.row.busy === 'write'}
        @rows-change=${(event: RowsChange) => {
          this.draft = event.detail.rows.flat()
        }}
      ></dst-curve-editor>
      ${
        problems.length === 0 || !this.dirty
          ? nothing
          : html`<ul class="small text-danger-emphasis mt-2 mb-0 ps-3">
              ${problems.map((p) => html`<li>${p.text}</li>`)}
            </ul>`
      }
      ${this.saveButtons()}
      <dst-curve-csv
        .points=${check?.points ?? null}
        .dirty=${this.dirty}
        .stored=${this.row.stored === null ? null : pairs(stored)}
        .speed=${this.unit}
        .resolveUnit=${this.resolveUnit}
        .device=${this.device}
        ?disabled=${this.blocked}
        @rows-change=${(event: RowsChange) => {
          this.draft = event.detail.rows.flat()
        }}
      ></dst-curve-csv>
      ${this.factoryControl()}
    `
  }

  private choiceControl(options: readonly { value: boolean; label: string }[]) {
    return html`
      <select
        id=${this.inputId}
        class=${`${this.inputClass().replace('form-control', 'form-select')} dst-value-input`}
        ?disabled=${this.disabled || this.row.busy === 'write'}
        @change=${(event: Event) => {
          this.edit(0, (event.target as HTMLSelectElement).value)
        }}
      >
        ${this.row.stored === null ? html`<option value="" selected>—</option>` : nothing}
        ${options.map(
          (o) =>
            html`<option value=${String(o.value)} ?selected=${this.fields[0] === String(o.value)}>
              ${o.label}
            </option>`
        )}
      </select>
      ${this.saveButtons()}
    `
  }

  private descriptionControl() {
    return html`
      ${[0, 1].map(
        (index) => html`
          <div class="input-group input-group-sm mb-1">
            <label class="input-group-text" for=${`${this.inputId}-${String(index)}`}
              >Line ${index + 1}</label
            >
            <input
              id=${`${this.inputId}-${String(index)}`}
              type="text"
              maxlength="70"
              class=${this.inputClass()}
              .value=${this.fields[index] ?? ''}
              ?readonly=${this.row.busy === 'write'}
              ?disabled=${this.disabled}
              @input=${(event: Event) => {
                this.edit(index, (event.target as HTMLInputElement).value)
              }}
              @keydown=${(event: KeyboardEvent) => {
                this.keys(event)
              }}
            />
          </div>
        `
      )}
      ${this.saveButtons()}
    `
  }

  private filterControl() {
    const [type = '1', interval = '', duration = ''] = this.draft ?? []
    const iir = type === '1'
    const both = interval.trim() !== '' && duration.trim() !== ''
    const neither = interval.trim() === '' && duration.trim() === ''
    const value: Record<string, number> = { type: iir ? 1 : 0 }
    if (iir && both) {
      value.sampleInterval = Number(interval)
      value.filterDuration = Number(duration)
    }
    const set = (index: number, text: string) => {
      const next = [type, interval, duration]
      next[index] = text
      this.draft = next
    }
    const times = [
      ['Sample interval', 1, interval],
      ['Duration', 2, duration]
    ] as const
    return html`
      <div class="row g-2 align-items-end">
        <div class="col-auto">
          <label class="form-label small mb-1" for=${`${this.inputId}-type`}>Type</label>
          <select
            id=${`${this.inputId}-type`}
            class="form-select form-select-sm"
            ?disabled=${this.blocked}
            @change=${(event: Event) => {
              set(0, (event.target as HTMLSelectElement).value)
            }}
          >
            <option value="1" ?selected=${iir}>IIR filter</option>
            <option value="0" ?selected=${!iir}>No filter</option>
          </select>
        </div>
        ${
          iir
            ? times.map(
                ([label, index, text]) => html`
                  <div class="col">
                    <label class="form-label small mb-1" for=${`${this.inputId}-${String(index)}`}
                      >${label}</label
                    >
                    <div class="input-group input-group-sm">
                      <input
                        id=${`${this.inputId}-${String(index)}`}
                        type="text"
                        inputmode="decimal"
                        class="form-control"
                        .value=${text}
                        ?disabled=${this.blocked}
                        @input=${(event: Event) => {
                          set(index, (event.target as HTMLInputElement).value)
                        }}
                      />
                      <span class="input-group-text">s</span>
                    </div>
                  </div>
                `
              )
            : nothing
        }
        <div class="col-auto">
          <button
            type="button"
            class="btn btn-sm btn-primary"
            ?disabled=${this.blocked || (iir && !both && !neither)}
            @click=${() => {
              this.emitWrite(value)
            }}
          >
            ${this.row.busy === 'write' ? 'Writing…' : 'Write'}
          </button>
        </div>
      </div>
      <div class="form-text">
        The sensor cannot report this setting back.
        ${iir && neither ? 'Leave both times empty to keep the ones stored.' : ''}
      </div>
    `
  }

  private tripControl() {
    const log = isRecord(this.row.stored?.value) ? this.row.stored.value : null
    const distance = (metres: unknown) =>
      typeof metres === 'number' && this.unit !== null
        ? `${this.unit.format(metres)} ${this.unit.symbol}`
        : '—'
    return html`
      <div class="d-flex flex-wrap align-items-center gap-3">
        <span
          ><span class="fw-semibold">${distance(log?.tripLog)}</span>
          <span class="text-body-secondary">· total ${distance(log?.log)}</span></span
        >
        ${
          this.confirming
            ? nothing
            : html`<button
                type="button"
                class="btn btn-sm btn-outline-secondary"
                ?disabled=${this.blocked}
                @click=${() => {
                  this.confirming = true
                }}
              >
                Reset trip…
              </button>`
        }
      </div>
      ${
        this.confirming
          ? html`<div class="mt-2">
              <span class="me-2">Set the trip to zero? The total is not affected.</span>
              <button
                type="button"
                class="btn btn-sm btn-primary"
                ?disabled=${this.blocked}
                @click=${() => {
                  this.emitWrite({ tripLog: 0 })
                }}
              >
                Reset trip
              </button>
              <button
                type="button"
                class="btn btn-sm btn-link"
                @click=${() => {
                  this.confirming = false
                }}
              >
                Cancel
              </button>
            </div>`
          : nothing
      }
    `
  }

  private simulateControl() {
    if (this.row.stored?.value === true) {
      return html`<div class="d-flex align-items-center gap-3">
        <span class="badge text-bg-danger">On</span>
        <button
          type="button"
          class="btn btn-sm btn-danger"
          ?disabled=${this.blocked}
          @click=${() => {
            this.emitWrite(false)
          }}
        >
          Turn off simulate mode
        </button>
      </div>`
    }
    if (!this.confirming) {
      return html`<div class="d-flex align-items-center gap-3">
        <span class="text-body-secondary">${this.row.stored === null ? '—' : 'Off'}</span>
        <button
          type="button"
          class="btn btn-sm btn-outline-danger"
          ?disabled=${this.blocked}
          @click=${() => {
            this.confirming = true
          }}
        >
          Turn on simulate mode…
        </button>
      </div>`
    }
    return html`
      <div class="bg-danger-subtle border border-danger-subtle rounded p-3">
        <p class="mb-2 text-danger-emphasis">
          Every device on the network, autopilot and anchor alarm included, will receive simulated
          depth, speed and temperature as real, until you turn it off or the sensor loses power.
        </p>
        <div class="form-check mb-2">
          <input
            id=${`${this.inputId}-understood`}
            class="form-check-input"
            type="checkbox"
            .checked=${this.understood}
            @change=${(event: Event) => {
              this.understood = (event.target as HTMLInputElement).checked
            }}
          />
          <label class="form-check-label" for=${`${this.inputId}-understood`}>I understand</label>
        </div>
        <button
          type="button"
          class="btn btn-sm btn-danger me-2"
          ?disabled=${this.blocked || !this.understood}
          @click=${() => {
            this.emitWrite(true)
          }}
        >
          Turn simulate mode on
        </button>
        <button
          type="button"
          class="btn btn-sm btn-link"
          @click=${() => {
            this.confirming = false
            this.understood = false
          }}
        >
          Cancel
        </button>
      </div>
    `
  }

  private control() {
    switch (this.editor.kind) {
      case 'number':
        return this.numberControl()
      case 'choice':
        return this.choiceControl(this.editor.options)
      case 'description':
        return this.descriptionControl()
      case 'filter':
        return this.filterControl()
      case 'tripReset':
        return this.tripControl()
      case 'simulate':
        return this.simulateControl()
      case 'curve':
        return this.curveControl()
    }
  }

  private readAgain(text: string, tone: string): TemplateResult {
    return html`<div class="small mt-1 text-${tone}-emphasis" role="status">
      ${text}
      <button
        type="button"
        class="btn btn-link btn-sm p-0 align-baseline"
        ?disabled=${this.blocked}
        @click=${() => {
          this.emitRead()
        }}
      >
        Read again
      </button>
    </div>`
  }

  /** The line under the control: what the last operation did, in the sensor's terms. */
  private status() {
    if (this.row.busy === 'read') {
      return html`<div class="small mt-1 text-body-secondary" role="status">Reading…</div>`
    }
    const outcome = this.row.outcome
    if (outcome === null) {
      return this.readable && this.row.stored === null && !this.disabled
        ? this.readAgain('Not read yet.', 'secondary')
        : nothing
    }
    if (outcome.kind === 'stored' && this.storedNoticeGone) {
      return nothing
    }
    // A restore sends one field, so naming it would hide that the restore failed.
    if (
      this.editor.kind === 'curve' &&
      outcome.kind === 'refused' &&
      outcome.fields.length > 0 &&
      outcome.requested !== FACTORY_CURVE
    ) {
      const text = outcome.fields.map((f) => `${f.field}: ${inWords([f.error])}`).join('; ')
      return html`<div class="small mt-1 text-danger-emphasis" role="status">
        The sensor refused ${text}.
      </div>`
    }
    const { tone, text } = describeOutcome(outcome, (value) => this.show(value), this.row.stored)
    const retry =
      outcome.kind === 'unconfirmed' ||
      outcome.kind === 'readRefused' ||
      outcome.kind === 'notRead' ||
      (outcome.kind === 'noAnswer' && outcome.operation === 'read')
    return retry
      ? this.readAgain(text, tone)
      : html`<div class="small mt-1 text-${tone}-emphasis" role="status">${text}</div>`
  }

  override render() {
    const wide = this.editor.kind === 'curve'
    return html`
      <div class="row g-2">
        <div class=${wide ? 'col-12' : 'col-md-5'}>
          <label class="fw-semibold" for=${this.inputId}>${this.label}</label>
          ${
            this.level1
              ? html`<span
                  class="badge bg-secondary-subtle text-secondary-emphasis ms-1"
                  title="Saving this needs Level 1 access, which the console asks for itself."
                  >Level 1</span
                >`
              : nothing
          }
          ${this.help === '' ? nothing : html`<div class="form-text mt-0">${this.help}</div>`}
        </div>
        <div class=${wide ? 'col-12' : 'col-md-7'}>${this.control()} ${this.status()}</div>
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-setting-row': SettingRow
  }
}
