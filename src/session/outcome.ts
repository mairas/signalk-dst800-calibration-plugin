/**
 * The result of one device operation.
 *
 * Three-valued rather than two. Silence is not failure: canboatjs drops a
 * fast-packet message that lost a frame without reporting it, which on the
 * wire is indistinguishable from a PID the device does not implement. Folding
 * both into "failed" would let the console tell the user a supported setting
 * does not exist.
 *
 * The converse matters as much. A device that refuses an operation has told
 * us something firm, so a rejection must never be downgraded to silence by a
 * later step failing.
 */

import type { AcknowledgeResult } from '../protocol/codec.js'

export type Outcome<T> =
  | { status: 'answered'; value: T }
  /**
   * The device refused. `detail` carries the decoded acknowledgement, whose
   * 1-based parameter indices are the only way to tell the user which field
   * of a multi-parameter write was refused; `reason` is for logs.
   */
  | { status: 'rejected'; reason: string; detail?: AcknowledgeResult }
  | { status: 'unknown'; reason: string }

/** The device acknowledged with no error. Any other code is a failure. */
export const ACK_OK = 'Acknowledge'

/** PGN error code 3 and parameter error code 4: the access level is too low. */
export const ACCESS_DENIED = 'Access denied'

/** Parameter error code 2: the device is momentarily unable to comply. */
export const TEMPORARY_ERROR = 'Temporary error'

/** Whether the device refused because the access level was too low. */
export const isAccessDenied = (ack: AcknowledgeResult): boolean =>
  ack.pgnError === ACCESS_DENIED || ack.parameterErrors.some((e) => e.error === ACCESS_DENIED)
