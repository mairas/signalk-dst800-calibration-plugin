import { LitElement, html, css } from 'lit'
import { customElement, state } from 'lit/decorators.js'
import type { HealthResponse } from '../types.js'

const API_BASE = '/plugins/signalk-airmar-dst-config'

@customElement('dst-app')
export class DstApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 1rem;
      font-family: system-ui, sans-serif;
    }
    .error {
      color: #b00;
    }
  `

  @state() private health: HealthResponse | null = null
  @state() private error: string | null = null

  private inFlight: AbortController | null = null

  override connectedCallback() {
    super.connectedCallback()
    void this.load()
  }

  override disconnectedCallback() {
    super.disconnectedCallback()
    this.inFlight?.abort()
    this.inFlight = null
  }

  /**
   * Re-attaching the element calls connectedCallback again, so an earlier
   * request can still be in flight. Abort it rather than letting whichever
   * response lands last win.
   */
  private async load() {
    this.inFlight?.abort()
    const controller = new AbortController()
    this.inFlight = controller
    try {
      const response = await fetch(`${API_BASE}/api/health`, {
        credentials: 'same-origin',
        signal: controller.signal
      })
      if (!response.ok) {
        throw new Error(`${String(response.status)} ${response.statusText}`)
      }
      this.health = (await response.json()) as HealthResponse
      this.error = null
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        return
      }
      this.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      if (this.inFlight === controller) {
        this.inFlight = null
      }
    }
  }

  override render() {
    if (this.error !== null) {
      return html`
        <p class="error">Cannot reach the plugin: ${this.error}</p>
        <button @click=${() => void this.load()}>Retry</button>
      `
    }
    if (this.health === null) {
      return html`<p>Loading…</p>`
    }
    return html`
      <h1>Airmar DST Config</h1>
      <p>Plugin ${this.health.running ? 'running' : 'stopped'}.</p>
      <p>
        ${
          this.health.selectedDevice === null
            ? 'No device selected.'
            : `Device ${String(this.health.selectedDevice.uniqueNumber)}.`
        }
      </p>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-app': DstApp
  }
}
