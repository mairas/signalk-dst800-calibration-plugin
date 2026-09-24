/**
 * Access Level 1 lifetime, as the device enforces it.
 *
 * The level is granted to the unlocking source address, expires 15 minutes
 * after the unlock or at power-down, and is not stored in EEPROM. Nothing on
 * the bus announces the expiry, so the plugin tracks it and re-unlocks before
 * the device drops it.
 *
 * This class holds no timers and does no I/O: every decision is a function of
 * the caller's clock, so the session can drive it under fake time.
 */

/** The device expires the level this long after the unlock. */
export const ACCESS_LEVEL_1_TTL_MS = 15 * 60 * 1000

/**
 * Re-unlock a minute before the device would expire the level.
 *
 * The margin covers the round trip and the queue ahead of the operation: an
 * unlock that lands after the device has expired the level is answered with
 * access denied, which costs an extra round trip on every later operation.
 */
const REFRESH_MARGIN_MS = 60 * 1000
export const ACCESS_LEVEL_1_REFRESH_MS = ACCESS_LEVEL_1_TTL_MS - REFRESH_MARGIN_MS

/**
 * How many refusals before the plugin stops asking for Level 1.
 *
 * Not one. An unlock is a Command Group Function on PGN 65287, and until the
 * session knows the gateway's own source address it cannot tell the device's
 * refusal of *another* plotter's unlock from a refusal of its own.
 */
export const REFUSALS_BEFORE_UNAVAILABLE = 2

/**
 * Access Level 1 as the console shows it.
 *
 * `locked` is also what a lapsed grant reads as: the next Level 1 operation
 * unlocks again. The times are left rather than deadlines, because the
 * plugin's clock is monotonic and means nothing to a browser.
 */
export type AccessView =
  | { state: 'granted'; expiresInMs: number }
  | { state: 'locked' }
  /** The plugin will not ask again for `retryInMs`. */
  | { state: 'unavailable'; retryInMs: number }

export class AccessLevelState {
  private unlockedAt: number | null = null
  private refusals = 0
  private refusedAt: number | null = null

  /** True when the next Level-1 operation must be preceded by an unlock. */
  needsUnlock(now: number): boolean {
    if (this.unlockedAt === null) {
      return true
    }
    const held = now - this.unlockedAt
    // A negative age means the clock went backwards under us. A vessel's Pi
    // has no RTC, so it boots stale and steps when GPS lands — next to the
    // GPS this plugin talks to. Treat an impossible age as expired rather
    // than holding a grant the device has already dropped.
    return held < 0 || held >= ACCESS_LEVEL_1_REFRESH_MS
  }

  recordUnlock(now: number): void {
    this.unlockedAt = now
    // The device has just proved it offers Level 1, so earlier refusals said
    // something about who they answered, not about this product.
    this.refusals = 0
    this.refusedAt = null
  }

  /**
   * Forget the unlock after the device refused an operation.
   *
   * The grant is bound to the gateway's source address, so an address
   * re-claim silently voids it with no message on the bus. An access-denied
   * reply is the only evidence, and it means the recorded timestamp is wrong.
   */
  recordDenied(): void {
    this.unlockedAt = null
  }

  /** The device refused the unlock itself. Returns true once that is final. */
  recordRefusal(now: number): boolean {
    if (this.refusedAt !== null && !this.withinRefusalWindow(now)) {
      this.refusals = 0
    }
    this.refusals += 1
    this.refusedAt = now
    return this.isUnavailable(now)
  }

  /**
   * Whether to stop asking for Level 1 for now.
   *
   * Deliberately not permanent. The refusals that set it may have answered
   * another node's unlock, and an absorbing state derived from a frame this
   * session could not attribute would disable calibration for the rest of the
   * session with nothing the user could do. It lapses after one grant
   * lifetime, so a product that truly has no Level 1 is asked again at most
   * once every fifteen minutes rather than on every write.
   */
  isUnavailable(now: number): boolean {
    return this.withinRefusalWindow(now) && this.refusals >= REFUSALS_BEFORE_UNAVAILABLE
  }

  view(now: number): AccessView {
    if (this.isUnavailable(now) && this.refusedAt !== null) {
      return { state: 'unavailable', retryInMs: ACCESS_LEVEL_1_TTL_MS - (now - this.refusedAt) }
    }
    const held = this.unlockedAt === null ? -1 : now - this.unlockedAt
    return held >= 0 && held < ACCESS_LEVEL_1_TTL_MS
      ? { state: 'granted', expiresInMs: ACCESS_LEVEL_1_TTL_MS - held }
      : { state: 'locked' }
  }

  private withinRefusalWindow(now: number): boolean {
    if (this.refusedAt === null) {
      return false
    }
    const since = now - this.refusedAt
    return since >= 0 && since < ACCESS_LEVEL_1_TTL_MS
  }

  /** A master reset or EEPROM restore drops the grant at the device. */
  forget(): void {
    this.unlockedAt = null
  }
}
