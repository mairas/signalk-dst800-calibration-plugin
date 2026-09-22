/**
 * signalk-airmar-dst-config - interactive configuration console for Airmar
 * DST-family NMEA 2000 depth, speed and temperature sensors.
 */

import type { Request, Response } from 'express'
import type { Plugin, PluginRouter, ServerAPI } from '@signalk/server-api'
import { parsePluginConfig, type HealthResponse, type PluginConfig } from './types.js'

export type { DeviceKey, PluginConfig, HealthResponse } from './types.js'

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
      required: ['manufacturerCode', 'uniqueNumber'],
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

interface StoredOptions {
  configuration?: unknown
}

export default function plugin(app: ServerAPI): Plugin {
  let running = false

  /**
   * Read the configuration the server currently holds.
   *
   * Not a snapshot taken in start(): registerWithRouter runs once at plugin
   * load, before and independently of start(), and app.savePluginOptions
   * writes the file without restarting the plugin. A closed-over copy would
   * report a device the user has just changed, or none at all while the plugin
   * is disabled.
   */
  const currentConfig = (): PluginConfig => {
    const stored = app.readPluginOptions() as StoredOptions
    return parsePluginConfig(stored.configuration)
  }

  return {
    id: PLUGIN_ID,
    name: 'Airmar DST Config',
    description:
      'Read and write the calibration, filter and transmission settings of an Airmar DST-family sensor over NMEA 2000.',

    schema: () => configSchema,

    start() {
      running = true
      app.setPluginStatus('Started')
    },

    stop() {
      running = false
      app.setPluginStatus('Stopped')
    },

    registerWithRouter(router: PluginRouter) {
      // Read routes are readonly so a non-admin login can watch the console.
      // Routes that write to a sensor stay on the admin default; register them
      // with a plain router.get/post, never through access().
      router.access('readonly').get('/api/health', (_req: Request, res: Response) => {
        const body: HealthResponse = {
          running,
          selectedDevice: currentConfig().selectedDevice ?? null
        }
        res.json(body)
      })
    }
  }
}
