/**
 * How the console presents each setting: its section, label, help, unit and
 * editor, and what each outcome of a read or write says to the user.
 *
 * The plugin's registry owns ranges and validation; the console lays values
 * out in the user's units and converts what the user typed back to SI.
 */

import type { ReadResult, WriteResult } from '../types.js'
import type { UnitSpec } from './units.js'

export type Editor =
  | { kind: 'number' }
  | { kind: 'choice'; options: readonly { value: boolean; label: string }[] }
  | { kind: 'simulate' }
  | { kind: 'description' }
  | { kind: 'filter' }
  | { kind: 'tripReset' }

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
    help: 'Whether the sensor sends each message at its measurement interval or at the interval set for that message.',
    editor: {
      kind: 'choice',
      options: [
        { value: false, label: 'Measurement interval' },
        { value: true, label: 'As set per message' }
      ]
    }
  },
  simulateMode: {
    label: 'Simulate mode',
    help: 'Replaces measured depth, speed and temperature with simulated values, for testing an installation.',
    editor: { kind: 'simulate' }
  }
}

/** The console's sections, in page order. */
export const SECTIONS: readonly { id: string; title: string; settings: readonly string[] }[] = [
  { id: 'depth', title: 'Depth', settings: ['depthOffset', 'speedOfSound'] },
  { id: 'speed', title: 'Speed', settings: ['speedFilter'] },
  { id: 'temperature', title: 'Temperature', settings: ['temperatureOffset', 'temperatureFilter'] },
  { id: 'log', title: 'Distance log', settings: ['distanceLog'] },
  { id: 'network', title: 'NMEA 2000 output', settings: ['transmissionIntervalOverride'] },
  { id: 'installation', title: 'Installation', settings: ['installationDescription'] },
  { id: 'maintenance', title: 'Maintenance', settings: ['simulateMode'] }
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
  | { kind: 'refused'; requested: unknown; reason: string }
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

const inWords = (errors: readonly string[]): string =>
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
        ? { kind: 'refused', requested: result.requested, reason: refusalReason(result) }
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
