/**
 * Everything the plugin holds while it runs.
 *
 * Built in `start()` and closed in `stop()`. The routes are registered once at
 * plugin load, before and independently of `start()`, so they reach the
 * runtime through a getter and answer 503 while there is none.
 */

import { DeviceConnection } from './devices/connection.js'
import { ProbeCache, probe, type ProbeResult } from './devices/probe.js'
import { DeviceRegistry, claimOf, sameKey, type Location } from './devices/registry.js'
import type { OutgoingRaw } from './protocol/messages.js'
import { PGN } from './protocol/pids.js'
import { DeviceSession, type Bus } from './session/deviceSession.js'
import type { PgnContext } from './settings/pgnIntervals.js'
import type { DeviceKey, DeviceResponse, DevicesResponse, ResetResult } from './types.js'

/** How long a reset device has to claim an address again before the console stops waiting. */
export const RESET_CLAIM_TIMEOUT_MS = 30_000

export interface RuntimeOptions {
  bus: Bus
  /** The server's `/sources` tree. */
  sources: () => unknown
  selected: DeviceKey | null
  onError: (error: unknown) => void
  /** Monotonic milliseconds. */
  now?: () => number
  /**
   * Called when the device list, the selection, the selected device's location
   * or its cached probe may have changed. Carries no payload: re-read the views.
   */
  onChange?: (runtime: ConsoleRuntime) => void
}

export class ConsoleRuntime {
  readonly registry: DeviceRegistry
  readonly probes = new ProbeCache()

  private readonly bus: Bus
  private readonly onError: (error: unknown) => void
  private readonly now: () => number
  private readonly onChange: ((runtime: ConsoleRuntime) => void) | undefined
  private key: DeviceKey | null = null
  private connection: DeviceConnection | null = null
  private pending: { session: DeviceSession; result: Promise<ProbeResult> } | null = null

  constructor(options: RuntimeOptions) {
    this.bus = options.bus
    this.onError = options.onError
    this.now = options.now ?? (() => performance.now())
    this.onChange = options.onChange
    this.registry = new DeviceRegistry({
      sources: options.sources,
      subscribe: (handler) => options.bus.subscribe(handler),
      now: this.now,
      onError: options.onError
    })
    this.registry.onChange(() => {
      this.changed()
    })
    this.select(options.selected)
  }

  get selected(): DeviceKey | null {
    return this.key
  }

  /** Null when no device is selected. */
  get location(): Location | null {
    return this.connection?.location ?? null
  }

  /** Null until the selected device has been heard at its address. */
  get session(): DeviceSession | null {
    return this.connection?.session ?? null
  }

  /**
   * Point the console at another device, or at none.
   *
   * Selecting the device already selected keeps its session: closing it would
   * report an in-flight write as unanswered, discard a running probe, and give
   * up the Level 1 grant.
   */
  select(key: DeviceKey | null): void {
    const unchanged = key === null || this.key === null ? key === this.key : sameKey(key, this.key)
    if (unchanged) {
      return
    }
    this.connection?.close()
    this.key = key
    this.connection =
      key === null
        ? null
        : new DeviceConnection({
            registry: this.registry,
            key,
            createSession: (address) =>
              new DeviceSession({ address, bus: this.bus, now: this.now, onError: this.onError }),
            onChange: () => {
              this.changed()
            }
          })
    this.changed()
  }

  /**
   * Probe the selected device through `session` and keep the result.
   *
   * A request while a probe runs on the same session shares that probe. Two
   * probes would alternate in the queue, and each would take twice as long.
   * A probe that a reset detached is not kept: part of it asked a rebooting
   * device.
   */
  probe(session: DeviceSession): Promise<ProbeResult> {
    if (this.pending?.session === session) {
      return this.pending.result
    }
    const key = this.key
    const result = probe(session).then((found) => {
      if (key !== null && this.pending === pending) {
        this.probes.set(key, found)
        this.changed()
      }
      return found
    })
    const pending = { session, result }
    this.pending = pending
    const clear = (): void => {
      if (this.pending === pending) {
        this.pending = null
      }
    }
    void result.then(clear, clear)
    return result
  }

  /**
   * Send a master reset or an EEPROM restore through `session`, and follow the
   * device through the reboot that follows.
   *
   * The device reboots and claims an address again, perhaps another one, which
   * the registry follows. The cached probe no longer describes it, so it is
   * dropped, and the device is probed again once it has claimed.
   */
  async restart(session: DeviceSession, message: OutgoingRaw): Promise<ResetResult> {
    const key = this.key
    if (key === null) {
      return { status: 'notSent', reason: 'No device is selected' }
    }
    const sent = await session.sendRaw(message, { requiresLevel1: true })
    if (sent.status !== 'answered') {
      return { status: 'notSent', reason: sent.reason }
    }
    this.probes.invalidate(key)
    // A probe still running asks a rebooting device: detach it, so it is
    // neither kept nor shared with the probe after the claim.
    this.pending = null
    this.changed()
    const claimed = await this.claimed(key.uniqueNumber)
    const next = this.session
    if (!claimed) {
      return {
        status: 'lost',
        reason: `The device did not claim an address within ${String(RESET_CLAIM_TIMEOUT_MS / 1000)} s`
      }
    }
    if (next === null || this.key === null || !sameKey(this.key, key)) {
      return { status: 'lost', reason: 'The console stopped following the device' }
    }
    return { status: 'claimed', probe: await this.probe(next) }
  }

  /** Resolves true on the next Address Claim from `uniqueNumber`, false after the timeout. */
  private claimed(uniqueNumber: number): Promise<boolean> {
    return new Promise((resolve) => {
      const finish = (claimed: boolean): void => {
        clearTimeout(timer)
        unsubscribe()
        resolve(claimed)
      }
      const timer = setTimeout(() => {
        finish(false)
      }, RESET_CLAIM_TIMEOUT_MS)
      const unsubscribe = this.bus.subscribe((pgn) => {
        if (pgn.pgn === PGN.addressClaim && claimOf(pgn)?.uniqueNumber === uniqueNumber) {
          finish(true)
        }
      })
    })
  }

  /** What an interval write needs: the session, and the bus to time the frames on. */
  pgnContext(session: DeviceSession): PgnContext {
    return { session, subscribe: (handler) => this.bus.subscribe(handler), now: this.now }
  }

  /** Body of `GET /api/devices`. */
  devicesView(): DevicesResponse {
    return { candidates: this.registry.candidates() }
  }

  /** Body of `GET /api/device`. */
  deviceView(): DeviceResponse {
    const key = this.key
    return {
      selected: key,
      location: this.location,
      probe: key === null ? null : (this.probes.get(key) ?? null)
    }
  }

  private changed(): void {
    this.onChange?.(this)
  }

  close(): void {
    this.connection?.close()
    this.connection = null
    this.registry.close()
  }
}
