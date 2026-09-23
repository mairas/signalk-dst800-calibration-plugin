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

import { ACCESS_DENIED, type AcknowledgeResult } from '../protocol/codec.js'

export type Outcome<T> =
  | { status: 'answered'; value: T }
  /**
   * The device refused. `detail` carries the decoded acknowledgement, whose
   * 1-based parameter indices are the only way to tell the user which field
   * of a multi-parameter write was refused; `reason` is for logs.
   */
  | { status: 'rejected'; reason: string; detail?: AcknowledgeResult }
  | { status: 'unknown'; reason: string }

export { ACK_OK, ACCESS_DENIED, TEMPORARY_ERROR } from '../protocol/codec.js'

/** Whether the device refused because the access level was too low. */
export const isAccessDenied = (ack: AcknowledgeResult): boolean =>
  ack.pgnError === ACCESS_DENIED ||
  ack.intervalPriorityError === ACCESS_DENIED ||
  ack.parameterErrors.some((e) => e.error === ACCESS_DENIED)
