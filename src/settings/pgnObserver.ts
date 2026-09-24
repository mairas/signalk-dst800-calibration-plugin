/**
 * Each PGN's transmission interval and priority, measured from what the
 * device sends.
 *
 * No message reports them (DST200 manual p.54: a Request Group Function
 * answers with the PGN itself or an Acknowledge of error codes), but every
 * frame carries its priority in the CAN header, and the gaps between frames
 * are the interval.
 */

import { MAX_INTERVAL_MS } from './intervalLimits.js'

/** Frames kept per PGN: six gaps, so one late or lost frame cannot move the median. */
const FRAMES_KEPT = 7

/** Intervals are reported to the nearest 10 ms, the step the console shows. */
const ROUND_MS = 10

/** A gap longer than the longest settable interval, with room for jitter, is not a period. */
const MAX_PERIODIC_GAP_MS = MAX_INTERVAL_MS * 1.5

/** A PGN not heard for this many of its periods, plus the slack, has stopped. */
const STALE_PERIODS = 3
const STALE_SLACK_MS = 2000

export interface Observed {
  /** 0 when the PGN is not being sent periodically, as the manual writes a default of none. */
  intervalMs: number
  /** From the last frame's header; null when the PGN was never heard. */
  priority: number | null
}

export const NOT_SEEN: Observed = { intervalMs: 0, priority: null }

/** One PGN's measurement, as the API reports it. */
export interface PgnMeasurement {
  pgn: number
  /** The interval measured on the bus, to 10 ms; 0 while it is not sent periodically. */
  observedIntervalMs: number
  /** The priority the last frame carried; null when none was heard since it was last set. */
  observedPriority: number | null
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export class PgnObserver {
  private readonly heard = new Map<number, { times: number[]; priority: number | null }>()

  constructor(private readonly now: () => number) {}

  /** A frame of `pgn` from the device, with the priority its header carried. */
  record(pgn: number, priority: number | undefined): void {
    const at = this.now()
    const entry = this.heard.get(pgn) ?? { times: [], priority: null }
    const last = entry.times.at(-1)
    // A gap no interval explains starts the measurement over: the PGN was off,
    // or it was only ever sent on request.
    const times = last !== undefined && at - last > MAX_PERIODIC_GAP_MS ? [] : entry.times
    this.heard.set(pgn, {
      times: [...times, at].slice(-FRAMES_KEPT),
      priority: priority ?? entry.priority
    })
  }

  observed(pgn: number): Observed {
    const entry = this.heard.get(pgn)
    if (entry === undefined) {
      return NOT_SEEN
    }
    const gaps = entry.times.slice(1).map((time, i) => time - entry.times[i])
    if (gaps.length === 0) {
      return { intervalMs: 0, priority: entry.priority }
    }
    const period = median(gaps)
    const last = entry.times[entry.times.length - 1]
    const stopped = this.now() - last > STALE_PERIODS * period + STALE_SLACK_MS
    return {
      intervalMs: stopped ? 0 : Math.round(period / ROUND_MS) * ROUND_MS,
      priority: entry.priority
    }
  }

  /** Every PGN heard since the last clear. */
  measurements(): PgnMeasurement[] {
    return [...this.heard.keys()].map((pgn) => {
      const { intervalMs, priority } = this.observed(pgn)
      return { pgn, observedIntervalMs: intervalMs, observedPriority: priority }
    })
  }

  /** Wait for the next frame's priority, as after the priority was set. */
  forgetPriority(pgn: number): void {
    const entry = this.heard.get(pgn)
    if (entry !== undefined) {
      this.heard.set(pgn, { ...entry, priority: null })
    }
  }

  /** Measure `pgn` afresh, as after its interval was set. */
  forget(pgn: number): void {
    this.heard.delete(pgn)
  }

  /** Measure everything afresh, as for another device or after a restart. */
  clear(): void {
    this.heard.clear()
  }
}
