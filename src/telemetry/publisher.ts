/**
 * The selected sensor's own telemetry, as Signal K deltas.
 *
 * Published on receipt only. Nothing is synthesised, and silence publishes no
 * null: Signal K has no staleness rule, so consumers read the timestamp. A
 * frame with a missing or zero field is skipped rather than published as a
 * wrong number. The paths are a consumer contract, documented in the README.
 */

import type { DecodedPgn } from '../protocol/messages.js'
import { PGN } from '../protocol/pids.js'

export interface TelemetryValue {
  path: string
  value: number
}

const PREFIX = 'sensors.airmarDst'

/** Units and descriptions, published once as meta. */
export const TELEMETRY_META: readonly { path: string; units?: string; description: string }[] = [
  {
    path: `${PREFIX}.speed.pulseRate`,
    units: 'Hz',
    description: 'Paddlewheel pulse rate: the pulse count over its interval (PGN 65409)'
  },
  {
    path: `${PREFIX}.speed.pulseCount`,
    description: 'Paddlewheel pulses counted in the interval, unreduced (PGN 65409)'
  },
  {
    path: `${PREFIX}.speed.pulseInterval`,
    units: 's',
    description: 'The interval the pulses were counted over (PGN 65409)'
  },
  {
    path: `${PREFIX}.supplyVoltage`,
    units: 'V',
    description: 'Supply voltage at the sensor (PGN 65410)'
  },
  {
    path: `${PREFIX}.temperature`,
    units: 'K',
    description: 'Temperature of the sensor’s board (PGN 65410)'
  },
  {
    path: `${PREFIX}.depth.quality`,
    units: 'ratio',
    description: 'Depth quality factor, 0 when the depth is unlocked (PGN 65408)'
  }
]

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** canboat renders a duration as `HH:MM:SS.fffff`; a raw decoder may give seconds. */
function seconds(value: unknown): number | null {
  if (typeof value === 'number') {
    return finite(value)
  }
  if (typeof value !== 'string') {
    return null
  }
  const parts = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value)
  return parts === null ? null : Number(parts[1]) * 3600 + Number(parts[2]) * 60 + Number(parts[3])
}

const QUALITY_STEPS = 10

/** canboat's AIRMAR_DEPTH_QUALITY_FACTOR: `Depth unlocked`, then `Quality 10%` to `Quality 100%`. */
function quality(value: unknown): number | null {
  const step =
    typeof value === 'number'
      ? value
      : value === 'Depth unlocked'
        ? 0
        : typeof value === 'string'
          ? Number(/^Quality (\d+)%$/.exec(value)?.[1] ?? NaN) / QUALITY_STEPS
          : NaN
  return Number.isInteger(step) && step >= 0 && step <= QUALITY_STEPS ? step / QUALITY_STEPS : null
}

/** The values a frame carries, or none. */
export function telemetryOf(frame: DecodedPgn): TelemetryValue[] {
  const fields = frame.fields ?? {}
  switch (frame.pgn) {
    case PGN.speedPulseCount: {
      const count = finite(fields.numberOfPulsesReceived)
      const interval = seconds(fields.durationOfInterval)
      if (count === null || interval === null || interval <= 0) {
        return []
      }
      return [
        { path: `${PREFIX}.speed.pulseRate`, value: count / interval },
        { path: `${PREFIX}.speed.pulseCount`, value: count },
        { path: `${PREFIX}.speed.pulseInterval`, value: interval }
      ]
    }
    case PGN.deviceInformation: {
      const values: TelemetryValue[] = []
      const voltage = finite(fields.supplyVoltage)
      const temperature = finite(fields.internalDeviceTemperature)
      if (voltage !== null) {
        values.push({ path: `${PREFIX}.supplyVoltage`, value: voltage })
      }
      if (temperature !== null) {
        values.push({ path: `${PREFIX}.temperature`, value: temperature })
      }
      return values
    }
    case PGN.depthQualityFactor: {
      const ratio = quality(fields.depthQualityFactor)
      return ratio === null ? [] : [{ path: `${PREFIX}.depth.quality`, value: ratio }]
    }
    default:
      return []
  }
}

export interface TelemetryOptions {
  /** Every decoded PGN on the bus. Returns the unsubscribe. */
  subscribe: (handler: (frame: DecodedPgn) => void) => () => void
  /** The selected sensor's source address, or null when it has none. */
  address: () => number | null
  publish: (values: TelemetryValue[]) => void
  /** This runs inside the server's event dispatch, where a throw stops Signal K. */
  onError?: (error: unknown) => void
}

/** Publish the selected sensor's telemetry until the returned function is called. */
export function startTelemetry(options: TelemetryOptions): () => void {
  return options.subscribe((frame) => {
    try {
      const address = options.address()
      if (address === null || frame.src !== address) {
        return
      }
      const values = telemetryOf(frame)
      if (values.length > 0) {
        options.publish(values)
      }
    } catch (error) {
      options.onError?.(error)
    }
  })
}
