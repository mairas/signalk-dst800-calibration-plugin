import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type {
  DeviceKey,
  DeviceResponse,
  PgnListResult,
  ResetResult,
  ReadResult,
  SettingEvent,
  SettingInfo,
  SettingsResponse,
  WriteResult
} from '../../types.js'
import { ApiError, describeFailure, request } from '../api.js'
import { sameCurve } from '../curve.js'
import { sameKey } from '../format.js'
import { LightElement } from '../light-element.js'
import {
  describeRestart,
  isPgnRestore,
  routeOf,
  type RestartAction,
  type RestartRequest,
  type RestartResult,
  type Restarted
} from '../restart.js'
import {
  SECTIONS,
  type CustomSection,
  TEMPERATURE_SOURCES,
  VIEWS,
  age,
  outcomeOf,
  slotKey,
  unitOf,
  storedValueOf,
  type Outcome
} from '../settings.js'
import { SI, type DisplayUnit, type Units } from '../units.js'
import { EMPTY_ROW, type RowState, type WriteRequest } from './setting-row.js'
import './setting-row.js'
import './pgn-table.js'
import './snapshot-panel.js'
import './danger-zone.js'

/** How often the read age moves on screen. */
const TICK_MS = 5000

/** Read with the rest, shown in the header rather than as a row. */
const PRODUCT = 'productInformation'

/** The first status that says the server failed rather than refused. */
const SERVER_ERROR = 500

/** The plugin's answer when the sensor is not on the bus, before anything is sent. */
const SERVICE_UNAVAILABLE = 503

/** The section that holds the transmitted PGNs, below its settings. */
const PGN_SECTION = 'network'

/** Its setting that decides whether the intervals set per PGN apply. */
const OVERRIDE = 'transmissionIntervalOverride'

interface Slot {
  id: string
  qualifier: number | null
}

const pathOf = ({ id, qualifier }: Slot): string =>
  `/settings/${id}${qualifier === null ? '' : `?qualifier=${String(qualifier)}`}`

const slotsOf = (info: SettingInfo): Slot[] =>
  (info.qualifiers?.map((q) => q.value) ?? [null]).map((qualifier) => ({ id: info.id, qualifier }))

const isLoginRefusal = (cause: unknown): boolean =>
  cause instanceof ApiError && (cause.status === 401 || cause.status === 403)

/**
 * The selected sensor's settings, one card per section.
 *
 * Reads every offered, readable setting once the sensor is present and
 * probed, one at a time, and again after each probe. A capability the probe
 * rejected has no row; one it got no answer for offers Check again, which
 * fires `probe`. The product information read with the rest fires `product`.
 */
@customElement('dst-settings')
export class SettingsPanel extends LightElement {
  @property({ attribute: false }) device: DeviceResponse | null = null
  @property({ attribute: false }) units: Units = SI

  @state() private infos: SettingInfo[] | null = null
  @state() private rows = new Map<string, RowState>()
  @state() private loadError: string | null = null
  /** The server wants an admin login for reads; asking again would only be refused again. */
  @state() private readDenied = false
  @state() private now = Date.now()
  /** When the last full read finished. */
  @state() private readAt: number | null = null
  @state() private reading = false
  @state() private pgns: PgnListResult | null = null
  @state() private pgnsError: string | null = null
  /**
   * An action that restarts the sensor. The sections that offer them vanish
   * while the sensor is away, so the panel keeps how it went.
   */
  @state() private restarting: RestartAction | null = null
  @state() private restarted: Restarted | null = null
  /** The restart request in flight; a selection change forgets it. */
  private restartToken: object | null = null

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
      this.readAt = null
      this.probeSeen = null
      this.pgns = null
      this.pgnsError = null
      this.restarting = null
      this.restartToken = null
      this.restarted = null
    }
  }

  /** Requests start after the render, so the state they change is the next update's. */
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    if (!changed.has('device')) {
      return
    }
    const probe = JSON.stringify(this.device?.probe ?? null)
    if ((this.device?.probe ?? null) === null) {
      // The plugin dropped its probe, as a restart does: what was read under
      // it is no longer known to be current, so the next probe reads afresh.
      this.readFor = null
    }
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
      .filter(
        (info) =>
          info.available === 'yes' &&
          info.readable &&
          (VIEWS[info.id] !== undefined || info.id === PRODUCT)
      )
      .flatMap(slotsOf)
  }

  /** Read every offered setting, one at a time: once per sensor and probe, or on request. */
  private async readAll(force = false): Promise<void> {
    const key = this.selected
    const probe = this.device?.probe ?? null
    if (key === null || probe === null || !this.present || this.infos === null || this.readDenied) {
      return
    }
    const target = JSON.stringify([key, probe, force ? Date.now() : 0])
    if (!force && target === this.readFor) {
      return
    }
    this.readFor = target
    this.reading = true
    try {
      for (const slot of this.readable()) {
        if (this.superseded(target, key)) {
          return
        }
        await this.read(slot)
      }
      if (this.superseded(target, key)) {
        return
      }
      await this.loadPgns(target, key)
      this.readAt = Date.now()
    } finally {
      if (this.readFor === target) {
        this.reading = false
      }
    }
  }

  /** Whether a read pass should stop: each read awaits, and the console can move on meanwhile. */
  private superseded(target: string, key: DeviceKey): boolean {
    return this.readFor !== target || this.readDenied || !sameKey(this.selected, key)
  }

  /** What the sensor transmits: its PGN 126464 list, which needs a request on the bus. */
  private async loadPgns(target: string, key: DeviceKey): Promise<void> {
    let list: PgnListResult | null = null
    let failure: string | null = null
    try {
      list = await request<PgnListResult>('GET', '/pgns')
    } catch (cause) {
      failure = describeFailure(cause)
    }
    if (this.superseded(target, key)) {
      return
    }
    this.pgns = list
    this.pgnsError = failure
  }

  /** One restart at a time: a second would reach a sensor that is already rebooting. */
  private async restart(event: RestartRequest): Promise<void> {
    if (this.restarting !== null) {
      return
    }
    const { action } = event.detail
    const { path, body } = routeOf(action)
    const token = {}
    this.restartToken = token
    this.restarting = action
    this.restarted = null
    let result: RestartResult
    try {
      result = await request<ResetResult>('POST', path, body)
    } catch (cause) {
      // The plugin refuses before sending with a 4xx, or a 503 when the sensor
      // is not on the bus. Anything else, a lost connection included, may come
      // after the frame went out.
      const refused =
        cause instanceof ApiError &&
        (cause.status < SERVER_ERROR || cause.status === SERVICE_UNAVAILABLE)
      result = refused
        ? { status: 'notSent', reason: describeFailure(cause) }
        : { status: 'unanswered', reason: describeFailure(cause) }
    }
    if (this.restartToken === token) {
      this.restartToken = null
      this.restarting = null
      this.restarted = { action, result }
    }
  }

  /** The restart in flight or its outcome, for while the sections are gone with the probe. */
  private restartLine() {
    if (this.restarting !== null) {
      return html`<p class="text-body-secondary" role="status">
        <span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
        The sensor is restarting…
      </p>`
    }
    if (this.restarted === null) {
      return nothing
    }
    const { tone, text } = describeRestart(this.restarted)
    return html`<p class=${`text-${tone}-emphasis`} role="status">${text}</p>`
  }

  private change(slot: Slot, edit: (row: RowState) => RowState): void {
    const key = slotKey(slot)
    const rows = new Map(this.rows)
    rows.set(key, edit(rows.get(key) ?? EMPTY_ROW))
    this.rows = rows
  }

  private settle(slot: Slot, outcome: Outcome | null, result: ReadResult | WriteResult): void {
    const stored = storedValueOf(result)
    this.change(slot, (row) => ({
      stored: stored ?? row.stored,
      outcome,
      busy: null
    }))
    if (slot.id === PRODUCT && stored !== null) {
      this.dispatchEvent(new CustomEvent('product', { detail: stored.value, bubbles: true }))
    }
  }

  private async read(slot: Slot): Promise<ReadResult> {
    this.change(slot, (row) => ({ ...row, busy: 'read' }))
    let result: ReadResult
    try {
      result = await request<ReadResult>('GET', pathOf(slot))
    } catch (cause) {
      this.readDenied ||= isLoginRefusal(cause)
      result = { status: 'invalid', reason: describeFailure(cause) }
    }
    this.settle(slot, outcomeOf('read', result), result)
    return result
  }

  private async write(slot: Slot, value: unknown): Promise<void> {
    this.change(slot, (row) => ({ ...row, busy: 'write' }))
    const body = slot.qualifier === null ? { value } : { value, qualifier: slot.qualifier }
    let result: WriteResult
    try {
      result = await request<WriteResult>('PUT', `/settings/${slot.id}`, body)
    } catch (cause) {
      result = { status: 'invalid', reason: describeFailure(cause) }
    }
    if (result.status !== 'unknown') {
      this.settle(slot, outcomeOf('write', result), result)
      return
    }
    // Silence says nothing about whether the value arrived; the sensor's
    // current value does.
    this.change(slot, (row) => ({ ...row, outcome: { kind: 'checking' } }))
    const readBack = await this.read(slot)
    const stored = storedValueOf(readBack)
    const unit = this.unitOf(slot.id)
    const same = stored !== null && this.sameAsShown(slot.id, value, stored.value, unit)
    this.change(slot, (row) => ({
      ...row,
      outcome: same ? { kind: 'holdsRequested' } : { kind: 'noAnswer', operation: 'write' }
    }))
  }

  /** Whether two values read the same to the user, which is as close as the sensor stores them. */
  private sameAsShown(id: string, a: unknown, b: unknown, unit: DisplayUnit | null): boolean {
    if (unit !== null && VIEWS[id]?.editor.kind === 'curve') {
      return sameCurve(a, b, unit)
    }
    return typeof a === 'number' && typeof b === 'number' && unit !== null
      ? unit.format(a) === unit.format(b)
      : JSON.stringify(a) === JSON.stringify(b)
  }

  /** A read or write that reached the sensor, from this console or another. */
  apply(event: SettingEvent): void {
    const slot = { id: event.id, qualifier: event.qualifier }
    // A request of this console's own settles its row when its answer arrives.
    if ((this.rows.get(slotKey(slot))?.busy ?? null) === null) {
      this.settle(slot, outcomeOf(event.operation, event.result), event.result)
    }
  }

  /** The sensor was reset or restored: nothing read from it before still holds. */
  forget(): void {
    this.rows = new Map()
    this.pgns = null
    this.readFor = null
    this.readAt = null
  }

  private unitOf(id: string): DisplayUnit | null {
    return unitOf(this.units, id)
  }

  private placeholder(info: SettingInfo, label: string) {
    return html`
      <div class="list-group-item" data-slot=${`${info.id}:`}>
        <div class="row g-2 align-items-center">
          <div class="col-md-5 fw-semibold">${label}</div>
          <div class="col-md-7">
            <span class="text-body-secondary me-2"
              >The sensor didn’t answer when checked for this.</span
            >
            <button
              type="button"
              class="btn btn-sm btn-outline-secondary"
              ?disabled=${!this.present}
              @click=${() => this.dispatchEvent(new CustomEvent('probe', { bubbles: true }))}
            >
              Check again
            </button>
          </div>
        </div>
      </div>
    `
  }

  private row(info: SettingInfo, slot: Slot, label: string, help: string) {
    const view = VIEWS[info.id]
    if (view === undefined) {
      return nothing
    }
    return html`<dst-setting-row
      class="list-group-item d-block"
      data-slot=${slotKey(slot)}
      .settingId=${info.id}
      .label=${label}
      .help=${help}
      .editor=${view.editor}
      .unit=${this.unitOf(info.id)}
      .units=${this.units}
      .device=${this.selected}
      .readable=${info.readable}
      .level1=${info.requiresLevel1}
      .row=${this.rows.get(slotKey(slot)) ?? EMPTY_ROW}
      .disabled=${!this.present}
      @read=${() => this.read(slot)}
      @write=${(event: WriteRequest) => this.write(slot, event.detail.value)}
    ></dst-setting-row>`
  }

  private rowsOf(info: SettingInfo) {
    const view = VIEWS[info.id]
    if (view === undefined || info.available === 'no') {
      return nothing
    }
    if (info.available === 'unknown') {
      return this.placeholder(info, view.label)
    }
    if (info.id === 'temperatureOffset') {
      const offered = new Set(info.qualifiers?.map((q) => q.value) ?? [])
      return TEMPERATURE_SOURCES.filter((source) => offered.has(source.qualifier)).map((source) =>
        this.row(info, { id: info.id, qualifier: source.qualifier }, source.label, source.help)
      )
    }
    return this.row(info, { id: info.id, qualifier: null }, view.label, view.help ?? '')
  }

  private custom(id: string, title: string, kind: CustomSection) {
    return html`
      <section
        id=${id}
        class=${`card mb-3 ${kind === 'danger' ? 'border-danger-subtle' : ''}`}
        aria-labelledby=${`${id}-title`}
      >
        <h2 id=${`${id}-title`} class="card-header h6 mb-0">${title}</h2>
        ${
          kind === 'snapshots'
            ? html`<dst-snapshots
                .selected=${this.selected}
                .units=${this.units}
                .disabled=${!this.present}
              ></dst-snapshots>`
            : html`<dst-danger-zone
                .selected=${this.selected}
                .disabled=${!this.present}
                .restarting=${this.restarting}
                .restarted=${this.restarted}
                @restart=${(event: RestartRequest) => this.restart(event)}
              ></dst-danger-zone>`
        }
      </section>
    `
  }

  private section(id: string, title: string, settings: readonly string[]) {
    const infos = (this.infos ?? []).filter(
      (info) => settings.includes(info.id) && info.available !== 'no'
    )
    const pgns =
      id === PGN_SECTION &&
      (this.pgns !== null ||
        this.pgnsError !== null ||
        isPgnRestore(this.restarting ?? undefined) ||
        isPgnRestore(this.restarted?.action))
    if (infos.length === 0 && !pgns) {
      return nothing
    }
    const override = this.rows.get(`${OVERRIDE}:`)?.stored?.value
    return html`
      <section id=${id} class="card mb-3" aria-labelledby=${`${id}-title`}>
        <h2 id=${`${id}-title`} class="card-header h6 mb-0">${title}</h2>
        <div class="list-group list-group-flush">
          ${infos.map((info) => this.rowsOf(info))}
          ${
            pgns
              ? html`<dst-pgns
                  .list=${this.pgns}
                  .listError=${this.pgnsError}
                  .override=${typeof override === 'boolean' ? override : null}
                  .disabled=${!this.present}
                  .restarting=${this.restarting}
                  .restarted=${this.restarted}
                  @restart=${(event: RestartRequest) => this.restart(event)}
                ></dst-pgns>`
              : nothing
          }
        </div>
      </section>
    `
  }

  private readLine() {
    if (this.readDenied) {
      return html`<p class="text-warning-emphasis">
        Reading values from the sensor needs an admin login to the Signal K server.
      </p>`
    }
    if (this.reading && this.readAt === null) {
      return html`<p class="text-body-secondary">
        <span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
        Reading settings from the sensor…
      </p>`
    }
    if (this.readAt === null) {
      return nothing
    }
    return html`<p class="text-body-secondary text-end small mb-2">
      Read from the sensor ${age(this.readAt, this.now)} ·
      <button
        type="button"
        class="btn btn-link btn-sm p-0 align-baseline"
        ?disabled=${this.reading || !this.present}
        @click=${() => this.readAll(true)}
      >
        ${this.reading ? 'Reading…' : 'Read again'}
      </button>
    </p>`
  }

  override render() {
    if (this.selected === null) {
      return nothing
    }
    if ((this.device?.probe ?? null) === null) {
      // A restart drops the probe, and with it every section; its outcome stays here.
      return html`
        ${this.restartLine()}
        <p class="text-body-secondary">
          <span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
          Checking what the sensor supports…
        </p>
      `
    }
    if (this.loadError !== null) {
      return html`<div class="alert alert-danger">Cannot list the settings: ${this.loadError}</div>`
    }
    if (this.infos === null) {
      return html`<p class="text-body-secondary">Loading settings…</p>`
    }
    return html`
      ${this.readLine()}
      ${SECTIONS.map((section) =>
        section.custom === undefined
          ? this.section(section.id, section.title, section.settings)
          : this.custom(section.id, section.title, section.custom)
      )}
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-settings': SettingsPanel
  }
}
