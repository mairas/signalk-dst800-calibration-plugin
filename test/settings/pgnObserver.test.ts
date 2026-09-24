import { describe, it, expect, beforeEach } from 'vitest'
import { PgnObserver } from '../../src/settings/pgnObserver.js'

const DEPTH = 128267

describe('PgnObserver', () => {
  let now: number
  let observer: PgnObserver

  beforeEach(() => {
    now = 0
    observer = new PgnObserver(() => now)
  })

  /** Frames of `pgn` at each of `times` (ms), with `prio`. */
  const hear = (pgn: number, times: number[], prio = 3) => {
    for (const time of times) {
      now = time
      observer.record(pgn, prio)
    }
  }

  it('reports the gap between frames, rounded to 10 ms, and their priority', () => {
    hear(DEPTH, [0, 1004, 1995, 3010, 4001])

    expect(observer.observed(DEPTH)).toEqual({ intervalMs: 1000, priority: 3 })
  })

  it('is not moved by one late or one missing frame', () => {
    hear(DEPTH, [0, 1000, 2000, 3300, 4000, 6000, 7000])

    expect(observer.observed(DEPTH).intervalMs).toBe(1000)
  })

  it('reports 0 for a PGN never heard, with no priority', () => {
    expect(observer.observed(DEPTH)).toEqual({ intervalMs: 0, priority: null })
  })

  it('reports 0 for a PGN heard once, as in answer to a request, with its priority', () => {
    hear(DEPTH, [0], 6)

    expect(observer.observed(DEPTH)).toEqual({ intervalMs: 0, priority: 6 })
  })

  it('reports 0 for frames further apart than any interval the sensor can be set to', () => {
    hear(DEPTH, [0, 120_000, 240_000])

    expect(observer.observed(DEPTH).intervalMs).toBe(0)
  })

  it('reports 0 once a PGN has stopped arriving', () => {
    hear(DEPTH, [0, 1000, 2000])
    now = 60_000

    expect(observer.observed(DEPTH).intervalMs).toBe(0)
  })

  it('starts over for a PGN it is told to forget, and for everything on clear', () => {
    hear(DEPTH, [0, 1000, 2000])
    hear(130316, [0, 500, 1000])

    observer.forget(DEPTH)
    expect(observer.observed(DEPTH)).toEqual({ intervalMs: 0, priority: null })
    expect(observer.observed(130316).intervalMs).toBe(500)

    observer.clear()
    expect(observer.observed(130316)).toEqual({ intervalMs: 0, priority: null })
  })

  it('follows a new interval once the frames after it outnumber those before', () => {
    hear(DEPTH, [0, 1000, 2000, 3000, 3500, 4000, 4500, 5000])

    expect(observer.observed(DEPTH).intervalMs).toBe(500)
  })
})
