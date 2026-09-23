/**
 * Simulate mode as the rest of the vessel sees it.
 *
 * While simulate mode is on, the sensor puts simulated depth, speed and
 * temperature on the bus for every autopilot and anchor alarm. A Signal K
 * notification makes that visible outside the console.
 */

import type { Delta, Notification, Path } from '@signalk/server-api'
import type { ServerEvent } from './types.js'

export const SIMULATE_NOTIFICATION_PATH = 'notifications.airmarDst.simulateMode'

/**
 * How often an open console has the plugin read simulate mode again.
 *
 * Another display on the bus can turn it on, and a power cycle turns it off,
 * and neither tells this plugin.
 */
export const SIMULATE_REREAD_MS = 60_000

/** Whether `event` says the device simulates now, or null when it says nothing about it. */
export function simulateStateOf(event: ServerEvent): boolean | null {
  // Not a reset: its only evidence of a reboot is an Address Claim, which a
  // device that ignored the reset also sends when another display asks.
  if (event.type !== 'setting' || event.data.id !== 'simulateMode') {
    return null
  }
  const result = event.data.result
  const value =
    result.status === 'answered'
      ? result.value
      : result.status === 'applied' || result.status === 'storedDiffers'
        ? result.stored
        : null
  return typeof value === 'boolean' ? value : null
}

export function simulateNotification(on: boolean): Partial<Delta> {
  const value = (
    on
      ? {
          state: 'warn',
          method: ['visual'],
          message:
            'The Airmar sensor is in simulate mode: its depth, speed and temperature are simulated'
        }
      : { state: 'normal', method: [], message: 'The Airmar sensor is not in simulate mode' }
  ) as Notification
  return { updates: [{ values: [{ path: SIMULATE_NOTIFICATION_PATH as Path, value }] }] }
}
