import { html, nothing } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import type {
  Candidate,
  DeviceKey,
  DeviceResponse,
  DevicesResponse,
  ProbeResult,
  ReadResult,
  ServerEvent,
  WriteResult
} from '../types.js'
import { describeFailure, followEvents, request } from './api.js'
import './components/device-picker.js'
import './components/device-status.js'
import { sameKey } from './format.js'
import { LightElement } from './light-element.js'

/** What a read or write of simulate mode says the device now holds, or null when it says nothing. */
function simulateValueOf(result: ReadResult | WriteResult): boolean | null {
  const value =
    result.status === 'answered'
      ? result.value
      : result.status === 'applied' || result.status === 'storedDiffers'
        ? result.stored
        : 'readBack' in result && result.readBack?.status === 'answered'
          ? result.readBack.value
          : null
  return typeof value === 'boolean' ? value : null
}

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

  private loading: AbortController | null = null
  private events: { close: () => void } | null = null

  override connectedCallback(): void {
    super.connectedCallback()
    void this.load()
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
      this.probeError = null
    }
    this.device = device
  }

  private receive(event: ServerEvent): void {
    switch (event.type) {
      case 'devices':
        this.candidates = event.data.candidates
        break
      case 'device':
        this.showDevice(event.data)
        break
      case 'setting':
        if (event.data.id === 'simulateMode') {
          this.simulating = simulateValueOf(event.data.result) ?? this.simulating
        }
        break
      case 'reset':
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
    const hasDevice = this.device.selected !== null
    return html`
      <main class="container-fluid py-3">
        <h1 class="h4 mb-3">Airmar DST configuration</h1>
        ${
          this.simulating === true
            ? html`<div class="alert alert-danger" role="alert">
                <strong>Simulate mode is on.</strong> The sensor is sending simulated depth, speed
                and temperature, and every device on the NMEA 2000 bus is receiving them as real,
                autopilot and anchor alarm included.
              </div>`
            : nothing
        }
        ${
          this.streamLost
            ? html`<p class="text-warning">Live updates lost, reconnecting…</p>`
            : nothing
        }
        ${
          hasDevice
            ? html`<section class="mb-4" aria-label="Selected sensor">
                <dst-device-status
                  .device=${this.device}
                  .candidate=${this.selectedCandidate()}
                  .probing=${this.probing}
                  .probeError=${this.probeError}
                  @probe=${() => this.probe()}
                ></dst-device-status>
              </section>`
            : html`<p class="lead">Choose the sensor to configure.</p>`
        }
        <details ?open=${!hasDevice}>
          <summary class="mb-2">${hasDevice ? 'Change sensor' : 'Devices on the bus'}</summary>
          <dst-device-picker
            .candidates=${this.candidates}
            .selected=${this.device.selected}
            .busy=${this.selecting}
            @select=${(event: CustomEvent<DeviceKey>) => this.select(event.detail)}
          ></dst-device-picker>
        </details>
      </main>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-app': DstApp
  }
}
