import type { DecodedPgn } from '../../src/protocol/messages.js'
import type { CurvePoint } from '../../src/protocol/codec.js'
import { CALIBRATE_SPEED_NAME, PGN, pidName, AirmarPid } from '../../src/protocol/pids.js'
import { decode } from './canboat.js'

/**
 * Device replies, built by encoding a real frame and parsing it back.
 *
 * Hand-writing these fixtures is what hid the Unit 2 defect: the decoder read
 * `numberOfPairsOfDataPointsToFollow`, which canboatjs never emits, and the
 * fixture invented the same name — so the test asserted the code against
 * itself while the trim never ran. Round-tripping means a canboat rename
 * breaks the suite instead of the device.
 */

interface Addressing {
  src?: number
  dst?: number
}

const addressed = (pgn: DecodedPgn, where: Addressing): DecodedPgn => ({
  ...pgn,
  ...(where.src === undefined ? {} : { src: where.src }),
  ...(where.dst === undefined ? {} : { dst: where.dst })
})

export const curveReply = (
  points: CurvePoint[],
  where: Addressing = {},
  declared = points.length
): DecodedPgn =>
  addressed(
    decode({
      pgn: PGN.proprietary,
      dst: 255,
      prio: 7,
      fields: {
        manufacturerCode: 'Airmar',
        industryCode: 'Marine Industry',
        proprietaryId: CALIBRATE_SPEED_NAME,
        numberOfPairsOfDataPoints: declared,
        list: points.map((point) => ({ inputFrequency: point.hz, outputSpeed: point.speed }))
      }
    }),
    where
  )

/**
 * A PGN 126464 list reply. A request with no function code answers twice, once
 * with the transmit list and once with the receive list, which is what a
 * multi-reply read has to wait for.
 *
 * This stands in for PID 43 and 44, which answer once per filter type and
 * would be the more natural fixture. canboatjs cannot encode a Speed Filter
 * 126720: its variants match on `filterType`, and the encoder throws on every
 * field combination. See the note in AGENTS.md.
 */
export type PgnListKind = 'Transmit PGN list' | 'Receive PGN list'

export const pgnListReply = (
  functionCode: PgnListKind,
  pgns: number[],
  where: Addressing = {}
): DecodedPgn =>
  addressed(
    decode({
      pgn: PGN.pgnList,
      dst: 255,
      prio: 6,
      fields: { functionCode, list: pgns.map((pgn) => ({ pgn })) }
    }),
    where
  )

/** A 126720 reply naming a different proprietary ID from a speed curve read. */
export const depthCalibrationReply = (offset: number, where: Addressing = {}): DecodedPgn =>
  addressed(
    decode({
      pgn: PGN.proprietary,
      dst: 255,
      prio: 7,
      fields: {
        manufacturerCode: 'Airmar',
        industryCode: 'Marine Industry',
        proprietaryId: pidName(AirmarPid.CalibrateDepth),
        depthOffset: offset
      }
    }),
    where
  )

export interface AckOptions {
  /** PGN_ERROR_CODE. Keep parameter-level codes out of this slot. */
  pgnErrorCode?: string
  /** TRANSMISSION_INTERVAL error, for a refused interval or priority. */
  intervalErrorCode?: string
  /** PARAMETER_FIELD codes, one per commanded parameter. */
  parameterErrors?: (string | undefined)[]
  acknowledgedPgn?: number
}

export const acknowledge = (options: AckOptions = {}, where: Addressing = {}): DecodedPgn =>
  addressed(
    decode({
      pgn: PGN.groupFunction,
      dst: 255,
      prio: 3,
      fields: {
        functionCode: 'Acknowledge',
        pgn: options.acknowledgedPgn ?? PGN.proprietary,
        pgnErrorCode: options.pgnErrorCode ?? 'Acknowledge',
        transmissionIntervalPriorityErrorCode: options.intervalErrorCode ?? 'Acknowledge',
        numberOfParameters: (options.parameterErrors ?? []).length,
        list: (options.parameterErrors ?? []).map((error) => ({
          parameter: error ?? 'Acknowledge'
        }))
      }
    }),
    where
  )

export interface Claim {
  uniqueNumber: number
  /** As canboatjs renders it: a name it knows, or the raw number. */
  manufacturerCode: string | number
}

/** An ISO Address Claim, PGN 60928, as the device would send it at `src`. */
export const addressClaim = (claim: Claim, src: number): DecodedPgn =>
  addressed(
    decode({
      pgn: PGN.addressClaim,
      dst: 255,
      prio: 6,
      fields: {
        uniqueNumber: claim.uniqueNumber,
        manufacturerCode: claim.manufacturerCode,
        deviceInstanceLower: 0,
        deviceInstanceUpper: 0,
        deviceFunction: 130,
        deviceClass: 'Sensor Communication Interface',
        systemInstance: 0,
        industryGroup: 'Marine',
        arbitraryAddressCapable: 'Yes'
      }
    }),
    { src }
  )

const AIRMAR_FIELDS = { manufacturerCode: 'Airmar', industryCode: 'Marine Industry' }

/**
 * A 126720 reply naming `pid`, with no settings.
 *
 * Speed Filter and Temperature Filter are built by hand: canboatjs cannot
 * encode either (issue 22), so they cannot be round-tripped. The probe reads
 * nothing from a reply but its PGN and proprietary ID.
 */
export const pidReply = (pid: AirmarPid, where: Addressing = {}): DecodedPgn => {
  const proprietaryId = pidName(pid)
  if (pid === AirmarPid.SpeedFilter || pid === AirmarPid.TemperatureFilter) {
    return {
      pgn: PGN.proprietary,
      src: where.src,
      dst: where.dst ?? 255,
      prio: 7,
      fields: { ...AIRMAR_FIELDS, proprietaryId }
    }
  }
  return addressed(
    decode({
      pgn: PGN.proprietary,
      dst: 255,
      prio: 7,
      fields: { ...AIRMAR_FIELDS, proprietaryId }
    }),
    where
  )
}

/** Minimal field sets that canboatjs encodes for each whole PGN the probe asks for. */
const PGN_FIELDS: Partial<Record<number, Record<string, unknown>>> = {
  [PGN.accessLevel]: AIRMAR_FIELDS,
  [PGN.depthQualityFactor]: AIRMAR_FIELDS,
  [PGN.speedPulseCount]: AIRMAR_FIELDS,
  [PGN.deviceInformation]: AIRMAR_FIELDS,
  [PGN.post]: AIRMAR_FIELDS,
  [PGN.pgnList]: { functionCode: 'Transmit PGN list', list: [{ pgn: 128267 }] },
  [PGN.productInformation]: { modelId: 'DST800' },
  [PGN.configurationInformation]: { installationDescription1: 'bow' },
  [PGN.distanceLog]: { log: 1000 }
}

/** A whole-PGN reply, such as Product Information, from the device. */
export const pgnReply = (pgn: number, where: Addressing = {}): DecodedPgn => {
  const fields = PGN_FIELDS[pgn]
  if (fields === undefined) {
    throw new Error(`No fixture for PGN ${String(pgn)}`)
  }
  return addressed(decode({ pgn, dst: 255, prio: 6, fields }), where)
}
