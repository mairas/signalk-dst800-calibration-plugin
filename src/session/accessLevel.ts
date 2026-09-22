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
 * Re-unlock this long after the unlock, a minute short of the expiry.
 *
 * The margin covers the round trip and the queue ahead of the operation: an
 * unlock that lands after the device has expired the level is answered with
 * access denied, which costs an extra round trip on every later operation.
 */
export const ACCESS_LEVEL_1_REFRESH_MS = 14 * 60 * 1000

export class AccessLevelState {
  private unlockedAt: number | null = null
  private unavailable = false

  /** True when the next Level-1 operation must be preceded by an unlock. */
  needsUnlock(now: number): boolean {
    return this.unlockedAt === null || now - this.unlockedAt >= ACCESS_LEVEL_1_REFRESH_MS
  }

  recordUnlock(now: number): void {
    this.unlockedAt = now
  }

  /**
   * Forget the unlock after the device refused an operation.
   *
   * The grant is bound to the gateway's source address, so an address re-claim
   * silently voids it with no message on the bus. An access-denied reply is
   * the only evidence, and it means the recorded timestamp is wrong.
   */
  recordDenied(): void {
    this.unlockedAt = null
  }

  /**
   * The device refused the unlock itself — a non-DST product, say.
   *
   * Sticky: retrying an unlock the device has already NAKed would loop on
   * every Level-1 operation for as long as the console stays open.
   */
  markUnavailable(): void {
    this.unavailable = true
  }

  get isUnavailable(): boolean {
    return this.unavailable
  }
}
