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

/** Parameter numbers shared by every proprietary parameter list. */
export const PARAM = {
  manufacturerCode: 1,
  industryCode: 3,
  proprietaryId: 4
} as const

/** Field 5 of PGN 126720-41: restore the factory default curve. */
export const RESTORE_DEFAULT_CURVE = 0xfe

/** The manual documents this fixed value as the Access Level 1 password. */
export const ACCESS_LEVEL_1_KEY = 0x12345678

export const PGN = {
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
 * Proprietary IDs 1 and 130 have no @canboat/ts-pgns definition, so canboatjs
 * drops the proprietary ID as not-available and both encode to the same wrong
 * frame. These definitions are registered with canboatjs at module load.
 *
 * They are also the only two Airmar messages sent as a bare addressed 126720
 * rather than wrapped in a 126208 Command Group Function.
 */
const identityFields = (proprietaryId: number) => [
  { Id: 'manufacturerCode', BitLength: 11, Match: AIRMAR.manufacturerCode, FieldType: 'LOOKUP' },
  { Id: 'reserved', BitLength: 2, FieldType: 'RESERVED' },
  { Id: 'industryCode', BitLength: 3, Match: AIRMAR.industryCode, FieldType: 'LOOKUP' },
  { Id: 'proprietaryId', BitLength: 8, Match: proprietaryId, FieldType: 'LOOKUP' }
]

export const CUSTOM_PGNS = {
  PGNs: [
    {
      PGN: PGN.proprietary,
      Id: 'airmarMasterReset',
      Description: 'Airmar: Master Reset',
      Type: 'Fast',
      Complete: true,
      FieldCount: 5,
      Length: 6,
      Fields: [
        ...identityFields(AirmarPid.MasterReset),
        { Id: 'reserved5', BitLength: 24, FieldType: 'RESERVED' }
      ]
    },
    {
      PGN: PGN.proprietary,
      Id: 'airmarResetEeprom',
      Description: 'Airmar: Reset EEPROM',
      Type: 'Fast',
      Complete: true,
      FieldCount: 6,
      Length: 6,
      Fields: [
        ...identityFields(AirmarPid.ResetEeprom),
        { Id: 'options', BitLength: 4, FieldType: 'LOOKUP' },
        { Id: 'reserved6', BitLength: 20, FieldType: 'RESERVED' }
      ]
    }
  ]
}
