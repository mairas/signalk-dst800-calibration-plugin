/**
 * signalk-airmar-dst-config - interactive configuration console for Airmar
 * DST-family NMEA 2000 depth, speed and temperature sensors.
 */

import type { IRouter, Request, Response } from 'express'
import type { Plugin, ServerAPI } from '@signalk/server-api'
import type { PluginConfig } from './types.js'

export type { DeviceKey, PluginConfig } from './types.js'

export const PLUGIN_ID = 'signalk-airmar-dst-config'

/**
 * Configuration schema shown in the Signal K admin UI.
 *
 * The console is the place to configure a device; this form only records which
 * device it is pointed at, and is normally left alone.
 */
const configSchema = {
  type: 'object' as const,
  properties: {
    selectedDevice: {
      type: 'object',
      title: 'Selected device',
      description:
        'Set from the console. Identifies the device by Address Claim, not by source address.',
      properties: {
        manufacturerCode: {
          type: 'number',
          title: 'Manufacturer code'
        },
        uniqueNumber: {
          type: 'number',
          title: 'Unique number'
        }
      }
    }
  }
}

export default function plugin(app: ServerAPI): Plugin {
  let config: PluginConfig = {}
  let running = false

  return {
    id: PLUGIN_ID,
    name: 'Airmar DST Config',
    description:
      'Read and write the calibration, filter and transmission settings of an Airmar DST-family sensor over NMEA 2000.',

    schema: () => configSchema,

    start(options: object) {
      config = options
      running = true
      app.setPluginStatus('Started')
    },

    stop() {
      running = false
      config = {}
      app.setPluginStatus('Stopped')
    },

    registerWithRouter(router: IRouter) {
      router.get('/api/health', (_req: Request, res: Response) => {
        res.json({ running, selectedDevice: config.selectedDevice ?? null })
      })
    }
  }
}
