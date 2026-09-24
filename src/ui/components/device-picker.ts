import { html } from 'lit'
import { customElement, property } from 'lit/decorators.js'
import { ifDefined } from 'lit/directives/if-defined.js'
import type { Candidate, DeviceKey } from '../../types.js'
import { sameKey } from '../format.js'
import { LightElement } from '../light-element.js'

/**
 * Every NMEA 2000 device the server knows, to pick the sensor to configure.
 *
 * Not filtered by manufacturer: rebadged Airmar hardware claims its brand's
 * code. Whether a device is configurable is the probe's answer.
 *
 * Fires `select` with the chosen `DeviceKey` as its detail.
 */
@customElement('dst-device-picker')
export class DevicePicker extends LightElement {
  @property({ attribute: false }) candidates: Candidate[] = []
  @property({ attribute: false }) selected: DeviceKey | null = null
  @property({ type: Boolean }) busy = false

  private choose(key: DeviceKey): void {
    this.dispatchEvent(new CustomEvent<DeviceKey>('select', { detail: key, bubbles: true }))
  }

  override render() {
    if (this.candidates.length === 0) {
      return html`<p class="text-body-secondary">
        The server has not heard any NMEA 2000 device yet.
      </p>`
    }
    return html`
      <table class="table table-sm table-hover align-middle mb-0">
        <thead>
          <tr>
            <th scope="col">Manufacturer</th>
            <th scope="col">Model</th>
            <th scope="col">Serial</th>
            <th scope="col">Address</th>
            <th scope="col"><span class="visually-hidden">Action</span></th>
          </tr>
        </thead>
        <tbody>
          ${this.candidates.map((candidate) => {
            const current = sameKey(candidate.key, this.selected)
            return html`
              <tr
                aria-current=${ifDefined(current ? 'true' : undefined)}
                class=${current ? 'table-active' : ''}
              >
                <td>
                  ${candidate.manufacturerName ?? `Code ${String(candidate.key.manufacturerCode)}`}
                </td>
                <td>${candidate.modelId ?? '—'}</td>
                <td class="font-monospace">${candidate.serial ?? '—'}</td>
                <td>
                  ${
                    candidate.location.state === 'present'
                      ? String(candidate.location.address)
                      : html`<span class="text-body-secondary">not heard</span>`
                  }
                </td>
                <td class="text-end">
                  ${
                    current
                      ? html`<span class="badge text-bg-primary">Selected</span>`
                      : html`<button
                          type="button"
                          class="btn btn-sm btn-outline-primary"
                          ?disabled=${this.busy}
                          @click=${() => {
                            this.choose(candidate.key)
                          }}
                        >
                          Select
                        </button>`
                  }
                </td>
              </tr>
            `
          })}
        </tbody>
      </table>
    `
  }
}

declare global {
  interface HTMLElementTagNameMap {
    'dst-device-picker': DevicePicker
  }
}
