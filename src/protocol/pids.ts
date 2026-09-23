/**
 * Airmar proprietary protocol constants.
 *
 * Every proprietary message is identified by manufacturer code 135 and
 * industry code 4, then by a Proprietary ID. A PGN 126720 parameter list that
 * omits the manufacturer and proprietary-ID pairs cannot be encoded: canboatjs
 * narrows the 126720 variant by those match fields.
 */
export const AIRMAR = {
  manufacturerCode: 135,
  industryCode: 4
} as const

/** Proprietary IDs carried in PGN 126720 field 4. */
export enum AirmarPid {
  MasterReset = 1,
  SimulateMode = 35,
  CalibrateDepth = 40,
  CalibrateSpeed = 41,
  CalibrateTemperature = 42,
  SpeedFilter = 43,
  TemperatureFilter = 44,
  Nmea2000Options = 46,
  ResetEeprom = 130
}

/** PGN 126720-130 field 5. */
export enum EepromResetOption {
  /** Everything except the unique number, including the speed calibration curve. */
  All = 0,
  Priorities = 1,
  UpdateRates = 2,
  PrioritiesAndUpdateRates = 3,
  UniqueNumber = 4
}

/**
 * Parameter numbers.
 *
 * A parameter number is a field index within the *target* PGN, so the same
 * number means different things in different messages. The first three are
 * shared by every proprietary list; the rest are named per PGN.
 */
export const PARAM = {
  manufacturerCode: 1,
  industryCode: 3,
  proprietaryId: 4,
  /** PGN 65287 Access Level. */
  accessFormatCode: 4,
  accessLevel: 5,
  accessSeedKey: 7,
  /** PGN 126720-41 Calibrate Speed field 5. */
  curvePointCount: 5
} as const

/** PGN 126720-41: the first of the repeating frequency and speed pairs. */
export const CURVE_FIRST_PAIR_PARAM = 6

/** PGN 126720-41 field 5 allows at most 25 points. */
export const MAX_CURVE_POINTS = 25

/** PGN 126720-41 field 6: uint16 at 0.1 Hz. */
export const MAX_CURVE_HZ = 6553.2
export const CURVE_HZ_RESOLUTION = 0.1

/** PGN 126720-41 field 7: uint16 at 0.01 m/s. */
export const MAX_CURVE_SPEED = 655.32
export const CURVE_SPEED_RESOLUTION = 0.01

/**
 * The display strings canboatjs reports in a reply's `proprietaryId` field.
 *
 * canboatjs resolves the lookup to a string, so a reply cannot be matched
 * against the numeric PID that requested it without this table. Master reset
 * and EEPROM restore are absent from the canboat lookup and stay absent here;
 * neither is acknowledged, so neither is ever matched against a reply.
 */
const PID_NAMES = {
  [AirmarPid.SimulateMode]: 'Simulate Mode',
  [AirmarPid.CalibrateDepth]: 'Calibrate Depth',
  [AirmarPid.CalibrateSpeed]: 'Calibrate Speed',
  [AirmarPid.CalibrateTemperature]: 'Calibrate Temperature',
  [AirmarPid.SpeedFilter]: 'Speed Filter',
  [AirmarPid.TemperatureFilter]: 'Temperature Filter',
  [AirmarPid.Nmea2000Options]: 'NMEA 2000 options'
} as const

const NAME_BY_PID: Record<number, string | undefined> = PID_NAMES

/** The string canboatjs reports for this PID, or null when it reports none. */
export function pidName(pid: AirmarPid): string | null {
  return NAME_BY_PID[pid] ?? null
}

/**
 * Read a reply's proprietary ID field back into a PID.
 *
 * The field arrives as a string when canboatjs can name the value and as a
 * number when it cannot, so both are accepted. Anything else — including a
 * number that names no PID of this plugin's — is null rather than a guess.
 */
export function pidFromName(value: unknown): AirmarPid | null {
  if (typeof value === 'string') {
    const found = Object.entries(NAME_BY_PID).find(([, name]) => name === value)
    return found === undefined ? null : Number(found[0])
  }
  if (typeof value === 'number' && Number.isInteger(value) && value in AirmarPid) {
    return value
  }
  return null
}

/**
 * canboatjs resolves the proprietary ID lookup to this name in a reply.
 *
 * Read straight out of the table rather than through `pidName`, so it is
 * typed as the literal string. A nullable here with an empty-string default
 * would turn a lost table entry into a decoder that silently matches no real
 * reply, which is the one failure this constant must not have.
 */
export const CALIBRATE_SPEED_NAME = PID_NAMES[AirmarPid.CalibrateSpeed]

/** Field 5 of PGN 126720-41: restore the factory default curve. */
export const RESTORE_DEFAULT_CURVE = 0xfe

/** The manual documents this fixed value as the Access Level 1 password. */
export const ACCESS_LEVEL_1_KEY = 0x12345678

export const PGN = {
  addressClaim: 60928,
  accessLevel: 65287,
  depthQualityFactor: 65408,
  speedPulseCount: 65409,
  deviceInformation: 65410,
  groupFunction: 126208,
  pgnList: 126464,
  proprietary: 126720,
  productInformation: 126996,
  configurationInformation: 126998,
  speed: 128259,
  waterDepth: 128267,
  distanceLog: 128275,
  post: 130944
} as const

/**
 * Airmar's own PGNs, which answer only a group function naming the
 * manufacturer, and which PGN 126464 never lists.
 */
export const AIRMAR_PGNS: readonly number[] = [
  PGN.accessLevel,
  PGN.depthQualityFactor,
  PGN.speedPulseCount,
  PGN.deviceInformation,
  PGN.post
]

export const isAirmarPgn = (pgn: number): boolean => AIRMAR_PGNS.includes(pgn)

/** PGN 126464 field 1: which list, and the value naming the transmit list. */
export const PGN_LIST_FUNCTION_PARAM = 1
export const TRANSMIT_PGN_LIST = 0

/** The 126208 `pgn` field is 24 bits, and canboat wraps a larger value onto another PGN. */
export const MAX_PGN = 262143

/**
 * The fast-packet PGNs a DST-family sensor transmits. The plugin has no
 * runtime dependency on canboat, so the table is local; a test checks it
 * against canboat's definitions. A PGN missing here is treated as fast-packet,
 * whose minimum interval is the stricter one.
 */
export const SINGLE_FRAME_PGNS: readonly number[] = [
  59392, 60928, 65408, 65409, 65410, 126992, 126993, 127245, 127250, 128259, 128267, 130310, 130311,
  130312, 130316
]

/**
 * Actisense payload bytes for the two messages canboatjs cannot encode.
 *
 * Proprietary IDs 1 and 130 have no @canboat/ts-pgns definition, so canboatjs
 * drops the proprietary ID and both encode to the same wrong frame, 87,98,ff.
 *
 * Registering custom definitions was tried and rejected. canboatjs keeps one
 * module-scoped registry, and a plugin installed under the server's config
 * directory resolves its own copy: definitions registered there never reach
 * the copy that encodes what the plugin emits. Worse, where the copy *is*
 * shared, the registration corrupts every other 126720 in the process —
 * `identityFields` carrying no Description makes canboatjs's string-match
 * filter treat the definitions as wildcards, so an Airmar Simulate Mode
 * command from any other component encodes as this Master Reset frame, and a
 * Garmin 126720 has its manufacturer rewritten to Airmar.
 *
 * These two frames are six fixed bytes each, derived from the manual's field
 * tables, so they are built directly and sent on `nmea2000out`, which the
 * provider passes through without re-encoding.
 *
 * Byte 0 is the low 8 bits of the 11-bit manufacturer code 135. Byte 1 packs
 * its remaining 3 bits, the 2 reserved bits set to 1, and the 3-bit industry
 * code 4. Byte 2 is the proprietary ID. The remainder is the reserved tail,
 * padded with ones, with the EEPROM option in the low nibble of byte 3.
 */
const AIRMAR_IDENTITY_BYTES = '87,98'

export const MASTER_RESET_PAYLOAD = `${AIRMAR_IDENTITY_BYTES},01,ff,ff,ff`

export function eepromResetPayload(option: EepromResetOption): string {
  const nibble = (0xf0 | (option & 0x0f)).toString(16)
  return `${AIRMAR_IDENTITY_BYTES},82,${nibble},ff,ff`
}
