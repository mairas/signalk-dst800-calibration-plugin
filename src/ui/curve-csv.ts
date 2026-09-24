/**
 * The speed calibration curve as CSV, for spreadsheets and curve-fitting
 * scripts: a header naming the speed unit, then one frequency and speed per
 * line. Only the file's shape is checked here; the curve's own rules are the
 * table's, once the rows are in it.
 */

import { formatHz, type CurvePoint } from './curve.js'
import type { DisplayUnit } from './units.js'

const FREQUENCY_COLUMN = 'frequency_hz'
const SPEED_PREFIX = 'speed_'

export function curveToCsv(points: readonly CurvePoint[], speed: DisplayUnit): string {
  const lines = points.map((p) => `${formatHz(p.hz)},${speed.format(p.speed)}`)
  return `${FREQUENCY_COLUMN},${SPEED_PREFIX}${speed.symbol}\n${lines.map((l) => `${l}\n`).join('')}`
}

/** The unit the header names and each row's two values as written, or why the file is refused. */
export type CsvCurve =
  { ok: true; unit: string; rows: [hz: string, speed: string][] } | { ok: false; reason: string }

/** A field without the double quotes some tools, R's write.csv among them, put around it. */
const unquote = (field: string): string =>
  field
    .trim()
    .replace(/^"(.*)"$/, '$1')
    .trim()

export function parseCurveCsv(text: string): CsvCurve {
  // CRLF, LF, or CR alone as older Mac spreadsheets write.
  const lines = text
    .split(/\r\n|\r|\n/)
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line !== '')
  const header = lines.at(0)?.line ?? ''
  // A spreadsheet in a locale with decimal commas separates values with semicolons.
  const separator = header.includes(';') ? ';' : ','
  const columns = header.split(separator).map(unquote)
  if (
    columns.length !== 2 ||
    columns[0].toLowerCase() !== FREQUENCY_COLUMN ||
    !columns[1].toLowerCase().startsWith(SPEED_PREFIX)
  ) {
    return {
      ok: false,
      reason: `The first line must name the columns: ${FREQUENCY_COLUMN},${SPEED_PREFIX}<unit>, such as ${SPEED_PREFIX}kn`
    }
  }
  const rows: [string, string][] = []
  for (const { line, number } of lines.slice(1)) {
    const values = line.split(separator).map(unquote)
    // A spreadsheet writes bare separators for empty rows inside its used range.
    if (values.every((v) => v === '')) {
      continue
    }
    if (values.length !== 2) {
      return {
        ok: false,
        reason: `Line ${String(number)} has ${String(values.length)} values; each line is a frequency and a speed`
      }
    }
    if (values.some((v) => v.includes(','))) {
      return { ok: false, reason: 'The file uses decimal commas; write decimals with a point' }
    }
    rows.push([values[0], values[1]])
  }
  return { ok: true, unit: columns[1].slice(SPEED_PREFIX.length), rows }
}
