/**
 * signalk-airmar-dst-config - interactive configuration console for Airmar
 * DST-family NMEA 2000 depth, speed and temperature sensors.
 */

import type { Request, Response } from 'express'
import type { Delta, Path, Plugin, PluginRouter, ServerAPI } from '@signalk/server-api'
import { EventStream } from './api/events.js'
import { openApi } from './api/openApi.js'
import { registerRoutes } from './api/routes.js'
import { createBus } from './protocol/n2kAdapter.js'
import { ConsoleRuntime } from './runtime.js'
import { readSetting } from './settings/operations.js'
import { SIMULATE_REREAD_MS, simulateNotification, simulateStateOf } from './simulate.js'
import { TELEMETRY_META, startTelemetry } from './telemetry/publisher.js'
import {
  parsePluginConfig,
  type DeviceKey,
  type HealthResponse,
  type PluginConfig,
  type ServerEvent
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
   * The sensors last seen simulating, by key. The warning stays raised while
   * any of them is, so switching the console to another sensor cannot clear it.
   */
  const simulating = new Set<string>()
  /** The warning state last published; null until one is. */
  let warned: boolean | null = null
  let simulateTimer: ReturnType<typeof setInterval> | null = null
  let stopTelemetry: (() => void) | null = null

  const report = (error: unknown): void => {
    app.debug(error instanceof Error ? (error.stack ?? error.message) : String(error))
  }

  const publish = (event: ServerEvent): void => {
    events.send(event)
    const on = simulateStateOf(event)
    const device = runtime?.selected ?? null
    if (on === null || device === null) {
      return
    }
    const id = `${String(device.manufacturerCode)}:${String(device.uniqueNumber)}`
    if (on) {
      simulating.add(id)
    } else {
      simulating.delete(id)
    }
    const warn = simulating.size > 0
    if (warn !== warned) {
      warned = warn
      app.handleMessage(PLUGIN_ID, simulateNotification(warn))
    }
  }

  /** The re-read in flight, which every later trigger joins. */
  let rereading: Promise<void> | null = null

  /**
   * Read simulate mode again, while someone is watching the console.
   *
   * At most one read is in flight. Each console that opens triggers one, and
   * a readonly client reopening its stream in a loop would otherwise fill the
   * session's queue with Level 1 reads.
   */
  const rereadSimulate = (): Promise<void> => {
    const session = runtime?.session ?? null
    if (!events.hasClients || session === null) {
      return Promise.resolve()
    }
    rereading ??= readSetting(session, 'simulateMode')
      .then((result) => {
        publish({
          type: 'setting',
          data: { id: 'simulateMode', qualifier: null, operation: 'read', result }
        })
      })
      .finally(() => {
        rereading = null
      })
    return rereading
  }

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
      stopTelemetry?.()
      const bus = createBus(app)
      runtime = new ConsoleRuntime({
        bus,
        sources: () => app.getPath('/sources'),
        selected: currentConfig().selectedDevice ?? null,
        onError: report,
        onChange: (changed) => {
          publish({ type: 'devices', data: changed.devicesView() })
          publish({ type: 'device', data: changed.deviceView() })
        }
      })
      const meta: Partial<Delta> = {
        updates: [
          {
            meta: TELEMETRY_META.map(({ path, ...value }) => ({ path: path as Path, value }))
          }
        ]
      }
      app.handleMessage(PLUGIN_ID, meta)
      stopTelemetry = startTelemetry({
        subscribe: (handler) => bus.subscribe(handler),
        address: () => runtime?.location?.address ?? null,
        canName: () => runtime?.canName ?? null,
        publish: (values, source) => {
          app.handleMessage(PLUGIN_ID, {
            updates: [
              {
                ...(source === null ? {} : { source }),
                values: values.map(({ path, value }) => ({ path: path as Path, value }))
              }
            ]
          })
        },
        onError: report
      })
      simulating.clear()
      warned = null
      if (simulateTimer !== null) {
        clearInterval(simulateTimer)
      }
      simulateTimer = setInterval(() => {
        rereadSimulate().catch(report)
      }, SIMULATE_REREAD_MS)
      app.setPluginStatus('Started')
    },

    stop() {
      if (simulateTimer !== null) {
        clearInterval(simulateTimer)
        simulateTimer = null
      }
      stopTelemetry?.()
      stopTelemetry = null
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
        publish,
        consoleOpened: () => {
          rereadSimulate().catch(report)
        },
        select: async (key) => {
          await saveSelection(key)
          runtime?.select(key)
        }
      })
    }
  }
}
