import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type { DeviceKey } from '../../types.js'
import { formatHz, type CurvePoint, type CurveRow } from '../curve.js'
import { curveToCsv, parseCurveCsv } from '../curve-csv.js'
import { download } from '../download.js'
import { localDay, sameKey } from '../format.js'
import { LightElement } from '../light-element.js'
import { CURVE_SPEED_RESOLUTION } from '../../protocol/pids.js'
import type { DisplayUnit } from '../units.js'
import type { RowsChange } from './curve-editor.js'

/** Digits beyond the table's that a converted speed keeps when the table's would store another value. */
const CONVERTED_EXTRA_DECIMALS = 4

/** The sensor's own step for a speed, where two values store the same or not. */
const stepOf = (si: number): number => Math.round(si / CURVE_SPEED_RESOLUTION)

/**
 * A file's speed as the table shows it. The table's decimals are kept where
 * they store the same value as the file's; otherwise the file's own digits
 * stay, or, from another unit, enough more that only the sensor rounds.
 */
function speedText(written: string, si: number, sameUnit: boolean, shown: DisplayUnit): string {
  const rounded = shown.format(si)
  const parsed = shown.parse(rounded)
  if (parsed !== null && stepOf(parsed) === stepOf(si)) {
    return rounded
  }
  return sameUnit ? written : shown.toShown(si).toFixed(shown.decimals + CONVERTED_EXTRA_DECIMALS)
}

/**
 * Export the curve table to CSV and import one into it.
 *
 * An import fires `rows-change`, as an edit in the table does, so the row
 * treats it as an unsaved edit: its checks and Save apply unchanged.
 */
@customElement('dst-curve-csv')
export class CurveCsv extends LightElement {
  /** The table's points, or null while it has problems. */
  @property({ attribute: false }) points: CurvePoint[] | null = null
  /** The table differs from what the sensor holds. */
  @property({ type: Boolean }) dirty = false
  /** What the sensor holds, as the table shows it. */
  @property({ attribute: false }) stored: CurveRow[] | null = null
  @property({ attribute: false }) speed: DisplayUnit | null = null
  /** The speed unit a file names, or null when the server knows no such unit. */
  @property({ attribute: false }) resolveUnit: (name: string) => DisplayUnit | null = () => null
  @property({ attribute: false }) device: DeviceKey | null = null
  @property({ type: Boolean }) disabled = false

  @state() private note: { tone: string; text: string } | null = null

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    const device = changed.get('device') as DeviceKey | null | undefined
    const wasDirty = changed.get('dirty') as boolean | undefined
    // The note describes an edit; once it is saved, cancelled or belongs to
    // another sensor, it describes nothing on screen.
    if ((device !== undefined && !sameKey(device, this.device)) || (wasDirty && !this.dirty)) {
      this.note = null
    }
  }

  private exportCsv(): void {
    if (this.points === null || this.speed === null) {
      return
    }
    const unique = this.device === null ? 'sensor' : String(this.device.uniqueNumber)
    const name = `dst-${unique}-curve-${localDay(new Date())}.csv`
    download(name, curveToCsv(this.points, this.speed), 'text/csv')
    this.note = this.dirty
      ? {
          tone: 'warning',
          text: `Exported ${name}: the edited curve, not saved to the sensor yet.`
        }
      : { tone: 'success', text: `Exported ${name}.` }
  }

  private async importCsv(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    const shown = this.speed
    if (file === undefined || shown === null) {
      return
    }
    const parsed = parseCurveCsv(await file.text())
    if (!parsed.ok) {
      this.note = { tone: 'danger', text: `${file.name} was not imported: ${parsed.reason}.` }
      return
    }
    const unit = this.resolveUnit(parsed.unit)
    if (unit === null) {
      this.note = {
        tone: 'danger',
        text: `${file.name} was not imported: ${parsed.unit} is not a speed unit the server knows.`
      }
      return
    }
    const sameUnit = unit.symbol === shown.symbol
    const rows = parsed.rows.map(([hz, speed]): CurveRow => {
      const frequency = hz === '' ? NaN : Number(hz)
      const si = unit.parse(speed)
      const text = si === null ? speed : speedText(speed, si, sameUnit, shown)
      return [Number.isFinite(frequency) ? formatHz(frequency) : hz, text]
    })
    this.dispatchEvent(
      new CustomEvent('rows-change', { detail: { rows }, bubbles: true }) satisfies RowsChange
    )
    this.note =
      JSON.stringify(rows) === JSON.stringify(this.stored)
        ? { tone: 'secondary', text: `${file.name} matches the curve the sensor holds.` }
        : {
            tone: 'secondary',
            text: `Imported ${file.name}. Check the points, then Save to write them to the sensor.`
          }
  }

  override render() {
    return html`
      <div class="d-flex flex-wrap align-items-center gap-2 mt-2">
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          ?disabled=${this.points === null || this.points.length === 0}
          @click=${() => {
            this.exportCsv()
          }}
        >
          Export CSV
        </button>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          ?disabled=${this.disabled}
          @click=${() => {
            this.querySelector<HTMLInputElement>('input[type="file"]')?.click()
          }}
        >
          Import CSV…
        </button>
        <input
          type="file"
          accept=".csv,text/csv"
          hidden
          ?disabled=${this.disabled}
          @change=${(event: Event) => this.importCsv(event)}
        />
        ${
          this.note === null
            ? nothing
            : html`<span class=${`small text-${this.note.tone}-emphasis`} role="status"
                >${this.note.text}</span
              >`
        }
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-curve-csv': CurveCsv
  }
}
