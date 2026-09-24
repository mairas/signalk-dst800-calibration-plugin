/**
 * Per-PGN transmission interval and priority.
 *
 * The two go through different group functions with different success
 * semantics. A priority is a Command, acknowledged like any other. An interval
 * is a Request, which the device acknowledges only to refuse (manual p.15), so
 * silence is acceptance and the confirmation is the new period, observed on
 * the bus.
 */

import type { ProbeResult } from '../devices/probe.js'
import { commandPriority, requestInterval, requestTransmitList } from '../protocol/codec.js'
import type { AcknowledgeResult } from '../protocol/codec.js'
import type { DecodedPgn } from '../protocol/messages.js'
import { PGN, SINGLE_FRAME_PGNS, TRANSMIT_PGN_LIST } from '../protocol/pids.js'
import type { DeviceSession } from '../session/deviceSession.js'
import type { Outcome } from '../session/outcome.js'
import { FRAMES_TO_OBSERVE, MAX_INTERVAL_MS, observationWindowMs } from './intervalLimits.js'
import type { Observed } from './pgnObserver.js'

export { MAX_INTERVAL_MS }

/**
 * Airmar's periodic PGNs. PGN 126464 excludes proprietary PGNs (manual p.16),
 * so these reach the list only through the probe. The plugin's telemetry reads
 * all three, so a long interval slows every consumer of them.
 */
export const TELEMETRY_PGNS: readonly number[] = [
  PGN.depthQualityFactor,
  PGN.speedPulseCount,
  PGN.deviceInformation
]

export const MIN_SINGLE_FRAME_INTERVAL_MS = 50
const MIN_FAST_PACKET_INTERVAL_MS = 100
export const MAX_PRIORITY = 7

/**
 * How far an observed period may stray from the requested one and still
 * count as applied. The floor absorbs the arrival jitter a gateway adds,
 * which matters at the shortest intervals.
 */
const PERIOD_TOLERANCE = 0.25
const MIN_TOLERANCE_MS = 30

export interface PgnInfo {
  pgn: number
  minIntervalMs: number
  /** The plugin's telemetry reads this PGN. */
  telemetry: boolean
  /** The interval measured on the bus, to 10 ms; 0 while it is not sent periodically. */
  observedIntervalMs: number
  /** The priority the last frame carried; null when it has not been heard. */
  observedPriority: number | null
}

export type PgnListResult =
  | { status: 'answered'; pgns: PgnInfo[] }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; reason: string }

export type PgnWriteOutcome =
  /** Refused before the bus: out of range or not a number. */
  | { status: 'invalid'; reason: string }
  /** The unlock was refused, or the session was full or closed. */
  | { status: 'notSent'; reason: string }
  | { status: 'rejected'; reason: string; detail: AcknowledgeResult }
  /** A priority command went unanswered. */
  | { status: 'unknown'; reason: string }
  /** A priority was acknowledged, or an interval was observed within tolerance. */
  | { status: 'applied'; observedIntervalMs?: number }
  | { status: 'observedDiffers'; requestedIntervalMs: number; observedIntervalMs: number }
  /** The device did not refuse the interval, but did not send the PGN often enough to time. */
  | { status: 'unconfirmed'; reason: string }

/** `warning` is set on an interval write that reached the device, for a PGN the telemetry reads. */
export type PgnWriteResult = PgnWriteOutcome & { warning?: string }

export interface PgnContext {
  session: Pick<DeviceSession, 'address' | 'command'>
  /** Every decoded PGN on the bus. Returns the unsubscribe. */
  subscribe: (handler: (pgn: DecodedPgn) => void) => () => void
  /** Monotonic milliseconds. */
  now: () => number
}

export const minIntervalMs = (pgn: number): number =>
  SINGLE_FRAME_PGNS.includes(pgn) ? MIN_SINGLE_FRAME_INTERVAL_MS : MIN_FAST_PACKET_INTERVAL_MS

const isTransmitList = (value: unknown): boolean =>
  value === 'Transmit PGN list' || value === TRANSMIT_PGN_LIST

/** The PGNs the device transmits and the probe confirmed, each once. */
export async function readPgns(
  session: Pick<DeviceSession, 'address' | 'read'>,
  probe: ProbeResult | undefined,
  observed: (pgn: number) => Observed = () => ({ intervalMs: 0, priority: null })
): Promise<PgnListResult> {
  const outcome = await session.read({
    message: requestTransmitList(session.address),
    match: (reply) => {
      if (reply.pgn !== PGN.pgnList || !isTransmitList(reply.fields?.functionCode)) {
        return null
      }
      const list = reply.fields?.list
      return Array.isArray(list)
        ? list.map((entry: { pgn?: unknown }) => entry.pgn).filter((pgn) => typeof pgn === 'number')
        : null
    }
  })
  if (outcome.status !== 'answered') {
    return { status: outcome.status, reason: outcome.reason }
  }
  const probed = (probe?.capabilities ?? []).flatMap((c) =>
    c.result.state === 'supported' &&
    c.capability.kind === 'pgn' &&
    TELEMETRY_PGNS.includes(c.capability.pgn)
      ? [c.capability.pgn]
      : []
  )
  const pgns = [...new Set([...outcome.value.flat(), ...probed])]
  return {
    status: 'answered',
    pgns: pgns.map((pgn) => {
      const { intervalMs, priority } = observed(pgn)
      return {
        pgn,
        minIntervalMs: minIntervalMs(pgn),
        telemetry: TELEMETRY_PGNS.includes(pgn),
        observedIntervalMs: intervalMs,
        observedPriority: priority
      }
    })
  }
}

const notAnswered = (outcome: Exclude<Outcome<void>, { status: 'answered' }>): PgnWriteResult =>
  outcome.status === 'rejected'
    ? outcome.detail === undefined
      ? { status: 'notSent', reason: outcome.reason }
      : { status: 'rejected', reason: outcome.reason, detail: outcome.detail }
    : { status: 'unknown', reason: outcome.reason }

const withWarning = (pgn: number, result: PgnWriteResult): PgnWriteResult =>
  TELEMETRY_PGNS.includes(pgn)
    ? {
        ...result,
        warning: `The plugin's telemetry reads PGN ${String(pgn)}; its interval sets how often every consumer of it updates`
      }
    : result

/** Set how often the device transmits `pgn`, then time the frames it sends. */
export async function writeInterval(
  context: PgnContext,
  pgn: number,
  input: unknown
): Promise<PgnWriteResult> {
  const min = minIntervalMs(pgn)
  if (
    typeof input !== 'number' ||
    !Number.isInteger(input) ||
    input < min ||
    input > MAX_INTERVAL_MS
  ) {
    return {
      status: 'invalid',
      reason: `The interval of PGN ${String(pgn)} is a whole number of milliseconds from ${String(min)} to ${String(MAX_INTERVAL_MS)}`
    }
  }
  const { session } = context
  const outcome = await session.command({
    message: requestInterval(session.address, pgn, input),
    silenceMeansAccepted: true
  })
  if (outcome.status !== 'answered') {
    return notAnswered(outcome)
  }
  const frames = await observe(context, pgn, observationWindowMs(input))
  if (frames.length < FRAMES_TO_OBSERVE) {
    return withWarning(pgn, {
      status: 'unconfirmed',
      reason: `The device did not refuse the interval, but sent PGN ${String(pgn)} ${String(frames.length)} times while the console watched`
    })
  }
  const observed = Math.round(frames[frames.length - 1] - frames[frames.length - 2])
  const tolerance = Math.max(input * PERIOD_TOLERANCE, MIN_TOLERANCE_MS)
  return withWarning(
    pgn,
    Math.abs(observed - input) <= tolerance
      ? { status: 'applied', observedIntervalMs: observed }
      : { status: 'observedDiffers', requestedIntervalMs: input, observedIntervalMs: observed }
  )
}

/** The arrival times of `pgn` from the device, until enough are seen or `windowMs` passes. */
function observe(context: PgnContext, pgn: number, windowMs: number): Promise<number[]> {
  const address = context.session.address
  return new Promise((resolve) => {
    const frames: number[] = []
    const finish = (): void => {
      clearTimeout(timer)
      unsubscribe()
      resolve(frames)
    }
    const timer = setTimeout(finish, windowMs)
    const unsubscribe = context.subscribe((frame) => {
      if (frame.pgn === pgn && frame.src === address) {
        frames.push(context.now())
        if (frames.length >= FRAMES_TO_OBSERVE) {
          finish()
        }
      }
    })
  })
}

/** Set the priority the device transmits `pgn` at. */
export async function writePriority(
  session: Pick<DeviceSession, 'address' | 'command'>,
  pgn: number,
  input: unknown
): Promise<PgnWriteResult> {
  if (typeof input !== 'number' || !Number.isInteger(input) || input < 0 || input > MAX_PRIORITY) {
    return {
      status: 'invalid',
      reason: `A priority is a whole number from 0 to ${String(MAX_PRIORITY)}`
    }
  }
  const outcome = await session.command({ message: commandPriority(session.address, pgn, input) })
  return outcome.status === 'answered' ? { status: 'applied' } : notAnswered(outcome)
}
