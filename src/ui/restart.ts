/**
 * The actions that restart the sensor: a master reset, which keeps what it
 * has stored, and the EEPROM restores, which put part or all of it back to
 * factory defaults first. Each is followed through the restart by the plugin.
 */

import type { ResetResult } from '../types.js'
import { clause } from './format.js'

export type RestartAction = 'reset' | 'all' | 'updateRates' | 'priorities'

/** Sent when the user confirms `action`; the settings panel owns the request. */
export type RestartRequest = CustomEvent<{ action: RestartAction }>

/** An action and how it went, kept by the settings panel across the restart. */
export interface Restarted {
  action: RestartAction
  result: ResetResult
}

/** The plugin route and body for `action`. */
export function routeOf(action: RestartAction): { path: string; body?: { option: string } } {
  return action === 'reset'
    ? { path: '/device/reset' }
    : { path: '/device/restore', body: { option: action } }
}

const DONE: Record<RestartAction, string> = {
  reset: '✓ The sensor restarted.',
  all: '✓ Factory settings restored. The sensor restarted.',
  updateRates: '✓ Restored. The sensor restarted.',
  priorities: '✓ Restored. The sensor restarted.'
}

/** What an action's result says. */
export function describeRestart({ action, result }: Restarted): { tone: string; text: string } {
  switch (result.status) {
    case 'claimed':
      return { tone: 'success', text: DONE[action] }
    case 'lost':
      return {
        tone: 'warning',
        text: `Sent, but the sensor didn’t come back: ${clause(result.reason)}.`
      }
    case 'notSent':
      return { tone: 'danger', text: `Not sent: ${clause(result.reason)}.` }
  }
}
