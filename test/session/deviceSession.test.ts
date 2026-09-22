import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FakeBus } from '../helpers/FakeBus.js'
import { DeviceSession, DEFAULT_TIMEOUT_MS } from '../../src/session/deviceSession.js'
import type { RequestSpec } from '../../src/session/deviceSession.js'
import { ACCESS_LEVEL_1_REFRESH_MS } from '../../src/session/accessLevel.js'
import {
  decodeSpeedCurve,
  requestProprietary,
  requestSpeedCurve,
  setSpeedCurve
} from '../../src/protocol/codec.js'
import type { CurvePoint, DecodedPgn } from '../../src/protocol/codec.js'
import { AirmarPid, PGN } from '../../src/protocol/pids.js'

const DEVICE = 22
const GATEWAY = 100
const OTHER_DEVICE = 7
const OTHER_NODE = 3

const GLOBAL = 255

/** A Calibrate Speed reply, addressed to the gateway unless told otherwise. */
const curveReply = (over: Partial<DecodedPgn> = {}): DecodedPgn => ({
  pgn: PGN.proprietary,
  src: DEVICE,
  dst: GATEWAY,
  fields: {
    proprietaryId: 'Calibrate Speed',
    numberOfPairsOfDataPoints: 1,
    list: [{ inputFrequency: 10, outputSpeed: 1.2 }]
  },
  ...over
})

/** A Speed Filter reply; PID 43 sends one per filter type. */
const filterReply = (filterType: string): DecodedPgn => ({
  pgn: PGN.proprietary,
  src: DEVICE,
  dst: GATEWAY,
  fields: { proprietaryId: 'Speed Filter', filterType }
})

interface AckOptions {
  pgnErrorCode?: string
  parameterErrors?: (string | undefined)[]
  acknowledgedPgn?: number
  src?: number
  dst?: number
}

const acknowledge = (options: AckOptions = {}): DecodedPgn => ({
  pgn: PGN.groupFunction,
  src: options.src ?? DEVICE,
  dst: options.dst ?? GATEWAY,
  fields: {
    functionCode: 'Acknowledge',
    pgn: options.acknowledgedPgn ?? PGN.proprietary,
    pgnErrorCode: options.pgnErrorCode ?? 'Acknowledge',
    transmissionIntervalPriorityErrorCode: 'Acknowledge',
    list: (options.parameterErrors ?? []).map((error) => ({
      parameter: error ?? 'Acknowledge'
    }))
  }
})

const readCurve = (): RequestSpec<CurvePoint[]> => ({
  key: 'curve',
  message: requestSpeedCurve(DEVICE),
  acknowledgedPgn: PGN.proprietary,
  match: decodeSpeedCurve
})

const readSpeedFilter = (): RequestSpec<string> => ({
  key: 'speedFilter',
  message: requestProprietary(DEVICE, AirmarPid.SpeedFilter),
  acknowledgedPgn: PGN.proprietary,
  expectedReplies: 2,
  match: (reply) => {
    const filterType = reply.fields?.filterType
    return reply.fields?.proprietaryId === 'Speed Filter' && typeof filterType === 'string'
      ? filterType
      : null
  }
})

/** A Level-1 command: the acknowledgement is the whole answer. */
const writeCurve = (): RequestSpec<never> => ({
  key: 'writeCurve',
  message: setSpeedCurve(DEVICE, [{ hz: 10, speed: 1.2 }]),
  acknowledgedPgn: PGN.proprietary,
  requiresLevel1: true
})

describe('DeviceSession', () => {
  let bus: FakeBus
  let observed: DecodedPgn[]
  let session: DeviceSession

  beforeEach(() => {
    vi.useFakeTimers()
    bus = new FakeBus()
    observed = []
    session = new DeviceSession({
      address: DEVICE,
      bus,
      onObservation: (pgn) => observed.push(pgn)
    })
  })

  afterEach(() => {
    session.close()
    vi.useRealTimers()
  })

  /** Let the queue send, so a test can answer what is on the bus. */
  const flush = () => vi.advanceTimersByTimeAsync(0)

  describe('correlation', () => {
    it('resolves a request from the reply that answers it', async () => {
      const pending = session.request(readCurve())
      await flush()
      bus.deliver(curveReply())
      const outcome = await pending

      expect(outcome.status).toBe('answered')
      expect(outcome.status === 'answered' && outcome.value).toEqual([[{ hz: 10, speed: 1.2 }]])
    })

    it('waits for every reply a multi-reply request declares', async () => {
      const pending = session.request(readSpeedFilter())
      await flush()

      bus.deliver(filterReply('Basic filter'))
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1)
      bus.deliver(filterReply('Response filter'))
      const outcome = await pending

      expect(outcome.status === 'answered' && outcome.value).toEqual([
        'Basic filter',
        'Response filter'
      ])
    })

    it('sends one frame for two identical concurrent requests and resolves both', async () => {
      const first = session.request(readCurve())
      const second = session.request(readCurve())
      await flush()

      expect(bus.sent).toHaveLength(1)

      bus.deliver(curveReply())
      const [a, b] = await Promise.all([first, second])

      expect(a.status).toBe('answered')
      expect(b.status).toBe('answered')
      expect(a).toEqual(b)
    })

    it('ignores a reply from another device and times out', async () => {
      const pending = session.request(readCurve())
      await flush()

      bus.deliver(curveReply({ src: OTHER_DEVICE }))
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      const outcome = await pending

      expect(outcome.status).toBe('unknown')
      expect(observed).toHaveLength(0)
    })

    it('accepts a global reply into the cache without addressing it to anyone', async () => {
      void session.request(readCurve())
      await flush()
      bus.deliver(curveReply({ dst: GLOBAL }))

      expect(observed).toHaveLength(1)
    })

    it('does not resurrect a timed-out request with a late reply, but does cache it', async () => {
      const pending = session.request(readCurve())
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      const outcome = await pending

      expect(outcome.status).toBe('unknown')

      bus.deliver(curveReply())
      expect(observed).toHaveLength(1)
      expect(outcome.status).toBe('unknown')
    })
  })

  describe('gateway address', () => {
    const answerOnce = async () => {
      const pending = session.request(readCurve())
      await flush()
      bus.deliver(curveReply())
      await pending
    }

    it('accepts another node’s addressed reply until the gateway address is known', async () => {
      const pending = session.request(readCurve())
      await flush()

      bus.deliver(curveReply({ dst: OTHER_NODE }))
      const outcome = await pending

      expect(session.gatewayAddress).toBeNull()
      expect(outcome.status).toBe('answered')
    })

    it('learns its own address from two agreeing replies and then ignores other nodes', async () => {
      await answerOnce()
      expect(session.gatewayAddress).toBeNull()
      await answerOnce()
      expect(session.gatewayAddress).toBe(GATEWAY)

      const pending = session.request(readCurve())
      await flush()
      bus.deliver(curveReply({ dst: OTHER_NODE }))
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect((await pending).status).toBe('unknown')
    })

    it('forgets a learned address after a timeout, so a wrong guess cannot persist', async () => {
      await answerOnce()
      await answerOnce()
      expect(session.gatewayAddress).toBe(GATEWAY)

      const pending = session.request(readCurve())
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await pending

      expect(session.gatewayAddress).toBeNull()
    })
  })

  describe('outcomes', () => {
    it('reports a refused PGN as rejected rather than as silence', async () => {
      const pending = session.request(readCurve())
      await flush()
      bus.deliver(acknowledge({ pgnErrorCode: 'PGN not supported' }))
      const outcome = await pending

      expect(outcome.status).toBe('rejected')
      expect(outcome.status === 'rejected' && outcome.reason).toContain('PGN not supported')
      expect(bus.sent).toHaveLength(1)
    })

    it('ignores an Acknowledge that names another PGN', async () => {
      const pending = session.request(readCurve())
      await flush()
      bus.deliver(acknowledge({ pgnErrorCode: 'Access denied', acknowledgedPgn: PGN.waterDepth }))
      bus.deliver(curveReply())

      expect((await pending).status).toBe('answered')
    })

    it('waits for the data after an ok Acknowledge, which is not a read’s answer', async () => {
      const pending = session.request(readCurve())
      await flush()
      bus.deliver(acknowledge())
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1)
      bus.deliver(curveReply())
      const outcome = await pending

      expect(outcome.status === 'answered' && outcome.value).toEqual([[{ hz: 10, speed: 1.2 }]])
    })

    it('retries a temporary error exactly once, then surfaces it', async () => {
      const pending = session.request(readCurve())
      await flush()
      bus.deliver(acknowledge({ parameterErrors: ['Temporary error'] }))
      await flush()

      expect(bus.sent).toHaveLength(2)

      bus.deliver(acknowledge({ parameterErrors: ['Temporary error'] }))
      const outcome = await pending

      expect(bus.sent).toHaveLength(2)
      expect(outcome.status).toBe('rejected')
      expect(outcome.status === 'rejected' && outcome.reason).toContain('Temporary error')
    })
  })

  describe('access level', () => {
    /** Answer the unlock command on the bus with an ok Acknowledge. */
    const grantUnlock = async () => {
      await flush()
      bus.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }))
      await flush()
    }

    it('unlocks before the operation it protects, in that order on the bus', async () => {
      const pending = session.request(writeCurve())
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel])

      bus.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }))
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary])

      bus.deliver(acknowledge())
      expect((await pending).status).toBe('answered')
    })

    it('does not unlock again for a second operation inside the level’s lifetime', async () => {
      const first = session.request(writeCurve())
      await grantUnlock()
      bus.deliver(acknowledge())
      await first

      const second = session.request({ ...writeCurve(), key: 'writeCurve2' })
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary, PGN.proprietary])
      bus.deliver(acknowledge())
      await second
    })

    it('re-unlocks a minute before the device expires the level', async () => {
      const first = session.request(writeCurve())
      await grantUnlock()
      bus.deliver(acknowledge())
      await first

      await vi.advanceTimersByTimeAsync(ACCESS_LEVEL_1_REFRESH_MS)

      const second = session.request({ ...writeCurve(), key: 'writeCurve2' })
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary, PGN.accessLevel])
      bus.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }))
      await flush()
      bus.deliver(acknowledge())
      await second
    })

    it('re-unlocks and retries once when the device reports access denied', async () => {
      const pending = session.request(writeCurve())
      await grantUnlock()

      bus.deliver(acknowledge({ pgnErrorCode: 'Access denied' }))
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary, PGN.accessLevel])

      bus.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }))
      await flush()

      expect(bus.targets()).toEqual([
        PGN.accessLevel,
        PGN.proprietary,
        PGN.accessLevel,
        PGN.proprietary
      ])

      bus.deliver(acknowledge({ pgnErrorCode: 'Access denied' }))
      const outcome = await pending

      expect(outcome.status).toBe('rejected')
      expect(bus.sent).toHaveLength(4)
    })

    it('leaves Level 1 available when the unlock goes unanswered', async () => {
      const pending = session.request(writeCurve())
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      const outcome = await pending

      expect(outcome.status).toBe('unknown')
      expect(session.level1Unavailable).toBe(false)

      const second = session.request({ ...writeCurve(), key: 'writeCurve2' })
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.accessLevel])
      bus.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }))
      await flush()
      bus.deliver(acknowledge())
      expect((await second).status).toBe('answered')
    })

    it('stops at a NAKed unlock instead of looping, and refuses later operations', async () => {
      const pending = session.request(writeCurve())
      await flush()
      bus.deliver(
        acknowledge({ acknowledgedPgn: PGN.accessLevel, pgnErrorCode: 'PGN not supported' })
      )
      const outcome = await pending

      expect(outcome.status).toBe('rejected')
      expect(session.level1Unavailable).toBe(true)
      expect(bus.sent).toHaveLength(1)

      const second = await session.request({ ...writeCurve(), key: 'writeCurve2' })

      expect(second.status).toBe('rejected')
      expect(bus.sent).toHaveLength(1)
    })
  })

  it('stops listening and fails queued work when closed', async () => {
    const pending = session.request(readCurve())
    await flush()
    session.close()

    expect((await pending).status).toBe('unknown')

    bus.deliver(curveReply())
    expect(observed).toHaveLength(0)
  })
})
