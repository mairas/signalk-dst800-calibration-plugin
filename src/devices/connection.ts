/**
 * The console's hold on one device, across address changes.
 *
 * A `DeviceSession` is bound to one source address for its life, because its
 * correlation rests on the address a reply comes from. A device changes
 * address on a re-claim, and this plugin's own master reset causes one. This
 * class owns the session and replaces it when the registry reports a move,
 * telling everything still waiting on the old one where the device went.
 *
 * A silence alone does not close the session. The device is still at the
 * same address and the session's own timeouts already report what it does
 * not answer.
 */

import type { DeviceSession } from '../session/deviceSession.js'
import type { DeviceKey } from '../types.js'
import type { DeviceRegistry, Location } from './registry.js'

export interface DeviceConnectionOptions {
  registry: Pick<DeviceRegistry, 'locate' | 'onChange'>
  key: DeviceKey
  createSession: (address: number) => DeviceSession
  /** Called after each change of location, with the session already replaced. */
  onChange?: (location: Location) => void
}

const describeMove = (from: number, to: number | null): string =>
  to === null
    ? `The device no longer holds address ${String(from)}`
    : `The device moved from address ${String(from)} to ${String(to)}`

export class DeviceConnection {
  private readonly registry: DeviceConnectionOptions['registry']
  private readonly key: DeviceKey
  private readonly createSession: (address: number) => DeviceSession
  private readonly onChange: ((location: Location) => void) | undefined
  private readonly unsubscribe: () => void

  private current: Location
  private active: DeviceSession | null = null
  private closed = false

  constructor(options: DeviceConnectionOptions) {
    this.registry = options.registry
    this.key = options.key
    this.createSession = options.createSession
    this.onChange = options.onChange
    this.current = this.registry.locate(this.key)
    this.follow(this.current)
    this.unsubscribe = this.registry.onChange(() => {
      this.update()
    })
  }

  get location(): Location {
    return this.current
  }

  /**
   * Null until the device is first heard at its current address.
   *
   * Stays set through a silence at the same address, so it says nothing
   * about presence; `location` does.
   */
  get session(): DeviceSession | null {
    return this.active
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.unsubscribe()
    this.active?.close()
    this.active = null
  }

  private update(): void {
    if (this.closed) {
      return
    }
    const next = this.registry.locate(this.key)
    if (next.state === this.current.state && next.address === this.current.address) {
      return
    }
    // Follow first: if opening the session throws, the location stays as it
    // was, so the next change from the registry tries again.
    this.follow(next)
    this.current = next
    this.onChange?.(next)
  }

  private follow(location: Location): void {
    if (this.active !== null && this.active.address !== location.address) {
      this.active.close(describeMove(this.active.address, location.address))
      this.active = null
    }
    if (this.active === null && location.state === 'present') {
      this.active = this.createSession(location.address)
    }
  }
}
