/**
 * The speed calibration curve as the console edits it: one row of text per
 * point, checked in the browser against the rules the plugin's encoder
 * enforces, so a curve the plugin would refuse never leaves the page.
 */

import {
  CURVE_HZ_RESOLUTION,
  MAX_CURVE_HZ,
  MAX_CURVE_POINTS,
  MAX_CURVE_SPEED
} from '../protocol/pids.js'
import type { DisplayUnit } from './units.js'

export { MAX_CURVE_POINTS }

export interface CurvePoint {
  hz: number
  speed: number
}

/** A point as typed: frequency in Hz, speed in the user's unit. */
export type CurveRow = readonly [hz: string, speed: string]

export interface CurveProblem {
  /** Zero-based point, or null for the curve as a whole. */
  point: number | null
  field: 'hz' | 'speed' | null
  text: string
}

const HZ_DECIMALS = 1

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A value the plugin reported as a curve, or null when it is not one. */
export function curveOf(value: unknown): CurvePoint[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const points = value.filter(
    (p): p is CurvePoint => isRecord(p) && typeof p.hz === 'number' && typeof p.speed === 'number'
  )
  return points.length === value.length ? points : null
}

export const formatHz = (hz: number): string => hz.toFixed(HZ_DECIMALS)

export function rowsOf(points: readonly CurvePoint[], speed: DisplayUnit): CurveRow[] {
  return points.map((p) => [formatHz(p.hz), speed.format(p.speed)])
}

/** Whether two curves hold the same points as the user reads them. */
export function sameCurve(a: unknown, b: unknown, speed: DisplayUnit): boolean {
  const left = curveOf(a)
  const right = curveOf(b)
  return (
    left !== null &&
    right !== null &&
    JSON.stringify(rowsOf(left, speed)) === JSON.stringify(rowsOf(right, speed))
  )
}

const parseHz = (text: string): number | null => {
  const hz = text.trim() === '' ? NaN : Number(text)
  return Number.isFinite(hz) ? hz : null
}

/** The frequency as the sensor stores it, in steps of 0.1 Hz. */
const step = (hz: number): number => Math.round(hz / CURVE_HZ_RESOLUTION)

/**
 * The curve the rows describe, in SI units, or every reason it cannot be
 * written. Frequencies must increase at the stored 0.1 Hz step, since that
 * is what the sensor compares.
 */
export function checkCurve(
  rows: readonly CurveRow[],
  speed: DisplayUnit
): { points: CurvePoint[]; problems: [] } | { points: null; problems: CurveProblem[] } {
  const problems: CurveProblem[] = []
  if (rows.length === 0 || rows.length > MAX_CURVE_POINTS) {
    problems.push({
      point: null,
      field: null,
      text: `A curve holds 1 to ${String(MAX_CURVE_POINTS)} points.`
    })
  }
  const points: CurvePoint[] = []
  let previous: number | null = null
  rows.forEach(([hzText, speedText], index) => {
    const at = `Point ${String(index + 1)}`
    const hz = parseHz(hzText)
    if (hz === null) {
      problems.push({ point: index, field: 'hz', text: `${at}: enter a frequency.` })
    } else if (hz < 0 || hz > MAX_CURVE_HZ) {
      problems.push({
        point: index,
        field: 'hz',
        text: `${at}: frequency must be between 0 and ${String(MAX_CURVE_HZ)} Hz.`
      })
    } else if (previous !== null && step(hz) <= step(previous)) {
      problems.push({
        point: index,
        field: 'hz',
        text: `${at}: frequency must be above point ${String(index)}’s ${formatHz(previous)} Hz.`
      })
    }
    const si = speed.parse(speedText)
    if (si === null) {
      problems.push({ point: index, field: 'speed', text: `${at}: enter a speed.` })
    } else if (si < 0 || si > MAX_CURVE_SPEED) {
      problems.push({
        point: index,
        field: 'speed',
        text: `${at}: speed must be between ${speed.format(0)} and ${speed.format(MAX_CURVE_SPEED)} ${speed.symbol}.`
      })
    }
    if (hz !== null) {
      previous = hz
    }
    if (hz !== null && si !== null) {
      points.push({ hz, speed: si })
    }
  })
  return problems.length === 0 ? { points, problems: [] } : { points: null, problems }
}

/** The point and field a refused field names, as the plugin names them: `point 3 hz`. */
export function refusedAt(field: string): { point: number; field: 'hz' | 'speed' } | null {
  const match = /^point (\d+) (hz|speed)$/.exec(field)
  return match === null
    ? null
    : { point: Number(match[1]) - 1, field: match[2] === 'hz' ? 'hz' : 'speed' }
}
