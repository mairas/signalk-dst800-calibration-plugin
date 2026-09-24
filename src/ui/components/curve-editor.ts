import { html, nothing, svg } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { MAX_CURVE_POINTS, type CurveRow } from '../curve.js'
import { LightElement } from '../light-element.js'

/** Sent with the rows as the user left them. */
export type RowsChange = CustomEvent<{ rows: CurveRow[] }>

const WIDTH = 320
const HEIGHT = 200
const MARGIN = { left: 40, right: 12, top: 10, bottom: 30 }
const PLOT_W = WIDTH - MARGIN.left - MARGIN.right
const PLOT_H = HEIGHT - MARGIN.top - MARGIN.bottom
/** At most this many gridlines per axis. */
const MAX_TICKS = 5

/** Round steps of 1, 2 or 5 times a power of ten that cover `max` in at most MAX_TICKS. */
function ticks(max: number): number[] {
  const span = max > 0 ? max : 1
  const magnitude = 10 ** Math.floor(Math.log10(span / MAX_TICKS))
  const step =
    [1, 2, 5, 10].map((m) => m * magnitude).find((s) => span / s <= MAX_TICKS) ?? 10 * magnitude
  return Array.from({ length: Math.ceil(span / step) + 1 }, (_, i) => i * step)
}

/** The rows that hold two numbers, as plot coordinates in the typed units. */
const plotted = (rows: readonly CurveRow[]): [number, number][] =>
  rows
    .map(([hz, speed]) => [Number(hz), Number(speed)] as [number, number])
    .filter(
      ([hz, speed], i) =>
        rows[i][0].trim() !== '' &&
        rows[i][1].trim() !== '' &&
        Number.isFinite(hz) &&
        Number.isFinite(speed)
    )

/**
 * The speed calibration curve as a table of points beside a plot of them.
 *
 * Presentational: the row that holds it owns the draft, and this fires
 * `rows-change` with each edit, addition or removal.
 */
@customElement('dst-curve-editor')
export class CurveEditor extends LightElement {
  @property({ attribute: false }) rows: readonly CurveRow[] = []
  /** What the sensor holds, drawn behind the edited curve when they differ. */
  @property({ attribute: false }) stored: readonly CurveRow[] | null = null
  @property() speedSymbol = ''
  /** `index:field` of each input to mark invalid. */
  @property({ attribute: false }) invalid: ReadonlySet<string> = new Set()
  @property({ type: Boolean }) disabled = false
  @property({ type: Boolean }) readonly = false

  private emit(rows: CurveRow[]): void {
    this.dispatchEvent(new CustomEvent('rows-change', { detail: { rows }, bubbles: true }))
  }

  private edit(index: number, field: 0 | 1, text: string): void {
    this.emit(
      this.rows.map((row, i) =>
        i !== index ? row : field === 0 ? ([text, row[1]] as const) : ([row[0], text] as const)
      )
    )
  }

  private table() {
    const cell = (index: number, field: 0 | 1, label: string) =>
      html`<input
        type="text"
        inputmode="decimal"
        aria-label=${`Point ${String(index + 1)} ${label}`}
        class=${`form-control form-control-sm ${this.invalid.has(`${String(index)}:${field === 0 ? 'hz' : 'speed'}`) ? 'is-invalid' : ''}`}
        .value=${this.rows[index][field]}
        ?readonly=${this.readonly}
        ?disabled=${this.disabled}
        @input=${(event: Event) => {
          this.edit(index, field, (event.target as HTMLInputElement).value)
        }}
      />`
    const full = this.rows.length >= MAX_CURVE_POINTS
    return html`
      <table class="table table-sm align-middle mb-2">
        <thead>
          <tr>
            <th scope="col" class="text-body-secondary fw-normal">#</th>
            <th scope="col">Frequency (Hz)</th>
            <th scope="col">Speed (${this.speedSymbol})</th>
            <th scope="col"><span class="visually-hidden">Remove</span></th>
          </tr>
        </thead>
        <tbody>
          ${this.rows.map(
            (_, index) =>
              html`<tr>
                <td class="text-body-secondary">${index + 1}</td>
                <td>${cell(index, 0, 'frequency')}</td>
                <td>${cell(index, 1, 'speed')}</td>
                <td class="text-end">
                  <button
                    type="button"
                    class="btn btn-sm btn-link text-body-secondary text-decoration-none"
                    aria-label=${`Remove point ${String(index + 1)}`}
                    ?disabled=${this.disabled || this.readonly}
                    @click=${() => {
                      this.emit(this.rows.filter((__, i) => i !== index))
                    }}
                  >
                    ✕
                  </button>
                </td>
              </tr>`
          )}
        </tbody>
      </table>
      <div class="d-flex align-items-center gap-2">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          ?disabled=${this.disabled || this.readonly || full}
          @click=${() => {
            this.emit([...this.rows, ['', '']])
          }}
        >
          Add point
        </button>
        ${
          full
            ? html`<span class="small text-body-secondary"
                >The sensor holds at most ${MAX_CURVE_POINTS} points.</span
              >`
            : nothing
        }
      </div>
    `
  }

  private plot() {
    const edited = plotted(this.rows)
    const behind =
      this.stored !== null && JSON.stringify(this.stored) !== JSON.stringify(this.rows)
        ? plotted(this.stored)
        : []
    const all = [...edited, ...behind]
    const xTicks = ticks(Math.max(0, ...all.map(([hz]) => hz)))
    const yTicks = ticks(Math.max(0, ...all.map(([, speed]) => speed)))
    const xMax = xTicks[xTicks.length - 1]
    const yMax = yTicks[yTicks.length - 1]
    const x = (hz: number) => MARGIN.left + (hz / xMax) * PLOT_W
    const y = (speed: number) => MARGIN.top + PLOT_H - (speed / yMax) * PLOT_H
    const line = (points: [number, number][]) =>
      points.map(([hz, speed]) => `${x(hz).toFixed(1)},${y(speed).toFixed(1)}`).join(' ')
    return html`<svg
      class="dst-curve-plot w-100"
      viewBox=${`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      role="img"
      aria-label=${`Speed against paddlewheel frequency, ${String(edited.length)} points`}
    >
      ${xTicks.map(
        (t) => svg`
          <line class="dst-curve-grid" x1=${x(t)} x2=${x(t)} y1=${MARGIN.top} y2=${MARGIN.top + PLOT_H} />
          <text class="dst-curve-label" x=${x(t)} y=${HEIGHT - 16} text-anchor="middle">${t}</text>`
      )}
      ${yTicks.map(
        (t) => svg`
          <line class="dst-curve-grid" x1=${MARGIN.left} x2=${MARGIN.left + PLOT_W} y1=${y(t)} y2=${y(t)} />
          <text class="dst-curve-label" x=${MARGIN.left - 6} y=${y(t) + 4} text-anchor="end">${t}</text>`
      )}
      <text
        class="dst-curve-label"
        x=${MARGIN.left + PLOT_W / 2}
        y=${HEIGHT - 2}
        text-anchor="middle"
      >
        Hz
      </text>
      <text class="dst-curve-label" x=${4} y=${MARGIN.top + 8}>${this.speedSymbol}</text>
      ${
        behind.length === 0
          ? nothing
          : svg`<polyline class="dst-curve-stored" points=${line(behind)} />`
      }
      <polyline class="dst-curve-line" points=${line(edited)} />
      ${edited.map(
        ([hz, speed]) => svg`<circle class="dst-curve-point" cx=${x(hz)} cy=${y(speed)} r="3" />`
      )}
    </svg>`
  }

  override render() {
    return html`<div class="row g-3">
      <div class="col-lg-6">${this.table()}</div>
      <div class="col-lg-6">${this.plot()}</div>
    </div>`
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-curve-editor': CurveEditor
  }
}
