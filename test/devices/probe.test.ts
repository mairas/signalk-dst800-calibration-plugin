import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FakeBus } from '../helpers/FakeBus.js'
import { acknowledge, pgnReply, pidReply } from '../helpers/replies.js'
import {
  PROBED,
  ProbeCache,
  capabilityId,
  probe,
  probeBudgetMs,
  type ProbeResult
} from '../../src/devices/probe.js'
import { DeviceSession, MAX_QUEUE_DEPTH } from '../../src/session/deviceSession.js'
import { setSpeedCurve } from '../../src/protocol/codec.js'
import type { OutgoingPgn, OutgoingRaw } from '../../src/protocol/messages.js'
import { AirmarPid, PARAM, PGN } from '../../src/protocol/pids.js'

const DEVICE = 22
const GATEWAY = 100
const from = { src: DEVICE, dst: GATEWAY }

/** How the simulated device treats one request: answer, refuse with a code, or ignore it. */
type Reaction = 'answer' | 'silent' | { error: string }

interface Profile {
  unlock: Reaction
  /** Keyed by `capabilityId`; anything absent is answered. */
  reactions?: Record<string, Reaction>
}

const paramsOf = (message: OutgoingPgn) =>
  message.fields.list as { parameter: number; value: number }[]

const pidOf = (message: OutgoingPgn): AirmarPid | null => {
  const entry = paramsOf(message).find((p) => p.parameter === PARAM.proprietaryId)
  return entry === undefined ? null : entry.value
}

/** Airmar's own PGNs, which the manual says answer only a request naming fields 1 and 3. */
const AIRMAR_PGNS = new Set<number>([
  PGN.accessLevel,
  PGN.depthQualityFactor,
  PGN.speedPulseCount,
  PGN.deviceInformation,
  PGN.post
])

const namesAirmar = (message: OutgoingPgn): boolean => {
  const params = paramsOf(message)
  return (
    params.some((p) => p.parameter === PARAM.manufacturerCode && p.value === 135) &&
    params.some((p) => p.parameter === PARAM.industryCode && p.value === 4)
  )
}

/**
 * A bus with a device on it that answers per `profile`.
 *
 * Replies are delivered on a microtask, after the session has registered
 * the request as in flight, as a real reply would.
 */
class DeviceBus extends FakeBus {
  constructor(private readonly profile: Profile) {
    super()
  }

  override send(message: OutgoingPgn | OutgoingRaw): void {
    super.send(message)
    if (!('fields' in message)) {
      return
    }
    const target = Number(message.fields.pgn)
    const isUnlock = message.fields.functionCode === 'Command' && target === PGN.accessLevel
    const pid = target === PGN.proprietary ? pidOf(message) : null
    const id =
      pid === null ? capabilityId({ kind: 'pgn', pgn: target }) : capabilityId({ kind: 'pid', pid })
    const reaction = isUnlock ? this.profile.unlock : (this.profile.reactions?.[id] ?? 'answer')
    if (reaction === 'silent' || (AIRMAR_PGNS.has(target) && !isUnlock && !namesAirmar(message))) {
      return
    }
    queueMicrotask(() => {
      if (typeof reaction === 'object') {
        this.deliver(acknowledge({ acknowledgedPgn: target, pgnErrorCode: reaction.error }, from))
      } else if (isUnlock) {
        this.deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }, from))
      } else if (pid !== null) {
        this.deliver(pidReply(pid, from))
      } else {
        this.deliver(pgnReply(target, from))
      }
    })
  }
}

const everything = (reaction: Reaction): Record<string, Reaction> =>
  Object.fromEntries(PROBED.map((c) => [capabilityId(c), reaction]))

const stateOf = (result: ProbeResult, id: string) =>
  result.capabilities.find((c) => capabilityId(c.capability) === id)?.result

describe('probe', () => {
  let bus: DeviceBus
  let session: DeviceSession | undefined

  const current = (): DeviceSession => {
    if (session === undefined) {
      throw new Error('start() the device first')
    }
    return session
  }

  const start = (profile: Profile) => {
    bus = new DeviceBus(profile)
    session = new DeviceSession({ address: DEVICE, bus, now: () => Date.now() })
  }

  /** Run a probe to completion under fake time, reporting how long it took. */
  const run = async () => {
    const began = Date.now()
    let finished = Number.NaN
    const pending = probe(current()).then((result) => {
      finished = Date.now()
      return result
    })
    await vi.advanceTimersByTimeAsync(probeBudgetMs(current()) + 1)
    const result = await pending
    return { result, took: finished - began }
  }

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    session?.close()
    session = undefined
    vi.useRealTimers()
  })

  it('asks for exactly the capabilities the plan names', () => {
    expect(PROBED.map(capabilityId)).toEqual([
      'pid:35',
      'pid:40',
      'pid:41',
      'pid:42',
      'pid:43',
      'pid:44',
      'pid:46',
      'pgn:65287',
      'pgn:65408',
      'pgn:65409',
      'pgn:65410',
      'pgn:130944',
      'pgn:126464',
      'pgn:126996',
      'pgn:126998',
      'pgn:128275'
    ])
  })

  it('unlocks first, then asks for each capability once, in order', async () => {
    start({ unlock: 'answer' })
    await run()

    expect(bus.targets()).toEqual([
      PGN.accessLevel,
      ...PROBED.map((c) => (c.kind === 'pid' ? PGN.proprietary : c.pgn))
    ])
  })

  it('marks every capability of a device that answers everything supported', async () => {
    start({ unlock: 'answer' })
    const { result } = await run()

    expect(result.level1).toEqual({ state: 'granted' })
    expect(result.capabilities.every((c) => c.result.state === 'supported')).toBe(true)
    expect(result.configurable).toBe('yes')
    expect(result.interrupted).toBe(false)
  })

  it('finds no speed capabilities on a device that answers only depth', async () => {
    start({
      unlock: 'answer',
      reactions: {
        [capabilityId({ kind: 'pid', pid: AirmarPid.CalibrateSpeed })]: 'silent',
        [capabilityId({ kind: 'pid', pid: AirmarPid.SpeedFilter })]: 'silent',
        [capabilityId({ kind: 'pgn', pgn: PGN.speedPulseCount })]: 'silent'
      }
    })
    const { result } = await run()

    expect(stateOf(result, 'pid:41')?.state).toBe('noAnswer')
    expect(stateOf(result, 'pid:43')?.state).toBe('noAnswer')
    expect(stateOf(result, 'pgn:65409')?.state).toBe('noAnswer')
    expect(stateOf(result, 'pid:40')?.state).toBe('supported')
    // Silence is not a no: a lost fast-packet frame looks the same.
    expect(result.configurable).toBe('unknown')
  })

  it('keeps the device’s code when it refuses a capability', async () => {
    start({
      unlock: 'answer',
      reactions: { 'pid:41': { error: 'PGN not supported' } }
    })
    const { result } = await run()

    expect(stateOf(result, 'pid:41')).toEqual({ state: 'rejected', reason: 'PGN not supported' })
    expect(result.configurable).toBe('no')
  })

  it('counts an access-denied refusal as support, since the device parsed the request', async () => {
    start({
      unlock: 'answer',
      reactions: { 'pid:41': { error: 'Access denied' } }
    })
    const { result } = await run()

    expect(stateOf(result, 'pid:41')).toEqual({ state: 'supported' })
    expect(result.configurable).toBe('yes')
  })

  it('probes on when the device refuses the unlock', async () => {
    start({ unlock: { error: 'PGN not supported' } })
    const { result } = await run()

    expect(result.level1).toEqual({
      state: 'refused',
      reason: 'Access Level 1 refused: PGN not supported'
    })
    expect(stateOf(result, 'pid:41')).toEqual({ state: 'supported' })
  })

  it('reports a silent device as unanswered throughout, never as unsupported', async () => {
    start({ unlock: 'silent', reactions: everything('silent') })
    const { result, took } = await run()

    expect(result.level1.state).toBe('noAnswer')
    expect(result.capabilities).toHaveLength(PROBED.length)
    expect(result.capabilities.every((c) => c.result.state === 'noAnswer')).toBe(true)
    expect(result.configurable).toBe('unknown')
    expect(took).toBeLessThanOrEqual(probeBudgetMs(current()))
  })

  it('marks a probe interrupted when its session closes mid-run', async () => {
    start({ unlock: 'answer', reactions: everything('silent') })
    const pending = probe(current())
    await vi.advanceTimersByTimeAsync(0)
    current().close('The device moved from address 22 to 31')
    const result = await pending

    expect(result.interrupted).toBe(true)
    expect(result.capabilities.every((c) => c.result.state === 'noAnswer')).toBe(true)
    expect(stateOf(result, 'pid:41')).toEqual({
      state: 'noAnswer',
      reason: 'The device moved from address 22 to 31'
    })
  })
})

describe('probe against a session that refuses work itself', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports what the session refused as unanswered, not as the device’s refusal', async () => {
    vi.useFakeTimers()
    const bus = new DeviceBus({ unlock: 'silent', reactions: everything('silent') })
    const session = new DeviceSession({ address: DEVICE, bus, now: () => Date.now() })
    // Fill the backlog, so the session refuses every probe request unsent.
    for (let i = 0; i <= MAX_QUEUE_DEPTH; i += 1) {
      void session.command({ message: setSpeedCurve(DEVICE, [{ hz: i + 1, speed: 1 }]) })
    }
    const result = await probe(session)
    session.close()

    expect(result.level1.state).toBe('noAnswer')
    expect(result.capabilities.every((c) => c.result.state === 'noAnswer')).toBe(true)
  })
})

describe('ProbeCache', () => {
  const result: ProbeResult = {
    level1: { state: 'granted' },
    capabilities: [],
    configurable: 'yes',
    interrupted: false
  }
  const key = { manufacturerCode: 135, uniqueNumber: 123456 }

  it('holds a result per device until it is invalidated', () => {
    const cache = new ProbeCache()
    cache.set(key, result)

    expect(cache.get({ ...key })).toBe(result)
    expect(cache.get({ ...key, uniqueNumber: 1 })).toBeUndefined()

    cache.invalidate(key)

    expect(cache.get(key)).toBeUndefined()
  })

  it('does not keep a probe that was cut short', () => {
    const cache = new ProbeCache()
    cache.set(key, { ...result, interrupted: true })

    expect(cache.get(key)).toBeUndefined()
  })
})
