import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { observationWindowMs } from '../../settings/intervalLimits.js'
import type { PgnInfo, PgnListResult, PgnWriteResult } from '../../types.js'
import { describeFailure, request } from '../api.js'
import { LightElement } from '../light-element.js'
import {
  describeRestart,
  isPgnRestore,
  type PgnRestore,
  type RestartAction,
  type Restarted
} from '../restart.js'
import {
  defaultOf,
  describeMeasured,
  describePgnWrite,
  intervalRange,
  onRequest,
  parseInterval,
  pgnName,
  seconds,
  secondsText
} from '../pgns.js'

const PRIORITIES = [0, 1, 2, 3, 4, 5, 6, 7]

/** What the user has changed for one PGN, and how its last write went; the measurement comes with the list. */
interface PgnState {
  /** What the user typed or chose; null while the control shows what was measured. */
  interval: string | null
  priority: string | null
  busy: 'interval' | 'priority' | null
  outcome: { tone: string; text: string } | null
}

const EMPTY: PgnState = { interval: null, priority: null, busy: null, outcome: null }

const RESTORES: Record<PgnRestore, { label: string; what: string }> = {
  updateRates: { label: 'Restore default intervals…', what: 'every message’s default interval' },
  priorities: { label: 'Restore default priorities…', what: 'every message’s default priority' }
}

/**
 * The PGNs the sensor transmits, each with an interval and a priority to set.
 *
 * Each control shows what the plugin measured on the bus until the user
 * changes it, and each row says what its last write did. A PGN sent only on
 * request has no row.
 *
 * A restore restarts the sensor, and the panel replaces this element while
 * the sensor is away, so the panel sends it (`restart`) and passes back
 * `restarting` and `restarted`, the same as it passes the Danger zone.
 */
@customElement('dst-pgns')
export class PgnTable extends LightElement {
  @property({ attribute: false }) list: PgnListResult | null = null
  @property({ attribute: false }) listError: string | null = null
  /** The per-message interval setting: false while the sensor ignores the intervals set here. */
  @property({ attribute: false }) override: boolean | null = null
  @property({ type: Boolean }) disabled = false
  @property({ attribute: false }) restarting: RestartAction | null = null
  @property({ attribute: false }) restarted: Restarted | null = null

  @state() private pgns = new Map<number, PgnState>()
  @state() private confirming: PgnRestore | null = null

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('restarted') && this.restored?.result.status === 'claimed') {
      // Whatever was set here before, the sensor now holds its defaults.
      this.pgns = new Map()
    }
  }

  /**
   * Show each priority select's value. A binding on the select runs before
   * its options are rendered, so the value is set once they exist.
   */
  protected override updated(): void {
    for (const select of this.querySelectorAll<HTMLSelectElement>('select[data-value]')) {
      const value = select.dataset.value ?? ''
      if (select.value !== value) {
        select.value = value
      }
    }
  }

  private stateOf(pgn: number): PgnState {
    return this.pgns.get(pgn) ?? EMPTY
  }

  private change(pgn: number, edit: Partial<PgnState>): void {
    const pgns = new Map(this.pgns)
    pgns.set(pgn, { ...this.stateOf(pgn), ...edit })
    this.pgns = pgns
  }

  private async write(pgn: number, body: { intervalMs: number } | { priority: number }) {
    const kind = 'intervalMs' in body ? 'interval' : 'priority'
    this.change(pgn, { busy: kind, outcome: null })
    let result: PgnWriteResult
    try {
      result = await request<PgnWriteResult>('PUT', `/pgns/${String(pgn)}`, body)
    } catch (cause) {
      result = { status: 'invalid', reason: describeFailure(cause) }
    }
    const what = 'priority' in body ? { priority: body.priority } : { interval: true as const }
    // The written control follows the measurement again, which the panel takes afresh.
    this.change(pgn, { busy: null, outcome: describePgnWrite(result, what), [kind]: null })
    this.dispatchEvent(new CustomEvent('remeasure', { bubbles: true }))
  }

  /** One of this table's restores is in flight. */
  private get restoring(): boolean {
    return isPgnRestore(this.restarting ?? undefined)
  }

  /** How this table's last restore went, if the last restart was one of them. */
  private get restored(): Restarted | null {
    return this.restarted !== null && isPgnRestore(this.restarted.action) ? this.restarted : null
  }

  private restore(option: PgnRestore): void {
    this.confirming = null
    this.dispatchEvent(new CustomEvent('restart', { detail: { action: option }, bubbles: true }))
  }

  private row(info: PgnInfo) {
    const { pgn } = info
    const s = this.stateOf(pgn)
    const interval = s.interval === null ? null : parseInterval(s.interval, info.minIntervalMs)
    const measuredInterval = info.observedIntervalMs > 0 ? secondsText(info.observedIntervalMs) : ''
    const measuredPriority = info.observedPriority === null ? '' : String(info.observedPriority)
    const priority = s.priority ?? measuredPriority
    const blocked = this.disabled || s.busy !== null
    const id = `pgn-${String(pgn)}`
    return html`
      <div class="list-group-item" data-pgn=${pgn}>
        <div class="row g-2 align-items-start">
          <div class="col-md-4">
            <div class="fw-semibold">${pgnName(pgn)}</div>
            <div class="small text-body-secondary">
              PGN ${pgn}${defaultOf(pgn) === null ? '' : ` · ${String(defaultOf(pgn))}`}
            </div>
            <div class="small text-body-secondary">
              ${describeMeasured(info.observedIntervalMs, info.observedPriority)}
            </div>
            ${
              info.telemetry
                ? html`<div class="form-text mt-0 text-warning-emphasis">
                    The plugin reads this; a long interval slows every Signal K consumer of it.
                  </div>`
                : nothing
            }
          </div>
          <div class="col-sm-7 col-md-5">
            <div class="input-group input-group-sm">
              <input
                id=${`${id}-interval`}
                type="text"
                inputmode="decimal"
                aria-label=${`Interval of ${pgnName(pgn)}`}
                class=${`form-control ${interval !== null && !interval.ok ? 'is-invalid' : ''}`}
                placeholder=${info.observedIntervalMs > 0 ? 'Interval' : 'Not sent'}
                .value=${s.interval ?? measuredInterval}
                ?disabled=${blocked}
                @input=${(event: Event) => {
                  this.change(pgn, { interval: (event.target as HTMLInputElement).value })
                }}
                @keydown=${(event: KeyboardEvent) => {
                  if (event.key === 'Enter' && interval?.ok === true && !blocked) {
                    void this.write(pgn, { intervalMs: interval.ms })
                  }
                }}
              />
              <span class="input-group-text">s</span>
              <button
                type="button"
                class="btn btn-outline-primary"
                ?disabled=${blocked || interval?.ok !== true}
                @click=${() => {
                  if (interval?.ok === true) {
                    void this.write(pgn, { intervalMs: interval.ms })
                  }
                }}
              >
                Set
              </button>
            </div>
            ${
              interval !== null && !interval.ok
                ? html`<div class="small text-danger-emphasis mt-1">${interval.reason}</div>`
                : html`<div class="form-text mt-1">${intervalRange(info.minIntervalMs)}</div>`
            }
          </div>
          <div class="col-sm-5 col-md-3">
            <div class="input-group input-group-sm">
              <select
                aria-label=${`Priority of ${pgnName(pgn)}`}
                data-value=${priority}
                class="form-select"
                ?disabled=${blocked}
                @change=${(event: Event) => {
                  this.change(pgn, { priority: (event.target as HTMLSelectElement).value })
                }}
              >
                <option value="">Priority</option>
                ${PRIORITIES.map((p) => html`<option value=${String(p)}>${p}</option>`)}
              </select>
              <button
                type="button"
                class="btn btn-outline-primary"
                ?disabled=${blocked || s.priority === null || s.priority === ''}
                @click=${() => this.write(pgn, { priority: Number(s.priority) })}
              >
                Set priority
              </button>
            </div>
          </div>
        </div>
        ${this.status(s, info)}
      </div>
    `
  }

  private status(s: PgnState, info: PgnInfo) {
    if (s.busy === 'interval') {
      const interval = parseInterval(s.interval ?? '', info.minIntervalMs)
      const wait = interval.ok ? ` (up to ${seconds(observationWindowMs(interval.ms))})` : ''
      return html`<div class="small mt-1 text-body-secondary" role="status">
        <span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
        Timing the sensor’s next frames${wait}…
      </div>`
    }
    if (s.busy === 'priority') {
      return html`<div class="small mt-1 text-body-secondary" role="status">Setting…</div>`
    }
    return s.outcome === null
      ? nothing
      : html`<div class="small mt-1 text-${s.outcome.tone}-emphasis" role="status">
          ${s.outcome.text}
        </div>`
  }

  private restoreStatus() {
    if (this.restoring) {
      return html`<span class="small text-body-secondary" role="status">
        <span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
        Restoring. The sensor is restarting…
      </span>`
    }
    if (this.restored === null) {
      return nothing
    }
    const { tone, text } = describeRestart(this.restored)
    return html`<span class="small text-${tone}-emphasis" role="status">${text}</span>`
  }

  private restoreControls() {
    const confirming = this.confirming
    if (confirming !== null && !this.restoring) {
      return html`<div class="bg-warning-subtle border border-warning-subtle rounded p-3">
        <p class="mb-2">
          This puts back ${RESTORES[confirming].what}. The sensor restarts to apply this, and keeps
          its other settings.
        </p>
        <button
          type="button"
          class="btn btn-sm btn-warning me-2"
          ?disabled=${this.disabled || this.restarting !== null}
          @click=${() => {
            this.restore(confirming)
          }}
        >
          Restore and restart
        </button>
        <button
          type="button"
          class="btn btn-sm btn-link"
          @click=${() => {
            this.confirming = null
          }}
        >
          Cancel
        </button>
      </div>`
    }
    return html`<div class="d-flex flex-wrap align-items-center gap-2">
      ${(Object.keys(RESTORES) as PgnRestore[]).map(
        (option) =>
          html`<button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            ?disabled=${this.disabled || this.restarting !== null}
            @click=${() => {
              this.confirming = option
            }}
          >
            ${RESTORES[option].label}
          </button>`
      )}
      ${this.restoreStatus()}
    </div>`
  }

  override render() {
    if (this.listError !== null) {
      return html`<div class="list-group-item text-danger-emphasis">
        Cannot list what the sensor transmits: ${this.listError}
      </div>`
    }
    const list = this.list
    if (list === null) {
      // The sensor is restarting or being read again; a restore still says how it went.
      return this.restoring || this.restored !== null
        ? html`<div class="list-group-item">${this.restoreStatus()}</div>`
        : nothing
    }
    if (list.status !== 'answered') {
      return html`<div class="list-group-item text-warning-emphasis">
        ${
          list.status === 'unknown'
            ? 'The sensor didn’t answer when asked what it transmits.'
            : `The sensor refused to list what it transmits: ${list.reason}.`
        }
      </div>`
    }
    const periodic = list.pgns.filter((info) => !onRequest(info.pgn))
    const others = list.pgns.filter((info) => onRequest(info.pgn))
    return html`
      <div class="list-group-item">
        <div class="fw-semibold">Messages</div>
        <div class="form-text mt-0">
          How often the sensor sends each message, and at what priority (0 is the highest). Both are
          measured from what the sensor sends: a message it does not send on its own shows no
          interval, and a long interval shows once two messages have been heard.
        </div>
        ${
          this.override === false
            ? html`<div class="small text-warning-emphasis mt-1">
                The sensor sends no message faster than it measures its data. An interval shorter
                than that takes effect once Transmission intervals is set to “As set, repeating
                values”.
              </div>`
            : nothing
        }
      </div>
      ${periodic.map((info) => this.row(info))}
      <div class="list-group-item">
        ${
          others.length === 0
            ? nothing
            : html`<div class="small text-body-secondary mb-2">
                Also sent on request: ${others.map((info) => pgnName(info.pgn)).join(', ')}.
              </div>`
        }
        ${this.restoreControls()}
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-pgns': PgnTable
  }
}
