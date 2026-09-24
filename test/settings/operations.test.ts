import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FakeBus } from '../helpers/FakeBus.js'
import { decode } from '../helpers/canboat.js'
import { acknowledge, curveReply } from '../helpers/replies.js'
import { readSetting, writeSetting } from '../../src/settings/operations.js'
import {
  DeviceSession,
  DEFAULT_TIMEOUT_MS,
  MAX_QUEUE_DEPTH
} from '../../src/session/deviceSession.js'
import { requestStandardPgn, restoreDefaultSpeedCurve } from '../../src/protocol/codec.js'
import type { DecodedPgn } from '../../src/protocol/messages.js'
import { AirmarPid, PGN, pidName } from '../../src/protocol/pids.js'

const DEVICE = 22
const GATEWAY = 100
const from = { src: DEVICE, dst: GATEWAY }
const READ_AT = new Date('2026-09-23T12:00:00.000Z')

const speedOfSoundReply = (value: number): DecodedPgn => ({
  ...decode({
    pgn: PGN.proprietary,
    dst: GATEWAY,
    prio: 7,
    fields: {
      manufacturerCode: 'Airmar',
      industryCode: 'Marine Industry',
      proprietaryId: pidName(AirmarPid.CalibrateDepth),
      speedOfSoundMode: value
    }
  }),
  ...from
})

const depthReply = (offset: number): DecodedPgn => ({
  ...decode({ pgn: PGN.waterDepth, dst: 255, prio: 3, fields: { sid: 1, depth: 12, offset } }),
  src: DEVICE,
  dst: 255
})

describe('settings operations', () => {
  let bus: FakeBus
  let session: DeviceSession

  beforeEach(() => {
    vi.useFakeTimers()
    bus = new FakeBus()
    session = new DeviceSession({ address: DEVICE, bus, now: () => Date.now() })
  })

  afterEach(() => {
    session.close()
    vi.useRealTimers()
  })

  const flush = () => vi.advanceTimersByTimeAsync(0)
  const now = () => READ_AT

  /** Answer the unlock that a Level 1 operation starts with. */
  const grantUnlock = async () => {
    await flush()
    bus.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }, from))
    await flush()
  }

  describe('reading', () => {
    it('returns the device’s value with the time it was read', async () => {
      const pending = readSetting(session, 'depthOffset', undefined, now)
      await flush()
      bus.deliver(depthReply(0.35))

      expect(await pending).toEqual({
        status: 'answered',
        value: 0.35,
        readAt: READ_AT.toISOString()
      })
    })

    it('reports silence as unknown', async () => {
      const pending = readSetting(session, 'depthOffset', undefined, now)
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect((await pending).status).toBe('unknown')
    })

    it('says a write-only setting cannot be read, without touching the bus', async () => {
      const result = await readSetting(session, 'speedFilter', undefined, now)

      expect(result.status).toBe('invalid')
      expect(bus.sent).toHaveLength(0)
    })
  })

  describe('writing', () => {
    it('reads back exactly once after the acknowledgement and reports what was stored', async () => {
      const pending = writeSetting(session, 'depthOffset', 0.35, undefined, now)
      await flush()
      bus.deliver(acknowledge({ acknowledgedPgn: PGN.waterDepth }, from))
      await flush()

      expect(bus.targets()).toEqual([PGN.waterDepth, PGN.waterDepth])

      bus.deliver(depthReply(0.35))

      expect(await pending).toEqual({
        status: 'applied',
        stored: 0.35,
        readAt: READ_AT.toISOString()
      })
      expect(bus.sent).toHaveLength(2)
    })

    it('counts a stored value within the device’s resolution as applied', async () => {
      const pending = writeSetting(session, 'speedOfSound', 1500.04, undefined, now)
      await grantUnlock()
      bus.deliver(acknowledge({}, from))
      await flush()
      bus.deliver(speedOfSoundReply(1500))

      expect((await pending).status).toBe('applied')
    })

    it('shows the stored value beside the requested one when they differ, without calling it a failure', async () => {
      const pending = writeSetting(session, 'speedOfSound', 1520, undefined, now)
      await grantUnlock()
      bus.deliver(acknowledge({}, from))
      await flush()
      bus.deliver(speedOfSoundReply(1500))

      expect(await pending).toEqual({
        status: 'storedDiffers',
        requested: 1520,
        stored: 1500,
        readAt: READ_AT.toISOString()
      })
    })

    it('refuses an out-of-range value before it reaches the bus', async () => {
      const result = await writeSetting(session, 'speedOfSound', 2000, undefined, now)

      expect(result.status).toBe('invalid')
      expect(bus.sent).toHaveLength(0)
    })

    it('surfaces the device’s own out-of-range code and what the device holds', async () => {
      const pending = writeSetting(session, 'speedOfSound', 1500, undefined, now)
      await grantUnlock()
      // Parameters 1, 3, 4 and 5 were commanded; the device refuses the fourth.
      bus.deliver(
        acknowledge(
          { parameterErrors: [undefined, undefined, undefined, 'Parameter out of range'] },
          from
        )
      )
      await flush()
      bus.deliver(speedOfSoundReply(1480))
      const result = await pending

      expect(result.status).toBe('rejected')
      expect(result.status === 'rejected' && result.detail.parameterErrors).toEqual([
        { index: 4, error: 'Parameter out of range' }
      ])
      expect(result.status === 'rejected' && result.readBack).toEqual({
        status: 'answered',
        value: 1480,
        readAt: READ_AT.toISOString()
      })
      expect(result.status === 'rejected' && result.refusedFields).toEqual([
        { field: 'value', error: 'Parameter out of range' }
      ])
      expect(result.status === 'rejected' && result.requested).toBe(1500)
      expect(result.status === 'rejected' && result.storedMatches).toBe(false)
    })

    it('restores the factory curve and reports the curve the device then holds', async () => {
      const pending = writeSetting(session, 'speedCurve', 'factory', undefined, now)
      await grantUnlock()

      const sent = bus.sent.filter((m) => 'fields' in m && m.fields.pgn === PGN.proprietary)
      expect(sent).toEqual([restoreDefaultSpeedCurve(session.address)])

      bus.deliver(acknowledge({}, from))
      await flush()
      const factory = [
        { hz: 0, speed: 0 },
        { hz: 50, speed: 5 }
      ]
      bus.deliver(curveReply(factory, from))

      expect(await pending).toEqual({
        status: 'applied',
        stored: factory,
        readAt: READ_AT.toISOString()
      })
    })

    it('reports a refused restore with the curve the device kept', async () => {
      const pending = writeSetting(session, 'speedCurve', 'factory', undefined, now)
      await grantUnlock()
      bus.deliver(
        acknowledge(
          { parameterErrors: [undefined, undefined, undefined, 'Parameter out of range'] },
          from
        )
      )
      await flush()
      bus.deliver(curveReply([{ hz: 10, speed: 1 }], from))
      const result = await pending

      expect(result.status).toBe('rejected')
      expect(result.status === 'rejected' && result.requested).toBe('factory')
      // The plugin does not know the factory points, so it cannot say whether the kept curve is them.
      expect(result).not.toHaveProperty('storedMatches')
      expect(result.status === 'rejected' && result.readBack).toEqual({
        status: 'answered',
        value: [{ hz: 10, speed: 1 }],
        readAt: READ_AT.toISOString()
      })
    })

    it('reads back a curve the device refused in part, so the console can show both', async () => {
      const asked = [
        { hz: 10, speed: 1 },
        { hz: 20, speed: 2 }
      ]
      const pending = writeSetting(session, 'speedCurve', asked, undefined, now)
      await grantUnlock()

      expect(
        bus.sent.filter((m) => 'fields' in m && m.fields.pgn === PGN.proprietary)
      ).toHaveLength(1)

      bus.deliver(
        acknowledge(
          {
            parameterErrors: [
              undefined,
              undefined,
              undefined,
              undefined,
              undefined,
              'Parameter out of range'
            ]
          },
          from
        )
      )
      await flush()
      bus.deliver(curveReply([{ hz: 10, speed: 1 }], from))
      const result = await pending

      expect(result.status).toBe('rejected')
      expect(result.status === 'rejected' && result.readBack).toEqual({
        status: 'answered',
        value: [{ hz: 10, speed: 1 }],
        readAt: READ_AT.toISOString()
      })
      // The sixth commanded parameter is field 7: the first point's speed.
      expect(result.status === 'rejected' && result.refusedFields).toEqual([
        { field: 'point 1 speed', error: 'Parameter out of range' }
      ])
      expect(result.status === 'rejected' && result.storedMatches).toBe(false)
    })

    it('reports a write that times out as unknown, distinct from a rejection, and reads nothing back', async () => {
      const pending = writeSetting(session, 'depthOffset', 0.35, undefined, now)
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      const result = await pending

      expect(result.status).toBe('unknown')
      expect(bus.sent).toHaveLength(1)
    })

    it('reports a write-only setting as acknowledged, with no read-back', async () => {
      const pending = writeSetting(
        session,
        'speedFilter',
        { type: 1, sampleInterval: 0.25, filterDuration: 2 },
        undefined,
        now
      )
      await grantUnlock()
      bus.deliver(acknowledge({}, from))

      expect(await pending).toEqual({ status: 'acknowledged' })
      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary])
    })

    it('reports a refused write-only setting without trying to read it', async () => {
      const pending = writeSetting(session, 'speedFilter', { type: 1 }, undefined, now)
      await grantUnlock()
      bus.deliver(
        acknowledge(
          { parameterErrors: [undefined, undefined, undefined, 'Parameter out of range'] },
          from
        )
      )
      const result = await pending

      expect(result.status).toBe('rejected')
      expect(result.status === 'rejected' && result.readBack).toBeUndefined()
      expect(result.status === 'rejected' && result.refusedFields).toEqual([
        { field: 'type', error: 'Parameter out of range' }
      ])
      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary])
    })
    it('reports an acknowledged write whose read-back goes unanswered as acknowledged', async () => {
      const pending = writeSetting(session, 'depthOffset', 0.35, undefined, now)
      await flush()
      bus.deliver(acknowledge({ acknowledgedPgn: PGN.waterDepth }, from))
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS * 2)
      const result = await pending

      expect(result.status).toBe('acknowledged')
      expect(result.status === 'acknowledged' && result.readBack?.status).toBe('unknown')
    })

    it('reports a refused unlock as not sent, and reads nothing back', async () => {
      const pending = writeSetting(session, 'speedOfSound', 1500, undefined, now)
      await flush()
      bus.deliver(
        acknowledge({ acknowledgedPgn: PGN.accessLevel, pgnErrorCode: 'PGN not supported' }, from)
      )

      expect(await pending).toEqual({
        status: 'notSent',
        reason: 'Access Level 1 refused: PGN not supported'
      })
      expect(bus.targets()).toEqual([PGN.accessLevel])
    })

    it('reports a full backlog as not sent, and reads nothing back', async () => {
      for (let i = 0; i < MAX_QUEUE_DEPTH + 1; i += 1) {
        void session.command({ message: requestStandardPgn(DEVICE, PGN.distanceLog) })
      }
      const result = await writeSetting(session, 'depthOffset', 0.35, undefined, now)

      expect(result).toEqual({
        status: 'notSent',
        reason: 'The device has a backlog of unanswered requests'
      })
    })

    it('does not read back after an access denial, which would spend a second unlock', async () => {
      const pending = writeSetting(session, 'speedOfSound', 1500, undefined, now)
      await grantUnlock()
      bus.deliver(acknowledge({ pgnErrorCode: 'Access denied' }, from))
      await flush()
      // The session re-unlocks once; the device refuses that too.
      bus.deliver(
        acknowledge({ acknowledgedPgn: PGN.accessLevel, pgnErrorCode: 'Access denied' }, from)
      )
      const result = await pending

      expect(result.status).toBe('rejected')
      expect(result.status === 'rejected' && result.readBack).toBeUndefined()
      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary, PGN.accessLevel])
      expect(session.level1Unavailable).toBe(false)
    })
    it('reports a write on a closed session as not sent, and sends nothing', async () => {
      session.close('The device moved from address 22 to 31')
      const result = await writeSetting(session, 'depthOffset', 0.35, undefined, now)

      expect(result).toEqual({
        status: 'notSent',
        reason: 'The device moved from address 22 to 31'
      })
      expect(bus.sent).toHaveLength(0)
    })

    it('reports a write as not sent when the session closes during its unlock', async () => {
      const pending = writeSetting(session, 'temperatureOffset', 0.5, 1, now)
      await flush()
      session.close()
      const result = await pending

      expect(result).toEqual({ status: 'notSent', reason: 'The session was closed' })
      expect(bus.targets()).toEqual([PGN.accessLevel])
    })

    it('reports a retried write as not sent when the session closes while it waits out the mute', async () => {
      const first = writeSetting(session, 'depthOffset', 0.35, undefined, now)
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await first
      const retry = writeSetting(session, 'depthOffset', 0.35, undefined, now)
      await vi.advanceTimersByTimeAsync(10)
      session.close()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect(await retry).toEqual({ status: 'notSent', reason: 'The session was closed' })
      expect(bus.sent).toHaveLength(1)
    })

    it('writes a qualified setting for the source it names, and reads back that source', async () => {
      const pending = writeSetting(session, 'temperatureOffset', 0.5, 1, now)
      await grantUnlock()
      bus.deliver(acknowledge({}, from))
      await flush()

      const readBack = bus.sent.at(-1)
      expect(readBack !== undefined && 'fields' in readBack && readBack.fields.list).toContainEqual(
        {
          parameter: 5,
          value: 1
        }
      )

      bus.deliver({
        ...decode({
          pgn: PGN.proprietary,
          dst: GATEWAY,
          prio: 7,
          fields: {
            manufacturerCode: 'Airmar',
            industryCode: 'Marine Industry',
            proprietaryId: pidName(AirmarPid.CalibrateTemperature),
            temperatureInstance: 'Onboard Water Sensor',
            temperatureOffset: 0.5
          }
        }),
        ...from
      })

      expect(await pending).toEqual({
        status: 'applied',
        stored: 0.5,
        readAt: READ_AT.toISOString()
      })
    })

    it('reports each of two queued writes against its own value', async () => {
      const first = writeSetting(session, 'depthOffset', 0.35, undefined, now)
      const second = writeSetting(session, 'depthOffset', 0.5, undefined, now)
      await flush()
      bus.deliver(acknowledge({ acknowledgedPgn: PGN.waterDepth }, from))
      await flush()
      bus.deliver(depthReply(0.35))
      await flush()
      bus.deliver(acknowledge({ acknowledgedPgn: PGN.waterDepth }, from))
      await flush()
      bus.deliver(depthReply(0.5))

      expect((await first).status).toBe('applied')
      expect((await second).status).toBe('applied')
    })
  })
})
