import { LitElement, html, css } from 'lit'
import { customElement, state } from 'lit/decorators.js'

const API_BASE = '/plugins/signalk-airmar-dst-config'

interface Health {
  running: boolean
  selectedDevice: { manufacturerCode: number; uniqueNumber: number } | null
}

@customElement('dst-app')
export class DstApp extends LitElement {
  static styles = css`
    :host {
      display: block;
      padding: 1rem;
      font-family: system-ui, sans-serif;
    }
  `

  @state() private health: Health | null = null
  @state() private error: string | null = null

  override connectedCallback() {
    super.connectedCallback()
    void this.load()
  }

  private async load() {
    try {
      const response = await fetch(`${API_BASE}/api/health`, { credentials: 'same-origin' })
      if (!response.ok) {
        throw new Error(`${String(response.status)} ${response.statusText}`)
      }
      this.health = (await response.json()) as Health
      this.error = null
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  override render() {
    if (this.error !== null) {
      return html`<p>Cannot reach the plugin: ${this.error}</p>`
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
