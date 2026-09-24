import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import type { AccessView, Candidate, DeviceKey, DeviceResponse } from '../../types.js'
import { clock, deviceName, isRecord, sameKey } from '../format.js'
import { LightElement } from '../light-element.js'
import { SECTIONS } from '../settings.js'
import './device-picker.js'

const TICK_MS = 1000

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : null

/**
 * The page's sticky header: which sensor the console follows, whether it is
 * on the bus, its access level, a menu to each section, and the warnings
 * that must stay in view on every section.
 *
 * Fires `simulate-off` from the simulate-mode warning, `probe` to check the
 * sensor again, and passes the picker's `select` through.
 */
@customElement('dst-sensor-header')
export class SensorHeader extends LightElement {
  @property({ attribute: false }) device: DeviceResponse | null = null
  @property({ attribute: false }) candidate: Candidate | null = null
  @property({ attribute: false }) candidates: Candidate[] = []
  /** The sensor's product information, once read. */
  @property({ attribute: false }) product: unknown = null
  @property({ attribute: false }) simulating: boolean | null = null
  /** Why the warning's Turn off did not take, if it did not. */
  @property({ attribute: false }) simulateError: string | null = null
  @property({ attribute: false }) probeError: string | null = null
  @property({ type: Boolean }) probing = false
  @property({ type: Boolean }) selecting = false

  @state() private choosing = false

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
      const previous = changed.get('device') as DeviceResponse | null | undefined
      if (!sameKey(previous?.selected ?? null, this.selected)) {
        this.choosing = false
      }
    }
  }

  private get selected(): DeviceKey | null {
    return this.device?.selected ?? null
  }

  private get present(): boolean {
    return this.device?.location?.state === 'present'
  }

  /** Time left on the grant or the refusal, counted down from when it arrived. */
  private left(ms: number): number {
    return ms - (performance.now() - this.accessAt)
  }

  private accessBadge() {
    const access = this.access
    if (access === null || !this.present) {
      return nothing
    }
    if (access.state === 'granted' && this.left(access.expiresInMs) > 0) {
      return html`<span
        class="badge bg-success-subtle text-success-emphasis border border-success-subtle"
      >
        Level 1 unlocked, ${clock(this.left(access.expiresInMs))} left
      </span>`
    }
    return access.state === 'unavailable' && this.left(access.retryInMs) > 0
      ? nothing
      : html`<span
          class="badge bg-secondary-subtle text-secondary-emphasis"
          title="The console asks for Level 1 when it reads or saves a setting that needs it."
          >Level 1 locked</span
        >`
  }

  private details(): string {
    const product = isRecord(this.product) ? this.product : {}
    const parts = [
      this.device?.location?.state === 'present'
        ? `Address ${String(this.device.location.address)}`
        : null,
      text(this.candidate?.serial ?? product.modelSerialCode) === null
        ? null
        : `Serial ${String(text(this.candidate?.serial ?? product.modelSerialCode))}`,
      text(product.softwareVersionCode) === null
        ? null
        : `Software ${String(text(product.softwareVersionCode))}`,
      text(product.modelVersion)
    ]
    return parts.filter((part) => part !== null).join(' · ')
  }

  private menu() {
    const links = SECTIONS.map(
      (section) => html`<a class="nav-link px-2 py-1" href=${`#${section.id}`}>${section.title}</a>`
    )
    return html`
      <nav class="d-none d-lg-flex flex-wrap small" aria-label="Sections">${links}</nav>
      <details class="dst-menu d-lg-none">
        <summary class="btn btn-sm btn-outline-secondary">Sections</summary>
        <nav
          class="dst-menu-list card shadow nav flex-column"
          aria-label="Sections"
          @click=${(event: Event) => {
            ;(event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')
          }}
        >
          ${links}
        </nav>
      </details>
    `
  }

  private alerts() {
    const access = this.access
    const refused = access?.state === 'unavailable' && this.left(access.retryInMs) > 0
    return html`
      ${
        this.simulating === true
          ? html`<div
              class="alert alert-danger d-flex flex-wrap align-items-center gap-2 py-2 mt-2 mb-0"
              role="alert"
            >
              <span class="me-auto"
                ><strong>Simulate mode is on.</strong> Every device on the network, autopilot and
                anchor alarm included, is receiving simulated depth, speed and temperature.</span
              >
              <button
                type="button"
                class="btn btn-sm btn-danger"
                @click=${() => this.dispatchEvent(new CustomEvent('simulate-off', { bubbles: true }))}
              >
                Turn off simulate mode
              </button>
              ${
                this.simulateError === null
                  ? nothing
                  : html`<div class="w-100 small fw-semibold">${this.simulateError}</div>`
              }
            </div>`
          : nothing
      }
      ${
        this.selected !== null && !this.present
          ? html`<div class="alert alert-warning py-2 mt-2 mb-0">
              <strong>Sensor offline.</strong> It has not been heard on the network. Values below
              are from its last read and cannot be changed until it is back.
            </div>`
          : nothing
      }
      ${
        refused && this.present
          ? html`<div class="alert alert-warning py-2 mt-2 mb-0">
              The sensor refused Level 1 access, so settings that need it cannot be read or saved.
              The console asks again in ${clock(this.left(access.retryInMs))}.
            </div>`
          : nothing
      }
      ${
        this.probeError === null
          ? nothing
          : html`<div
              class="alert alert-danger d-flex flex-wrap align-items-center gap-2 py-2 mt-2 mb-0"
            >
              <span class="me-auto"
                >Could not check what the sensor supports: ${this.probeError}</span
              >
              <button
                type="button"
                class="btn btn-sm btn-outline-danger"
                ?disabled=${this.probing || !this.present}
                @click=${() => this.dispatchEvent(new CustomEvent('probe', { bubbles: true }))}
              >
                Try again
              </button>
            </div>`
      }
    `
  }

  private picker() {
    return html`<div class="mt-2">
      <dst-device-picker
        .candidates=${this.candidates}
        .selected=${this.selected}
        .busy=${this.selecting}
      ></dst-device-picker>
    </div>`
  }

  override render() {
    const key = this.selected
    if (key === null) {
      return html`<div class="container-fluid py-3">
        <h1 class="h5 mb-1">Airmar DST configuration</h1>
        <p class="mb-2 text-body-secondary">Choose the sensor to configure.</p>
        ${this.picker()}
      </div>`
    }
    return html`
      <div class="container-fluid py-2">
        <div class="d-flex flex-wrap align-items-center gap-2">
          <h1 class="h5 mb-0">${deviceName(this.candidate, key)}</h1>
          ${
            this.present
              ? html`<span class="badge bg-success-subtle text-success-emphasis">● Online</span>`
              : html`<span class="badge bg-warning-subtle text-warning-emphasis">○ Offline</span>`
          }
          ${this.accessBadge()}
          <div class="ms-auto d-flex align-items-center gap-2">
            ${this.menu()}
            <button
              type="button"
              class="btn btn-sm btn-outline-secondary"
              aria-expanded=${this.choosing ? 'true' : 'false'}
              @click=${() => {
                this.choosing = !this.choosing
              }}
            >
              Change sensor
            </button>
          </div>
        </div>
        <div class="small text-body-secondary">${this.details()}</div>
        ${this.choosing ? this.picker() : nothing} ${this.alerts()}
      </div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-sensor-header': SensorHeader
  }
}
