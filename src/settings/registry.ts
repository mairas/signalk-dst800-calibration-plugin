/**
 * Every configurable capability, described once.
 *
 * Each entry says how to ask the device for its current value, how to check a
 * value a user typed, how to command it, and how to tell whether what the
 * device stored is what was asked for, so that routes and a write contract
 * can be generic over these entries and a new capability is a new entry.
 *
 * Field numbers, resolutions and ranges are from the DST200 manual. Names in
 * decoded replies are canboat's, and every lookup is accepted both as its
 * name and as its raw number, because a provider can turn name resolution
 * off.
 */

import type { Capability } from '../devices/probe.js'
import {
  commandProprietary,
  commandStandardField,
  decodeSpeedCurve,
  requestProprietary,
  requestStandardPgn,
  setSpeedCurve,
  type CurvePoint
} from '../protocol/codec.js'
import type { DecodedPgn, OutgoingPgn } from '../protocol/messages.js'
import {
  AirmarPid,
  CURVE_FIRST_PAIR_PARAM,
  CURVE_HZ_RESOLUTION,
  CURVE_SPEED_RESOLUTION,
  MAX_CURVE_POINTS,
  PGN,
  pidFromName
} from '../protocol/pids.js'
import type { CommandSpec, ReadSpec } from '../session/deviceSession.js'

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string }

/** One value a qualified capability is read and written per, with canboat's name for it. */
export interface Qualifier {
  value: number
  label: string
}

/**
 * One capability.
 *
 * `Stored` is what a read returns; `Written` is what a user supplies. They
 * differ where the device reports more than can be set, such as the distance
 * log's total alongside the resettable trip distance.
 */
export interface Setting<Stored, Written> {
  id: string
  /** The requirement in the plan this capability satisfies. */
  requirement: string
  /** What the probe must find for this capability to be offered; null when it is not probed. */
  capability: Capability | null
  /** Applies to the read as well as the command: `buildRead` and `buildCommand` add it. */
  requiresLevel1: boolean
  /** False when the device's value cannot be read back, and `read` returns null. */
  readable: boolean
  /** False for a read-only capability, whose `command` returns null. */
  writable: boolean
  /** The values a qualified capability is read and written per, such as a temperature source. */
  qualifiers?: readonly Qualifier[]
  /** Null when the value cannot be read back. */
  read(address: number, qualifier?: number): Omit<ReadSpec<Stored>, 'requiresLevel1'> | null
  /** Check input from outside the plugin. Nothing reaches the bus without passing this. */
  parse(input: unknown): ParseResult<Written>
  /** Null for a read-only capability. */
  command(address: number, value: Written, qualifier?: number): OutgoingPgn | null
  /** Whether the device stored what was asked for, at the device's own resolution. */
  sameAsStored(requested: Written, stored: Stored): boolean
  /**
   * The user's name for a field of the commanded PGN, so a refusal can say
   * which one the device refused. Null for a field the entry does not write.
   */
  fieldName(parameter: number): string | null
}

/**
 * A filter write.
 *
 * The device stores the parameters per filter type, so a type alone switches
 * filters and keeps each type's stored parameters. The IIR filter takes both
 * of its parameters or neither: the manual requires both in one command.
 */
export interface FilterSettings {
  /** 0 is no filter, 1 is the basic IIR filter. */
  type: 0 | 1
  /** Seconds between samples, stored at 0.01 s. */
  sampleInterval?: number
  /** Seconds, stored at 0.01 s. Only the IIR filter has one. */
  filterDuration?: number
}

export interface InstallationDescription {
  description1?: string
  description2?: string
}

export interface ProductInformation {
  productCode: number | null
  modelId: string | null
  softwareVersionCode: string | null
  modelVersion: string | null
  modelSerialCode: string | null
}

export interface DistanceLog {
  /** Metres since installation. */
  log: number | null
  /** Metres since the last reset. */
  tripLog: number | null
}

const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value })
const fail = <T>(error: string): ParseResult<T> => ({ ok: false, error })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The integer step a value is stored as.
 *
 * Rounded the way canboatjs encodes it, half away from zero. `Math.round`
 * rounds a negative half step the other way, and would compare -0.0015 K as
 * -1 step while the device stores -2.
 */
const stepOf = (resolution: number, value: number): number =>
  Number((value / resolution).toFixed(0))

/** Equal once both are stored at `resolution`, which is where the device compares them. */
const sameAt = (resolution: number, a: number, b: number): boolean =>
  stepOf(resolution, a) === stepOf(resolution, b)

function numberIn(input: unknown, min: number, max: number, what: string): ParseResult<number> {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return fail(`${what} must be a number`)
  }
  if (input < min || input > max) {
    return fail(`${what} must be between ${String(min)} and ${String(max)}, not ${String(input)}`)
  }
  return ok(input)
}

function booleanInput(input: unknown, what: string): ParseResult<boolean> {
  return typeof input === 'boolean' ? ok(input) : fail(`${what} must be true or false`)
}

/**
 * A lookup field as a number, whether canboatjs named it or not.
 *
 * `names[i]` is canboat's name for value `i`.
 */
function lookupValue(value: unknown, names: readonly string[]): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return value
  }
  const index = typeof value === 'string' ? names.indexOf(value) : -1
  return index === -1 ? null : index
}

const numberField = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

const textField = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** A reply of `pgn` from the device, or null for anything else on the bus. */
const fieldsOf = (reply: DecodedPgn, pgn: number): Record<string, unknown> | null =>
  reply.pgn === pgn ? (reply.fields ?? {}) : null

/** A 126720 reply naming `pid`. The session filters on this too; decoders do not rely on it. */
const pidFieldsOf = (reply: DecodedPgn, pid: AirmarPid): Record<string, unknown> | null => {
  const fields = fieldsOf(reply, PGN.proprietary)
  return fields !== null && pidFromName(fields.proprietaryId) === pid ? fields : null
}

/* ------------------------------------------------------------ on/off fields */

/** canboat's OFF_ON lookup: PID 35 field 5. */
const OFF_ON = ['Off', 'On'] as const
/** canboat's AIRMAR_TRANSMISSION_INTERVAL lookup: PID 46 field 5. */
const TRANSMISSION_INTERVAL = ['Measure interval', 'Requested by user'] as const

/** A 2-bit on/off field in a single-field PID: simulate mode and the PID 46 option. */
function onOffSetting(options: {
  id: string
  requirement: string
  pid: AirmarPid
  field: string
  names: readonly string[]
  requiresLevel1: boolean
}): Setting<boolean, boolean> {
  const { pid, field, names } = options
  return {
    id: options.id,
    requirement: options.requirement,
    capability: { kind: 'pid', pid },
    requiresLevel1: options.requiresLevel1,
    readable: true,
    writable: true,
    read: (address) => ({
      message: requestProprietary(address, pid),
      match: (reply) => {
        const fields = pidFieldsOf(reply, pid)
        const value = fields === null ? null : lookupValue(fields[field], names)
        return value === 0 || value === 1 ? value === 1 : null
      }
    }),
    parse: (input) => booleanInput(input, options.id),
    command: (address, value) =>
      commandProprietary(address, pid, [{ parameter: 5, value: value ? 1 : 0 }]),
    sameAsStored: (requested, stored) => requested === stored,
    fieldName: (parameter) => (parameter === 5 ? options.id : null)
  }
}

/* ----------------------------------------------------------------- filters */

const FILTER_FIELDS: Partial<Record<number, string>> = {
  5: 'type',
  7: 'sampleInterval',
  8: 'filterDuration'
}

/** Sample interval and filter duration: uint16 at 0.01 s, with 0 reserved. */
const FILTER_TIME_RESOLUTION = 0.01
const MAX_FILTER_SECONDS = 655.32

const filterTime = (input: unknown, what: string): ParseResult<number> =>
  numberIn(input, FILTER_TIME_RESOLUTION, MAX_FILTER_SECONDS, what)

function parseFilter(input: unknown): ParseResult<FilterSettings> {
  if (!isRecord(input)) {
    return fail('A filter is an object with a type')
  }
  const { type, sampleInterval, filterDuration } = input
  if (type !== 0 && type !== 1) {
    return fail('Filter type must be 0 (no filter) or 1 (basic IIR filter)')
  }
  if (type === 0) {
    if (filterDuration !== undefined) {
      return fail('The unfiltered type has no filter duration')
    }
    if (sampleInterval === undefined) {
      return ok({ type })
    }
    const interval = filterTime(sampleInterval, 'Sample interval')
    return interval.ok ? ok({ type, sampleInterval: interval.value }) : interval
  }
  if (sampleInterval === undefined && filterDuration === undefined) {
    return ok({ type })
  }
  if (sampleInterval === undefined || filterDuration === undefined) {
    return fail('The IIR filter takes both the sample interval and the filter duration, or neither')
  }
  const interval = filterTime(sampleInterval, 'Sample interval')
  if (!interval.ok) {
    return interval
  }
  const duration = filterTime(filterDuration, 'Filter duration')
  if (!duration.ok) {
    return duration
  }
  // The filter constant is duration over interval, and the manual requires
  // it to be at least 1.
  if (duration.value < interval.value) {
    return fail('Filter duration must be at least the sample interval')
  }
  return ok({ type, sampleInterval: interval.value, filterDuration: duration.value })
}

/**
 * Speed or temperature filter. Write-only.
 *
 * canboatjs 3.20.0 cannot decode a 126720-43 or -44 reply, and the server runs
 * the same version, so the stored value never reaches the plugin. The write
 * still reports the device's Acknowledge. See issue 22.
 */
function filterSetting(
  id: string,
  requirement: string,
  pid: AirmarPid
): Setting<never, FilterSettings> {
  return {
    id,
    requirement,
    capability: { kind: 'pid', pid },
    requiresLevel1: true,
    readable: false,
    writable: true,
    read: () => null,
    parse: parseFilter,
    command: (address, value) =>
      commandProprietary(address, pid, [
        { parameter: 5, value: value.type },
        ...(value.sampleInterval === undefined
          ? []
          : [{ parameter: 7, value: value.sampleInterval }]),
        ...(value.filterDuration === undefined
          ? []
          : [{ parameter: 8, value: value.filterDuration }])
      ]),
    sameAsStored: () => false,
    fieldName: (parameter) => FILTER_FIELDS[parameter] ?? null
  }
}

/* ----------------------------------------------------------- the settings */

/** Speed of sound, PID 40 field 5: the manual's allowable range. */
const MIN_SPEED_OF_SOUND = 1350
const MAX_SPEED_OF_SOUND = 1650
const SPEED_OF_SOUND_RESOLUTION = 0.1

/** Temperature offset, PID 42 field 7: the manual's allowable range. */
const MAX_TEMPERATURE_OFFSET = 9.999
const TEMPERATURE_OFFSET_RESOLUTION = 0.001
/** canboat's AIRMAR_TEMPERATURE_INSTANCE lookup: PID 42 field 5. */
const TEMPERATURE_SOURCES = ['Device Sensor', 'Onboard Water Sensor', 'Optional Water Sensor']
const TEMPERATURE_QUALIFIERS: readonly Qualifier[] = TEMPERATURE_SOURCES.map((label, value) => ({
  value,
  label
}))

/** Depth offset, PGN 128267 field 3: int16 at 1 mm. */
const MAX_DEPTH_OFFSET = 32.764
const DEPTH_OFFSET_RESOLUTION = 0.001

/** Installation description, PGN 126998 fields 1 and 2. */
const MAX_DESCRIPTION_LENGTH = 70
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/

/** Distance since last reset, PGN 128275 field 4: uint32 at 1 m, canboat's range. */
const MAX_TRIP_LOG = 0xfffffffc
const TRIP_LOG_RESOLUTION = 1
/**
 * How far the trip log may run on between a reset and its read-back.
 *
 * The device keeps counting while the boat moves, so a reset under way reads
 * back a few metres. 100 m covers a read-back that takes five seconds at
 * 40 kn, faster than any boat this sensor is fitted to.
 */
const MAX_TRIP_LOG_DRIFT = 100

const speedCurve: Setting<CurvePoint[], CurvePoint[]> = {
  id: 'speedCurve',
  requirement: 'R9',
  capability: { kind: 'pid', pid: AirmarPid.CalibrateSpeed },
  requiresLevel1: true,
  readable: true,
  writable: true,
  read: (address) => ({
    message: requestProprietary(address, AirmarPid.CalibrateSpeed),
    match: decodeSpeedCurve
  }),
  parse: (input) => {
    if (!Array.isArray(input) || input.length > MAX_CURVE_POINTS) {
      return fail(`A curve is a list of 1 to ${String(MAX_CURVE_POINTS)} points`)
    }
    const points: CurvePoint[] = []
    for (const [index, point] of input.entries()) {
      if (!isRecord(point) || typeof point.hz !== 'number' || typeof point.speed !== 'number') {
        return fail(`Point ${String(index + 1)} needs a numeric hz and speed`)
      }
      points.push({ hz: point.hz, speed: point.speed })
    }
    // The encoder owns the range and monotonicity rules; run it here so a bad
    // curve is refused before it reaches the bus, with the encoder's reason.
    try {
      setSpeedCurve(0, points)
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error))
    }
    return ok(points)
  },
  command: (address, value) => setSpeedCurve(address, value),
  sameAsStored: (requested, stored) =>
    requested.length === stored.length &&
    requested.every(
      (point, i) =>
        sameAt(CURVE_HZ_RESOLUTION, point.hz, stored[i].hz) &&
        sameAt(CURVE_SPEED_RESOLUTION, point.speed, stored[i].speed)
    ),
  // Field 5 is the point count, then each point is a frequency and speed pair.
  fieldName: (parameter) => {
    if (parameter === 5) {
      return 'point count'
    }
    if (parameter < CURVE_FIRST_PAIR_PARAM) {
      return null
    }
    const offset = parameter - CURVE_FIRST_PAIR_PARAM
    const point = Math.floor(offset / 2) + 1
    return `point ${String(point)} ${offset % 2 === 0 ? 'hz' : 'speed'}`
  }
}

const temperatureOffset: Setting<number, number> = {
  id: 'temperatureOffset',
  requirement: 'R10',
  capability: { kind: 'pid', pid: AirmarPid.CalibrateTemperature },
  requiresLevel1: true,
  readable: true,
  writable: true,
  qualifiers: TEMPERATURE_QUALIFIERS,
  read: (address, source = 0) => ({
    message: requestProprietary(address, AirmarPid.CalibrateTemperature, [
      { parameter: 5, value: source }
    ]),
    match: (reply) => {
      const fields = pidFieldsOf(reply, AirmarPid.CalibrateTemperature)
      if (
        fields === null ||
        lookupValue(fields.temperatureInstance, TEMPERATURE_SOURCES) !== source
      ) {
        return null
      }
      return numberField(fields.temperatureOffset)
    }
  }),
  parse: (input) =>
    numberIn(input, -MAX_TEMPERATURE_OFFSET, MAX_TEMPERATURE_OFFSET, 'Temperature offset'),
  // `buildCommand` has already checked the source against `qualifiers`.
  command: (address, value, source) => {
    if (source === undefined) {
      throw new Error('A temperature offset is written per source')
    }
    return commandProprietary(address, AirmarPid.CalibrateTemperature, [
      { parameter: 5, value: source },
      { parameter: 7, value }
    ])
  },
  sameAsStored: (requested, stored) => sameAt(TEMPERATURE_OFFSET_RESOLUTION, requested, stored),
  fieldName: (parameter) => (parameter === 5 ? 'source' : parameter === 7 ? 'value' : null)
}

const depthOffset: Setting<number, number> = {
  id: 'depthOffset',
  requirement: 'R11',
  capability: null,
  requiresLevel1: false,
  readable: true,
  writable: true,
  read: (address) => ({
    message: requestStandardPgn(address, PGN.waterDepth),
    match: (reply) => {
      const fields = fieldsOf(reply, PGN.waterDepth)
      return fields === null ? null : numberField(fields.offset)
    }
  }),
  parse: (input) => numberIn(input, -MAX_DEPTH_OFFSET, MAX_DEPTH_OFFSET, 'Depth offset'),
  command: (address, value) =>
    commandStandardField(address, PGN.waterDepth, [{ parameter: 3, value }]),
  sameAsStored: (requested, stored) => sameAt(DEPTH_OFFSET_RESOLUTION, requested, stored),
  fieldName: (parameter) => (parameter === 3 ? 'value' : null)
}

const speedOfSound: Setting<number, number> = {
  id: 'speedOfSound',
  requirement: 'R12',
  capability: { kind: 'pid', pid: AirmarPid.CalibrateDepth },
  requiresLevel1: true,
  readable: true,
  writable: true,
  read: (address) => ({
    message: requestProprietary(address, AirmarPid.CalibrateDepth),
    match: (reply) => {
      const fields = pidFieldsOf(reply, AirmarPid.CalibrateDepth)
      return fields === null ? null : numberField(fields.speedOfSoundMode)
    }
  }),
  parse: (input) => numberIn(input, MIN_SPEED_OF_SOUND, MAX_SPEED_OF_SOUND, 'Speed of sound'),
  command: (address, value) =>
    commandProprietary(address, AirmarPid.CalibrateDepth, [{ parameter: 5, value }]),
  sameAsStored: (requested, stored) => sameAt(SPEED_OF_SOUND_RESOLUTION, requested, stored),
  fieldName: (parameter) => (parameter === 5 ? 'value' : null)
}

const installationDescription: Setting<InstallationDescription, InstallationDescription> = {
  id: 'installationDescription',
  requirement: 'R16',
  capability: { kind: 'pgn', pgn: PGN.configurationInformation },
  requiresLevel1: false,
  readable: true,
  writable: true,
  read: (address) => ({
    message: requestStandardPgn(address, PGN.configurationInformation),
    match: (reply) => {
      const fields = fieldsOf(reply, PGN.configurationInformation)
      if (fields === null) {
        return null
      }
      return {
        description1: textField(fields.installationDescription1) ?? '',
        description2: textField(fields.installationDescription2) ?? ''
      }
    }
  }),
  parse: (input) => {
    if (!isRecord(input)) {
      return fail('An installation description is an object')
    }
    const value: InstallationDescription = {}
    for (const key of ['description1', 'description2'] as const) {
      const text = input[key]
      if (text === undefined) {
        continue
      }
      if (
        typeof text !== 'string' ||
        text.length > MAX_DESCRIPTION_LENGTH ||
        !PRINTABLE_ASCII.test(text)
      ) {
        return fail(
          `${key} must be printable ASCII of at most ${String(MAX_DESCRIPTION_LENGTH)} characters`
        )
      }
      // canboatjs trims a decoded string, so an edge space written would never
      // read back; write what the device will report.
      value[key] = text.trim()
    }
    return Object.keys(value).length === 0
      ? fail('Give description1, description2 or both')
      : ok(value)
  },
  command: (address, value) =>
    commandStandardField(address, PGN.configurationInformation, [
      ...(value.description1 === undefined ? [] : [{ parameter: 1, value: value.description1 }]),
      ...(value.description2 === undefined ? [] : [{ parameter: 2, value: value.description2 }])
    ]),
  sameAsStored: (requested, stored) =>
    (requested.description1 === undefined || requested.description1 === stored.description1) &&
    (requested.description2 === undefined || requested.description2 === stored.description2),
  fieldName: (parameter) =>
    parameter === 1 ? 'description1' : parameter === 2 ? 'description2' : null
}

const productInformation: Setting<ProductInformation, never> = {
  id: 'productInformation',
  requirement: 'R16',
  capability: { kind: 'pgn', pgn: PGN.productInformation },
  requiresLevel1: false,
  readable: true,
  writable: false,
  read: (address) => ({
    message: requestStandardPgn(address, PGN.productInformation),
    match: (reply) => {
      const fields = fieldsOf(reply, PGN.productInformation)
      if (fields === null) {
        return null
      }
      return {
        productCode: numberField(fields.productCode),
        modelId: textField(fields.modelId),
        softwareVersionCode: textField(fields.softwareVersionCode),
        modelVersion: textField(fields.modelVersion),
        modelSerialCode: textField(fields.modelSerialCode)
      }
    }
  }),
  parse: () => fail('Product information is read-only'),
  command: () => null,
  sameAsStored: () => false,
  fieldName: () => null
}

const distanceLog: Setting<DistanceLog, { tripLog: number }> = {
  id: 'distanceLog',
  requirement: 'R17',
  capability: { kind: 'pgn', pgn: PGN.distanceLog },
  requiresLevel1: false,
  readable: true,
  writable: true,
  read: (address) => ({
    message: requestStandardPgn(address, PGN.distanceLog),
    match: (reply) => {
      const fields = fieldsOf(reply, PGN.distanceLog)
      return fields === null
        ? null
        : { log: numberField(fields.log), tripLog: numberField(fields.tripLog) }
    }
  }),
  parse: (input) => {
    if (!isRecord(input)) {
      return fail('A distance log write is an object with the new tripLog')
    }
    const tripLog = numberIn(input.tripLog, 0, MAX_TRIP_LOG, 'tripLog')
    return tripLog.ok ? ok({ tripLog: tripLog.value }) : tripLog
  },
  command: (address, value) =>
    commandStandardField(address, PGN.distanceLog, [{ parameter: 4, value: value.tripLog }]),
  sameAsStored: (requested, stored) => {
    if (stored.tripLog === null) {
      return false
    }
    const ran =
      stepOf(TRIP_LOG_RESOLUTION, stored.tripLog) - stepOf(TRIP_LOG_RESOLUTION, requested.tripLog)
    return ran >= 0 && ran <= MAX_TRIP_LOG_DRIFT
  },
  fieldName: (parameter) => (parameter === 4 ? 'tripLog' : null)
}

const SETTING_TABLE = {
  speedCurve,
  temperatureOffset,
  depthOffset,
  speedOfSound,
  speedFilter: filterSetting('speedFilter', 'R13', AirmarPid.SpeedFilter),
  temperatureFilter: filterSetting('temperatureFilter', 'R14', AirmarPid.TemperatureFilter),
  transmissionIntervalOverride: onOffSetting({
    id: 'transmissionIntervalOverride',
    requirement: 'R15',
    pid: AirmarPid.Nmea2000Options,
    field: 'transmissionInterval',
    names: TRANSMISSION_INTERVAL,
    requiresLevel1: false
  }),
  installationDescription,
  productInformation,
  distanceLog,
  simulateMode: onOffSetting({
    id: 'simulateMode',
    requirement: 'R19',
    pid: AirmarPid.SimulateMode,
    field: 'simulateMode',
    names: OFF_ON,
    requiresLevel1: true
  })
}

export type SettingId = keyof typeof SETTING_TABLE

/**
 * A setting seen by a caller that holds only its id.
 *
 * Every entry is assignable to this, because the interface's methods are
 * compared bivariantly. A value from one entry's `parse` must only ever reach
 * the same entry's `command` and `sameAsStored`.
 */
export type AnySetting = Setting<unknown, unknown>

/** In the order they are listed. */
export const SETTINGS: readonly AnySetting[] = Object.values(SETTING_TABLE)

export function setting<K extends SettingId>(id: K): (typeof SETTING_TABLE)[K] {
  return SETTING_TABLE[id]
}

/**
 * Check a qualifier against what the setting accepts.
 *
 * A qualified setting needs one of its qualifiers; any other setting takes
 * none.
 */
function checkQualifier(entry: AnySetting, qualifier: number | undefined): ParseResult<undefined> {
  if (entry.qualifiers === undefined) {
    return qualifier === undefined ? ok(undefined) : fail(`${entry.id} takes no qualifier`)
  }
  return entry.qualifiers.some((q) => q.value === qualifier)
    ? ok(undefined)
    : fail(
        `${entry.id} needs one of ${entry.qualifiers.map((q) => `${String(q.value)} (${q.label})`).join(', ')}`
      )
}

/**
 * The one path from outside input to a command on the bus.
 *
 * Returns the parsed value alongside the frame, because the write contract
 * compares it with what the device stores.
 */
export function buildCommand(
  id: SettingId,
  address: number,
  input: unknown,
  qualifier?: number
): ParseResult<{ spec: CommandSpec; value: unknown }> {
  const entry: AnySetting = setting(id)
  const qualified = checkQualifier(entry, qualifier)
  if (!qualified.ok) {
    return qualified
  }
  const parsed = entry.parse(input)
  if (!parsed.ok) {
    return parsed
  }
  const message = entry.command(address, parsed.value, qualifier)
  return message === null
    ? fail(`${id} is read-only`)
    : ok({ spec: { message, requiresLevel1: entry.requiresLevel1 }, value: parsed.value })
}

/** The request for a setting, or an error saying why it cannot be read. */
export function buildRead(
  id: SettingId,
  address: number,
  qualifier?: number
): ParseResult<ReadSpec<unknown>> {
  const entry: AnySetting = setting(id)
  const qualified = checkQualifier(entry, qualifier)
  if (!qualified.ok) {
    return qualified
  }
  const spec = entry.read(address, qualifier)
  return spec === null
    ? fail(`${id} cannot be read back`)
    : ok({ ...spec, requiresLevel1: entry.requiresLevel1 })
}

/** Narrow a route parameter to a setting id. */
export const isSettingId = (value: string): value is SettingId =>
  Object.hasOwn(SETTING_TABLE, value)
