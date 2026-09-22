/**
 * Airmar proprietary protocol codec.
 *
 * Every message is built as a canboatjs JSON object and emitted on
 * `nmea2000JsonOut`. canboatjs produces output byte-identical to a hand-built
 * Actisense string for every message this plugin sends, so none are built by
 * hand.
 */

import { addCustomPgns } from '@canboat/canboatjs'
import {
  ACCESS_LEVEL_1_KEY,
  AIRMAR,
  AirmarPid,
  CUSTOM_PGNS,
  EepromResetOption,
  PARAM,
  PGN,
  RESTORE_DEFAULT_CURVE
} from './pids.js'

export { AIRMAR, AirmarPid, EepromResetOption, PGN } from './pids.js'

let registered = false

/**
 * canboatjs keeps one process-wide custom PGN registry shared with the whole
 * Signal K server, so register once.
 */
function ensureCustomPgns(): void {
  if (registered) {
    return
  }
  addCustomPgns(CUSTOM_PGNS, 'signalk-airmar-dst-config')
  registered = true
}
ensureCustomPgns()

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

/** A canboatjs JSON message, ready to emit on `nmea2000JsonOut`. */
export interface N2kMessage {
  pgn: number
  dst: number
  prio: number
  fields: Record<string, unknown>
}

const PRIORITY = 3
/** PGN 126208 field 4: leave the commanded PGN's priority unchanged. */
const PRIORITY_UNCHANGED = 8

const identity = (pid: AirmarPid): Parameter[] => [
  { parameter: PARAM.manufacturerCode, value: AIRMAR.manufacturerCode },
  { parameter: PARAM.industryCode, value: AIRMAR.industryCode },
  { parameter: PARAM.proprietaryId, value: pid }
]

function assertIdentity(params: Parameter[]): void {
  const present = new Set(params.map((p) => p.parameter))
  if (!present.has(PARAM.manufacturerCode) || !present.has(PARAM.proprietaryId)) {
    throw new Error(
      'A PGN 126720 parameter list must name the manufacturer code (parameter 1) and the proprietary ID (parameter 4); canboatjs cannot resolve the variant without them'
    )
  }
}

function groupFunction(
  dst: number,
  functionCode: 'Request' | 'Command',
  targetPgn: number,
  params: Parameter[]
): N2kMessage {
  const list = params.map((p) => ({ parameter: p.parameter, value: p.value }))
  // The transmission interval and its offset are left out rather than set to
  // a sentinel: they carry a 0.001 s resolution, so a raw 0xffffffff would be
  // scaled. Omitting them encodes the not-available value the device expects.
  const fields: Record<string, unknown> =
    functionCode === 'Request'
      ? {
          functionCode,
          pgn: targetPgn,
          numberOfParameters: list.length,
          list
        }
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
): N2kMessage {
  const params = [...identity(pid), ...qualifiers]
  assertIdentity(params)
  return groupFunction(dst, 'Request', PGN.proprietary, params)
}

export interface ProprietaryOptions {
  /** Test hook: skip the identifying pairs so the guard can be exercised. */
  omitIdentity?: boolean
}

/** Command a proprietary PGN 126720 message. */
export function commandProprietary(
  dst: number,
  pid: AirmarPid,
  params: Parameter[],
  options: ProprietaryOptions = {}
): N2kMessage {
  const full = options.omitIdentity === true ? params : [...identity(pid), ...params]
  assertIdentity(full)
  return groupFunction(dst, 'Command', PGN.proprietary, full)
}

/** Command a field of a standard, non-proprietary PGN. */
export function commandStandardField(
  dst: number,
  targetPgn: number,
  params: Parameter[]
): N2kMessage {
  return groupFunction(dst, 'Command', targetPgn, params)
}

/**
 * Raise the access level to 1.
 *
 * Field 7 is a fixed password for this level; levels above 1 need a seed and a
 * key and are out of scope. The level expires 15 minutes after unlock or at
 * power-down and is not stored in EEPROM.
 */
export function unlockLevel1(dst: number): N2kMessage {
  return groupFunction(dst, 'Command', PGN.accessLevel, [
    { parameter: 1, value: AIRMAR.manufacturerCode },
    { parameter: 3, value: AIRMAR.industryCode },
    { parameter: 4, value: 1 },
    { parameter: 5, value: 1 },
    { parameter: 7, value: ACCESS_LEVEL_1_KEY }
  ])
}

export function requestSpeedCurve(dst: number): N2kMessage {
  return requestProprietary(dst, AirmarPid.CalibrateSpeed)
}

/**
 * Write the whole speed calibration curve.
 *
 * The protocol takes every point in one command; a subset is not permitted.
 * Input frequencies must increase monotonically, and at most 25 points fit.
 */
export function setSpeedCurve(dst: number, points: CurvePoint[]): N2kMessage {
  if (points.length === 0 || points.length > 25) {
    throw new Error(`A speed curve holds 1 to 25 points, not ${String(points.length)}`)
  }
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].hz <= points[i - 1].hz) {
      throw new Error(
        `Curve input frequencies must increase: point ${String(i + 1)} is ${String(points[i].hz)} Hz after ${String(points[i - 1].hz)} Hz`
      )
    }
  }
  const pairs = points.flatMap((point, index) => [
    { parameter: 6 + 2 * index, value: point.hz },
    { parameter: 7 + 2 * index, value: point.speed }
  ])
  return commandProprietary(dst, AirmarPid.CalibrateSpeed, [
    { parameter: 5, value: points.length },
    ...pairs
  ])
}

export function restoreDefaultSpeedCurve(dst: number): N2kMessage {
  return commandProprietary(dst, AirmarPid.CalibrateSpeed, [
    { parameter: 5, value: RESTORE_DEFAULT_CURVE }
  ])
}

/**
 * Reboot the device, as if power had been cycled.
 *
 * Sent as a bare addressed 126720, not a Command Group Function, so the device
 * sends no acknowledgement. It re-runs address claim and loses its access
 * level and simulate mode.
 */
export function masterReset(dst: number): N2kMessage {
  return {
    pgn: PGN.proprietary,
    dst,
    prio: PRIORITY,
    fields: {
      manufacturerCode: AIRMAR.manufacturerCode,
      industryCode: AIRMAR.industryCode,
      proprietaryId: AirmarPid.MasterReset
    }
  }
}

/**
 * Restore part of user EEPROM to its factory state.
 *
 * Option `All` includes the speed calibration curve. Like master reset, this
 * is a bare addressed 126720 and is not acknowledged.
 */
export function resetEeprom(dst: number, option: EepromResetOption): N2kMessage {
  return {
    pgn: PGN.proprietary,
    dst,
    prio: PRIORITY,
    fields: {
      manufacturerCode: AIRMAR.manufacturerCode,
      industryCode: AIRMAR.industryCode,
      proprietaryId: AirmarPid.ResetEeprom,
      options: option
    }
  }
}

/* ------------------------------------------------------------------ decode */

interface DecodedMessage {
  pgn: number
  src?: number
  fields?: Record<string, unknown>
}

export interface ParameterError {
  /** 1-based position in the parameter list the device rejected. */
  index: number
  error: string
}

export interface AcknowledgeResult {
  acknowledgedPgn: number
  src: number | undefined
  ok: boolean
  pgnError: string
  parameterErrors: ParameterError[]
}

const OK = 'Acknowledge'

/**
 * Read a PGN 126208 Acknowledge Group Function.
 *
 * Returns null for any other 126208, including the requests and commands this
 * plugin itself sends, which are echoed back on a shared bus.
 */
export function decodeAcknowledge(message: DecodedMessage): AcknowledgeResult | null {
  const fields = message.fields ?? {}
  if (message.pgn !== PGN.groupFunction || fields.functionCode !== OK) {
    return null
  }
  const pgnError = typeof fields.pgnErrorCode === 'string' ? fields.pgnErrorCode : OK
  const list = Array.isArray(fields.list) ? (fields.list as { parameter?: unknown }[]) : []
  const parameterErrors = list.flatMap((entry, index) =>
    typeof entry.parameter === 'string' && entry.parameter !== OK
      ? [{ index: index + 1, error: entry.parameter }]
      : []
  )
  return {
    acknowledgedPgn: typeof fields.pgn === 'number' ? fields.pgn : 0,
    src: message.src,
    ok: pgnError === OK && parameterErrors.length === 0,
    pgnError,
    parameterErrors
  }
}

/**
 * Read a speed calibration curve reply.
 *
 * The device returns a fixed-length list and declares how many rows are real;
 * the rest are padding. Reading past that count yields phantom points.
 */
export function decodeSpeedCurve(message: DecodedMessage): CurvePoint[] {
  const fields = message.fields ?? {}
  const declared = fields.numberOfPairsOfDataPointsToFollow
  const list = Array.isArray(fields.list)
    ? (fields.list as { inputFrequency?: number; outputSpeed?: number }[])
    : []
  const count = typeof declared === 'number' ? Math.min(declared, list.length) : list.length
  return list.slice(0, count).map((row) => ({
    hz: row.inputFrequency ?? 0,
    speed: row.outputSpeed ?? 0
  }))
}
