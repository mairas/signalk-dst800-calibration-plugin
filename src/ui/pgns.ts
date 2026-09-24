/**
 * How the console presents the PGNs a sensor transmits: their names, which
 * ones a transmission interval means anything for, and what each outcome of
 * setting an interval or a priority says.
 */

import { MAX_INTERVAL_MS } from '../settings/intervalLimits.js'
import type { PgnWriteResult } from '../types.js'
import { inWords } from './settings.js'

/** Names for the PGNs an Airmar DST can transmit. */
const NAMES: Partial<Record<number, string>> = {
  128267: 'Water depth',
  128259: 'Speed through water',
  128275: 'Distance log',
  130310: 'Environmental parameters (obsolete)',
  130311: 'Environmental parameters',
  130312: 'Temperature',
  130316: 'Temperature, extended range',
  65408: 'Depth quality factor (Airmar)',
  65409: 'Speed pulse count (Airmar)',
  65410: 'Device information (Airmar)',
  126992: 'System time',
  126993: 'Heartbeat',
  127245: 'Rudder',
  127250: 'Vessel heading',
  127251: 'Rate of turn',
  127257: 'Attitude'
}

/**
 * PGNs a device sends in answer to a request or an event, never on a period,
 * so an interval means nothing for them.
 */
const ON_REQUEST: Partial<Record<number, string>> = {
  59392: 'ISO acknowledgement',
  59904: 'ISO request',
  60928: 'Address claim',
  65240: 'Commanded address',
  65287: 'Access level (Airmar)',
  126208: 'Group function',
  126464: 'PGN list',
  126720: 'Airmar proprietary',
  126996: 'Product information',
  126998: 'Configuration information',
  130944: 'Self-test result (Airmar)'
}

/**
 * What the DST200 user manual (revision 1.000) gives as each periodic PGN's
 * factory default: its update rate, 0 when it is not sent on a period, and its
 * priority. The manual marks every one of these as changeable and kept in
 * EEPROM across a power cycle.
 */
const DEFAULTS: Partial<Record<number, { intervalMs: number; priority: number }>> = {
  128259: { intervalMs: 1000, priority: 2 },
  128267: { intervalMs: 1000, priority: 3 },
  128275: { intervalMs: 1000, priority: 6 },
  130310: { intervalMs: 0, priority: 5 },
  130311: { intervalMs: 500, priority: 5 },
  65408: { intervalMs: 0, priority: 7 },
  65409: { intervalMs: 0, priority: 7 },
  65410: { intervalMs: 0, priority: 7 }
}

/** The factory default in words, or null for a PGN the manual does not describe. */
export function defaultOf(pgn: number): string | null {
  const known = DEFAULTS[pgn]
  if (known === undefined) {
    return null
  }
  const rate = known.intervalMs === 0 ? 'not sent' : `every ${seconds(known.intervalMs)}`
  return `Default ${rate}, priority ${String(known.priority)}`
}

export const pgnName = (pgn: number): string =>
  NAMES[pgn] ?? ON_REQUEST[pgn] ?? `PGN ${String(pgn)}`

export const onRequest = (pgn: number): boolean => ON_REQUEST[pgn] !== undefined

const MS_PER_S = 1000

export const seconds = (ms: number): string => `${(ms / MS_PER_S).toFixed(2)} s`

/** The range an interval may take, as the console quotes it. */
export const intervalRange = (minMs: number): string =>
  `${String(minMs / MS_PER_S)} to ${String(MAX_INTERVAL_MS / MS_PER_S)} s`

/** The interval the user typed, in whole milliseconds, or why it cannot be sent. */
export function parseInterval(
  text: string,
  minMs: number
): { ok: true; ms: number } | { ok: false; reason: string } {
  const typed = text.trim() === '' ? NaN : Number(text)
  const ms = Math.round(typed * MS_PER_S)
  return Number.isFinite(typed) && ms >= minMs && ms <= MAX_INTERVAL_MS
    ? { ok: true, ms }
    : {
        ok: false,
        reason: `From ${intervalRange(minMs)}.`
      }
}

export type Tone = 'success' | 'warning' | 'danger'

/** What a write's result says, for an interval or a priority. */
export function describePgnWrite(
  result: PgnWriteResult,
  what: { interval: true } | { priority: number }
): { tone: Tone; text: string } {
  switch (result.status) {
    case 'applied':
      return 'priority' in what
        ? { tone: 'success', text: `✓ Priority ${String(what.priority)} stored.` }
        : result.observedIntervalMs === undefined
          ? { tone: 'success', text: '✓ Stored.' }
          : {
              tone: 'success',
              text: `✓ The sensor now sends it every ${seconds(result.observedIntervalMs)}.`
            }
    case 'observedDiffers':
      return {
        tone: 'warning',
        text: `The sensor sends it every ${seconds(result.observedIntervalMs)}, not ${seconds(result.requestedIntervalMs)}.`
      }
    case 'unconfirmed':
      return {
        tone: 'warning',
        text: 'The sensor didn’t refuse it, but sent it too seldom to time.'
      }
    case 'rejected': {
      const { pgnError, intervalPriorityError, parameterErrors } = result.detail
      const errors = [
        pgnError,
        intervalPriorityError,
        ...parameterErrors.map((e) => e.error)
      ].filter((error) => error !== 'Acknowledge')
      return {
        tone: 'danger',
        text: `The sensor refused it: ${inWords(errors.length === 0 ? [result.reason] : errors)}.`
      }
    }
    case 'unknown':
      return { tone: 'warning', text: 'The sensor didn’t answer.' }
    case 'notSent':
      return { tone: 'danger', text: `Not sent: ${result.reason}.` }
    case 'invalid':
      return { tone: 'danger', text: result.reason }
  }
}
