import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type {
  DeviceKey,
  DeviceResponse,
  ReadResult,
  SettingEvent,
  SettingInfo,
  SettingsResponse,
  WriteResult
} from '../../types.js'
import { ApiError, describeFailure, request } from '../api.js'
import { sameKey } from '../format.js'
import { LightElement } from '../light-element.js'
import { VIEWS, storedValueOf } from '../settings.js'
import { EMPTY_ROW, type RowState, type WriteRequest } from './setting-row.js'
import './setting-row.js'

/** How often ages move on screen. */
const TICK_MS = 5000

interface Slot {
  id: string
  qualifier: number | null
}

const slotKey = ({ id, qualifier }: Slot): string =>
  `${id}:${qualifier === null ? '' : String(qualifier)}`

const pathOf = ({ id, qualifier }: Slot): string =>
  `/settings/${id}${qualifier === null ? '' : `?qualifier=${String(qualifier)}`}`

const slotsOf = (info: SettingInfo): Slot[] =>
  (info.qualifiers?.map((q) => q.value) ?? [null]).map((qualifier) => ({ id: info.id, qualifier }))

const isLoginRefusal = (cause: unknown): boolean =>
  cause instanceof ApiError && (cause.status === 401 || cause.status === 403)

/**
 * The selected sensor's settings, one row per setting and qualifier.
 *
 * Reads every offered, readable setting once the sensor is present and
 * probed, one at a time, and again after each probe. A capability the probe
 * rejected has no row; one it got no answer for gets a placeholder that
 * offers another probe. Fires `probe` for that.
 */
@customElement('dst-settings')
export class SettingsPanel extends LightElement {
  @property({ attribute: false }) device: DeviceResponse | null = null

  @state() private infos: SettingInfo[] | null = null
  @state() private rows = new Map<string, RowState>()
  @state() private loadError: string | null = null
  /** The server wants an admin login for reads; asking again would only be refused again. */
  @state() private readDenied = false
  @state() private now = Date.now()

  private ticker: ReturnType<typeof setInterval> | null = null
  private probeSeen: string | null = null
  private readFor: string | null = null

  override connectedCallback(): void {
    super.connectedCallback()
    this.ticker = setInterval(() => {
      this.now = Date.now()
    }, TICK_MS)
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    if (this.ticker !== null) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  private get selected(): DeviceKey | null {
    return this.device?.selected ?? null
  }

  private get present(): boolean {
    return this.device?.location?.state === 'present'
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (!changed.has('device')) {
      return
    }
    const previous = changed.get('device') as DeviceResponse | null | undefined
    if (!sameKey(previous?.selected ?? null, this.selected)) {
      this.rows = new Map()
      this.readDenied = false
      this.readFor = null
      this.probeSeen = null
    }
  }

  /** Requests start after the render, so the state they change is the next update's. */
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (!changed.has('device')) {
      return
    }
    const probe = JSON.stringify(this.device?.probe ?? null)
    if (probe !== this.probeSeen) {
      this.probeSeen = probe
      void this.loadList()
    } else {
      void this.readAll()
    }
  }

  /** The settings list carries what the last probe found, so it is fetched again after each. */
  private async loadList(): Promise<void> {
    try {
      this.infos = (await request<SettingsResponse>('GET', '/settings')).settings
      this.loadError = null
    } catch (cause) {
      this.loadError = describeFailure(cause)
      return
    }
    await this.readAll()
  }

  /** The slots to read: offered, readable, and shown by this console. */
  private readable(): Slot[] {
    return (this.infos ?? [])
      .filter((info) => info.available === 'yes' && info.readable && VIEWS[info.id] !== undefined)
      .flatMap(slotsOf)
  }

  /** Read every offered setting once per sensor and probe, one at a time. */
  private async readAll(): Promise<void> {
    const key = this.selected
    const probe = this.device?.probe ?? null
    if (key === null || probe === null || !this.present || this.infos === null || this.readDenied) {
      return
    }
    const target = JSON.stringify([key, probe])
    if (target === this.readFor) {
      return
    }
    this.readFor = target
    for (const slot of this.readable()) {
      if (this.superseded(target, key)) {
        return
      }
      await this.read(slot)
    }
  }

  /** Whether a read pass should stop: each read awaits, and the console can move on meanwhile. */
  private superseded(target: string, key: DeviceKey): boolean {
    return this.readFor !== target || this.readDenied || !sameKey(this.selected, key)
  }

  private change(slot: Slot, edit: (row: RowState) => RowState): void {
    const key = slotKey(slot)
    const rows = new Map(this.rows)
    rows.set(key, edit(rows.get(key) ?? EMPTY_ROW))
    this.rows = rows
  }

  private settle(slot: Slot, operation: 'read' | 'write', result: ReadResult | WriteResult): void {
    this.change(slot, (row) => ({
      stored: storedValueOf(result) ?? row.stored,
      last: { operation, result },
      busy: null
    }))
  }

  private async read(slot: Slot): Promise<void> {
    this.change(slot, (row) => ({ ...row, busy: 'read' }))
    try {
      this.settle(slot, 'read', await request<ReadResult>('GET', pathOf(slot)))
    } catch (cause) {
      this.readDenied ||= isLoginRefusal(cause)
      this.settle(slot, 'read', { status: 'invalid', reason: describeFailure(cause) })
    }
  }

  private async write(slot: Slot, value: unknown): Promise<void> {
    this.change(slot, (row) => ({ ...row, busy: 'write' }))
    const body = slot.qualifier === null ? { value } : { value, qualifier: slot.qualifier }
    try {
      this.settle(slot, 'write', await request<WriteResult>('PUT', `/settings/${slot.id}`, body))
    } catch (cause) {
      this.settle(slot, 'write', { status: 'invalid', reason: describeFailure(cause) })
    }
  }

  /** A read or write that reached the sensor, from this console or another. */
  apply(event: SettingEvent): void {
    const slot = { id: event.id, qualifier: event.qualifier }
    // A request of this console's own settles its row when its answer arrives.
    if ((this.rows.get(slotKey(slot))?.busy ?? null) === null) {
      this.settle(slot, event.operation, event.result)
    }
  }

  /** The sensor was reset or restored: nothing read from it before still holds. */
  forget(): void {
    this.rows = new Map()
    this.readFor = null
  }

  private placeholder(info: SettingInfo, label: string) {
    return html`
      <div class="list-group-item" data-slot=${`${info.id}:`}>
        <span class="fw-semibold">${label}</span>
        <span class="text-body-secondary">
          The sensor did not answer when probed for this, so it may still support it.
        </span>
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary ms-2"
          ?disabled=${!this.present}
          @click=${() => this.dispatchEvent(new CustomEvent('probe', { bubbles: true }))}
        >
          Probe again
        </button>
      </div>
    `
  }

  private rowsOf(info: SettingInfo) {
    const view = VIEWS[info.id]
    if (view === undefined || info.available === 'no') {
      return nothing
    }
    if (info.available === 'unknown') {
      return this.placeholder(info, view.label)
    }
    return slotsOf(info).map((slot) => {
      const qualifier = info.qualifiers?.find((q) => q.value === slot.qualifier)
      const label =
        qualifier === undefined ? view.label : `${view.label}, ${qualifier.label.toLowerCase()}`
      return html`<dst-setting-row
        class="list-group-item d-block"
        data-slot=${slotKey(slot)}
        .settingId=${info.id}
        .label=${label}
        .view=${view}
        .readable=${info.readable}
        .row=${this.rows.get(slotKey(slot)) ?? EMPTY_ROW}
        .disabled=${!this.present}
        .now=${this.now}
        @read=${() => this.read(slot)}
        @write=${(event: WriteRequest) => this.write(slot, event.detail.value)}
      ></dst-setting-row>`
    })
  }

  override render() {
    if (this.selected === null) {
      return nothing
    }
    if ((this.device?.probe ?? null) === null) {
      return html`<p class="text-body-secondary">Probe the sensor to see its settings.</p>`
    }
    if (this.loadError !== null) {
      return html`<div class="alert alert-danger">Cannot list the settings: ${this.loadError}</div>`
    }
    if (this.infos === null) {
      return html`<p>Loading settings…</p>`
    }
    return html`
      <h2 class="h5">Settings</h2>
      ${
        this.present
          ? nothing
          : html`<p class="text-warning-emphasis">
              The sensor is not on the bus. The values below are from its last read.
            </p>`
      }
      ${
        this.readDenied
          ? html`<p class="text-warning-emphasis">
              Reading values from the sensor needs an admin login to the Signal K server.
            </p>`
          : nothing
      }
      <div class="list-group">${this.infos.map((info) => this.rowsOf(info))}</div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-settings': SettingsPanel
  }
}
