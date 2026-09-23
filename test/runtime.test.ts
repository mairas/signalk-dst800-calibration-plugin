import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FakeBus } from './helpers/FakeBus.js'
import { PROBED } from '../src/devices/probe.js'
import { ConsoleRuntime } from '../src/runtime.js'
import { DeviceSession, MAX_ADAPTIVE_TIMEOUT_MS } from '../src/session/deviceSession.js'

/** Longer than any probe of a silent device, whose timeout widens as it goes. */
const LONGEST_PROBE_MS = (PROBED.length + 1) * MAX_ADAPTIVE_TIMEOUT_MS

describe('ConsoleRuntime', () => {
  let bus: FakeBus
  let runtime: ConsoleRuntime
  const sessions: DeviceSession[] = []

  const session = (address: number): DeviceSession => {
    const created = new DeviceSession({ address, bus, now: () => Date.now() })
    sessions.push(created)
    return created
  }

  beforeEach(() => {
    vi.useFakeTimers()
    bus = new FakeBus()
    runtime = new ConsoleRuntime({
      bus,
      sources: () => ({}),
      selected: null,
      onError: () => undefined
    })
  })

  afterEach(() => {
    sessions.splice(0).forEach((s) => {
      s.close()
    })
    runtime.close()
    vi.useRealTimers()
  })

  describe('probe', () => {
    it('shares a running probe only with requests on the same session', () => {
      const first = session(22)
      const second = session(30)
      const running = runtime.probe(first)

      expect(runtime.probe(first)).toBe(running)
      expect(runtime.probe(second)).not.toBe(running)
    })

    it('probes again once the previous probe has finished', async () => {
      const device = session(22)
      const finished = runtime.probe(device)
      await vi.advanceTimersByTimeAsync(LONGEST_PROBE_MS)
      await finished

      expect(runtime.probe(device)).not.toBe(finished)
    })
  })
})
