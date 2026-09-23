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
 * refusal of *another* plotter's unlock from a refusal of its own. Acting on
 * a single refusal lets one neighbour on the bus disable calibration for the
 * rest of the session, with no way back.
 */
export const REFUSALS_BEFORE_UNAVAILABLE = 2

export class AccessLevelState {
  private unlockedAt: number | null = null
  private refusals = 0

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
  recordRefusal(): boolean {
    this.refusals += 1
    return this.isUnavailable
  }

  get isUnavailable(): boolean {
    return this.refusals >= REFUSALS_BEFORE_UNAVAILABLE
  }

  /** A master reset or EEPROM restore drops the grant at the device. */
  forget(): void {
    this.unlockedAt = null
  }
}
