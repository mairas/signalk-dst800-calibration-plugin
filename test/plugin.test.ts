import { describe, it, expect } from 'vitest'
import plugin, { PLUGIN_ID } from '../src/index.js'
import type { HealthResponse } from '../src/types.js'
import {
  createMockServerAPI,
  createRecordingRouter,
  createJsonResponse
} from './helpers/MockServerAPI.js'
import { decode } from './helpers/canboat.js'
import { sourcesTree } from './helpers/sources.js'
import { PGN } from '../src/protocol/pids.js'
import type { DecodedPgn } from '../src/protocol/messages.js'

describe('plugin lifecycle', () => {
  it('exposes the Signal K plugin interface', () => {
    const app = createMockServerAPI()
    const p = plugin(app.asServerAPI())

    expect(p.id).toBe(PLUGIN_ID)
    expect(p.name).toBeTruthy()
    expect(p.description).toBeTruthy()
    expect(typeof p.start).toBe('function')
    expect(typeof p.stop).toBe('function')
  })

  it('reports its status to the server on start and stop', () => {
    const app = createMockServerAPI()
    const p = plugin(app.asServerAPI())

    p.start({}, () => undefined)
    void p.stop()

    expect(app.statuses).toEqual(['Started', 'Stopped'])
    expect(app.errors).toEqual([])
  })

  it('returns a usable schema before it has ever been configured', () => {
    const app = createMockServerAPI()
    const { schema } = plugin(app.asServerAPI())
    const resolved: unknown = typeof schema === 'function' ? schema() : schema

    expect(resolved).toBeTypeOf('object')
    expect(JSON.parse(JSON.stringify(resolved))).toEqual(resolved)
  })

  it('requires both DeviceKey fields in the schema it hands the admin UI', () => {
    const app = createMockServerAPI()
    const { schema } = plugin(app.asServerAPI())
    const resolved = (typeof schema === 'function' ? schema() : schema) as {
      properties: { selectedDevice: { required?: string[] } }
    }

    expect(resolved.properties.selectedDevice.required).toEqual([
      'manufacturerCode',
      'uniqueNumber'
    ])
  })
})

describe('GET /api/health', () => {
  const health = (app: ReturnType<typeof createMockServerAPI>, started: boolean) => {
    const p = plugin(app.asServerAPI())
    const { routes, router } = createRecordingRouter()
    p.registerWithRouter?.(router)
    if (started) {
      p.start({}, () => undefined)
    }
    const route = routes.find((r) => r.path === '/api/health')
    expect(route).toBeDefined()
    const captured = createJsonResponse()
    route?.handler({}, captured.res)
    return { body: captured.body as HealthResponse, route }
  }

  it('is registered as readonly so a non-admin login can reach it', () => {
    const { route } = health(createMockServerAPI(), false)

    // A plain router.get registers no permission, and the server then falls
    // through to admin-only. The webapp is this route's only consumer.
    expect(route?.access).toBe('readonly')
  })

  it('reports null before a device is configured', () => {
    const { body } = health(createMockServerAPI(), true)

    expect(body).toEqual({ running: true, selectedDevice: null })
  })

  it('reports the configured device', () => {
    const app = createMockServerAPI({ selectedDevice: { manufacturerCode: 135, uniqueNumber: 42 } })
    const { body } = health(app, true)

    expect(body.selectedDevice).toEqual({ manufacturerCode: 135, uniqueNumber: 42 })
  })

  it('reflects a device saved while the plugin is disabled', () => {
    // registerWithRouter runs at plugin load; start() never runs for a disabled
    // plugin. A config snapshot taken in start() would report null here.
    const app = createMockServerAPI()
    const p = plugin(app.asServerAPI())
    const { routes, router } = createRecordingRouter()
    p.registerWithRouter?.(router)

    app.storedOptions.configuration = {
      selectedDevice: { manufacturerCode: 135, uniqueNumber: 7 }
    }
    const captured = createJsonResponse()
    routes[0].handler({}, captured.res)

    expect((captured.body as HealthResponse).selectedDevice).toEqual({
      manufacturerCode: 135,
      uniqueNumber: 7
    })
    expect((captured.body as HealthResponse).running).toBe(false)
  })

  it('reflects a device saved after start, without a restart', () => {
    // app.savePluginOptions writes the file and does not restart the plugin.
    const app = createMockServerAPI()
    const { body: before } = health(app, true)
    expect(before.selectedDevice).toBeNull()

    const p = plugin(app.asServerAPI())
    const { routes, router } = createRecordingRouter()
    p.registerWithRouter?.(router)
    p.start({}, () => undefined)
    app.storedOptions.configuration = {
      selectedDevice: { manufacturerCode: 135, uniqueNumber: 99 }
    }
    const captured = createJsonResponse()
    routes[0].handler({}, captured.res)

    expect((captured.body as HealthResponse).selectedDevice).toEqual({
      manufacturerCode: 135,
      uniqueNumber: 99
    })
  })

  it('drops a stored selectedDevice that is not a complete DeviceKey', () => {
    // The server JSON-parses the config file without checking it against the
    // schema, so a hand-edited file reaches the plugin unvalidated.
    for (const bad of [{}, 'dst800', { manufacturerCode: 135 }, { uniqueNumber: 42 }, null]) {
      const app = createMockServerAPI({ selectedDevice: bad })
      const { body } = health(app, true)
      expect(body.selectedDevice).toBeNull()
    }
  })
})

describe('telemetry', () => {
  const DST = { address: 22, uniqueNumber: 123456, manufacturerCode: 'Airmar', modelId: 'DST800' }
  const pulses: DecodedPgn = {
    ...decode({
      pgn: PGN.speedPulseCount,
      dst: 255,
      prio: 7,
      fields: {
        manufacturerCode: 'Airmar',
        industryCode: 'Marine Industry',
        sid: 1,
        durationOfInterval: 2,
        numberOfPulsesReceived: 40
      }
    }),
    src: DST.address,
    dst: 255
  }

  const started = () => {
    const app = createMockServerAPI({
      selectedDevice: { manufacturerCode: 135, uniqueNumber: DST.uniqueNumber }
    })
    app.sources = sourcesTree([DST])
    const p = plugin(app.asServerAPI())
    p.start({}, () => undefined)
    return { app, p }
  }

  /** The entries of the last delta's first update, under `key`. */
  const last = (app: ReturnType<typeof createMockServerAPI>, key: 'meta' | 'values') =>
    (app.deltas.at(-1) as { updates: Record<string, { path: string; value: unknown }[]>[] })
      .updates[0][key]

  it('describes the unit of each path once, on start', () => {
    const { app, p } = started()

    expect(app.deltas).toHaveLength(1)
    expect(
      last(app, 'meta').find((m) => m.path === 'sensors.airmarDst.speed.pulseRate')?.value
    ).toMatchObject({ units: 'Hz' })
    void p.stop()
  })

  it('publishes the selected sensor’s pulse rate as it arrives, and nothing once stopped', () => {
    const { app, p } = started()
    app.events.emit('N2KAnalyzerOut', pulses)

    expect(last(app, 'values')).toContainEqual({
      path: 'sensors.airmarDst.speed.pulseRate',
      value: 20
    })

    const count = app.deltas.length
    void p.stop()
    app.events.emit('N2KAnalyzerOut', pulses)

    expect(app.deltas).toHaveLength(count)
  })
})
