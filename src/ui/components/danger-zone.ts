import { html, nothing } from 'lit'
import { customElement, property, state } from 'lit/decorators.js'
import { LightElement } from '../light-element.js'
import { describeRestart, type RestartAction, type Restarted } from '../restart.js'

/** What the user types before a factory restore, so it is never one click away. */
const CONFIRMATION = 'RESTORE'

type Asking = 'reset' | 'all'

/**
 * The actions that cannot be undone from the console: a master reset, which
 * restarts the sensor, and a factory restore, which erases every setting it
 * has stored. Each asks first; the factory restore wants a typed word.
 *
 * Fires `restart`; the settings panel sends it and passes back `restarting`
 * and `restarted`, because the restart replaces this element.
 */
@customElement('dst-danger-zone')
export class DangerZone extends LightElement {
  @property({ type: Boolean }) disabled = false
  @property({ attribute: false }) restarting: RestartAction | null = null
  @property({ attribute: false }) restarted: Restarted | null = null

  @state() private asking: Asking | null = null
  @state() private typed = ''

  private go(action: Asking): void {
    this.asking = null
    this.typed = ''
    this.dispatchEvent(new CustomEvent('restart', { detail: { action }, bubbles: true }))
  }

  private cancel(): void {
    this.asking = null
    this.typed = ''
  }

  private mine(action: RestartAction | undefined): boolean {
    return action === 'reset' || action === 'all'
  }

  private status() {
    if (this.mine(this.restarting ?? undefined)) {
      return html`<p class="small text-body-secondary mb-0 mt-2" role="status">
        <span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>
        The sensor is restarting…
      </p>`
    }
    const restarted = this.restarted
    if (restarted === null || !this.mine(restarted.action)) {
      return nothing
    }
    const { tone, text } = describeRestart(restarted)
    return html`<p class=${`small text-${tone}-emphasis mb-0 mt-2`} role="status">${text}</p>`
  }

  private resetConfirm() {
    return html`<div class="bg-warning-subtle border border-warning-subtle rounded p-3 mt-2">
      <p class="mb-2">
        The sensor restarts as though its power had been cycled. Stored settings are kept; Level 1
        access and simulate mode end.
      </p>
      <button
        type="button"
        class="btn btn-sm btn-warning me-2"
        ?disabled=${this.disabled}
        @click=${() => {
          this.go('reset')
        }}
      >
        Restart
      </button>
      <button
        type="button"
        class="btn btn-sm btn-link"
        @click=${() => {
          this.cancel()
        }}
      >
        Cancel
      </button>
    </div>`
  }

  private restoreConfirm() {
    return html`<div class="bg-danger-subtle border border-danger-subtle rounded p-3 mt-2">
      <p class="mb-2 text-danger-emphasis">
        Every setting the sensor stores returns to its factory default, including the speed
        calibration curve, the offsets, the installation note, and each message's interval and
        priority. The sensor then restarts, which also ends Level 1 access and simulate mode.
        <a href="#snapshots">Export the settings</a> first to keep a copy.
      </p>
      <label class="form-label small" for="dst-restore-confirmation"
        >Type ${CONFIRMATION} to confirm</label
      >
      <div class="d-flex flex-wrap gap-2">
        <input
          id="dst-restore-confirmation"
          type="text"
          class="form-control form-control-sm dst-value-input"
          autocomplete="off"
          .value=${this.typed}
          @input=${(event: Event) => {
            this.typed = (event.target as HTMLInputElement).value
          }}
        />
        <button
          type="button"
          class="btn btn-sm btn-danger"
          ?disabled=${this.disabled || this.typed !== CONFIRMATION}
          @click=${() => {
            this.go('all')
          }}
        >
          Restore factory settings
        </button>
        <button
          type="button"
          class="btn btn-sm btn-link"
          @click=${() => {
            this.cancel()
          }}
        >
          Cancel
        </button>
      </div>
    </div>`
  }

  override render() {
    const busy = this.restarting !== null
    return html`
      <div class="list-group list-group-flush">
        <div class="list-group-item">
          <div class="fw-semibold">Restart sensor</div>
          <div class="form-text mt-0 mb-2">
            The same as cycling its power. Nothing stored changes.
          </div>
          ${
            this.asking === 'reset'
              ? this.resetConfirm()
              : html`<button
                  type="button"
                  class="btn btn-sm btn-outline-secondary"
                  ?disabled=${this.disabled || busy}
                  @click=${() => {
                    this.asking = 'reset'
                  }}
                >
                  Restart sensor…
                </button>`
          }
        </div>
        <div class="list-group-item">
          <div class="fw-semibold">Restore factory settings</div>
          <div class="form-text mt-0 mb-2">
            Erases every setting the sensor stores, except its unique number.
          </div>
          ${
            this.asking === 'all'
              ? this.restoreConfirm()
              : html`<button
                  type="button"
                  class="btn btn-sm btn-outline-danger"
                  ?disabled=${this.disabled || busy}
                  @click=${() => {
                    this.asking = 'all'
                  }}
                >
                  Restore factory settings…
                </button>`
          }
        </div>
      </div>
      <div class="px-3 pb-3">${this.status()}</div>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-danger-zone': DangerZone
  }
}
