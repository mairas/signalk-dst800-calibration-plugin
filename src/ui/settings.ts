/**
 * How the console presents each setting: its section, label, help, unit and
 * editor, and what each outcome of a read or write says to the user.
 *
 * The plugin's registry owns ranges and validation; the console lays values
 * out in the user's units and converts what the user typed back to SI.
 */

import { CURVE_SPEED_RESOLUTION } from '../protocol/pids.js'
import type { ReadResult, WriteResult } from '../types.js'
import { FACTORY_CURVE, curveOf } from './curve.js'
import { isRecord } from './format.js'
import { unitFor, unitNamed, type DisplayUnit, type UnitSpec, type Units } from './units.js'

export type Editor =
  | { kind: 'number' }
  | { kind: 'choice'; options: readonly { value: boolean; label: string }[] }
  | { kind: 'simulate' }
  | { kind: 'description' }
  | { kind: 'filter' }
  | { kind: 'tripReset' }
  | { kind: 'curve' }

export interface SettingView {
  label: string
  help?: string
  editor: Editor
  /** For a number, or for the value a read-only line shows. */
  unit?: UnitSpec
}

/** Per temperature source, by the plugin's qualifier value, in the order shown. */
export const TEMPERATURE_SOURCES: readonly { qualifier: number; label: string; help: string }[] = [
  { qualifier: 1, label: 'Water sensor offset', help: 'Added to the measured water temperature.' },
  {
    qualifier: 0,
    label: 'Sensor body offset',
    help: 'Added to the temperature inside the sensor body.'
  },
  {
    qualifier: 2,
    label: 'Optional water sensor offset',
    help: 'Only where a separate temperature probe is fitted.'
  }
]

const FILTER_HELP = 'A longer duration gives a steadier reading that reacts more slowly.'

export const VIEWS: Partial<Record<string, SettingView>> = {
  depthOffset: {
    label: 'Depth offset',
    help: 'From the transducer face to the waterline (positive) or to the keel (negative). Zero reports depth below the transducer.',
    editor: { kind: 'number' },
    unit: { category: 'depth', resolution: 0.001 }
  },
  speedOfSound: {
    label: 'Speed of sound',
    help: 'Turns echo time into depth: about 1500 m/s in sea water and 1480 m/s in fresh water.',
    editor: { kind: 'number' },
    unit: { fixed: { symbol: 'm/s', decimals: 1 } }
  },
  speedFilter: { label: 'Speed filter', help: FILTER_HELP, editor: { kind: 'filter' } },
  speedCurve: {
    label: 'Calibration curve',
    help: 'Each point pairs a paddlewheel frequency with the boat speed it stands for. Frequencies must increase from point to point.',
    editor: { kind: 'curve' },
    unit: { category: 'speed', resolution: CURVE_SPEED_RESOLUTION }
  },
  temperatureOffset: {
    label: 'Temperature offset',
    editor: { kind: 'number' },
    unit: { category: 'temperature', difference: true, resolution: 0.001 }
  },
  temperatureFilter: { label: 'Temperature filter', help: FILTER_HELP, editor: { kind: 'filter' } },
  distanceLog: {
    label: 'Trip',
    editor: { kind: 'tripReset' },
    unit: { category: 'distance' }
  },
  installationDescription: {
    label: 'Installation note',
    help: 'Stored in the sensor and shown to other devices on the network, e.g. where it is mounted.',
    editor: { kind: 'description' }
  },
  transmissionIntervalOverride: {
    label: 'Transmission intervals',
    help: 'Whether a message may be sent faster than the sensor measures its data. If so, values repeat until measured again. A longer interval applies either way.',
    editor: {
      kind: 'choice',
      options: [
        { value: false, label: 'No faster than measured' },
        { value: true, label: 'As set, repeating values' }
      ]
    }
  },
  simulateMode: {
    label: 'Simulate mode',
    help: 'Replaces measured depth, speed and temperature with simulated values, for testing an installation.',
    editor: { kind: 'simulate' }
  }
}

/** The installation description's two lines. */
export const descriptionLines = (value: unknown): [string, string] => {
  const record = isRecord(value) ? value : {}
  const line = (key: string) => (typeof record[key] === 'string' ? record[key] : '')
  return [line('description1'), line('description2')]
}

/** A setting's value as the user reads it, in a sentence, in the user's units. */
export function describeValue(editor: Editor, unit: DisplayUnit | null, value: unknown): string {
  const inUnit = (si: unknown) =>
    typeof si === 'number' && unit !== null ? `${unit.format(si)} ${unit.symbol}` : '—'
  switch (editor.kind) {
    case 'number':
      return typeof value === 'number' ? inUnit(value) : JSON.stringify(value)
    case 'choice':
      return editor.options.find((o) => o.value === value)?.label ?? String(value)
    case 'simulate':
      return value === true ? 'on' : 'off'
    case 'curve': {
      if (value === FACTORY_CURVE) {
        return 'the factory curve'
      }
      const points = curveOf(value)
      return points === null ? JSON.stringify(value) : `a ${String(points.length)}-point curve`
    }
    case 'description':
      return `“${descriptionLines(value)
        .filter((line) => line !== '')
        .join(' / ')}”`
    case 'tripReset': {
      const log = isRecord(value) ? value : {}
      // A trip reset asks only for the trip; the total is the sensor's own.
      return log.log === undefined
        ? `trip ${inUnit(log.tripLog)}`
        : `trip ${inUnit(log.tripLog)}, total ${inUnit(log.log)}`
    }
    case 'filter':
      return JSON.stringify(value)
  }
}

/** Settings the console reads but shows no row for. */
const OTHER_LABELS: Partial<Record<string, string>> = {
  productInformation: 'Product information'
}

/** A setting's name as its row shows it, per temperature source for the offsets. */
export function labelOf(id: string, qualifier: number | null): string {
  if (qualifier !== null && id === 'temperatureOffset') {
    return TEMPERATURE_SOURCES.find((s) => s.qualifier === qualifier)?.label ?? id
  }
  return VIEWS[id]?.label ?? OTHER_LABELS[id] ?? id
}

/** How a setting's values show under `units`, or null for one without a unit. */
export function unitOf(units: Units, id: string): DisplayUnit | null {
  const spec = VIEWS[id]?.unit
  return spec === undefined ? null : unitFor(units, spec)
}

/** A unit of a setting's kind that a file names, or null when the server knows none. */
export function unitNamedFor(units: Units, id: string, name: string): DisplayUnit | null {
  const spec = VIEWS[id]?.unit
  return spec === undefined ? null : unitNamed(units, spec, name)
}

/** A setting's value as its row says it, or JSON for a setting the console shows no row for. */
export function showValue(units: Units, id: string, value: unknown): string {
  const view = VIEWS[id]
  return view === undefined
    ? JSON.stringify(value)
    : describeValue(view.editor, unitOf(units, id), value)
}

/** One row per setting and qualifier. */
export const slotKey = ({ id, qualifier }: { id: string; qualifier: number | null }): string =>
  `${id}:${qualifier === null ? '' : String(qualifier)}`

/**
 * A section that holds its own controls rather than settings: `snapshots`
 * exports and imports settings, `danger` restarts and restores the sensor.
 */
export type CustomSection = 'snapshots' | 'danger'

/** The console's sections, in page order. */
export const SECTIONS: readonly {
  id: string
  title: string
  settings: readonly string[]
  custom?: CustomSection
}[] = [
  { id: 'depth', title: 'Depth', settings: ['depthOffset', 'speedOfSound'] },
  { id: 'speed', title: 'Speed', settings: ['speedFilter'] },
  { id: 'calibration', title: 'Speed calibration', settings: ['speedCurve'] },
  { id: 'temperature', title: 'Temperature', settings: ['temperatureOffset', 'temperatureFilter'] },
  { id: 'log', title: 'Distance log', settings: ['distanceLog'] },
  { id: 'network', title: 'NMEA 2000 output', settings: ['transmissionIntervalOverride'] },
  { id: 'installation', title: 'Installation', settings: ['installationDescription'] },
  { id: 'maintenance', title: 'Maintenance', settings: ['simulateMode'] },
  { id: 'snapshots', title: 'Snapshots', settings: [], custom: 'snapshots' },
  { id: 'danger', title: 'Danger zone', settings: [], custom: 'danger' }
]

/**
 * What the console says about a row's last read or write.
 *
 * Built from the plugin's results, but not one of them: a write the sensor
 * did not answer is followed by a read, and the pair reads as one outcome.
 */
export type Outcome =
  | { kind: 'stored' }
  | { kind: 'differs'; requested: unknown; stored: unknown }
  | { kind: 'accepted' }
  | { kind: 'unconfirmed' }
  | {
      kind: 'refused'
      requested: unknown
      reason: string
      /** The fields the sensor refused, as the plugin names them. */
      fields: readonly { field: string; error: string }[]
    }
  /** The sensor did not answer the write, but a read afterwards finds the value asked for. */
  | { kind: 'holdsRequested' }
  /** The sensor refused a read, with its acknowledgement. */
  | { kind: 'readRefused'; reason: string }
  /** The plugin did not send the read, for example with Level 1 unavailable. */
  | { kind: 'notRead'; reason: string }
  | { kind: 'noAnswer'; operation: 'read' | 'write' }
  | { kind: 'checking' }
  | { kind: 'notSent'; reason: string }
  | { kind: 'invalid'; reason: string }

/** canboat's error names, in words a boat owner reads. */
const ERROR_WORDS: Partial<Record<string, string>> = {
  'Parameter out of range': 'out of its allowed range',
  'Access denied': 'it needs Level 1 access',
  'Read or Write not supported': 'this cannot be changed',
  'Temporary error': 'it was busy; try again',
  'Invalid parameter field': 'it did not accept one of the fields',
  'Not supported': 'it does not support this',
  'PGN not supported': 'it does not support this'
}

export const inWords = (errors: readonly string[]): string =>
  [...new Set(errors)].map((error) => ERROR_WORDS[error] ?? error).join('; ')

function refusalReason(result: Extract<WriteResult, { status: 'rejected' }>): string {
  const errors = result.refusedFields.map((f) => f.error)
  return inWords(errors.length === 0 ? [result.reason] : errors)
}

/** A refused read: the device's own when it carries an acknowledgement, else the plugin's. */
function readRefusal(result: Extract<ReadResult, { status: 'rejected' }>): Outcome {
  const detail = result.detail
  if (detail === undefined) {
    return { kind: 'notRead', reason: result.reason }
  }
  const errors = [detail.pgnError, ...detail.parameterErrors.map((e) => e.error)].filter(
    (error) => error !== 'Acknowledge'
  )
  return { kind: 'readRefused', reason: inWords(errors.length === 0 ? [result.reason] : errors) }
}

/** The outcome a result reports, or null for a read that simply answered. */
export function outcomeOf(
  operation: 'read' | 'write',
  result: ReadResult | WriteResult
): Outcome | null {
  switch (result.status) {
    case 'answered':
      return null
    case 'applied':
      return { kind: 'stored' }
    case 'storedDiffers':
      return { kind: 'differs', requested: result.requested, stored: result.stored }
    case 'acknowledged':
      return result.readBack === undefined ? { kind: 'accepted' } : { kind: 'unconfirmed' }
    case 'rejected':
      return 'refusedFields' in result
        ? {
            kind: 'refused',
            requested: result.requested,
            reason: refusalReason(result),
            fields: result.refusedFields
          }
        : readRefusal(result)
    case 'unknown':
      return { kind: 'noAnswer', operation }
    case 'notSent':
      return { kind: 'notSent', reason: result.reason }
    case 'invalid':
      return { kind: 'invalid', reason: result.reason }
  }
}

export type Tone = 'success' | 'warning' | 'danger' | 'secondary'

/**
 * What an outcome says, in the sensor's terms. `show` formats a value in
 * the user's units; `stored` is what the sensor holds now, if known.
 */
export function describeOutcome(
  outcome: Outcome,
  show: (value: unknown) => string,
  stored: { value: unknown } | null
): { tone: Tone; text: string } {
  const has = stored === null ? '' : ` It has ${show(stored.value)}.`
  switch (outcome.kind) {
    case 'stored':
      return { tone: 'success', text: '✓ Stored.' }
    case 'holdsRequested':
      return {
        tone: 'warning',
        text: `The sensor didn’t acknowledge the write, but it now holds ${stored === null ? 'the value' : show(stored.value)}.`
      }
    case 'differs':
      return {
        tone: 'warning',
        text: `The sensor stored ${show(outcome.stored)}, not ${show(outcome.requested)}.`
      }
    case 'accepted':
      return { tone: 'success', text: '✓ Sent. The sensor accepted it.' }
    case 'unconfirmed':
      return { tone: 'warning', text: 'The sensor accepted it, but reading it back failed.' }
    case 'refused':
      return {
        tone: 'danger',
        text: `The sensor refused ${show(outcome.requested)}: ${outcome.reason}.${has}`
      }
    case 'readRefused':
      return { tone: 'danger', text: `The sensor refused the read: ${outcome.reason}.` }
    case 'notRead':
      return { tone: 'warning', text: `Not read: ${outcome.reason}.` }
    case 'noAnswer':
      return outcome.operation === 'read'
        ? { tone: 'warning', text: 'The sensor didn’t answer.' }
        : { tone: 'warning', text: `The sensor didn’t answer.${has}` }
    case 'checking':
      return { tone: 'secondary', text: 'The sensor didn’t answer. Reading it back to check…' }
    case 'notSent':
      return { tone: 'danger', text: `Not sent: ${outcome.reason}.` }
    case 'invalid':
      return { tone: 'danger', text: outcome.reason }
  }
}

/** The value a result says the device now holds, if it says. */
export function storedValueOf(
  result: ReadResult | WriteResult
): { value: unknown; readAt: string } | null {
  if (result.status === 'answered') {
    return { value: result.value, readAt: result.readAt }
  }
  if (result.status === 'applied' || result.status === 'storedDiffers') {
    return { value: result.stored, readAt: result.readAt }
  }
  if ('readBack' in result && result.readBack?.status === 'answered') {
    return { value: result.readBack.value, readAt: result.readBack.readAt }
  }
  return null
}

/** How long ago, in the coarsest unit that still says something. */
export function age(readAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - readAt) / 1000))
  if (seconds < 60) {
    return `${String(seconds)} s ago`
  }
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${String(minutes)} min ago` : `${String(Math.round(minutes / 60))} h ago`
}
