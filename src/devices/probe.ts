/**
 * What a device supports, asked of the device itself.
 *
 * No model table: the same protocol ships in the DST200, DT200, D200, ST200,
 * DST800 and rebadged units, each with a different subset. The probe asks for
 * each capability in turn and records one of three answers.
 *
 * Silence is `noAnswer`, never unsupported. canboatjs drops a fast-packet
 * message that lost a frame without reporting it, so a supported PID can go
 * unanswered, and calling it unsupported would hide a whole screen.
 *
 * The probe unlocks first. The manual marks PIDs 35 and 40–44 Access Level 1
 * without saying whether that gates reads or only writes; probing locked
 * could make a DST800 look like a depth-only unit. For the same reason an
 * access-denied refusal counts as support: the device parsed the request.
 */

import { requestAirmarPgn, requestProprietary, requestStandardPgn } from '../protocol/codec.js'
import type { DecodedPgn, OutgoingPgn } from '../protocol/messages.js'
import { AirmarPid, PGN, isAirmarPgn } from '../protocol/pids.js'
import type { DeviceSession } from '../session/deviceSession.js'
import { isAccessDenied, type Outcome } from '../session/outcome.js'
import type { DeviceKey } from '../types.js'

export type Capability = { kind: 'pid'; pid: AirmarPid } | { kind: 'pgn'; pgn: number }

export type CapabilityState =
  | { state: 'supported' }
  | { state: 'rejected'; reason: string }
  | { state: 'noAnswer'; reason: string }

export type Level1State =
  | { state: 'granted' }
  | { state: 'refused'; reason: string }
  | { state: 'noAnswer'; reason: string }

export interface ProbeResult {
  level1: Level1State
  capabilities: { capability: Capability; result: CapabilityState }[]
  /**
   * Whether the device implements the speed calibration curve, the
   * console's reason to exist. `unknown` when PID 41 went unanswered, which a
   * single lost fast-packet frame causes. Whether the console may write the
   * curve is `level1`'s answer, not this one.
   */
  configurable: 'yes' | 'no' | 'unknown'
  /**
   * The session closed before the probe finished, typically because the
   * device moved. The unanswered capabilities were never asked, so the
   * result describes nothing about the product and must not be kept.
   */
  interrupted: boolean
}

/** In the order they are asked. */
export const PROBED: readonly Capability[] = [
  ...[
    AirmarPid.SimulateMode,
    AirmarPid.CalibrateDepth,
    AirmarPid.CalibrateSpeed,
    AirmarPid.CalibrateTemperature,
    AirmarPid.SpeedFilter,
    AirmarPid.TemperatureFilter,
    AirmarPid.Nmea2000Options
  ].map((pid): Capability => ({ kind: 'pid', pid })),
  ...[
    PGN.accessLevel,
    PGN.depthQualityFactor,
    PGN.speedPulseCount,
    PGN.deviceInformation,
    PGN.post,
    PGN.pgnList,
    PGN.productInformation,
    PGN.configurationInformation,
    PGN.distanceLog
  ].map((pgn): Capability => ({ kind: 'pgn', pgn }))
]

/** A stable name for a capability, such as `pid:41` or `pgn:65409`. */
export const capabilityId = (capability: Capability): string =>
  capability.kind === 'pid' ? `pid:${String(capability.pid)}` : `pgn:${String(capability.pgn)}`

/**
 * The longest a probe of a device that answers nothing takes on `session`:
 * the unlock plus one timeout per capability, asked one at a time, at the
 * timeout the session has widened to.
 *
 * Excludes any operations already queued on the session. A device that
 * refuses with a temporary error or access denied costs more, because the
 * session retries each once, but it answers, so each retry is quick.
 */
export const probeBudgetMs = (session: Pick<DeviceSession, 'currentTimeoutMs'>): number =>
  (PROBED.length + 1) * session.currentTimeoutMs

function requestFor(address: number, capability: Capability): OutgoingPgn {
  if (capability.kind === 'pid') {
    return requestProprietary(address, capability.pid)
  }
  return isAirmarPgn(capability.pgn)
    ? requestAirmarPgn(address, capability.pgn)
    : requestStandardPgn(address, capability.pgn)
}

/**
 * Any reply of the requested PGN is an answer.
 *
 * The session already requires a 126720 reply to name the requested
 * proprietary ID. A periodic PGN such as the distance log may answer with a
 * frame the device would have sent anyway, which proves support just as well.
 */
const answersPgn =
  (pgn: number) =>
  (reply: DecodedPgn): true | null =>
    reply.pgn === pgn ? true : null

async function ask(session: DeviceSession, capability: Capability): Promise<CapabilityState> {
  const message = requestFor(session.address, capability)
  const outcome = await session.read({ message, match: answersPgn(Number(message.fields.pgn)) })
  if (outcome.status === 'answered') {
    return { state: 'supported' }
  }
  if (outcome.status === 'rejected' && outcome.detail !== undefined) {
    return isAccessDenied(outcome.detail)
      ? { state: 'supported' }
      : { state: 'rejected', reason: outcome.reason }
  }
  return { state: 'noAnswer', reason: outcome.reason }
}

/**
 * A refusal counts only when the device sent it.
 *
 * Without the device's acknowledgement the refusal was the session's own,
 * such as a full queue, and says nothing about the device.
 */
function level1Of(outcome: Outcome<void>): Level1State {
  if (outcome.status === 'answered') {
    return { state: 'granted' }
  }
  if (outcome.status === 'rejected' && outcome.detail !== undefined) {
    return { state: 'refused', reason: outcome.reason }
  }
  return { state: 'noAnswer', reason: outcome.reason }
}

const CONFIGURABLE = { supported: 'yes', rejected: 'no', noAnswer: 'unknown' } as const

/** Ask the device on `session` for every capability in `PROBED`, one at a time. */
export async function probe(session: DeviceSession): Promise<ProbeResult> {
  const level1 = level1Of(await session.unlock())

  const capabilities: ProbeResult['capabilities'] = []
  for (const capability of PROBED) {
    capabilities.push({ capability, result: await ask(session, capability) })
  }

  const speedCurve = capabilities.find(
    (c) => c.capability.kind === 'pid' && c.capability.pid === AirmarPid.CalibrateSpeed
  )
  return {
    level1,
    capabilities,
    configurable: speedCurve === undefined ? 'unknown' : CONFIGURABLE[speedCurve.result.state],
    interrupted: session.closedReason !== null
  }
}

/**
 * Probe results per device, until the device is probed again or reset.
 *
 * Keyed by identity, not address: a result describes the product, which
 * does not change when the device re-claims.
 */
export class ProbeCache {
  private readonly results = new Map<string, ProbeResult>()

  get(key: DeviceKey): ProbeResult | undefined {
    return this.results.get(ProbeCache.id(key))
  }

  /** Ignores an interrupted result, which says nothing about the product. */
  set(key: DeviceKey, result: ProbeResult): void {
    if (result.interrupted) {
      return
    }
    this.results.set(ProbeCache.id(key), result)
  }

  invalidate(key: DeviceKey): void {
    this.results.delete(ProbeCache.id(key))
  }

  private static id(key: DeviceKey): string {
    return `${String(key.manufacturerCode)}:${String(key.uniqueNumber)}`
  }
}
