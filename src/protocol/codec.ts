/**
 * Airmar proprietary protocol codec.
 *
 * Group functions are built as canboatjs JSON objects and emitted on
 * `nmea2000JsonOut`, where the server's own canboatjs encodes them. canboatjs
 * produces output byte-identical to a hand-built Actisense string for every
 * such message, so none are built by hand.
 *
 * The two exceptions are proprietary IDs 1 and 130; see pids.ts for why they
 * are fixed byte strings instead.
 */

import {
  ACCESS_LEVEL_1_KEY,
  AIRMAR,
  AirmarPid,
  CALIBRATE_SPEED_NAME,
  CURVE_FIRST_PAIR_PARAM,
  EepromResetOption,
  MASTER_RESET_PAYLOAD,
  MAX_CURVE_HZ,
  MAX_CURVE_POINTS,
  MAX_CURVE_SPEED,
  PARAM,
  PGN,
  RESTORE_DEFAULT_CURVE,
  eepromResetPayload
} from './pids.js'
import type { DecodedPgn, OutgoingPgn, OutgoingRaw } from './messages.js'

export type { DecodedPgn, OutgoingPgn, OutgoingRaw } from './messages.js'

export {
  AIRMAR,
  AirmarPid,
  EepromResetOption,
  PGN,
  MAX_CURVE_POINTS,
  MAX_CURVE_HZ,
  MAX_CURVE_SPEED
} from './pids.js'

export interface Parameter {
  parameter: number
  value: number
}

/** A point on the paddlewheel transfer function. */
export interface CurvePoint {
  /** Pulse frequency, in Hz. Stored at 0.1 Hz resolution. */
  hz: number
  /** Speed through water, in m/s. Stored at 0.01 m/s resolution. */
  speed: number
}

const PRIORITY = 3
/** PGN 126208 field 4: leave the commanded PGN's priority unchanged. */
const PRIORITY_UNCHANGED = 8

const identity = (pid: AirmarPid): Parameter[] => [
  { parameter: PARAM.manufacturerCode, value: AIRMAR.manufacturerCode },
  { parameter: PARAM.industryCode, value: AIRMAR.industryCode },
  { parameter: PARAM.proprietaryId, value: pid }
]

/**
 * Check a 126720 parameter list names, and leads with, the identifying pairs.
 *
 * canboatjs narrows the 126720 variant by those match fields and throws an
 * opaque `unable to read` when they are absent or follow the fields they are
 * meant to narrow. Failing here names the problem instead.
 */
export function assertIdentity(params: Parameter[]): void {
  const first: number | undefined = params.length > 0 ? params[0].parameter : undefined
  if (first !== PARAM.manufacturerCode) {
    throw new Error(
      `A PGN 126720 parameter list must lead with the manufacturer code (parameter ${String(PARAM.manufacturerCode)}), not parameter ${String(first ?? 'none')}`
    )
  }
  const pidAt = params.findIndex((p) => p.parameter === PARAM.proprietaryId)
  if (pidAt === -1) {
    throw new Error(
      `A PGN 126720 parameter list must name the proprietary ID (parameter ${String(PARAM.proprietaryId)})`
    )
  }
  const narrowed = params.findIndex((p) => p.parameter > PARAM.proprietaryId)
  if (narrowed !== -1 && narrowed < pidAt) {
    throw new Error(
      `The proprietary ID (parameter ${String(PARAM.proprietaryId)}) must precede the fields it narrows; parameter ${String(params[narrowed].parameter)} comes first`
    )
  }
}

function groupFunction(
  dst: number,
  functionCode: 'Request' | 'Command',
  targetPgn: number,
  params: Parameter[]
): OutgoingPgn {
  const list = params.map((p) => ({ parameter: p.parameter, value: p.value }))
  // The transmission interval and its offset are left out rather than set to
  // a sentinel: they carry a 0.001 s resolution, so a raw 0xffffffff would be
  // scaled. Omitting them encodes the not-available value the device expects.
  const fields: Record<string, unknown> =
    functionCode === 'Request'
      ? { functionCode, pgn: targetPgn, numberOfParameters: list.length, list }
      : {
          functionCode,
          pgn: targetPgn,
          priority: PRIORITY_UNCHANGED,
          numberOfParameters: list.length,
          list
        }
  return { pgn: PGN.groupFunction, dst, prio: PRIORITY, fields }
}

/** Request a proprietary PGN 126720 message by its proprietary ID. */
export function requestProprietary(
  dst: number,
  pid: AirmarPid,
  qualifiers: Parameter[] = []
): OutgoingPgn {
  const params = [...identity(pid), ...qualifiers]
  assertIdentity(params)
  return groupFunction(dst, 'Request', PGN.proprietary, params)
}

/**
 * Request one of Airmar's own proprietary PGNs, such as 65409 or 130944.
 *
 * The manual requires fields 1 and 3 in the request, and none of these PGNs
 * answers an ISO Request.
 */
export function requestAirmarPgn(dst: number, pgn: number): OutgoingPgn {
  return groupFunction(dst, 'Request', pgn, [
    { parameter: PARAM.manufacturerCode, value: AIRMAR.manufacturerCode },
    { parameter: PARAM.industryCode, value: AIRMAR.industryCode }
  ])
}

/** Request a standard PGN, such as 126996 Product Information. */
export function requestStandardPgn(dst: number, pgn: number): OutgoingPgn {
  return groupFunction(dst, 'Request', pgn, [])
}

/** Command a proprietary PGN 126720 message. */
export function commandProprietary(dst: number, pid: AirmarPid, params: Parameter[]): OutgoingPgn {
  const full = [...identity(pid), ...params]
  assertIdentity(full)
  return groupFunction(dst, 'Command', PGN.proprietary, full)
}

/** Command a field of a standard, non-proprietary PGN. */
export function commandStandardField(
  dst: number,
  targetPgn: number,
  params: Parameter[]
): OutgoingPgn {
  return groupFunction(dst, 'Command', targetPgn, params)
}

/**
 * Raise the access level to 1.
 *
 * Field 7 is a fixed password for this level; levels above 1 need a seed and a
 * key and are out of scope. The level is granted to the commanding source
 * address only, and expires 15 minutes after unlock or at power-down.
 */
export function unlockLevel1(dst: number): OutgoingPgn {
  return groupFunction(dst, 'Command', PGN.accessLevel, [
    { parameter: PARAM.manufacturerCode, value: AIRMAR.manufacturerCode },
    { parameter: PARAM.industryCode, value: AIRMAR.industryCode },
    { parameter: PARAM.accessFormatCode, value: 1 },
    { parameter: PARAM.accessLevel, value: 1 },
    { parameter: PARAM.accessSeedKey, value: ACCESS_LEVEL_1_KEY }
  ])
}

export function requestSpeedCurve(dst: number): OutgoingPgn {
  return requestProprietary(dst, AirmarPid.CalibrateSpeed)
}

/**
 * Write the whole speed calibration curve.
 *
 * The protocol takes every point in one command; a subset is not permitted.
 *
 * Validation is strict rather than clamping, because a clamped point is still
 * a curve the user did not ask for, written to EEPROM, and the device does not
 * report the inconsistency. Three cases are easy to reach from a web form and
 * all three encode silently without these checks: NaN from an empty number
 * input, which defeats every comparison and stores as 0 Hz; a value beyond the
 * field range, which truncates to 16 bits so -5 Hz becomes 6548.6 Hz; and two
 * points closer than the 0.1 Hz storage resolution, which land on the same
 * stored frequency and give the transfer function a zero-width segment.
 */
export function setSpeedCurve(dst: number, points: CurvePoint[]): OutgoingPgn {
  if (points.length === 0 || points.length > MAX_CURVE_POINTS) {
    throw new Error(
      `A speed curve holds 1 to ${String(MAX_CURVE_POINTS)} points, not ${String(points.length)}`
    )
  }
  points.forEach((point, index) => {
    const at = `point ${String(index + 1)}`
    if (!Number.isFinite(point.hz) || point.hz < 0 || point.hz > MAX_CURVE_HZ) {
      throw new Error(
        `${at}: frequency must be between 0 and ${String(MAX_CURVE_HZ)} Hz, not ${String(point.hz)}`
      )
    }
    if (!Number.isFinite(point.speed) || point.speed < 0 || point.speed > MAX_CURVE_SPEED) {
      throw new Error(
        `${at}: speed must be between 0 and ${String(MAX_CURVE_SPEED)} m/s, not ${String(point.speed)}`
      )
    }
  })
  // Compared at the stored resolution, not as floats: the device sees the
  // quantised values, so that is where "monotonically increasing" applies.
  const storedHz = points.map((point) => Math.round(point.hz * 10))
  for (let i = 1; i < storedHz.length; i += 1) {
    if (storedHz[i] <= storedHz[i - 1]) {
      throw new Error(
        `Curve frequencies must increase at the stored 0.1 Hz resolution: point ${String(i + 1)} stores as ${String(storedHz[i] / 10)} Hz, after ${String(storedHz[i - 1] / 10)} Hz`
      )
    }
  }
  const pairs = points.flatMap((point, index) => [
    { parameter: CURVE_FIRST_PAIR_PARAM + 2 * index, value: point.hz },
    { parameter: CURVE_FIRST_PAIR_PARAM + 2 * index + 1, value: point.speed }
  ])
  return commandProprietary(dst, AirmarPid.CalibrateSpeed, [
    { parameter: PARAM.curvePointCount, value: points.length },
    ...pairs
  ])
}

export function restoreDefaultSpeedCurve(dst: number): OutgoingPgn {
  return commandProprietary(dst, AirmarPid.CalibrateSpeed, [
    { parameter: PARAM.curvePointCount, value: RESTORE_DEFAULT_CURVE }
  ])
}

/**
 * Reboot the device, as if power had been cycled.
 *
 * Requires Access Level 1. Sent as a bare addressed 126720, not a Command
 * Group Function, so the device sends no acknowledgement. It re-runs address
 * claim and may take a different source address, and it loses its access level
 * and simulate mode — so the caller must re-resolve the address and re-unlock
 * before commanding it again.
 */
export function masterReset(dst: number): OutgoingRaw {
  return { pgn: PGN.proprietary, dst, prio: PRIORITY, payload: MASTER_RESET_PAYLOAD }
}

/**
 * Restore part of user EEPROM to its factory state.
 *
 * Requires Access Level 1, and like master reset is not acknowledged.
 *
 * `EepromResetOption.All` includes the speed calibration curve. It is also
 * numeric zero, which is what an uninitialised variable or an empty parsed
 * form field carries, and the wire field is four bits so 16 and 0.5 truncate
 * onto it too. The option is therefore checked against the enum rather than
 * trusted from the type.
 */
export function resetEeprom(dst: number, option: EepromResetOption): OutgoingRaw {
  if (!Object.values(EepromResetOption).includes(option)) {
    throw new Error(`${String(option)} is not an EEPROM reset option`)
  }
  return { pgn: PGN.proprietary, dst, prio: PRIORITY, payload: eepromResetPayload(option) }
}

/* ------------------------------------------------------------------ decode */

export interface ParameterError {
  /** 1-based position in the parameter list the device rejected. */
  index: number
  error: string
}

export interface AcknowledgeResult {
  /** Undefined when the reply did not name a PGN, which is not correlatable. */
  acknowledgedPgn: number | undefined
  src: number | undefined
  ok: boolean
  pgnError: string
  /** The device's verdict on the commanded priority or transmission interval. */
  intervalPriorityError: string
  parameterErrors: ParameterError[]
  /**
   * How many of the declared per-parameter codes are absent from the decoded
   * list. Non-zero means the positions in `parameterErrors` cannot be trusted:
   * canboatjs drops an entry it cannot name rather than leaving a gap.
   */
  missingParameterCodes: number
}

/** The device acknowledged with no error. Any other code is a failure. */
export const ACK_OK = 'Acknowledge'

/** PGN error 3, interval error 3 and parameter error 4: the access level is too low. */
export const ACCESS_DENIED = 'Access denied'

/** Parameter error 2: the device is momentarily unable to comply. */
export const TEMPORARY_ERROR = 'Temporary error'

/**
 * A code field that carries no code.
 *
 * All ones in a 4-bit field is "data not available". With names resolved,
 * canboatjs drops such a field from the decoded message, as it does a field
 * a truncated frame never carried; with `resolveEnums: false` it arrives as
 * 15. Both read the same, and both are failures, because a refusal read as
 * success is a write reported as applied.
 */
export const NO_CODE = 'No code'

const NOT_AVAILABLE_4_BIT = 0xf

/**
 * The names canboatjs gives each acknowledgement code, indexed by code.
 *
 * A code arrives as a number, not a name, in two cases: canboatjs has no name
 * for it, or the provider set `resolveEnums: false`, which the server passes
 * straight to canboatjs. In the second case even a clean acknowledgement is
 * code 0, so without these tables every write would read as refused and
 * every access-denied reply would miss the re-unlock.
 *
 * Copied from PGN_ERROR_CODE, TRANSMISSION_INTERVAL and PARAMETER_FIELD in
 * `@canboat/ts-pgns` `canboat-lookups.json`, 1.11.18. A test decodes every
 * code both ways through the installed canboatjs, so a rename there fails it.
 */
const PGN_ERROR_NAMES = [
  ACK_OK,
  'PGN not supported',
  'PGN not available',
  ACCESS_DENIED,
  'Not supported',
  'Tag not supported',
  'Read or Write not supported'
]
const INTERVAL_ERROR_NAMES = [
  ACK_OK,
  'Transmit Interval/Priority not supported',
  'Transmit Interval too low',
  ACCESS_DENIED,
  'Not supported'
]
const PARAMETER_ERROR_NAMES = [
  ACK_OK,
  'Invalid parameter field',
  TEMPORARY_ERROR,
  'Parameter out of range',
  ACCESS_DENIED,
  'Not supported',
  'Read or Write not supported'
]

/**
 * Anything that is not the acknowledgement code is a failure.
 *
 * The fields are four bits wide and the lookups name fewer than half the
 * values. Defaulting an unnamed or absent code to success would report a
 * refused command as applied.
 */
const errorText = (value: unknown, names: readonly string[]): string => {
  if (typeof value === 'string') {
    return value
  }
  if (value === undefined || value === NOT_AVAILABLE_4_BIT) {
    return NO_CODE
  }
  if (typeof value === 'number') {
    return names[value] ?? `Unknown code ${String(value)}`
  }
  return `Unknown code ${JSON.stringify(value)}`
}

/**
 * Read a PGN 126208 Acknowledge Group Function.
 *
 * Returns null for any other 126208, including the requests and commands this
 * plugin itself sends, which are echoed back on a shared bus.
 *
 * This says nothing about whether the acknowledgement answers a command *this*
 * plugin sent. Airmar messages carry no transaction id, so correlation is the
 * caller's job: match on `src` and serialise one command per device.
 */
export function decodeAcknowledge(message: DecodedPgn): AcknowledgeResult | null {
  const fields = message.fields ?? {}
  if (message.pgn !== PGN.groupFunction || fields.functionCode !== ACK_OK) {
    return null
  }
  const pgnError = errorText(fields.pgnErrorCode, PGN_ERROR_NAMES)
  const intervalPriorityError = errorText(
    fields.transmissionIntervalPriorityErrorCode,
    INTERVAL_ERROR_NAMES
  )
  const list = Array.isArray(fields.list) ? (fields.list as { parameter?: unknown }[]) : []
  const parameterErrors = list.flatMap((entry, index) => {
    const error = errorText(entry.parameter, PARAMETER_ERROR_NAMES)
    return error === ACK_OK ? [] : [{ index: index + 1, error }]
  })
  const declared = fields.numberOfParameters
  const missingParameterCodes =
    typeof declared === 'number' && declared > list.length ? declared - list.length : 0
  return {
    acknowledgedPgn: typeof fields.pgn === 'number' ? fields.pgn : undefined,
    src: message.src,
    ok:
      pgnError === ACK_OK &&
      intervalPriorityError === ACK_OK &&
      parameterErrors.length === 0 &&
      missingParameterCodes === 0,
    pgnError,
    intervalPriorityError,
    parameterErrors,
    missingParameterCodes
  }
}

/**
 * Read a speed calibration curve reply.
 *
 * The device returns a fixed-length list and declares how many rows are real;
 * the rest are padding. Reading past that count yields phantom points, which
 * written back would be a curve reading zero speed at every frequency.
 *
 * Returns null for anything that is not a Calibrate Speed reply: the caller is
 * fed by a firehose covering every device on the bus.
 */
export function decodeSpeedCurve(message: DecodedPgn): CurvePoint[] | null {
  const fields = message.fields ?? {}
  if (message.pgn !== PGN.proprietary || fields.proprietaryId !== CALIBRATE_SPEED_NAME) {
    return null
  }
  const declared = fields.numberOfPairsOfDataPoints
  const list = Array.isArray(fields.list)
    ? (fields.list as { inputFrequency?: number; outputSpeed?: number }[])
    : []
  const count =
    typeof declared === 'number' && Number.isFinite(declared)
      ? Math.max(0, Math.min(Math.trunc(declared), list.length))
      : list.length
  return list.slice(0, count).map((row) => ({
    hz: row.inputFrequency ?? 0,
    speed: row.outputSpeed ?? 0
  }))
}
