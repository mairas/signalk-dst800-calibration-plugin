import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { observationWindowMs } from '../../settings/intervalLimits.js'
import type { PgnInfo, PgnListResult, PgnWriteResult, ResetResult } from '../../types.js'
import { describeFailure, request } from '../api.js'
import { LightElement } from '../light-element.js'
import {
  defaultOf,
  describePgnWrite,
  intervalRange,
  onRequest,
  parseInterval,
  pgnName,
  seconds
} from '../pgns.js'

const PRIORITIES = [0, 1, 2, 3, 4, 5, 6, 7]

/** What the console knows about one PGN: nothing is read from the sensor, only what was set. */
interface PgnState {
  interval: string
  priority: string
  busy: 'interval' | 'priority' | null
  outcome: { tone: string; text: string } | null
}

const EMPTY: PgnState = { interval: '', priority: '', busy: null, outcome: null }

type Restore = 'updateRates' | 'priorities'

const RESTORES: Record<Restore, { label: string; what: string }> = {
  updateRates: { label: 'Restore default intervals…', what: 'every message’s default interval' },
  priorities: { label: 'Restore default priorities…', what: 'every message’s default priority' }
}

/** A restore that went through restarts the sensor; say so in words. */
function describeRestore(result: ResetResult): { tone: string; text: string } {
  switch (result.status) {
    case 'claimed':
      return { tone: 'success', text: '✓ Restored. The sensor restarted.' }
    case 'lost':
      return { tone: 'warning', text: `Sent, but the sensor didn’t come back: ${result.reason}.` }
    case 'notSent':
      return { tone: 'danger', text: `Not sent: ${result.reason}.` }
  }
}

/**
 * The PGNs the sensor transmits, each with an interval and a priority to set.
 *
 * The sensor does not report either, so the controls start empty and each
 * row says what the last write did. A PGN sent only on request has no row.
 */
@customElement('dst-pgns')
export class PgnTable extends LightElement {
  @property({ attribute: false }) list: PgnListResult | null = null
  @property({ attribute: false }) listError: string | null = null
  /** The per-message interval setting: false while the sensor ignores the intervals set here. */
  @property({ attribute: false }) override: boolean | null = null
  @property({ type: Boolean }) disabled = false

  @state() private pgns = new Map<number, PgnState>()
  @state() private confirming: Restore | null = null
  @state() private restoring = false
  @state() private restored: { tone: string; text: string } | null = null

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
    this.change(pgn, { busy: null, outcome: describePgnWrite(result, what) })
  }

  private async restore(option: Restore): Promise<void> {
    this.restoring = true
    let result: ResetResult
    try {
      result = await request<ResetResult>('POST', '/device/restore', { option })
    } catch (cause) {
      result = { status: 'notSent', reason: describeFailure(cause) }
    }
    this.restoring = false
    this.confirming = null
    this.restored = describeRestore(result)
    if (result.status === 'claimed') {
      // Whatever was set here before, the sensor now holds its defaults.
      this.pgns = new Map()
    }
  }

  private row(info: PgnInfo) {
    const { pgn } = info
    const s = this.stateOf(pgn)
    const interval = s.interval === '' ? null : parseInterval(s.interval, info.minIntervalMs)
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
                placeholder="Interval"
                .value=${s.interval}
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
                class="form-select"
                ?disabled=${blocked}
                @change=${(event: Event) => {
                  this.change(pgn, { priority: (event.target as HTMLSelectElement).value })
                }}
              >
                <option value="" ?selected=${s.priority === ''}>Priority</option>
                ${PRIORITIES.map(
                  (p) =>
                    html`<option value=${String(p)} ?selected=${s.priority === String(p)}>
                      ${p}
                    </option>`
                )}
              </select>
              <button
                type="button"
                class="btn btn-outline-primary"
                ?disabled=${blocked || s.priority === ''}
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
      const interval = parseInterval(s.interval, info.minIntervalMs)
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

  private restoreControls() {
    const confirming = this.confirming
    if (confirming !== null) {
      return html`<div class="bg-warning-subtle border border-warning-subtle rounded p-3">
        <p class="mb-2">
          This puts back ${RESTORES[confirming].what}. The sensor restarts to apply this, and keeps
          its other settings.
        </p>
        <button
          type="button"
          class="btn btn-sm btn-warning me-2"
          ?disabled=${this.disabled || this.restoring}
          @click=${() => this.restore(confirming)}
        >
          ${this.restoring ? 'Restoring…' : 'Restore and restart'}
        </button>
        <button
          type="button"
          class="btn btn-sm btn-link"
          ?disabled=${this.restoring}
          @click=${() => {
            this.confirming = null
          }}
        >
          Cancel
        </button>
      </div>`
    }
    return html`<div class="d-flex flex-wrap align-items-center gap-2">
      ${(Object.keys(RESTORES) as Restore[]).map(
        (option) =>
          html`<button
            type="button"
            class="btn btn-sm btn-outline-secondary"
            ?disabled=${this.disabled}
            @click=${() => {
              this.confirming = option
              this.restored = null
            }}
          >
            ${RESTORES[option].label}
          </button>`
      )}
      ${
        this.restored === null
          ? nothing
          : html`<span class="small text-${this.restored.tone}-emphasis" role="status"
              >${this.restored.text}</span
            >`
      }
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
      return nothing
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
          How often the sensor sends each message, and at what priority (0 is the highest). The
          sensor does not report its current intervals or priorities, so each shows only what was
          set here.
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
