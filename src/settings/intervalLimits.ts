/**
 * Transmission interval limits and how the plugin confirms an interval,
 * without imports, so the webapp can quote them.
 */

/** The longest interval the protocol allows (manual p.15). */
export const MAX_INTERVAL_MS = 60_000

/** A frame may be scheduled on the old period; allow for it on top of three new ones. */
export const OBSERVATION_SLACK_MS = 5000

/** The first frame after the write may still follow the old schedule, so time the next two. */
export const FRAMES_TO_OBSERVE = 3

/** The longest the plugin watches the bus after setting `intervalMs`. */
export const observationWindowMs = (intervalMs: number): number =>
  FRAMES_TO_OBSERVE * intervalMs + OBSERVATION_SLACK_MS
