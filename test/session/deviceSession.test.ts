import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FakeBus } from '../helpers/FakeBus.js'
import { decodeLine } from '../helpers/canboat.js'
import { acknowledge, curveReply, depthCalibrationReply, pgnListReply } from '../helpers/replies.js'
import {
  DeviceSession,
  DEFAULT_TIMEOUT_MS,
  MAX_QUEUE_DEPTH
} from '../../src/session/deviceSession.js'
import type { ReadSpec, CommandSpec } from '../../src/session/deviceSession.js'
import { ACCESS_LEVEL_1_REFRESH_MS, ACCESS_LEVEL_1_TTL_MS } from '../../src/session/accessLevel.js'
import {
  commandStandardField,
  decodeSpeedCurve,
  masterReset,
  requestInterval,
  requestSpeedCurve,
  setSpeedCurve
} from '../../src/protocol/codec.js'
import type { CurvePoint, DecodedPgn } from '../../src/protocol/codec.js'
import { PGN } from '../../src/protocol/pids.js'

const DEVICE = 22
const GATEWAY = 100
const OTHER_DEVICE = 7
const OTHER_NODE = 3
const GLOBAL = 255

const CURVE: CurvePoint[] = [{ hz: 10, speed: 1.2 }]
const OTHER_CURVE: CurvePoint[] = [{ hz: 44, speed: 3.5 }]

const fromDevice = (dst: number = GATEWAY) => ({ src: DEVICE, dst })

const readCurve = (): ReadSpec<CurvePoint[]> => ({
  message: requestSpeedCurve(DEVICE),
  match: decodeSpeedCurve
})

/** PGN 126464 with no function code: the device answers with two lists. */
const readPgnLists = (): ReadSpec<string> => ({
  message: commandStandardField(DEVICE, PGN.pgnList, []),
  expectedReplies: 2,
  match: (reply) => {
    const functionCode = reply.fields?.functionCode
    return reply.pgn === PGN.pgnList && typeof functionCode === 'string' ? functionCode : null
  }
})

const writeCurve = (points: CurvePoint[] = CURVE): CommandSpec => ({
  message: setSpeedCurve(DEVICE, points),
  requiresLevel1: true
})

describe('DeviceSession', () => {
  let bus: FakeBus
  let observed: DecodedPgn[]
  let errors: unknown[]
  let session: DeviceSession

  beforeEach(() => {
    // Vitest fakes Date alongside the timers, so the session's injected clock
    // moves with advanceTimersByTimeAsync. The access-level tests depend on it.
    vi.useFakeTimers()
    bus = new FakeBus()
    observed = []
    errors = []
    session = new DeviceSession({
      address: DEVICE,
      bus,
      now: () => Date.now(),
      onObservation: (pgn) => observed.push(pgn),
      onError: (error) => errors.push(error)
    })
  })

  afterEach(() => {
    session.close()
    vi.useRealTimers()
  })

  /** Let the queue send, so a test can answer what is on the bus. */
  const flush = () => vi.advanceTimersByTimeAsync(0)

  /** Answer one read, which is also how the session learns the gateway address. */
  const answerOnce = async () => {
    const pending = session.read(readCurve())
    await flush()
    bus.deliver(curveReply(CURVE, fromDevice()))
    return pending
  }

  const grantUnlock = async () => {
    await flush()
    bus.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }, fromDevice()))
    await flush()
  }

  describe('correlation', () => {
    it('resolves a read from the reply that answers it', async () => {
      const pending = session.read(readCurve())
      await flush()
      bus.deliver(curveReply(CURVE, fromDevice()))
      const outcome = await pending

      expect(outcome).toEqual({ status: 'answered', value: [CURVE] })
    })

    it('waits for every reply a multi-reply read declares', async () => {
      const pending = session.read(readPgnLists())
      await flush()

      bus.deliver(pgnListReply('Transmit PGN list', [128267], fromDevice()))
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1)
      bus.deliver(pgnListReply('Receive PGN list', [126208], fromDevice()))
      const outcome = await pending

      expect(outcome.status === 'answered' && outcome.value).toEqual([
        'Transmit PGN list',
        'Receive PGN list'
      ])
    })

    it('counts a repeated reply once, so a duplicate cannot fill the budget', async () => {
      const pending = session.read(readPgnLists())
      await flush()

      bus.deliver(pgnListReply('Transmit PGN list', [128267], fromDevice()))
      bus.deliver(pgnListReply('Transmit PGN list', [128267], fromDevice()))
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1)

      expect(bus.sent).toHaveLength(1)

      bus.deliver(pgnListReply('Receive PGN list', [126208], fromDevice()))
      const outcome = await pending

      expect(outcome.status === 'answered' && outcome.value).toEqual([
        'Transmit PGN list',
        'Receive PGN list'
      ])
    })

    it('sends one frame for two identical concurrent reads and resolves both', async () => {
      const first = session.read(readCurve())
      const second = session.read(readCurve())
      await flush()

      expect(bus.sent).toHaveLength(1)

      bus.deliver(curveReply(CURVE, fromDevice()))
      const [a, b] = await Promise.all([first, second])

      expect(a.status).toBe('answered')
      expect(a).toEqual(b)
    })

    it('never coalesces commands, because two writes carry two values', async () => {
      const first = session.command(writeCurve(CURVE))
      const second = session.command(writeCurve(OTHER_CURVE))
      await grantUnlock()
      bus.deliver(acknowledge({}, fromDevice()))
      await first
      await flush()
      bus.deliver(acknowledge({}, fromDevice()))
      await second

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary, PGN.proprietary])
      expect(bus.sent[1]).not.toEqual(bus.sent[2])
    })

    it('ignores a reply from another device and times out', async () => {
      const pending = session.read(readCurve())
      await flush()

      bus.deliver(curveReply(CURVE, { src: OTHER_DEVICE, dst: GATEWAY }))
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect((await pending).status).toBe('unknown')
      expect(observed).toHaveLength(0)
    })

    it('ignores a 126720 reply naming a different proprietary ID', async () => {
      // A matcher that accepts anything, so only the session's own PID check
      // can keep another question's answer out of this read.
      const pending = session.read({ ...readCurve(), match: () => 'anything' })
      await flush()

      bus.deliver(depthCalibrationReply(0.5, fromDevice()))
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect((await pending).status).toBe('unknown')
      expect(observed).toHaveLength(1)
    })

    it('ignores the periodic traffic the matcher rejects', async () => {
      const pending = session.read(readCurve())
      await flush()

      bus.deliver({ pgn: PGN.waterDepth, ...fromDevice(), fields: { depth: 4.2 } })
      bus.deliver(curveReply(CURVE, fromDevice()))
      const outcome = await pending

      expect(outcome.status === 'answered' && outcome.value).toEqual([CURVE])
    })

    it('accepts a global reply into the cache and as an answer once addressing is known', async () => {
      await answerOnce()
      await answerOnce()

      expect(session.gatewayAddress).toBe(GATEWAY)

      const pending = session.read(readCurve())
      await flush()
      bus.deliver(curveReply(CURVE, { src: DEVICE, dst: GLOBAL }))

      expect((await pending).status).toBe('answered')
      expect(observed).toHaveLength(3)
    })

    it('caches an addressed reply meant for another node without answering with it', async () => {
      await answerOnce()
      await answerOnce()

      const pending = session.read(readCurve())
      await flush()
      bus.deliver(curveReply(OTHER_CURVE, { src: DEVICE, dst: OTHER_NODE }))
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect((await pending).status).toBe('unknown')
      expect(observed).toHaveLength(3)
    })

    it('does not resurrect a timed-out read with a late reply, but does cache it', async () => {
      const pending = session.read(readCurve())
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect((await pending).status).toBe('unknown')

      bus.deliver(curveReply(CURVE, fromDevice()))

      expect(observed).toHaveLength(1)
      expect(bus.sent).toHaveLength(1)
    })

    it('never lets a late reply settle anything, whichever arrives first', async () => {
      const first = session.read(readCurve())
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await first

      // The next read is held back until the mute lapses, so it cannot race
      // the device's late answer to the read that gave up.
      const second = session.read(readCurve())
      await flush()

      expect(bus.sent).toHaveLength(1)

      bus.deliver(curveReply(OTHER_CURVE, fromDevice()))
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect(bus.sent).toHaveLength(2)

      bus.deliver(curveReply(CURVE, fromDevice()))
      const outcome = await second

      expect(outcome.status === 'answered' && outcome.value).toEqual([CURVE])
    })

    it('holds back the next command of a shape whose acknowledgement may still arrive', async () => {
      const first = session.command({ message: setSpeedCurve(DEVICE, CURVE) })
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await first

      const second = session.command({ message: setSpeedCurve(DEVICE, OTHER_CURVE) })
      await flush()

      expect(bus.sent).toHaveLength(1)

      bus.deliver(acknowledge({}, fromDevice()))
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect(bus.sent).toHaveLength(2)

      bus.deliver(acknowledge({}, fromDevice()))

      expect((await second).status).toBe('answered')
    })

    it('does not hold back an unrelated shape', async () => {
      const first = session.read(readCurve())
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await first

      const other = session.read(readPgnLists())
      await flush()

      expect(bus.sent).toHaveLength(2)

      bus.deliver(pgnListReply('Transmit PGN list', [128267], fromDevice()))
      bus.deliver(pgnListReply('Receive PGN list', [126208], fromDevice()))

      expect((await other).status).toBe('answered')
    })

    it('answers a device slower than the timeout instead of failing for ever', async () => {
      const LATENCY = DEFAULT_TIMEOUT_MS + 500

      // The device answers every request, just later than the session waits.
      const first = session.read(readCurve())
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect((await first).status).toBe('unknown')

      // Its answer lands inside the mute, which is what tells the session the
      // timeout is too short for this bus.
      await vi.advanceTimersByTimeAsync(LATENCY - DEFAULT_TIMEOUT_MS)
      expect(session.currentTimeoutMs).toBe(DEFAULT_TIMEOUT_MS)
      bus.deliver(curveReply(CURVE, fromDevice()))

      expect(session.currentTimeoutMs).toBe(2 * DEFAULT_TIMEOUT_MS)

      const second = session.read(readCurve())
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect(bus.sent).toHaveLength(2)

      await vi.advanceTimersByTimeAsync(LATENCY)
      bus.deliver(curveReply(CURVE, fromDevice()))

      expect((await second).status === 'answered').toBe(true)
    })

    it('does not dedupe two distinct replies whose decoded values are equal', async () => {
      // A decoder that discards the discriminating field. The session must key
      // on the frame, not on what the caller made of it.
      const pending = session.read({ ...readPgnLists(), match: () => 'same' })
      await flush()
      bus.deliver(pgnListReply('Transmit PGN list', [128267], fromDevice()))
      bus.deliver(pgnListReply('Receive PGN list', [126208], fromDevice()))
      const outcome = await pending

      expect(outcome.status === 'answered' && outcome.value).toEqual(['same', 'same'])
    })

    it('does not mute a command’s acknowledgement behind a read that gave up', async () => {
      const read = session.read(readCurve())
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await read

      // A read is owed data; it can never be owed an acknowledgement, so the
      // next write must be sent at once and answered by its own ack.
      const write = session.command({ message: setSpeedCurve(DEVICE, CURVE) })
      await flush()

      expect(bus.sent).toHaveLength(2)

      bus.deliver(acknowledge({}, fromDevice()))

      expect((await write).status).toBe('answered')
    })

    it('does not treat the device’s periodic traffic as a late reply', async () => {
      // A read of a standard PGN has no proprietary ID, so its mute must be
      // keyed on the reply PGN too. Keyed on the ID alone it matches every
      // depth and speed frame, each of which would widen the timeout.
      const first = session.read(readPgnLists())
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await first

      for (let i = 0; i < 4; i += 1) {
        bus.deliver({ pgn: PGN.waterDepth, ...fromDevice(), fields: { depth: 4 + i } })
      }

      // Past the mute, so the next read is sent at once and can only be
      // bounded by the timeout itself.
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      let settled = false
      const second = session.read(readPgnLists())
      void second.then(() => {
        settled = true
      })
      await flush()

      expect(bus.sent).toHaveLength(2)

      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect(settled).toBe(true)
      expect((await second).status).toBe('unknown')
    })

    it('stops holding requests back once the learned address is discarded', async () => {
      await answerOnce()
      await answerOnce()

      const first = session.read(readCurve())
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await first

      // The second probe waits out the first's mute, then times out itself.
      const second = session.read(readCurve())
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS * 2)
      await second

      expect(session.gatewayAddress).toBeNull()

      // Those timeouts were the wrong address, not a slow device, so the
      // recovery must not queue behind the mutes they left.
      const sentBefore = bus.sent.length
      void session.read(readCurve())
      await flush()

      expect(bus.sent).toHaveLength(sentBefore + 1)
    })
  })

  describe('gateway address', () => {
    it('accepts another node’s addressed reply until the gateway address is known', async () => {
      const pending = session.read(readCurve())
      await flush()

      bus.deliver(curveReply(CURVE, { src: DEVICE, dst: OTHER_NODE }))

      expect(session.gatewayAddress).toBeNull()
      expect((await pending).status).toBe('answered')
    })

    it('learns only from two separate exchanges', async () => {
      await answerOnce()

      expect(session.gatewayAddress).toBeNull()

      await answerOnce()

      expect(session.gatewayAddress).toBe(GATEWAY)
    })

    it('does not learn from two replies of one multi-reply exchange', async () => {
      const pending = session.read(readPgnLists())
      await flush()
      bus.deliver(pgnListReply('Transmit PGN list', [128267], { src: DEVICE, dst: OTHER_NODE }))
      bus.deliver(pgnListReply('Receive PGN list', [126208], { src: DEVICE, dst: OTHER_NODE }))
      await pending

      expect(session.gatewayAddress).toBeNull()
    })

    it('never learns an address from a global reply', async () => {
      for (let i = 0; i < 2; i += 1) {
        const pending = session.read(readCurve())
        await flush()
        bus.deliver(curveReply(CURVE, { src: DEVICE, dst: GLOBAL }))
        await pending
      }

      expect(session.gatewayAddress).toBeNull()
    })

    it('keeps the address through one isolated timeout', async () => {
      await answerOnce()
      await answerOnce()

      const probe = session.read(readCurve())
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await probe

      expect(session.gatewayAddress).toBe(GATEWAY)
    })

    it('discards the address after two consecutive timeouts', async () => {
      await answerOnce()
      await answerOnce()

      for (let i = 0; i < 2; i += 1) {
        const probe = session.read(readCurve())
        await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS * 2)
        await probe
      }

      expect(session.gatewayAddress).toBeNull()
    })
  })

  describe('outcomes', () => {
    it('reports a refused PGN as rejected, carrying the device’s own answer', async () => {
      const pending = session.read(readCurve())
      await flush()
      bus.deliver(acknowledge({ pgnErrorCode: 'PGN not supported' }, fromDevice()))
      const outcome = await pending

      expect(outcome.status).toBe('rejected')
      expect(outcome.status === 'rejected' && outcome.reason).toBe('PGN not supported')
      expect(outcome.status === 'rejected' && outcome.detail?.pgnError).toBe('PGN not supported')
      expect(bus.sent).toHaveLength(1)
    })

    it('names the parameter the device refused, by its position in the command', async () => {
      const pending = session.command({ message: setSpeedCurve(DEVICE, CURVE) })
      await flush()
      bus.deliver(
        acknowledge({ parameterErrors: ['Acknowledge', 'Parameter out of range'] }, fromDevice())
      )
      const outcome = await pending

      expect(outcome.status === 'rejected' && outcome.reason).toBe(
        'parameter 2: Parameter out of range'
      )
      expect(outcome.status === 'rejected' && outcome.detail?.parameterErrors).toEqual([
        { index: 2, error: 'Parameter out of range' }
      ])
    })

    it('surfaces a refused transmission interval', async () => {
      const pending = session.command({ message: setSpeedCurve(DEVICE, CURVE) })
      await flush()
      bus.deliver(acknowledge({ intervalErrorCode: 'Transmit Interval too low' }, fromDevice()))
      const outcome = await pending

      expect(outcome.status === 'rejected' && outcome.reason).toBe(
        'interval or priority: Transmit Interval too low'
      )
    })

    it('ignores an Acknowledge that names another PGN', async () => {
      const pending = session.read(readCurve())
      await flush()
      bus.deliver(
        acknowledge(
          { pgnErrorCode: 'Access denied', acknowledgedPgn: PGN.waterDepth },
          fromDevice()
        )
      )
      bus.deliver(curveReply(CURVE, fromDevice()))

      expect((await pending).status).toBe('answered')
    })

    it('waits for the data after an ok Acknowledge, which is not a read’s answer', async () => {
      const pending = session.read(readCurve())
      await flush()
      bus.deliver(acknowledge({}, fromDevice()))
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS - 1)
      bus.deliver(curveReply(CURVE, fromDevice()))

      expect((await pending).status === 'answered').toBe(true)
    })

    it('says how much of a multi-reply read arrived when the rest does not', async () => {
      const pending = session.read(readPgnLists())
      await flush()
      bus.deliver(pgnListReply('Transmit PGN list', [128267], fromDevice()))
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      const outcome = await pending

      expect(outcome).toEqual({
        status: 'unknown',
        reason: 'The device answered 1 of 2 times'
      })
    })

    it('retries a temporary error exactly once, then surfaces it', async () => {
      const pending = session.read(readCurve())
      await flush()
      bus.deliver(acknowledge({ parameterErrors: ['Temporary error'] }, fromDevice()))
      await flush()

      expect(bus.sent).toHaveLength(2)

      bus.deliver(acknowledge({ parameterErrors: ['Temporary error'] }, fromDevice()))
      const outcome = await pending

      expect(bus.sent).toHaveLength(2)
      expect(outcome.status).toBe('rejected')
      expect(outcome.status === 'rejected' && outcome.reason).toContain('Temporary error')
    })
  })

  describe('access level', () => {
    it('unlocks before the operation it protects, in that order on the bus', async () => {
      const pending = session.command(writeCurve())
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel])

      bus.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }, fromDevice()))
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary])

      bus.deliver(acknowledge({}, fromDevice()))

      expect((await pending).status).toBe('answered')
    })

    it('does not unlock again for a second operation inside the level’s lifetime', async () => {
      const first = session.command(writeCurve())
      await grantUnlock()
      bus.deliver(acknowledge({}, fromDevice()))
      await first

      const second = session.command(writeCurve(OTHER_CURVE))
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary, PGN.proprietary])

      bus.deliver(acknowledge({}, fromDevice()))
      await second
    })

    it('re-unlocks a minute before the device expires the level', async () => {
      const first = session.command(writeCurve())
      await grantUnlock()
      bus.deliver(acknowledge({}, fromDevice()))
      await first

      await vi.advanceTimersByTimeAsync(ACCESS_LEVEL_1_REFRESH_MS)

      const second = session.command(writeCurve(OTHER_CURVE))
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary, PGN.accessLevel])

      bus.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }, fromDevice()))
      await flush()
      bus.deliver(acknowledge({}, fromDevice()))
      await second
    })

    it.each([
      ['a PGN error code', { pgnErrorCode: 'Access denied' }],
      ['a parameter error code', { parameterErrors: ['Access denied'] }]
    ])('re-unlocks and retries once when the device denies access by %s', async (_name, ack) => {
      const pending = session.command(writeCurve())
      await grantUnlock()

      bus.deliver(acknowledge(ack, fromDevice()))
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary, PGN.accessLevel])

      bus.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }, fromDevice()))
      await flush()

      expect(bus.targets()).toEqual([
        PGN.accessLevel,
        PGN.proprietary,
        PGN.accessLevel,
        PGN.proprietary
      ])

      bus.deliver(acknowledge(ack, fromDevice()))

      expect((await pending).status).toBe('rejected')
      expect(bus.sent).toHaveLength(4)
    })

    it('re-unlocks when the device denies the interval or priority for lack of access', async () => {
      const pending = session.command(writeCurve())
      await grantUnlock()

      bus.deliver(acknowledge({ intervalErrorCode: 'Access denied' }, fromDevice()))
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary, PGN.accessLevel])

      bus.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }, fromDevice()))
      await flush()
      bus.deliver(acknowledge({}, fromDevice()))

      expect((await pending).status).toBe('answered')
    })

    it('retries once when a temporary error arrives as a raw number', async () => {
      const pending = session.command({ message: setSpeedCurve(DEVICE, CURVE) })
      await flush()

      // Acknowledge of 126720, one parameter, parameter code 2, enums unresolved.
      bus.deliver(
        decodeLine(
          `2026-01-01T00:00:00.000Z,3,126208,${String(DEVICE)},${String(GATEWAY)},7,02,00,ef,01,00,01,f2`,
          { resolveEnums: false }
        )
      )
      await flush()

      expect(bus.targets()).toEqual([PGN.proprietary, PGN.proprietary])

      bus.deliver(acknowledge({}, fromDevice()))

      expect((await pending).status).toBe('answered')
    })

    it('re-unlocks when the access-denied code arrives as a raw number', async () => {
      const pending = session.command(writeCurve())
      await grantUnlock()

      // Acknowledge of 126720 with PGN error code 3, decoded with enums unresolved.
      bus.deliver(
        decodeLine(
          `2026-01-01T00:00:00.000Z,3,126208,${String(DEVICE)},${String(GATEWAY)},6,02,00,ef,01,03,00`,
          { resolveEnums: false }
        )
      )
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary, PGN.accessLevel])

      bus.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }, fromDevice()))
      await flush()
      bus.deliver(acknowledge({}, fromDevice()))

      expect((await pending).status).toBe('answered')
    })

    it('keeps the device’s rejection when the re-unlock goes unanswered', async () => {
      const pending = session.command(writeCurve())
      await grantUnlock()

      bus.deliver(acknowledge({ pgnErrorCode: 'Access denied' }, fromDevice()))
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      const outcome = await pending

      expect(outcome.status).toBe('rejected')
      expect(outcome.status === 'rejected' && outcome.reason).toBe('Access denied')
    })

    it('does not give up on one refused unlock, which may have answered another node', async () => {
      const first = session.command(writeCurve())
      await flush()
      bus.deliver(
        acknowledge(
          { acknowledgedPgn: PGN.accessLevel, pgnErrorCode: 'PGN not supported' },
          fromDevice()
        )
      )

      expect((await first).status).toBe('rejected')
      expect(session.level1Unavailable).toBe(false)

      const second = session.command(writeCurve())
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.accessLevel])

      bus.deliver(
        acknowledge(
          { acknowledgedPgn: PGN.accessLevel, pgnErrorCode: 'PGN not supported' },
          fromDevice()
        )
      )

      expect((await second).status).toBe('rejected')
      expect(session.level1Unavailable).toBe(true)
    })

    it('stops asking once Level 1 is unavailable', async () => {
      for (let i = 0; i < 2; i += 1) {
        const pending = session.command(writeCurve())
        await flush()
        bus.deliver(
          acknowledge(
            { acknowledgedPgn: PGN.accessLevel, pgnErrorCode: 'PGN not supported' },
            fromDevice()
          )
        )
        await pending
      }

      const outcome = await session.command(writeCurve())

      expect(outcome.status).toBe('rejected')
      expect(bus.sent).toHaveLength(2)
    })

    it('reports each change to the access level, and what it now is', async () => {
      const changes: string[] = []
      const watched: DeviceSession = new DeviceSession({
        address: DEVICE,
        bus,
        now: () => Date.now(),
        onAccessChange: () => changes.push(watched.access.state)
      })
      const refuse = async () => {
        const pending = watched.unlock()
        await flush()
        bus.deliver(
          acknowledge(
            { acknowledgedPgn: PGN.accessLevel, pgnErrorCode: 'PGN not supported' },
            fromDevice()
          )
        )
        await pending
      }

      expect(watched.access).toEqual({ state: 'locked' })

      const unlocked = watched.unlock()
      await grantUnlock()
      await unlocked

      expect(watched.access).toMatchObject({ state: 'granted' })

      await vi.advanceTimersByTimeAsync(ACCESS_LEVEL_1_TTL_MS)
      await refuse()
      await refuse()

      expect(changes).toEqual(['granted', 'locked', 'unavailable'])
      expect(watched.access).toMatchObject({ state: 'unavailable' })
      watched.close()
    })

    it('unlocks on request, with no operation to protect', async () => {
      const pending = session.unlock()
      await grantUnlock()

      expect(await pending).toEqual({ status: 'answered', value: undefined })
      expect(bus.targets()).toEqual([PGN.accessLevel])

      expect((await session.unlock()).status).toBe('answered')
      expect(bus.sent).toHaveLength(1)
    })

    it('reports a refused unlock with the device’s acknowledgement', async () => {
      const pending = session.unlock()
      await flush()
      bus.deliver(
        acknowledge(
          { acknowledgedPgn: PGN.accessLevel, pgnErrorCode: 'PGN not supported' },
          fromDevice()
        )
      )
      const outcome = await pending

      expect(outcome.status).toBe('rejected')
      expect(outcome.status === 'rejected' && outcome.detail?.pgnError).toBe('PGN not supported')
    })

    it('leaves Level 1 available when the unlock goes unanswered', async () => {
      const pending = session.command(writeCurve())
      await flush()
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect((await pending).status).toBe('unknown')
      expect(session.level1Unavailable).toBe(false)
    })
  })

  describe('a request the device answers only to refuse', () => {
    const setInterval = (): CommandSpec => ({
      message: requestInterval(DEVICE, PGN.waterDepth, 500),
      silenceMeansAccepted: true
    })

    it('takes silence as acceptance, without counting it as a timeout', async () => {
      await answerOnce()
      await answerOnce()

      for (let i = 0; i < 3; i += 1) {
        const pending = session.command(setInterval())
        await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

        expect(await pending).toEqual({ status: 'answered', value: undefined })
      }
      expect(session.gatewayAddress).toBe(GATEWAY)
    })

    it('leaves the count of timeouts alone, so two failed reads around it still forget the gateway', async () => {
      await answerOnce()
      await answerOnce()
      const first = session.read(readCurve())
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await first
      const accepted = session.command(setInterval())
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await accepted
      const second = session.read(readCurve())
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS * 2)
      await second

      expect(session.gatewayAddress).toBeNull()
    })

    it('reports the device’s refusal', async () => {
      const pending = session.command(setInterval())
      await flush()
      bus.deliver(
        acknowledge(
          { acknowledgedPgn: PGN.waterDepth, intervalErrorCode: 'Transmit Interval too low' },
          fromDevice()
        )
      )

      expect(await pending).toMatchObject({ status: 'rejected' })
    })
  })

  describe('raw frames', () => {
    it('unlocks, sends, and then trusts neither the grant nor the address', async () => {
      await answerOnce()
      await answerOnce()

      expect(session.gatewayAddress).toBe(GATEWAY)

      const pending = session.sendRaw(masterReset(DEVICE), { requiresLevel1: true })
      await grantUnlock()
      const outcome = await pending

      expect(outcome).toEqual({ status: 'answered', value: undefined })
      expect(bus.targets()).toEqual([
        PGN.proprietary,
        PGN.proprietary,
        PGN.accessLevel,
        PGN.proprietary
      ])
      expect(session.gatewayAddress).toBeNull()

      const next = session.command(writeCurve())
      await flush()

      expect(bus.targets().at(-1)).toBe(PGN.accessLevel)
      bus.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }, fromDevice()))
      await flush()
      bus.deliver(acknowledge({}, fromDevice()))
      await next
    })

    it('unlocks again before a raw frame, however recent the last grant', async () => {
      const write = session.command(writeCurve())
      await grantUnlock()
      bus.deliver(acknowledge({}, fromDevice()))
      await write

      const pending = session.sendRaw(masterReset(DEVICE), { requiresLevel1: true })
      await flush()

      expect(bus.targets()).toEqual([PGN.accessLevel, PGN.proprietary, PGN.accessLevel])

      await grantUnlock()

      expect(await pending).toEqual({ status: 'answered', value: undefined })
      expect(bus.targets().at(-1)).toBe(PGN.proprietary)
    })
  })

  describe('failures that must not reach the server', () => {
    it('reports a send that throws and keeps the queue working', async () => {
      bus.failFrom = 1
      const first = await session.read(readCurve())

      expect(first.status).toBe('unknown')
      expect(errors).toHaveLength(1)

      bus.failFrom = null
      const second = session.read(readPgnLists())
      await flush()

      expect(bus.sent).toHaveLength(1)

      bus.deliver(pgnListReply('Transmit PGN list', [128267], fromDevice()))
      bus.deliver(pgnListReply('Receive PGN list', [126208], fromDevice()))

      expect((await second).status).toBe('answered')
    })

    it('leaves no abandoned reply behind when the send throws', async () => {
      bus.failFrom = 1
      await session.read(readCurve())
      bus.failFrom = null

      // The failed attempt never started waiting, so it is owed nothing and
      // it left no timer to declare otherwise. Give any stray one time to
      // fire: the next read's first reply must not be swallowed as a late
      // answer to a request that was never asked.
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      const second = session.read(readCurve())
      await flush()
      bus.deliver(curveReply(CURVE, fromDevice()))

      expect((await second).status).toBe('answered')
    })

    it('settles the caller when an operation throws before it reaches the bus', async () => {
      // A group function with no target PGN cannot be correlated, so the
      // session refuses it rather than sending a frame it could not match.
      const outcome = await session.command({
        message: { pgn: PGN.groupFunction, dst: DEVICE, prio: 3, fields: {} }
      })

      expect(outcome).toEqual({
        status: 'unknown',
        reason: 'The operation failed before it was answered'
      })
      expect(errors).toHaveLength(1)
      expect(bus.sent).toHaveLength(0)
    })

    it('contains a matcher that throws, and still answers the next read', async () => {
      const pending = session.read({
        ...readCurve(),
        match: () => {
          throw new Error('bad reply shape')
        }
      })
      await flush()
      bus.deliver(curveReply(CURVE, fromDevice()))
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect((await pending).status).toBe('unknown')
      expect(errors).toHaveLength(1)

      // Let the abandoned attempt stop expecting the reply it never decoded.
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      const second = session.read(readCurve())
      await flush()
      bus.deliver(curveReply(CURVE, fromDevice()))

      expect((await second).status).toBe('answered')
    })

    it('survives a reporter that throws, without leaving the caller waiting', async () => {
      const hostile = new DeviceSession({
        address: DEVICE,
        bus,
        now: () => Date.now(),
        onObservation: () => {
          throw new Error('cache is down')
        },
        onError: () => {
          throw new Error('logger is down')
        }
      })
      try {
        bus.failFrom = 1
        const outcome = await hostile.command({ message: setSpeedCurve(DEVICE, CURVE) })

        expect(outcome.status).not.toBe('answered')

        bus.failFrom = null
        // The bus dispatch must survive a callback that throws twice over.
        expect(() => {
          bus.deliver(curveReply(CURVE, fromDevice()))
        }).not.toThrow()
      } finally {
        hostile.close()
      }
    })

    it('does not let a throwing cache callback cost a read its answer', async () => {
      const broken = new DeviceSession({
        address: DEVICE,
        bus,
        now: () => Date.now(),
        onObservation: () => {
          throw new Error('cache is broken')
        },
        onError: (error) => errors.push(error)
      })
      try {
        const pending = broken.read(readCurve())
        await flush()
        bus.deliver(curveReply(CURVE, fromDevice()))

        expect((await pending).status).toBe('answered')
        expect(errors).toHaveLength(1)
      } finally {
        broken.close()
      }
    })
  })

  describe('a command and its read-back', () => {
    const depthCommand = (offset: number): CommandSpec => ({
      message: commandStandardField(DEVICE, PGN.waterDepth, [{ parameter: 3, value: offset }])
    })

    it('runs the read-back in the command’s queue slot, before anything queued behind it', async () => {
      const first = session.commandThenRead(depthCommand(0.35), () => readCurve())
      const second = session.command(depthCommand(0.5))
      await flush()
      bus.deliver(acknowledge({ acknowledgedPgn: PGN.waterDepth }, fromDevice()))
      await flush()

      expect(bus.targets()).toEqual([PGN.waterDepth, PGN.proprietary])

      bus.deliver(curveReply(CURVE, fromDevice()))
      await flush()

      expect(bus.targets()).toEqual([PGN.waterDepth, PGN.proprietary, PGN.waterDepth])
      expect(await first).toEqual({
        command: { status: 'answered', value: undefined },
        read: { status: 'answered', value: [CURVE] }
      })

      bus.deliver(acknowledge({ acknowledgedPgn: PGN.waterDepth }, fromDevice()))
      await second
    })

    it('lets the caller skip the read-back from the command’s outcome', async () => {
      const pending = session.commandThenRead(depthCommand(0.35), (outcome) =>
        outcome.status === 'answered' ? readCurve() : null
      )
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)

      expect(await pending).toEqual({
        command: { status: 'unknown', reason: 'The device did not answer' },
        read: null
      })
      expect(bus.sent).toHaveLength(1)
    })

    it('reports a full backlog as the command’s refusal, with no read', async () => {
      for (let i = 0; i < MAX_QUEUE_DEPTH + 1; i += 1) {
        void session.command(depthCommand(i))
      }
      const outcome = await session.commandThenRead(depthCommand(0.35), () => readCurve())

      expect(outcome).toEqual({
        command: { status: 'rejected', reason: 'The device has a backlog of unanswered requests' },
        read: null
      })
    })
  })

  describe('shutdown and backpressure', () => {
    it('stops listening, and refuses queued work it never sent, when closed', async () => {
      const first = session.read(readCurve())
      const second = session.read(readPgnLists())
      await flush()
      session.close()

      expect((await first).status).toBe('unknown')
      expect(await second).toEqual({ status: 'rejected', reason: 'The session was closed' })
      expect(bus.sent).toHaveLength(1)

      bus.deliver(curveReply(CURVE, fromDevice()))

      expect(observed).toHaveLength(0)
    })

    it('tells everything outstanding why the session was closed', async () => {
      expect(session.closedReason).toBeNull()
      const first = session.read(readCurve())
      const second = session.read(readPgnLists())
      await flush()
      session.close('The device moved to address 30')

      expect(session.closedReason).toBe('The device moved to address 30')
      expect(await first).toEqual({ status: 'unknown', reason: 'The device moved to address 30' })
      expect(await second).toEqual({ status: 'rejected', reason: 'The device moved to address 30' })
    })

    it('sends nothing more when closed between two attempts of a retry, and says so', async () => {
      const pending = session.read(readCurve())
      await flush()
      bus.deliver(acknowledge({ parameterErrors: ['Temporary error'] }, fromDevice()))
      session.close()
      await flush()

      expect(await pending).toEqual({ status: 'rejected', reason: 'The session was closed' })
      expect(bus.sent).toHaveLength(1)
    })

    it('refuses work once the backlog is full rather than queueing it', async () => {
      const pending: Promise<unknown>[] = []
      // One operation leaves the queue at once to become the in-flight attempt,
      // so the queue fills after MAX_QUEUE_DEPTH + 1 accepted operations.
      for (let i = 0; i < MAX_QUEUE_DEPTH + 2; i += 1) {
        pending.push(session.command({ message: setSpeedCurve(DEVICE, [{ hz: i + 1, speed: 1 }]) }))
      }
      await flush()

      expect(await pending[MAX_QUEUE_DEPTH + 1]).toEqual({
        status: 'rejected',
        reason: 'The device has a backlog of unanswered requests'
      })
      expect(bus.sent).toHaveLength(1)

      session.close()
      await flush()
      const outcomes = await Promise.all(pending)

      expect(outcomes.every((o) => (o as { status: string }).status !== 'answered')).toBe(true)
    })
  })
})
