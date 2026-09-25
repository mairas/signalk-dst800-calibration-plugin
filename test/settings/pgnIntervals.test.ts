import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FakeBus } from '../helpers/FakeBus.js'
import { acknowledge, pgnListReply } from '../helpers/replies.js'
import { DeviceSession, DEFAULT_TIMEOUT_MS } from '../../src/session/deviceSession.js'
import { PGN } from '../../src/protocol/pids.js'
import type { ProbeResult } from '../../src/devices/probe.js'
import {
  readPgns,
  writeInterval,
  writePriority,
  type PgnContext
} from '../../src/settings/pgnIntervals.js'
import { NOT_SEEN } from '../../src/settings/pgnObserver.js'

const DEVICE = 22
const GATEWAY = 100
const from = { src: DEVICE, dst: GATEWAY }

const probed = (...pgns: number[]): ProbeResult => ({
  level1: { state: 'granted' },
  capabilities: pgns.map((pgn) => ({
    capability: { kind: 'pgn', pgn },
    result: { state: 'supported' }
  })),
  configurable: 'yes',
  interrupted: false
})

describe('PGN intervals and priorities', () => {
  let bus: FakeBus
  let session: DeviceSession
  let context: PgnContext
  let changed: number[]

  beforeEach(() => {
    vi.useFakeTimers()
    bus = new FakeBus()
    session = new DeviceSession({ address: DEVICE, bus, now: () => Date.now() })
    changed = []
    context = {
      session,
      subscribe: (handler) => bus.subscribe(handler),
      now: () => Date.now(),
      intervalChanged: (pgn) => changed.push(pgn)
    }
  })

  afterEach(() => {
    session.close()
    vi.useRealTimers()
  })

  const flush = () => vi.advanceTimersByTimeAsync(0)

  /** Send `pgn` from the device every `periodMs`, `count` times, starting now. */
  const transmit = async (pgn: number, periodMs: number, count: number) => {
    for (let i = 0; i < count; i += 1) {
      bus.deliver({ pgn, src: DEVICE, dst: 255, fields: {} })
      await vi.advanceTimersByTimeAsync(periodMs)
    }
  }

  describe('the editable list', () => {
    it('joins the transmit list with the proprietary PGNs the probe found, once each', async () => {
      const pending = readPgns(session, probed(PGN.speedPulseCount, PGN.waterDepth), () => NOT_SEEN)
      await flush()
      bus.deliver(pgnListReply('Transmit PGN list', [PGN.waterDepth, PGN.speed], from))
      const result = await pending

      expect(result).toMatchObject({ status: 'answered' })
      const pgns = result.status === 'answered' ? result.pgns : []

      expect(pgns.map((p) => p.pgn)).toEqual([PGN.waterDepth, PGN.speed, PGN.speedPulseCount])
      expect(pgns.find((p) => p.pgn === PGN.speedPulseCount)).toMatchObject({
        minIntervalMs: 50,
        telemetry: true
      })
      expect(pgns.find((p) => p.pgn === PGN.waterDepth)).toMatchObject({ telemetry: false })
    })

    it('leaves out the reserved PGNs 0, 255 and 65285, which cannot be configured', async () => {
      const pending = readPgns(session, undefined, () => NOT_SEEN)
      await flush()
      bus.deliver(pgnListReply('Transmit PGN list', [0, PGN.waterDepth, 255, 65285], from))

      expect(await pending).toMatchObject({ status: 'answered', pgns: [{ pgn: PGN.waterDepth }] })
    })

    it('ignores the receive list', async () => {
      const pending = readPgns(session, undefined, () => NOT_SEEN)
      await flush()
      bus.deliver(pgnListReply('Receive PGN list', [PGN.groupFunction], from))
      bus.deliver(pgnListReply('Transmit PGN list', [PGN.distanceLog], from))

      expect(await pending).toMatchObject({
        status: 'answered',
        pgns: [{ pgn: PGN.distanceLog, minIntervalMs: 100 }]
      })
    })
  })

  describe('writing an interval', () => {
    it('reports the period it then observes', async () => {
      const pending = writeInterval(context, PGN.waterDepth, 500)
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await transmit(PGN.waterDepth, 500, 3)

      expect(await pending).toEqual({ status: 'applied', observedIntervalMs: 500 })
      expect(changed).toEqual([PGN.waterDepth])
    })

    it('times the last gap, since the first frame may still follow the old period', async () => {
      const pending = writeInterval(context, PGN.waterDepth, 500)
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      bus.deliver({ pgn: PGN.waterDepth, src: DEVICE, dst: 255, fields: {} })
      await vi.advanceTimersByTimeAsync(900)
      await transmit(PGN.waterDepth, 500, 2)

      expect(await pending).toEqual({ status: 'applied', observedIntervalMs: 500 })
    })

    it('reports a period the device did not take up, with the one it keeps', async () => {
      const pending = writeInterval(context, PGN.waterDepth, 500)
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await transmit(PGN.waterDepth, 1000, 3)

      expect(await pending).toEqual({
        status: 'observedDiffers',
        requestedIntervalMs: 500,
        observedIntervalMs: 1000
      })
    })

    it('reports a refusal at once, without watching the bus', async () => {
      const pending = writeInterval(context, PGN.waterDepth, 500)
      await flush()
      bus.deliver(
        acknowledge(
          { acknowledgedPgn: PGN.waterDepth, intervalErrorCode: 'Transmit Interval too low' },
          from
        )
      )

      expect(await pending).toMatchObject({ status: 'rejected' })
      // The old interval still holds, and so does its measurement.
      expect(changed).toEqual([])
    })

    it('turns a PGN off with an interval of 0, taking silence as acceptance', async () => {
      const pending = writeInterval(context, PGN.waterDepth, 0)
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect(await pending).toEqual({ status: 'applied' })
      expect(changed).toEqual([PGN.waterDepth])
    })

    it('reports an accepted interval it could not observe as unconfirmed', async () => {
      const pending = writeInterval(context, PGN.waterDepth, 500)
      await vi.advanceTimersByTimeAsync(60_000)

      expect(await pending).toMatchObject({ status: 'unconfirmed' })
    })

    it.each([
      ['a single-frame PGN at 0, which turns it off', PGN.waterDepth, 0, true],
      ['a fast-packet PGN at 0, which turns it off', PGN.distanceLog, 0, true],
      ['a single-frame PGN at 50 ms', PGN.waterDepth, 50, true],
      ['a single-frame PGN at 40 ms', PGN.waterDepth, 40, false],
      ['a fast-packet PGN at 100 ms', PGN.distanceLog, 100, true],
      ['a fast-packet PGN at 80 ms', PGN.distanceLog, 80, false],
      ['any PGN beyond 60 s', PGN.waterDepth, 60_001, false],
      ['a fraction of a millisecond', PGN.waterDepth, 500.5, false]
    ])('accepts %s only within its range', async (_name, pgn, intervalMs, accepted) => {
      const pending = writeInterval(context, pgn, intervalMs)
      await flush()

      expect(bus.sent.length > 0).toBe(accepted)
      if (!accepted) {
        expect(await pending).toMatchObject({ status: 'invalid' })
      }
    })
  })

  describe('writing a priority', () => {
    it('reports success from the acknowledgement', async () => {
      const pending = writePriority(session, PGN.speed, 2)
      await flush()
      bus.deliver(acknowledge({ acknowledgedPgn: PGN.speed }, from))

      expect(await pending).toEqual({ status: 'applied' })
    })

    it.each([-1, 8, 2.5, '3'])('refuses priority %j before the bus', async (priority) => {
      expect(await writePriority(session, PGN.speed, priority)).toMatchObject({
        status: 'invalid'
      })
      expect(bus.sent).toHaveLength(0)
    })
  })
})
