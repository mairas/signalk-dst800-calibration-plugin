/**
 * Everything the plugin holds while it runs.
 *
 * Built in `start()` and closed in `stop()`. The routes are registered once at
 * plugin load, before and independently of `start()`, so they reach the
 * runtime through a getter and answer 503 while there is none.
 */

import { DeviceConnection } from './devices/connection.js'
import { ProbeCache, probe, type ProbeResult } from './devices/probe.js'
import { DeviceRegistry, sameKey, type Location } from './devices/registry.js'
import { DeviceSession, type Bus } from './session/deviceSession.js'
import type { DeviceKey } from './types.js'

export interface RuntimeOptions {
  bus: Bus
  /** The server's `/sources` tree. */
  sources: () => unknown
  selected: DeviceKey | null
  onError: (error: unknown) => void
  /** Monotonic milliseconds. */
  now?: () => number
}

export class ConsoleRuntime {
  readonly registry: DeviceRegistry
  readonly probes = new ProbeCache()

  private readonly bus: Bus
  private readonly onError: (error: unknown) => void
  private readonly now: () => number
  private key: DeviceKey | null = null
  private connection: DeviceConnection | null = null
  private pending: { session: DeviceSession; result: Promise<ProbeResult> } | null = null

  constructor(options: RuntimeOptions) {
    this.bus = options.bus
    this.onError = options.onError
    this.now = options.now ?? (() => performance.now())
    this.registry = new DeviceRegistry({
      sources: options.sources,
      subscribe: (handler) => options.bus.subscribe(handler),
      now: this.now,
      onError: options.onError
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
              new DeviceSession({ address, bus: this.bus, now: this.now, onError: this.onError })
          })
  }

  /**
   * Probe the selected device through `session` and keep the result.
   *
   * A request while a probe runs on the same session shares that probe. Two
   * probes would alternate in the queue, and each would take twice as long.
   */
  probe(session: DeviceSession): Promise<ProbeResult> {
    if (this.pending?.session === session) {
      return this.pending.result
    }
    const key = this.key
    const result = probe(session).then((found) => {
      if (key !== null) {
        this.probes.set(key, found)
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

  close(): void {
    this.connection?.close()
    this.connection = null
    this.registry.close()
  }
}
