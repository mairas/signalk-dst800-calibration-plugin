import { html, nothing } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import type { AccessView, Candidate, DeviceResponse, ProbeResult } from '../../types.js'
import { clock, deviceName } from '../format.js'
import { LightElement } from '../light-element.js'

const TICK_MS = 1000

/**
 * The selected sensor: what it is, whether it is on the bus, its access level
 * and its last probe.
 *
 * The access level arrives as time left when the plugin sent it, so the
 * countdown runs from the moment it arrived. Fires `probe` when the user asks
 * for a probe.
 */
@customElement('dst-device-status')
export class DeviceStatus extends LightElement {
  @property({ attribute: false }) device: DeviceResponse | null = null
  @property({ attribute: false }) candidate: Candidate | null = null
  @property({ type: Boolean }) probing = false
  @property({ attribute: false }) probeError: string | null = null

  private access: AccessView | null = null
  /** `performance.now()` when `access` arrived. */
  private accessAt = 0
  private ticker: ReturnType<typeof setInterval> | null = null

  override connectedCallback(): void {
    super.connectedCallback()
    this.ticker = setInterval(() => {
      if (this.access !== null && this.access.state !== 'locked') {
        this.requestUpdate()
      }
    }, TICK_MS)
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback()
    if (this.ticker !== null) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  protected override willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has('device')) {
      this.access = this.device?.access ?? null
      this.accessAt = performance.now()
    }
  }

  private accessLine() {
    const access = this.access
    if (access === null) {
      return nothing
    }
    const elapsed = performance.now() - this.accessAt
    if (access.state === 'granted' && access.expiresInMs > elapsed) {
      return html`<span class="badge text-bg-success">
        Level 1 unlocked, ${clock(access.expiresInMs - elapsed)} left
      </span>`
    }
    if (access.state === 'unavailable' && access.retryInMs > elapsed) {
      return html`<span class="badge text-bg-danger">
        Level 1 refused by the device, asking again in ${clock(access.retryInMs - elapsed)}
      </span>`
    }
    return html`<span class="badge text-bg-secondary">Level 1 locked</span>`
  }

  private probeLine(probe: ProbeResult | null) {
    if (probe === null) {
      return html`<span class="text-body-secondary">Not probed yet.</span>`
    }
    const answered = probe.capabilities.filter((c) => c.result.state !== 'noAnswer').length
    const configurable = { yes: 'configurable', no: 'not configurable', unknown: 'configurable?' }[
      probe.configurable
    ]
    return html`<span>
      ${String(answered)} of ${String(probe.capabilities.length)} capabilities answered,
      ${configurable}.
    </span>`
  }

  override render() {
    const device = this.device
    const selected = device?.selected ?? null
    if (device === null || selected === null) {
      return nothing
    }
    const serial = this.candidate?.serial ?? null
    const location = device.location
    const present = location?.state === 'present'
    return html`
      <div class="d-flex flex-wrap align-items-baseline gap-3">
        <h2 class="h5 mb-0">${deviceName(this.candidate, selected)}</h2>
        ${
          serial === null
            ? nothing
            : html`<span class="font-monospace text-body-secondary">${serial}</span>`
        }
        ${
          present
            ? html`<span>At address ${String(location.address)}</span>`
            : html`<span class="badge text-bg-warning">Waiting for the device</span>`
        }
        ${this.accessLine()}
      </div>
      <div class="d-flex flex-wrap align-items-center gap-3 mt-2">
        ${this.probeLine(device.probe)}
        <button
          type="button"
          class="btn btn-sm btn-outline-secondary"
          ?disabled=${this.probing || !present}
          @click=${() => this.dispatchEvent(new CustomEvent('probe', { bubbles: true }))}
        >
          ${this.probing ? 'Probing…' : 'Probe'}
        </button>
        ${
          this.probeError === null
            ? nothing
            : html`<span class="text-danger">${this.probeError}</span>`
        }
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-device-status': DeviceStatus
  }
}
