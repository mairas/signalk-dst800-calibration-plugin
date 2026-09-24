import { html, nothing } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import type {
  Candidate,
  DeviceKey,
  DeviceResponse,
  DevicesResponse,
  ProbeResult,
  ServerEvent,
  WriteResult
} from '../types.js'
import { describeFailure, followEvents, request } from './api.js'
import './components/sensor-header.js'
import './components/settings-panel.js'
import { sameKey } from './format.js'
import { LightElement } from './light-element.js'
import { describeOutcome, outcomeOf, storedValueOf } from './settings.js'
import { loadUnits, type Units } from './units.js'

@customElement('dst-app')
export class DstApp extends LightElement {
  @state() private candidates: Candidate[] = []
  @state() private device: DeviceResponse | null = null
  @state() private loadError: string | null = null
  /** Null until a read or write of the selected sensor's simulate mode has said. */
  @state() private simulating: boolean | null = null
  @state() private streamLost = false
  @state() private selecting = false
  @state() private probing = false
  @state() private probeError: string | null = null
  /**
   * Null until the unit preferences have loaded or failed. The settings wait
   * for them: a value shown in SI and then converted under an edit in
   * progress would have the user's number read in the wrong unit.
   */
  @state() private units: Units | null = null
  /** What went wrong with the warning's Turn off, shown in the warning itself. */
  @state() private simulateError: string | null = null
  /** The selected sensor's product information, read with its settings. */
  @state() private product: unknown = null

  private loading: AbortController | null = null
  private events: { close: () => void } | null = null
  /** Whether the selected sensor has had its automatic probe since the stream last connected. */
  private autoProbed = false

  override connectedCallback(): void {
    super.connectedCallback()
    void this.load()
    void loadUnits().then((units) => {
      this.units = units
    })
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    this.loading?.abort()
    this.loading = null
    this.events?.close()
    this.events = null
  }

  /**
   * Load the device list and the selection, then follow the event stream.
   *
   * The first load is a plain request because an EventSource cannot say why
   * it failed: the plugin being stopped and a login being refused both look
   * the same to it.
   */
  private async load(): Promise<void> {
    this.loading?.abort()
    const controller = new AbortController()
    this.loading = controller
    try {
      const [devices, device] = await Promise.all([
        request<DevicesResponse>('GET', '/devices', undefined, controller.signal),
        request<DeviceResponse>('GET', '/device', undefined, controller.signal)
      ])
      this.candidates = devices.candidates
      this.showDevice(device)
      this.loadError = null
      this.events?.close()
      this.events = followEvents({
        onEvent: (event) => {
          this.receive(event)
        },
        onConnected: (connected) => {
          // A stream that comes back was most likely dropped by a plugin
          // restart, which forgets its probes: probe afresh if one is missing.
          if (connected && this.streamLost) {
            this.autoProbed = false
          }
          this.streamLost = !connected
        }
      })
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        return
      }
      this.loadError = describeFailure(cause)
    } finally {
      if (this.loading === controller) {
        this.loading = null
      }
    }
  }

  private showDevice(device: DeviceResponse): void {
    if (!sameKey(device.selected, this.device?.selected ?? null)) {
      this.simulating = null
      this.simulateError = null
      this.probeError = null
      this.product = null
      this.autoProbed = false
    }
    this.device = device
  }

  /**
   * Probe a sensor that is on the bus and has none, so its settings read
   * themselves. The plugin keeps probes in memory only, so a restart drops
   * them. Once per selection: a refused or failed probe is not retried.
   */
  protected override updated(changed: Map<PropertyKey, unknown>): void {
    const device = this.device
    // After a probe too: a selection made while one ran was skipped above.
    const relevant = changed.has('device') || changed.has('probing')
    if (!relevant || device === null || this.probing || this.autoProbed) {
      return
    }
    if (device.probe !== null) {
      // This selection has its probe. If the plugin drops it for a restart,
      // it probes again itself once the sensor claims an address.
      this.autoProbed = true
      return
    }
    if (device.selected === null || device.location?.state !== 'present') {
      return
    }
    this.autoProbed = true
    void this.probe()
  }

  private receive(event: ServerEvent): void {
    switch (event.type) {
      case 'devices':
        this.candidates = event.data.candidates
        break
      case 'device':
        this.showDevice(event.data)
        break
      case 'setting': {
        if (event.data.id === 'simulateMode') {
          const stored = storedValueOf(event.data.result)?.value
          this.simulating = typeof stored === 'boolean' ? stored : this.simulating
          if (this.simulating === false) {
            this.simulateError = null
          }
        }
        this.querySelector('dst-settings')?.apply(event.data)
        break
      }
      case 'reset':
        this.querySelector('dst-settings')?.forget()
        // The restart is over. A sensor that did not come back has no probe,
        // and gets one when it is heard again.
        this.autoProbed = false
        break
    }
  }

  private async select(key: DeviceKey): Promise<void> {
    this.selecting = true
    try {
      this.showDevice(await request<DeviceResponse>('PUT', '/device', { device: key }))
    } catch (cause) {
      this.loadError = describeFailure(cause)
    } finally {
      this.selecting = false
    }
  }

  /** Probe the selected sensor; a result that returns after another was selected is dropped. */
  private async probe(): Promise<void> {
    const asked = this.device?.selected ?? null
    this.probing = true
    this.probeError = null
    try {
      const probe = await request<ProbeResult>('POST', '/device/probe')
      if (this.device !== null && sameKey(this.device.selected, asked)) {
        this.device = { ...this.device, probe }
      }
    } catch (cause) {
      this.probeError = describeFailure(cause)
    } finally {
      this.probing = false
    }
  }

  /**
   * The warning's Turn off. The warning stays until a read or write says the
   * sensor stopped; anything but `applied` is shown in it, beside the button.
   */
  private async simulateOff(): Promise<void> {
    this.simulateError = null
    try {
      const result = await request<WriteResult>('PUT', '/settings/simulateMode', { value: false })
      const outcome = outcomeOf('write', result)
      if (result.status !== 'applied' && outcome !== null) {
        this.simulateError = describeOutcome(
          outcome,
          (value) => (value === true ? 'on' : 'off'),
          storedValueOf(result)
        ).text
      }
    } catch (cause) {
      this.simulateError = describeFailure(cause)
    }
  }

  private selectedCandidate(): Candidate | null {
    const key = this.device?.selected ?? null
    return this.candidates.find((c) => sameKey(c.key, key)) ?? null
  }

  override render() {
    if (this.loadError !== null) {
      return html`
        <main class="container-fluid py-3">
          <div class="alert alert-danger d-flex align-items-center gap-3">
            <span>Cannot reach the plugin: ${this.loadError}</span>
            <button type="button" class="btn btn-sm btn-outline-danger" @click=${() => this.load()}>
              Retry
            </button>
          </div>
        </main>
      `
    }
    if (this.device === null) {
      return html`<main class="container-fluid py-3"><p>Loading…</p></main>`
    }
    return html`
      <div class="dst-header">
        <dst-sensor-header
          .device=${this.device}
          .candidate=${this.selectedCandidate()}
          .candidates=${this.candidates}
          .product=${this.product}
          .simulating=${this.simulating}
          .simulateError=${this.simulateError}
          .probeError=${this.probeError}
          .probing=${this.probing}
          .selecting=${this.selecting}
          @select=${(event: CustomEvent<DeviceKey>) => this.select(event.detail)}
          @probe=${() => this.probe()}
          @simulate-off=${() => this.simulateOff()}
        ></dst-sensor-header>
        ${
          this.streamLost
            ? html`<div class="container-fluid small text-warning-emphasis pb-1">
                Live updates lost, reconnecting…
              </div>`
            : nothing
        }
      </div>
      <main class="container-fluid py-3">
        ${
          this.units === null
            ? html`<p class="text-body-secondary">Loading unit preferences…</p>`
            : html`<dst-settings
                .device=${this.device}
                .units=${this.units}
                @probe=${() => this.probe()}
                @product=${(event: CustomEvent<unknown>) => {
                  this.product = event.detail
                }}
              ></dst-settings>`
        }
      </main>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-app': DstApp
  }
}
