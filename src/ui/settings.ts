/**
 * How the console presents each setting: its label, how its value reads, how
 * it is edited, and what each outcome of a read or write says to the user.
 *
 * The plugin's registry owns ranges and validation; the console only lays
 * values out and passes what the user typed through. A value the device's
 * range forbids comes back from the plugin as a 400 with the reason.
 */

import type { ReadResult, WriteResult } from '../types.js'

export type Editor =
  | { kind: 'number'; unit: string; step: number; decimals: number }
  | { kind: 'choice'; options: readonly { value: boolean; label: string }[] }
  | { kind: 'simulate' }
  | { kind: 'description' }
  | { kind: 'filter' }
  | { kind: 'tripReset' }
  | { kind: 'none' }

export interface SettingView {
  label: string
  /** One line under the label, where the setting needs explaining. */
  help?: string
  editor: Editor
}

const METRES_PER_NAUTICAL_MILE = 1852

/** The settings this slice of the console shows; the speed curve has its own editor. */
export const VIEWS: Partial<Record<string, SettingView>> = {
  temperatureOffset: {
    label: 'Temperature offset',
    help: 'Added to the measured temperature.',
    editor: { kind: 'number', unit: 'K', step: 0.001, decimals: 3 }
  },
  depthOffset: {
    label: 'Depth offset',
    help: 'Positive: distance from the transducer to the waterline. Negative: to the keel.',
    editor: { kind: 'number', unit: 'm', step: 0.001, decimals: 3 }
  },
  speedOfSound: {
    label: 'Speed of sound',
    editor: { kind: 'number', unit: 'm/s', step: 0.1, decimals: 1 }
  },
  speedFilter: { label: 'Speed filter', editor: { kind: 'filter' } },
  temperatureFilter: { label: 'Temperature filter', editor: { kind: 'filter' } },
  transmissionIntervalOverride: {
    label: 'Transmission intervals',
    editor: {
      kind: 'choice',
      options: [
        { value: false, label: 'Follow the measurement interval' },
        { value: true, label: 'As set per PGN' }
      ]
    }
  },
  installationDescription: { label: 'Installation description', editor: { kind: 'description' } },
  productInformation: { label: 'Product information', editor: { kind: 'none' } },
  distanceLog: { label: 'Distance log', editor: { kind: 'tripReset' } },
  simulateMode: {
    label: 'Simulate mode',
    help: 'Replaces measured depth, speed and temperature with simulated values for every device on the bus.',
    editor: { kind: 'simulate' }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nauticalMiles = (metres: unknown): string =>
  typeof metres === 'number'
    ? `${(metres / METRES_PER_NAUTICAL_MILE).toFixed(2)} nmi`
    : 'not reported'

/** A stored value as the user reads it. */
export function formatValue(id: string, value: unknown): string {
  const editor = VIEWS[id]?.editor
  if (editor?.kind === 'number' && typeof value === 'number') {
    return `${value.toFixed(editor.decimals)} ${editor.unit}`
  }
  if (editor?.kind === 'choice' && typeof value === 'boolean') {
    return editor.options.find((o) => o.value === value)?.label ?? String(value)
  }
  if (editor?.kind === 'simulate' && typeof value === 'boolean') {
    return value ? 'On' : 'Off'
  }
  if (id === 'installationDescription' && isRecord(value)) {
    const lines = [value.description1, value.description2].filter(
      (line): line is string => typeof line === 'string' && line !== ''
    )
    return lines.length === 0 ? 'Empty' : lines.join(' / ')
  }
  if (id === 'distanceLog' && isRecord(value)) {
    return `Total ${nauticalMiles(value.log)}, trip ${nauticalMiles(value.tripLog)}`
  }
  if (id === 'productInformation' && isRecord(value)) {
    const parts = [
      value.modelId,
      value.modelVersion,
      typeof value.softwareVersionCode === 'string'
        ? `software ${value.softwareVersionCode}`
        : null,
      typeof value.modelSerialCode === 'string' ? `serial ${value.modelSerialCode}` : null
    ].filter((part): part is string => typeof part === 'string' && part !== '')
    return parts.join(', ')
  }
  return JSON.stringify(value)
}

/** How long ago, in the coarsest unit that still says something. */
export function age(readAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(readAt)) / 1000))
  if (seconds < 60) {
    return `${String(seconds)} s ago`
  }
  const minutes = Math.round(seconds / 60)
  return minutes < 60 ? `${String(minutes)} min ago` : `${String(Math.round(minutes / 60))} h ago`
}

export type Tone = 'success' | 'warning' | 'danger' | 'secondary'

/** What the last read or write says, or null when it needs no line of its own. */
export function describeOutcome(
  id: string,
  operation: 'read' | 'write',
  result: ReadResult | WriteResult
): { tone: Tone; text: string } | null {
  switch (result.status) {
    case 'answered':
      return null
    case 'applied':
      return { tone: 'success', text: 'Stored.' }
    case 'storedDiffers':
      return {
        tone: 'warning',
        text: `The device stored ${formatValue(id, result.stored)}, not ${formatValue(id, result.requested)}.`
      }
    case 'acknowledged':
      return result.readBack === undefined
        ? { tone: 'success', text: 'Accepted. The device cannot report this value back.' }
        : {
            tone: 'warning',
            text: 'Accepted, but reading the stored value back failed, so it is not confirmed.'
          }
    case 'rejected': {
      const fields =
        'refusedFields' in result && result.refusedFields.length > 0
          ? result.refusedFields.map((f) => `${f.field}: ${f.error}`).join('; ')
          : result.reason
      return { tone: 'danger', text: `Refused by the device (${fields}).` }
    }
    case 'notSent':
      return { tone: 'danger', text: `Not sent: ${result.reason}.` }
    case 'unknown':
      return operation === 'read'
        ? { tone: 'warning', text: 'No answer to the read.' }
        : {
            tone: 'warning',
            text: 'No answer from the device. It may or may not have stored the value.'
          }
    case 'invalid':
      return { tone: 'danger', text: result.reason }
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
