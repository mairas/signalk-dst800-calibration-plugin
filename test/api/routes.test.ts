import { EventEmitter } from 'node:events'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import plugin from '../../src/index.js'
import { openApi } from '../../src/api/openApi.js'
import {
  createJsonResponse,
  createMockServerAPI,
  createStreamResponse,
  createRecordingRouter,
  type MockServerAPI,
  type RecordedRoute
} from '../helpers/MockServerAPI.js'
import { decode } from '../helpers/canboat.js'
import { acknowledge, pgnReply, pidReply } from '../helpers/replies.js'
import { sourcesTree, type TreeDevice } from '../helpers/sources.js'
import { PROBED, capabilityId } from '../../src/devices/probe.js'
import type { DecodedPgn, OutgoingPgn } from '../../src/protocol/messages.js'
import { PARAM, PGN } from '../../src/protocol/pids.js'
import { buildCommand, buildRead } from '../../src/settings/registry.js'
import type { DeviceKey } from '../../src/types.js'

const DST: TreeDevice = {
  address: 22,
  uniqueNumber: 123456,
  manufacturerCode: 'Airmar',
  modelId: 'DST800'
}
const DST_KEY: DeviceKey = { manufacturerCode: 135, uniqueNumber: 123456 }
const GATEWAY = 100
const from = { src: DST.address, dst: GATEWAY }

interface Call {
  params?: Record<string, string>
  query?: Record<string, unknown>
  body?: unknown
}

interface Schema {
  properties?: Record<string, Schema>
  items?: Schema
}

/** The documented schema of a route's 200 body. */
const documented = (path: string, method: string): Schema => {
  const paths = openApi.paths as unknown as Record<
    string,
    Record<string, { responses: Record<string, { content: Record<string, { schema: Schema }> }> }>
  >
  return paths[path][method].responses['200'].content['application/json'].schema
}

const keys = (value: unknown): string[] => Object.keys(value as object).sort()
const propertiesOf = (schema: Schema | undefined): string[] =>
  Object.keys(schema?.properties ?? {}).sort()

const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: string }): T => {
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.value
}

/** How the simulated device treats a probe request: answer it, refuse it, or ignore it. */
type Reaction = 'answer' | 'silent' | { error: string }

describe('REST API', () => {
  let app: MockServerAPI
  let routes: RecordedRoute[]
  let started: ReturnType<typeof plugin>
  let sent: OutgoingPgn[]

  const deliver = (pgn: DecodedPgn) => {
    app.events.emit('N2KAnalyzerOut', pgn)
  }
  const heard = () => {
    deliver(pgnReply(PGN.distanceLog, { src: DST.address }))
  }
  const flush = () => vi.advanceTimersByTimeAsync(0)
  const depthReply = (offset: number): DecodedPgn => ({
    ...decode({ pgn: PGN.waterDepth, dst: 255, prio: 3, fields: { sid: 1, depth: 12, offset } }),
    src: DST.address,
    dst: 255
  })

  /**
   * Answer the bus like the device: grant the unlock, and treat each probed
   * capability per `reactions`, keyed by `capabilityId`. Anything absent is
   * answered.
   */
  const respondLikeTheDevice = (reactions: Record<string, Reaction> = {}) => {
    app.events.on('nmea2000JsonOut', (message: OutgoingPgn) => {
      const target = Number(message.fields.pgn)
      const list = message.fields.list as { parameter: number; value: number }[]
      const pid =
        target === PGN.proprietary
          ? list.find((p) => p.parameter === PARAM.proprietaryId)?.value
          : undefined
      const isUnlock = message.fields.functionCode === 'Command' && target === PGN.accessLevel
      const id =
        pid === undefined
          ? capabilityId({ kind: 'pgn', pgn: target })
          : capabilityId({ kind: 'pid', pid })
      const reaction = isUnlock ? 'answer' : (reactions[id] ?? 'answer')
      if (reaction === 'silent') {
        return
      }
      queueMicrotask(() => {
        if (typeof reaction === 'object') {
          deliver(acknowledge({ acknowledgedPgn: target, pgnErrorCode: reaction.error }, from))
        } else if (isUnlock) {
          deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }, from))
        } else if (pid !== undefined) {
          deliver(pidReply(pid, from))
        } else {
          deliver(pgnReply(target, from))
        }
      })
    })
  }

  const route = (method: string, path: string): RecordedRoute => {
    const found = routes.find((r) => r.method === method && r.path === path)
    if (found === undefined) {
      throw new Error(`No ${method} ${path}`)
    }
    return found
  }

  /** Invoke a handler; returns the response once the handler has finished. */
  const call = (method: string, path: string, request: Call = {}) => {
    const response = createJsonResponse()
    const done = Promise.resolve(
      route(method, path).handler(
        { params: request.params ?? {}, query: request.query ?? {}, body: request.body },
        response.res
      )
    ).then(() => response)
    return done
  }

  beforeEach(() => {
    vi.useFakeTimers()
    app = createMockServerAPI()
    app.sources = sourcesTree([DST])
    sent = []
    app.events.on('nmea2000JsonOut', (message: OutgoingPgn) => sent.push(message))
    const recording = createRecordingRouter()
    routes = recording.routes
    started = plugin(app.asServerAPI())
    started.registerWithRouter?.(recording.router)
  })

  afterEach(async () => {
    await started.stop()
    vi.useRealTimers()
  })

  const start = (configuration: object = {}) => {
    app.storedOptions = { configuration }
    started.start(configuration, () => undefined)
  }

  describe('access', () => {
    it('lets a read-only login read what the plugin holds, and keeps every route that sends a frame at admin', () => {
      const levels = Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r.access]))

      expect(levels).toEqual({
        'get /api/health': 'readonly',
        'get /api/devices': 'readonly',
        'get /api/device': 'readonly',
        'put /api/device': 'admin',
        'post /api/device/probe': 'admin',
        'get /api/settings': 'readonly',
        'get /api/settings/:id': 'admin',
        'put /api/settings/:id': 'admin',
        'get /api/events': 'readonly'
      })
    })

    it('documents every route it registers', () => {
      const documented = Object.entries(openApi.paths).flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method} ${path}`)
      )
      const registered = routes
        .filter((r) => r.path !== '/api/health')
        .map((r) => `${r.method} ${r.path.replace(':id', '{id}')}`)

      expect(documented.sort()).toEqual(registered.sort())
    })
  })

  describe('response shapes', () => {
    it('answers each list and selection with the fields the document names', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const devices = (await call('get', '/api/devices')).body as { candidates: unknown[] }
      const settings = (await call('get', '/api/settings')).body as { settings: unknown[] }

      expect(keys(devices)).toEqual(propertiesOf(documented('/api/devices', 'get')))
      expect(keys(devices.candidates[0])).toEqual(
        propertiesOf(documented('/api/devices', 'get').properties?.candidates.items)
      )
      expect(keys((await call('get', '/api/device')).body)).toEqual(
        propertiesOf(documented('/api/device', 'get'))
      )
      expect(keys((await call('put', '/api/device', { body: { device: null } })).body)).toEqual(
        propertiesOf(documented('/api/device', 'put'))
      )
      expect(keys(settings)).toEqual(propertiesOf(documented('/api/settings', 'get')))
      expect(keys(settings.settings[0])).toEqual(
        propertiesOf(documented('/api/settings', 'get').properties?.settings.items)
      )
    })

    it('answers a probe with the fields the document names', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      respondLikeTheDevice()
      const pending = call('post', '/api/device/probe')
      await vi.advanceTimersByTimeAsync(60_000)

      expect(keys((await pending).body)).toEqual(
        propertiesOf(documented('/api/device/probe', 'post'))
      )
    })
  })

  describe('before start', () => {
    it('answers 503 rather than a stale or empty list', async () => {
      const response = await call('get', '/api/devices')

      expect(response.status).toBe(503)
    })
  })

  describe('devices', () => {
    it('lists the devices in the sources tree', async () => {
      start()
      const response = await call('get', '/api/devices')

      expect(response.body).toMatchObject({
        candidates: [
          { key: DST_KEY, modelId: 'DST800', location: { state: 'waiting', address: 22 } }
        ]
      })
    })

    it('saves a selection and follows the device', async () => {
      start()
      const response = await call('put', '/api/device', { body: { device: DST_KEY } })

      expect(response.status).toBe(200)
      expect(app.storedOptions.configuration).toEqual({ selectedDevice: DST_KEY })

      heard()

      expect((await call('get', '/api/device')).body).toMatchObject({
        selected: DST_KEY,
        location: { state: 'present', address: 22 },
        probe: null
      })
    })

    it('keeps the rest of the stored configuration when it saves a selection', async () => {
      start({ unrelated: 'kept' })
      await call('put', '/api/device', { body: { device: DST_KEY } })

      expect(app.storedOptions.configuration).toEqual({
        unrelated: 'kept',
        selectedDevice: DST_KEY
      })
    })

    it('clears the selection', async () => {
      start({ selectedDevice: DST_KEY })
      await call('put', '/api/device', { body: { device: null } })

      expect(app.storedOptions.configuration).toEqual({})
      expect((await call('get', '/api/device')).body).toMatchObject({
        selected: null,
        location: null
      })
    })

    it.each([
      ['no body', undefined],
      ['a partial key', { device: { manufacturerCode: 135 } }],
      ['a string', { device: '135:123456' }],
      ['a fractional code', { device: { manufacturerCode: 135.5, uniqueNumber: 1 } }],
      ['a negative number', { device: { manufacturerCode: 135, uniqueNumber: -1 } }],
      ['a code wider than its NAME field', { device: { manufacturerCode: 2048, uniqueNumber: 1 } }]
    ])('refuses %s', async (_name, body) => {
      start()

      expect((await call('put', '/api/device', { body })).status).toBe(400)
    })

    it('saves only the two key fields, whatever else the client sent', async () => {
      start()
      await call('put', '/api/device', { body: { device: { ...DST_KEY, note: 'kept out' } } })

      expect(app.storedOptions.configuration).toEqual({ selectedDevice: DST_KEY })
    })

    it('keeps the session when the selected device is selected again, so a write in flight completes', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const pending = call('put', '/api/settings/:id', {
        params: { id: 'depthOffset' },
        body: { value: 0.35 }
      })
      await flush()

      expect((await call('put', '/api/device', { body: { device: DST_KEY } })).status).toBe(200)

      deliver(acknowledge({ acknowledgedPgn: PGN.waterDepth }, from))
      await flush()
      deliver(depthReply(0.35))

      expect((await pending).body).toMatchObject({ status: 'applied', stored: 0.35 })
    })

    it('reports a selection it could not save', async () => {
      start()
      app.saveError = new Error('disk full')
      const response = await call('put', '/api/device', { body: { device: DST_KEY } })

      expect(response.status).toBe(500)
      expect((await call('get', '/api/device')).body).toMatchObject({ selected: null })
    })
  })

  describe('reading a setting', () => {
    it('answers 404 for a setting that does not exist', async () => {
      start({ selectedDevice: DST_KEY })

      expect(
        (await call('get', '/api/settings/:id', { params: { id: 'constructor' } })).status
      ).toBe(404)
    })

    it('answers 409 when no device is selected', async () => {
      start()

      expect(
        (await call('get', '/api/settings/:id', { params: { id: 'depthOffset' } })).status
      ).toBe(409)
    })

    it('answers 503 while the device has not been heard', async () => {
      start({ selectedDevice: DST_KEY })

      expect(
        (await call('get', '/api/settings/:id', { params: { id: 'depthOffset' } })).status
      ).toBe(503)
    })

    it('refuses a qualifier that is not a non-negative integer', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const response = await call('get', '/api/settings/:id', {
        params: { id: 'temperatureOffset' },
        query: { qualifier: '-1' }
      })

      expect(response.status).toBe(400)
    })

    it('reads the source the qualifier names', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      void call('get', '/api/settings/:id', {
        params: { id: 'temperatureOffset' },
        query: { qualifier: '1' }
      })
      await flush()
      deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }, from))
      await flush()

      expect(sent.at(-1)?.fields).toEqual(
        unwrap(buildRead('temperatureOffset', DST.address, 1)).message.fields
      )
    })

    it('answers a read the device never answers with 200 and the outcome', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const pending = call('get', '/api/settings/:id', { params: { id: 'depthOffset' } })
      await vi.advanceTimersByTimeAsync(60_000)
      const response = await pending

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ status: 'unknown' })
    })

    it('reads the device’s value over the bus', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const pending = call('get', '/api/settings/:id', { params: { id: 'depthOffset' } })
      await flush()

      expect(sent.at(-1)).toMatchObject({ pgn: PGN.groupFunction, dst: 22 })

      deliver({
        ...decode({
          pgn: PGN.waterDepth,
          dst: 255,
          prio: 3,
          fields: { sid: 1, depth: 12, offset: 0.35 }
        }),
        src: 22,
        dst: 255
      })
      const response = await pending

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ status: 'answered', value: 0.35 })
      expect(propertiesOf(documented('/api/settings/{id}', 'get'))).toEqual(
        expect.arrayContaining(keys(response.body))
      )
    })
  })

  describe('writing a setting', () => {
    it('refuses an out-of-range value with 400 and sends nothing', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const response = await call('put', '/api/settings/:id', {
        params: { id: 'speedOfSound' },
        body: { value: 2000 }
      })

      expect(response.status).toBe(400)
      expect(sent).toHaveLength(0)
    })

    it('refuses a negative qualifier before looking for the device', async () => {
      start()
      const response = await call('put', '/api/settings/:id', {
        params: { id: 'temperatureOffset' },
        body: { value: 0.5, qualifier: -1 }
      })

      expect(response.status).toBe(400)
    })

    it('writes to the source the qualifier names', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      void call('put', '/api/settings/:id', {
        params: { id: 'temperatureOffset' },
        body: { value: 0.5, qualifier: 1 }
      })
      await flush()
      deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }, from))
      await flush()

      expect(sent.at(-1)?.fields).toEqual(
        unwrap(buildCommand('temperatureOffset', DST.address, 0.5, 1)).spec.message.fields
      )
    })

    it('answers a write the device refuses with 200 and the refused field', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const pending = call('put', '/api/settings/:id', {
        params: { id: 'depthOffset' },
        body: { value: 0.35 }
      })
      await flush()
      deliver(
        acknowledge(
          { acknowledgedPgn: PGN.waterDepth, parameterErrors: ['Parameter out of range'] },
          from
        )
      )
      await flush()
      deliver(depthReply(0.2))
      const response = await pending

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({
        status: 'rejected',
        refusedFields: [{ error: 'Parameter out of range' }]
      })
      expect(propertiesOf(documented('/api/settings/{id}', 'put'))).toEqual(
        expect.arrayContaining(keys(response.body))
      )
    })

    it('refuses a body without a value', async () => {
      start({ selectedDevice: DST_KEY })
      heard()

      expect(
        (await call('put', '/api/settings/:id', { params: { id: 'depthOffset' }, body: 0.35 }))
          .status
      ).toBe(400)
    })

    it('writes, waits for the acknowledgement, reads back and reports what was stored', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const pending = call('put', '/api/settings/:id', {
        params: { id: 'depthOffset' },
        body: { value: 0.35 }
      })
      await flush()
      deliver(acknowledge({ acknowledgedPgn: PGN.waterDepth }, from))
      await flush()
      deliver({
        ...decode({
          pgn: PGN.waterDepth,
          dst: 255,
          prio: 3,
          fields: { sid: 1, depth: 12, offset: 0.35 }
        }),
        src: 22,
        dst: 255
      })
      const response = await pending

      expect(response.status).toBe(200)
      expect(response.body).toMatchObject({ status: 'applied', stored: 0.35 })
      expect(propertiesOf(documented('/api/settings/{id}', 'put'))).toEqual(
        expect.arrayContaining(keys(response.body))
      )
    })
  })

  describe('probing', () => {
    it('answers 409 without a selected device', async () => {
      start()

      expect((await call('post', '/api/device/probe')).status).toBe(409)
    })

    it('probes the device, keeps the result, and reports it per setting', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      respondLikeTheDevice({
        'pid:42': { error: 'PGN not supported' },
        'pid:40': 'silent'
      })
      const pending = call('post', '/api/device/probe')
      await vi.advanceTimersByTimeAsync(60_000)
      const response = await pending

      expect(response.body).toMatchObject({ configurable: 'yes', interrupted: false })
      expect((await call('get', '/api/device')).body).toMatchObject({
        probe: { configurable: 'yes' }
      })

      const settings = (await call('get', '/api/settings')).body as {
        settings: { id: string; available: string }[]
      }
      const available = (id: string) => settings.settings.find((s) => s.id === id)?.available

      expect(available('speedCurve')).toBe('yes')
      expect(available('temperatureOffset')).toBe('no')
      expect(available('speedOfSound')).toBe('unknown')
    })

    it('runs one probe for two requests that overlap', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      respondLikeTheDevice()
      const first = call('post', '/api/device/probe')
      const second = call('post', '/api/device/probe')
      await vi.advanceTimersByTimeAsync(60_000)

      expect((await first).body).toEqual((await second).body)
      expect(sent).toHaveLength(PROBED.length + 1)
    })
  })

  describe('event stream', () => {
    const OTHER: TreeDevice = {
      address: 30,
      uniqueNumber: 654321,
      manufacturerCode: 'Airmar',
      modelId: 'DST800'
    }

    /** Open `GET /api/events`; `leave` closes the client side, as a browser tab would. */
    const openStream = () => {
      const req = Object.assign(new EventEmitter(), { params: {}, query: {} })
      const stream = createStreamResponse()
      void route('get', '/api/events').handler(req, stream.res)
      return { stream, leave: () => req.emit('close') }
    }
    const named = (stream: ReturnType<typeof createStreamResponse>, event: string) =>
      stream.events().filter((e) => e.event === event)

    it('answers 503 before start', () => {
      expect(openStream().stream.status).toBe(503)
    })

    it('opens an uncompressed stream and sends the device list and the selected device first', () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const { stream } = openStream()

      expect(stream.headers['Content-Type']).toBe('text/event-stream')
      expect(stream.headers['Cache-Control']).toContain('no-transform')
      expect(stream.events().map((e) => e.event)).toEqual(['devices', 'device'])
      expect(stream.events()[1].data).toMatchObject({
        selected: DST_KEY,
        location: { state: 'present', address: 22 }
      })
    })

    it('pushes the selected device when it is first heard', () => {
      start({ selectedDevice: DST_KEY })
      const { stream } = openStream()

      expect(named(stream, 'device').at(-1)?.data).toMatchObject({
        location: { state: 'waiting' }
      })

      heard()

      expect(named(stream, 'device').at(-1)?.data).toMatchObject({
        location: { state: 'present', address: 22 }
      })
    })

    it('pushes the device list when another device is heard', () => {
      app.sources = sourcesTree([DST, OTHER])
      start({ selectedDevice: DST_KEY })
      heard()
      const { stream } = openStream()
      const devices = named(stream, 'devices').length

      deliver(pgnReply(PGN.distanceLog, { src: OTHER.address }))

      expect(named(stream, 'devices')).toHaveLength(devices + 1)
    })

    it('pushes the device list when a model arrives after the claim', async () => {
      app.sources = sourcesTree([{ ...DST, modelId: undefined }])
      start({ selectedDevice: DST_KEY })
      heard()
      const { stream } = openStream()
      app.sources = sourcesTree([DST])
      await vi.advanceTimersByTimeAsync(1_000)

      expect(named(stream, 'devices').at(-1)?.data).toMatchObject({
        candidates: [{ modelId: 'DST800' }]
      })
    })

    it('pushes to every open console, and keeps pushing to the rest when one leaves', () => {
      app.sources = sourcesTree([DST, OTHER])
      start({ selectedDevice: DST_KEY })
      const first = openStream()
      const second = openStream()
      heard()

      expect(named(first.stream, 'device').at(-1)?.data).toMatchObject({
        location: { state: 'present' }
      })
      expect(named(second.stream, 'device').at(-1)?.data).toMatchObject({
        location: { state: 'present' }
      })

      first.leave()
      const devices = named(second.stream, 'devices').length
      deliver(pgnReply(PGN.distanceLog, { src: OTHER.address }))

      expect(named(second.stream, 'devices')).toHaveLength(devices + 1)
    })

    it('pushes each write with its setting, qualifier and result', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const { stream } = openStream()
      const pending = call('put', '/api/settings/:id', {
        params: { id: 'depthOffset' },
        body: { value: 0.35 }
      })
      await flush()
      deliver(acknowledge({ acknowledgedPgn: PGN.waterDepth }, from))
      await flush()
      deliver(depthReply(0.35))
      await pending

      expect(named(stream, 'setting').at(-1)?.data).toEqual({
        id: 'depthOffset',
        qualifier: null,
        operation: 'write',
        result: (await pending).body
      })
    })

    it('pushes each read with the qualifier it named', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const { stream } = openStream()
      const pending = call('get', '/api/settings/:id', {
        params: { id: 'temperatureOffset' },
        query: { qualifier: '1' }
      })
      await vi.advanceTimersByTimeAsync(60_000)
      await pending

      expect(named(stream, 'setting').at(-1)?.data).toMatchObject({
        id: 'temperatureOffset',
        qualifier: 1,
        operation: 'read',
        result: { status: 'unknown' }
      })
    })

    it('does not push a request refused before the bus', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const { stream } = openStream()
      await call('put', '/api/settings/:id', {
        params: { id: 'speedOfSound' },
        body: { value: 2000 }
      })

      expect(named(stream, 'setting')).toHaveLength(0)
    })

    it('pushes a new selection', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const { stream } = openStream()
      await call('put', '/api/device', { body: { device: null } })

      expect(named(stream, 'device').at(-1)?.data).toEqual({
        selected: null,
        location: null,
        probe: null
      })
    })

    it('pushes the selected device once a probe completes', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      respondLikeTheDevice()
      const { stream } = openStream()
      const pending = call('post', '/api/device/probe')
      // Well inside the presence window, so no change of location sends it.
      await vi.advanceTimersByTimeAsync(1_000)
      await pending

      expect(named(stream, 'device').at(-1)?.data).toMatchObject({
        location: { state: 'present' },
        probe: { configurable: 'yes' }
      })
    })

    it('stops writing to a client that has gone', async () => {
      start({ selectedDevice: DST_KEY })
      const { stream, leave } = openStream()
      const written = stream.chunks.length
      leave()
      heard()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(stream.chunks).toHaveLength(written)
    })

    it('keeps an idle stream open with a comment line', async () => {
      start({ selectedDevice: DST_KEY })
      const { stream } = openStream()
      await vi.advanceTimersByTimeAsync(60_000)

      expect(stream.chunks.some((c) => c.startsWith(':'))).toBe(true)
    })

    it('ends every stream when the plugin stops', async () => {
      start({ selectedDevice: DST_KEY })
      const { stream } = openStream()
      await started.stop()

      expect(stream.ended).toBe(true)
    })
  })

  describe('stopping', () => {
    it('stops listening to the bus and answers 503', async () => {
      start({ selectedDevice: DST_KEY })
      heard()

      expect(app.events.listenerCount('N2KAnalyzerOut')).toBeGreaterThan(0)

      await started.stop()

      expect(app.events.listenerCount('N2KAnalyzerOut')).toBe(0)
      expect((await call('get', '/api/device')).status).toBe(503)
    })

    it('closes the previous runtime when started again without a stop', () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const listening = app.events.listenerCount('N2KAnalyzerOut')
      start({ selectedDevice: DST_KEY })
      heard()

      expect(app.events.listenerCount('N2KAnalyzerOut')).toBe(listening)
    })
  })
})
