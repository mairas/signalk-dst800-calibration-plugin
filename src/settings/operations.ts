/**
 * Reading and writing a setting, with the device's answer as the result.
 *
 * Every write follows one contract: send the command, wait for the
 * Acknowledge, and only then read the value back, once, in the same queue
 * slot so that nothing queued behind the write can land in between. The
 * Acknowledge is the only commit signal the protocol offers, and the
 * read-back is what the device now holds, which is the truth the console
 * shows.
 *
 * The read-back runs after the device refuses the command too. A refused
 * curve write carries per-parameter codes, and the manual does not say
 * whether one bad point rejects the whole curve or stores the rest, so the
 * console must show what the device holds beside what was asked for. It does
 * not run after silence, which says nothing about whether the frame arrived,
 * nor after an access denial, which stores nothing and whose read-back would
 * need the unlock the device has just refused.
 */

import type { AcknowledgeResult } from '../protocol/codec.js'
import { PGN } from '../protocol/pids.js'
import type { DeviceSession } from '../session/deviceSession.js'
import { isAccessDenied, type Outcome } from '../session/outcome.js'
import { buildCommand, buildRead, setting, type AnySetting, type SettingId } from './registry.js'

export type ReadResult =
  | { status: 'answered'; value: unknown; readAt: string }
  | { status: 'rejected'; reason: string; detail?: AcknowledgeResult }
  | { status: 'unknown'; reason: string }
  /** The request could not be built: an unknown qualifier, or a write-only setting. */
  | { status: 'invalid'; reason: string }

/** A field of the write the device refused, in the user's terms. */
export interface RefusedField {
  field: string
  error: string
}

export type WriteResult =
  /** Refused before it reached the bus: bad input, an unknown qualifier, or a read-only setting. */
  | { status: 'invalid'; reason: string }
  /**
   * The command never went out: the device refused the unlock it needs, the
   * session has Level 1 marked unavailable, its queue is full, or it closed
   * before the command was sent.
   */
  | { status: 'notSent'; reason: string }
  /** No answer to the command, or the session closed while it was in flight. Nothing was read back. */
  | { status: 'unknown'; reason: string }
  /**
   * The device refused the command. `refusedFields` names the fields it
   * refused; `detail` is its acknowledgement, for logs. `readBack` is what the
   * device holds now, and `storedMatches` says whether that is what was asked
   * for; both are absent after an access denial and for a write-only setting.
   * `reason` is for logs, not for the user.
   */
  | {
      status: 'rejected'
      reason: string
      refusedFields: RefusedField[]
      detail: AcknowledgeResult
      requested: unknown
      readBack?: ReadResult
      storedMatches?: boolean
    }
  /** Acknowledged, and the read-back matches at the device's resolution. */
  | { status: 'applied'; stored: unknown; readAt: string }
  /** Acknowledged, but the device stores something else. Its value is the truth. */
  | { status: 'storedDiffers'; requested: unknown; stored: unknown; readAt: string }
  /**
   * Acknowledged, but the stored value could not be confirmed. `readBack` says
   * why, and is absent for a write-only setting, which cannot be read at all.
   */
  | { status: 'acknowledged'; readBack?: ReadResult }

type SettingsSession = Pick<DeviceSession, 'address' | 'read' | 'commandThenRead'>

/** Wall-clock time, for display. The session keeps its own monotonic clock. */
const wallClock = (): Date => new Date()

/** The PGN 126720 identity fields every proprietary command leads with. */
const IDENTITY_FIELDS: Partial<Record<number, string>> = {
  1: 'manufacturer code',
  3: 'industry code',
  4: 'proprietary ID'
}

function readResultOf(outcome: Outcome<unknown[]>, now: () => Date): ReadResult {
  return outcome.status === 'answered'
    ? { status: 'answered', value: outcome.value[0], readAt: now().toISOString() }
    : outcome
}

export async function readSetting(
  session: Pick<DeviceSession, 'address' | 'read'>,
  id: SettingId,
  qualifier?: number,
  now: () => Date = wallClock
): Promise<ReadResult> {
  const request = buildRead(id, session.address, qualifier)
  if (!request.ok) {
    return { status: 'invalid', reason: request.error }
  }
  return readResultOf(await session.read(request.value), now)
}

/** Name each refused parameter by the field of the command it sits at. */
function refusedFields(
  entry: AnySetting,
  list: unknown,
  targetPgn: unknown,
  ack: AcknowledgeResult
): RefusedField[] {
  const sent = Array.isArray(list) ? (list as { parameter?: unknown }[]) : []
  return ack.parameterErrors.map(({ index, error }) => {
    const parameter = sent[index - 1]?.parameter
    const named =
      typeof parameter !== 'number'
        ? null
        : (entry.fieldName(parameter) ??
          (targetPgn === PGN.proprietary ? (IDENTITY_FIELDS[parameter] ?? null) : null))
    return { field: named ?? `parameter ${String(index)}`, error }
  })
}

export async function writeSetting(
  session: SettingsSession,
  id: SettingId,
  input: unknown,
  qualifier?: number,
  now: () => Date = wallClock
): Promise<WriteResult> {
  const entry: AnySetting = setting(id)
  const built = buildCommand(id, session.address, input, qualifier)
  if (!built.ok) {
    return { status: 'invalid', reason: built.error }
  }
  const { spec, value } = built.value
  const targetPgn = spec.message.fields.pgn
  const readBack = entry.readable ? buildRead(id, session.address, qualifier) : null
  const readSpec = readBack?.ok === true ? readBack.value : null

  /** Only an acknowledgement naming the command's own PGN says the device received it. */
  const refusedByDevice = (outcome: Outcome<void>): AcknowledgeResult | null => {
    const detail = outcome.status === 'rejected' ? outcome.detail : undefined
    return detail !== undefined && detail.acknowledgedPgn === targetPgn ? detail : null
  }

  const restore = entry.isRestore?.(value) === true
  const { command, read } = await session.commandThenRead(spec, (outcome) => {
    if (outcome.status === 'answered') {
      return readSpec
    }
    const refusal = refusedByDevice(outcome)
    return refusal === null || isAccessDenied(refusal) ? null : readSpec
  })

  if (command.status === 'unknown') {
    return command
  }
  if (command.status === 'rejected') {
    const refusal = refusedByDevice(command)
    if (refusal === null) {
      return { status: 'notSent', reason: command.reason }
    }
    const stored = read === null ? undefined : readResultOf(read, now)
    return {
      status: 'rejected',
      reason: command.reason,
      refusedFields: refusedFields(entry, spec.message.fields.list, targetPgn, refusal),
      detail: refusal,
      requested: value,
      ...(stored === undefined ? {} : { readBack: stored }),
      ...(stored?.status === 'answered' && !restore
        ? { storedMatches: entry.sameAsStored(value, stored.value) }
        : {})
    }
  }
  if (read === null) {
    return { status: 'acknowledged' }
  }
  const stored = readResultOf(read, now)
  if (stored.status !== 'answered') {
    return { status: 'acknowledged', readBack: stored }
  }
  // An acknowledged restore holds whatever the device's default is.
  return restore || entry.sameAsStored(value, stored.value)
    ? { status: 'applied', stored: stored.value, readAt: stored.readAt }
    : { status: 'storedDiffers', requested: value, stored: stored.value, readAt: stored.readAt }
}
