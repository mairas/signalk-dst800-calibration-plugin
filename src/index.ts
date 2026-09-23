/**
 * signalk-airmar-dst-config - interactive configuration console for Airmar
 * DST-family NMEA 2000 depth, speed and temperature sensors.
 */

import type { Request, Response } from 'express'
import type { Plugin, PluginRouter, ServerAPI } from '@signalk/server-api'
import { EventStream } from './api/events.js'
import { openApi } from './api/openApi.js'
import { registerRoutes } from './api/routes.js'
import { createBus } from './protocol/n2kAdapter.js'
import { ConsoleRuntime } from './runtime.js'
import {
  parsePluginConfig,
  type DeviceKey,
  type HealthResponse,
  type PluginConfig
} from './types.js'

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
  let runtime: ConsoleRuntime | null = null
  const events = new EventStream()

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

  /** Persist the selection, keeping whatever else the stored configuration holds. */
  const saveSelection = (key: DeviceKey | null): Promise<void> => {
    const stored = app.readPluginOptions() as StoredOptions
    const configuration: Record<string, unknown> =
      typeof stored.configuration === 'object' && stored.configuration !== null
        ? { ...(stored.configuration as Record<string, unknown>) }
        : {}
    if (key === null) {
      delete configuration.selectedDevice
    } else {
      configuration.selectedDevice = key
    }
    return new Promise((resolve, reject) => {
      app.savePluginOptions(configuration, (error) => {
        if (error === null) {
          resolve()
        } else {
          reject(error)
        }
      })
    })
  }

  return {
    id: PLUGIN_ID,
    name: 'Airmar DST Config',
    description:
      'Read and write the calibration, filter and transmission settings of an Airmar DST-family sensor over NMEA 2000.',

    schema: () => configSchema,

    getOpenApi: () => openApi,

    start() {
      runtime?.close()
      runtime = new ConsoleRuntime({
        bus: createBus(app),
        sources: () => app.getPath('/sources'),
        selected: currentConfig().selectedDevice ?? null,
        onError: (error) => {
          app.debug(error instanceof Error ? (error.stack ?? error.message) : String(error))
        },
        onChange: (changed) => {
          events.send({ type: 'devices', data: changed.devicesView() })
          events.send({ type: 'device', data: changed.deviceView() })
        }
      })
      app.setPluginStatus('Started')
    },

    stop() {
      events.close()
      runtime?.close()
      runtime = null
      app.setPluginStatus('Stopped')
    },

    registerWithRouter(router: PluginRouter) {
      // Routes that answer from what the plugin holds are readonly, so a
      // non-admin login can watch the console. Routes that put a frame on the
      // bus stay on the admin default; register them with a plain
      // router.get/put/post, never through access().
      router.access('readonly').get('/api/health', (_req: Request, res: Response) => {
        const body: HealthResponse = {
          running: runtime !== null,
          selectedDevice: currentConfig().selectedDevice ?? null
        }
        res.json(body)
      })
      registerRoutes(router, {
        runtime: () => runtime,
        events,
        select: async (key) => {
          await saveSelection(key)
          runtime?.select(key)
        }
      })
    }
  }
}
