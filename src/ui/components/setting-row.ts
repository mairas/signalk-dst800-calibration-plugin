import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type { ReadResult, WriteResult } from '../../types.js'
import { LightElement } from '../light-element.js'
import { age, describeOutcome, formatValue, type SettingView } from '../settings.js'

/** What the console knows about one setting of the selected sensor. */
export interface RowState {
  /** The last value the device reported, and when. */
  stored: { value: unknown; readAt: string } | null
  /** The last read or write, from this console or another. */
  last: { operation: 'read' | 'write'; result: ReadResult | WriteResult } | null
  busy: 'read' | 'write' | null
}

export const EMPTY_ROW: RowState = { stored: null, last: null, busy: null }

/** Sent when the user asks to write `value`. */
export type WriteRequest = CustomEvent<{ value: unknown }>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * One setting: its label, the device's value with its age, the outcome of the
 * last operation, and an editor for its kind.
 *
 * Fires `read` and `write` (a `WriteRequest`); the panel talks to the plugin.
 */
@customElement('dst-setting-row')
export class SettingRow extends LightElement {
  @property() settingId = ''
  @property() label = ''
  @property({ attribute: false }) view: SettingView | null = null
  @property({ type: Boolean }) readable = true
  @property({ attribute: false }) row: RowState = EMPTY_ROW
  /** The sensor is not on the bus, or the user may not act. */
  @property({ type: Boolean }) disabled = false
  /** `Date.now()` of the panel's last tick, so ages move without a request. */
  @property({ type: Number }) now = 0

  @state() private draft: string[] = []
  @state() private filterType: 0 | 1 = 1
  @state() private choice: boolean | null = null
  @state() private confirming = false

  private emitRead(): void {
    this.dispatchEvent(new CustomEvent('read', { bubbles: true }))
  }

  private emitWrite(value: unknown): void {
    this.confirming = false
    this.dispatchEvent(new CustomEvent('write', { detail: { value }, bubbles: true }))
  }

  private get blocked(): boolean {
    return this.disabled || this.row.busy !== null
  }

  private input(index: number, event: Event): void {
    const next = [...this.draft]
    next[index] = (event.target as HTMLInputElement).value
    this.draft = next
  }

  private numberEditor(unit: string, step: number) {
    const text = this.draft[0] ?? ''
    const value = Number(text)
    const usable = text.trim() !== '' && Number.isFinite(value)
    return html`
      <div class="input-group input-group-sm">
        <input
          type="number"
          class="form-control"
          step=${String(step)}
          aria-label=${this.label}
          .value=${text}
          @input=${(event: Event) => {
            this.input(0, event)
          }}
        />
        <span class="input-group-text">${unit}</span>
        <button
          type="button"
          class="btn btn-outline-primary"
          ?disabled=${this.blocked || !usable}
          @click=${() => {
            this.emitWrite(value)
          }}
        >
          Write
        </button>
      </div>
    `
  }

  private descriptionEditor() {
    const stored = isRecord(this.row.stored?.value) ? this.row.stored.value : {}
    const line = (index: number, key: 'description1' | 'description2') =>
      this.draft[index] ?? (typeof stored[key] === 'string' ? stored[key] : '')
    return html`
      <div class="d-flex flex-column gap-1">
        ${(['description1', 'description2'] as const).map(
          (key, index) =>
            html`<input
              type="text"
              class="form-control form-control-sm"
              maxlength="70"
              aria-label=${`${this.label}, line ${String(index + 1)}`}
              .value=${line(index, key)}
              @input=${(event: Event) => {
                this.input(index, event)
              }}
            />`
        )}
        <button
          type="button"
          class="btn btn-sm btn-outline-primary align-self-start"
          ?disabled=${this.blocked}
          @click=${() => {
            this.emitWrite({
              description1: line(0, 'description1'),
              description2: line(1, 'description2')
            })
          }}
        >
          Write
        </button>
      </div>
    `
  }

  private filterEditor() {
    const [interval = '', duration = ''] = this.draft
    const iir = this.filterType === 1
    const both = interval.trim() !== '' && duration.trim() !== ''
    const value: Record<string, number> = { type: this.filterType }
    if (iir && both) {
      value.sampleInterval = Number(interval)
      value.filterDuration = Number(duration)
    }
    return html`
      <div class="d-flex flex-wrap gap-1 align-items-center">
        <select
          class="form-select form-select-sm w-auto"
          aria-label=${`${this.label} type`}
          @change=${(event: Event) => {
            this.filterType = (event.target as HTMLSelectElement).value === '0' ? 0 : 1
          }}
        >
          <option value="1" ?selected=${iir}>IIR filter</option>
          <option value="0" ?selected=${!iir}>No filter</option>
        </select>
        ${
          iir
            ? html`
                <input
                  type="number"
                  class="form-control form-control-sm w-auto"
                  step="0.01"
                  placeholder="sample interval, s"
                  aria-label=${`${this.label} sample interval`}
                  .value=${interval}
                  @input=${(event: Event) => {
                    this.input(0, event)
                  }}
                />
                <input
                  type="number"
                  class="form-control form-control-sm w-auto"
                  step="0.01"
                  placeholder="duration, s"
                  aria-label=${`${this.label} filter duration`}
                  .value=${duration}
                  @input=${(event: Event) => {
                    this.input(1, event)
                  }}
                />
              `
            : nothing
        }
        <button
          type="button"
          class="btn btn-sm btn-outline-primary"
          ?disabled=${this.blocked || (iir && (interval !== '' || duration !== '') && !both)}
          @click=${() => {
            this.emitWrite(value)
          }}
        >
          Write
        </button>
      </div>
    `
  }

  private simulateEditor() {
    if (this.row.stored?.value === true) {
      return html`<button
        type="button"
        class="btn btn-sm btn-outline-danger"
        ?disabled=${this.blocked}
        @click=${() => {
          this.emitWrite(false)
        }}
      >
        Turn off
      </button>`
    }
    if (!this.confirming) {
      return html`<button
        type="button"
        class="btn btn-sm btn-outline-danger"
        ?disabled=${this.blocked}
        @click=${() => {
          this.confirming = true
        }}
      >
        Turn on…
      </button>`
    }
    return html`
      <div class="alert alert-danger py-2 mb-0">
        <p class="mb-2">
          Autopilots, depth alarms and anchor alarms will act on simulated values until you turn it
          off or the sensor loses power.
        </p>
        <button
          type="button"
          class="btn btn-sm btn-danger me-2"
          ?disabled=${this.blocked}
          @click=${() => {
            this.emitWrite(true)
          }}
        >
          Turn simulate mode on
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          @click=${() => {
            this.confirming = false
          }}
        >
          Cancel
        </button>
      </div>
    `
  }

  private editor() {
    const editor = this.view?.editor
    switch (editor?.kind) {
      case 'number':
        return this.numberEditor(editor.unit, editor.step)
      case 'choice': {
        const current = typeof this.row.stored?.value === 'boolean' ? this.row.stored.value : null
        const chosen = this.choice ?? current ?? editor.options[0].value
        return html`
          <div class="input-group input-group-sm">
            <select
              class="form-select"
              aria-label=${this.label}
              @change=${(event: Event) => {
                this.choice = (event.target as HTMLSelectElement).value === 'true'
              }}
            >
              ${editor.options.map(
                (o) =>
                  html`<option value=${String(o.value)} ?selected=${o.value === chosen}>
                    ${o.label}
                  </option>`
              )}
            </select>
            <button
              type="button"
              class="btn btn-outline-primary"
              ?disabled=${this.blocked}
              @click=${() => {
                this.emitWrite(chosen)
              }}
            >
              Write
            </button>
          </div>
        `
      }
      case 'simulate':
        return this.simulateEditor()
      case 'description':
        return this.descriptionEditor()
      case 'filter':
        return this.filterEditor()
      case 'tripReset':
        return html`<button
          type="button"
          class="btn btn-sm btn-outline-primary"
          ?disabled=${this.blocked}
          @click=${() => {
            this.emitWrite({ tripLog: 0 })
          }}
        >
          Reset trip
        </button>`
      default:
        return nothing
    }
  }

  private valueCell() {
    if (!this.readable) {
      return html`<span class="text-body-secondary"
        >The device cannot report this value back.</span
      >`
    }
    const stored = this.row.stored
    return html`
      ${
        stored === null
          ? html`<span class="text-body-secondary">Not read yet</span>`
          : html`<span class="fw-semibold">${formatValue(this.settingId, stored.value)}</span>
              <span class="small text-body-secondary">read ${age(stored.readAt, this.now)}</span>`
      }
      <button
        type="button"
        class="btn btn-link btn-sm p-0 ms-2 align-baseline"
        ?disabled=${this.blocked}
        @click=${() => {
          this.emitRead()
        }}
      >
        Read
      </button>
    `
  }

  private statusLine() {
    if (this.row.busy !== null) {
      return html`<div class="small text-body-secondary mt-1">
        ${this.row.busy === 'read' ? 'Reading…' : 'Writing…'}
      </div>`
    }
    const last = this.row.last
    const outcome =
      last === null ? null : describeOutcome(this.settingId, last.operation, last.result)
    return outcome === null
      ? nothing
      : html`<div class="small mt-1 text-${outcome.tone}-emphasis">${outcome.text}</div>`
  }

  override render() {
    return html`
      <div class="row g-2 align-items-center">
        <div class="col-md-4">
          <div class="fw-semibold">${this.label}</div>
          ${
            this.view?.help === undefined
              ? nothing
              : html`<div class="small text-body-secondary">${this.view.help}</div>`
          }
        </div>
        <div class="col-md-4">${this.valueCell()}</div>
        <div class="col-md-4">${this.editor()}</div>
      </div>
      ${this.statusLine()}
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-setting-row': SettingRow
  }
}
