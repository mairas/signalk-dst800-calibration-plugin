/**
 * The result of one device operation.
 *
 * Three-valued rather than two. Silence is not failure: canboatjs drops a
 * fast-packet message that lost a frame without reporting it, which on the
 * wire is indistinguishable from a PID the device does not implement. Folding
 * both into "failed" would let the console tell the user a supported setting
 * does not exist.
 */
export type Outcome<T> =
  | { status: 'answered'; value: T }
  | { status: 'rejected'; reason: string }
  | { status: 'unknown'; reason: string }

/** The device acknowledged with no error. Any other code is a failure. */
export const ACK_OK = 'Acknowledge'

/** PGN error code 3 and parameter error code 4: the access level is too low. */
export const ACCESS_DENIED = 'Access denied'

/** Parameter error code 2: the device is momentarily unable to comply. */
export const TEMPORARY_ERROR = 'Temporary error'
