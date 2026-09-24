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
import { acknowledge, addressClaim, pgnListReply, pgnReply, pidReply } from '../helpers/replies.js'
import { sourcesTree, type TreeDevice } from '../helpers/sources.js'
import { PROBED, capabilityId } from '../../src/devices/probe.js'
import type { DecodedPgn, OutgoingPgn } from '../../src/protocol/messages.js'
import {
  AirmarPid,
  EepromResetOption,
  MASTER_RESET_PAYLOAD,
  PARAM,
  PGN,
  eepromResetPayload
} from '../../src/protocol/pids.js'
import { RESET_CLAIM_TIMEOUT_MS } from '../../src/runtime.js'
import { DEFAULT_TIMEOUT_MS } from '../../src/session/deviceSession.js'
import { SIMULATE_NOTIFICATION_PATH, SIMULATE_REREAD_MS } from '../../src/simulate.js'
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
   * Answer the bus like the device: treat the unlock per `reactions.unlock`,
   * and each probed capability per `reactions`, keyed by `capabilityId`.
   * Anything absent is answered.
   */
  const respondLikeTheDevice = (reactions: Partial<Record<string, Reaction>> = {}) => {
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
      const reaction = (isUnlock ? reactions.unlock : reactions[id]) ?? 'answer'
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

  /** Open `GET /api/events`; `leave` closes the client side, as a browser tab would. */
  const openStream = () => {
    const req = Object.assign(new EventEmitter(), { params: {}, query: {} })
    const stream = createStreamResponse()
    void route('get', '/api/events').handler(req, stream.res)
    return { stream, leave: () => req.emit('close') }
  }
  const named = (stream: ReturnType<typeof createStreamResponse>, event: string) =>
    stream.events().filter((e) => e.event === event)

  describe('access', () => {
    it('lets a read-only login read what the plugin holds, and keeps every route that sends a frame at admin', () => {
      const levels = Object.fromEntries(routes.map((r) => [`${r.method} ${r.path}`, r.access]))

      expect(levels).toEqual({
        'get /api/health': 'readonly',
        'get /api/devices': 'readonly',
        'get /api/device': 'readonly',
        'put /api/device': 'admin',
        'post /api/device/probe': 'admin',
        'post /api/device/reset': 'admin',
        'post /api/device/restore': 'admin',
        'get /api/pgns': 'admin',
        'put /api/pgns/:pgn': 'admin',
        'get /api/settings': 'readonly',
        'get /api/settings/:id': 'admin',
        'put /api/settings/:id': 'admin',
        'get /api/snapshot': 'admin',
        'post /api/snapshot/diff': 'admin',
        'post /api/snapshot/import': 'admin',
        'get /api/events': 'readonly'
      })
    })

    it('documents every route it registers', () => {
      const documented = Object.entries(openApi.paths).flatMap(([path, methods]) =>
        Object.keys(methods).map((method) => `${method} ${path}`)
      )
      const registered = routes
        .filter((r) => r.path !== '/api/health')
        .map((r) => `${r.method} ${r.path.replace(':id', '{id}').replace(':pgn', '{pgn}')}`)

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

  describe('PGN intervals and priorities', () => {
    it('lists what the device transmits, in the documented shape', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const pending = call('get', '/api/pgns')
      await flush()
      deliver(pgnListReply('Transmit PGN list', [PGN.waterDepth], from))
      const response = await pending

      expect(response.body).toEqual({
        status: 'answered',
        pgns: [{ pgn: PGN.waterDepth, minIntervalMs: 50, telemetry: false }]
      })
      expect(propertiesOf(documented('/api/pgns', 'get'))).toEqual(
        expect.arrayContaining(keys(response.body))
      )
    })

    it('sets a priority and reports the device’s acknowledgement', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const pending = call('put', '/api/pgns/:pgn', {
        params: { pgn: String(PGN.speed) },
        body: { priority: 2 }
      })
      await flush()
      deliver(acknowledge({ acknowledgedPgn: PGN.speed }, from))

      expect((await pending).body).toEqual({ status: 'applied' })
    })

    it('sets an interval, times the PGN on the bus, and answers in the documented shape', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const pending = call('put', '/api/pgns/:pgn', {
        params: { pgn: String(PGN.waterDepth) },
        body: { intervalMs: 500 }
      })
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      for (let i = 0; i < 3; i += 1) {
        deliver(depthReply(0.35))
        await vi.advanceTimersByTimeAsync(500)
      }
      const response = await pending

      expect(response.body).toEqual({ status: 'applied', observedIntervalMs: 500 })
      expect(propertiesOf(documented('/api/pgns/{pgn}', 'put'))).toEqual(
        expect.arrayContaining(keys(response.body))
      )
    })

    it('refuses a PGN wider than the 126208 field, which would wrap onto another', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      const response = await call('put', '/api/pgns/:pgn', {
        params: { pgn: String(PGN.speed + 2 ** 24) },
        body: { priority: 2 }
      })

      expect(response.status).toBe(400)
      expect(sent).toHaveLength(0)
    })

    it.each([
      ['both an interval and a priority', { intervalMs: 500, priority: 2 }],
      ['neither', {}],
      ['an interval out of range', { intervalMs: 10 }]
    ])('refuses %s with 400 and sends nothing', async (_name, body) => {
      start({ selectedDevice: DST_KEY })
      heard()
      const response = await call('put', '/api/pgns/:pgn', {
        params: { pgn: String(PGN.waterDepth) },
        body
      })

      expect(response.status).toBe(400)
      expect(sent).toHaveLength(0)
    })
  })

  describe('resetting the device', () => {
    let raw: string[]

    beforeEach(() => {
      raw = []
      app.events.on('nmea2000out', (line: string) => raw.push(line))
    })

    const claim = () => {
      deliver(
        addressClaim({ uniqueNumber: DST.uniqueNumber, manufacturerCode: 'Airmar' }, DST.address)
      )
    }
    /** How many times the device was asked for `pid`. */
    const requestsFor = (pid: number) =>
      sent.filter(
        (m) =>
          m.fields.functionCode === 'Request' &&
          (m.fields.list as { parameter: number; value: number }[]).some(
            (p) => p.parameter === PARAM.proprietaryId && p.value === pid
          )
      ).length
    /** PGN, source and destination of a raw frame line. */
    const addressing = (line: string) => line.split(',').slice(2, 5)

    it('reboots the device, drops its probe, waits for its claim, and probes it again', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      respondLikeTheDevice()
      const probed = call('post', '/api/device/probe')
      await vi.advanceTimersByTimeAsync(60_000)
      await probed
      const { stream } = openStream()
      // Opening the stream reads simulate mode, and this device's PID 35 reply
      // carries no value, so the read holds the queue until it times out.
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      const pending = call('post', '/api/device/reset')
      await flush()

      expect(raw).toHaveLength(1)
      expect(addressing(raw[0])).toEqual([String(PGN.proprietary), '0', '22'])
      expect(raw[0].endsWith(MASTER_RESET_PAYLOAD)).toBe(true)
      expect((await call('get', '/api/device')).body).toMatchObject({ probe: null })

      claim()
      await vi.advanceTimersByTimeAsync(60_000)
      const response = await pending

      expect(response.body).toMatchObject({ status: 'claimed', probe: { configurable: 'yes' } })
      expect(propertiesOf(documented('/api/device/reset', 'post'))).toEqual(
        expect.arrayContaining(keys(response.body))
      )
      expect(named(stream, 'reset').map((e) => e.data)).toEqual([response.body])
    })

    it('probes afresh after the claim, even when a probe was running as the reset went out', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      // Simulate Mode holds the first probe while the reset is queued; POST
      // keeps it running after the reset frame has gone out.
      respondLikeTheDevice({
        'pid:35': 'silent',
        [capabilityId({ kind: 'pgn', pgn: PGN.post })]: 'silent'
      })
      void call('post', '/api/device/probe')
      await flush()
      const pending = call('post', '/api/device/reset')
      while (raw.length === 0) {
        await vi.advanceTimersByTimeAsync(100)
      }
      claim()
      await vi.advanceTimersByTimeAsync(60_000)

      expect((await pending).body).toMatchObject({ status: 'claimed' })
      expect(requestsFor(AirmarPid.CalibrateSpeed)).toBe(2)
    })

    it('sends nothing and tells no console when the device refuses the unlock', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      respondLikeTheDevice({ unlock: { error: 'Access denied' } })
      const { stream } = openStream()
      const pending = call('post', '/api/device/reset')
      await vi.advanceTimersByTimeAsync(60_000)

      expect((await pending).body).toMatchObject({ status: 'notSent' })
      expect(raw).toHaveLength(0)
      expect(named(stream, 'reset')).toHaveLength(0)
    })

    it('keeps no probe that ran across a reset the device never came back from', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      respondLikeTheDevice({
        'pid:35': 'silent',
        [capabilityId({ kind: 'pgn', pgn: PGN.post })]: 'silent'
      })
      void call('post', '/api/device/probe')
      await flush()
      const pending = call('post', '/api/device/reset')
      await vi.advanceTimersByTimeAsync(RESET_CLAIM_TIMEOUT_MS * 2)

      expect((await pending).body).toMatchObject({ status: 'lost' })
      expect((await call('get', '/api/device')).body).toMatchObject({ probe: null })
    })

    it('reports a device that does not announce itself again', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      respondLikeTheDevice()
      const pending = call('post', '/api/device/reset')
      await vi.advanceTimersByTimeAsync(RESET_CLAIM_TIMEOUT_MS)

      expect((await pending).body).toMatchObject({ status: 'lost' })
    })

    it('restores the EEPROM section it names', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      respondLikeTheDevice()
      const pending = call('post', '/api/device/restore', { body: { option: 'updateRates' } })
      await flush()

      expect(raw).toHaveLength(1)
      expect(raw[0].endsWith(eepromResetPayload(EepromResetOption.UpdateRates))).toBe(true)

      claim()
      await vi.advanceTimersByTimeAsync(60_000)

      expect((await pending).body).toMatchObject({ status: 'claimed' })
    })

    it.each([
      ['the unique number, which the console follows the device by', { option: 'uniqueNumber' }],
      ['the numeric option', { option: 0 }],
      ['no option', {}]
    ])('refuses to restore %s, and sends nothing', async (_name, body) => {
      start({ selectedDevice: DST_KEY })
      heard()
      const response = await call('post', '/api/device/restore', { body })

      expect(response.status).toBe(400)
      expect(sent).toHaveLength(0)
      expect(raw).toHaveLength(0)
    })
  })

  describe('snapshots', () => {
    const stored = { depthOffset: 0.35 }

    /**
     * A depth-only device: it refuses every Airmar PID, answers the standard
     * PGNs from fixtures, and stores the depth offset it is sent.
     */
    const depthOnlyDevice = () => {
      stored.depthOffset = 0.35
      app.events.on('nmea2000JsonOut', (message: OutgoingPgn) => {
        const target = Number(message.fields.pgn)
        const list = (message.fields.list ?? []) as { parameter: number; value: number }[]
        queueMicrotask(() => {
          if (message.fields.functionCode === 'Command') {
            if (target === PGN.waterDepth) {
              stored.depthOffset = list.find((p) => p.parameter === 3)?.value ?? NaN
            }
            deliver(acknowledge({ acknowledgedPgn: target }, from))
          } else if (target === PGN.proprietary) {
            deliver(
              acknowledge({ acknowledgedPgn: target, pgnErrorCode: 'PGN not supported' }, from)
            )
          } else if (target === PGN.waterDepth) {
            deliver(depthReply(stored.depthOffset))
          } else {
            deliver(pgnReply(target, from))
          }
        })
      })
    }

    const settle = async <T>(pending: Promise<T>): Promise<T> => {
      await vi.advanceTimersByTimeAsync(60_000)
      return pending
    }

    const exported = async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      depthOnlyDevice()
      return (await settle(call('get', '/api/snapshot'))).body as {
        settings: { id: string; value: unknown }[]
      }
    }

    const commandsTo = (pgn: number) =>
      sent.filter((m) => m.fields.functionCode === 'Command' && Number(m.fields.pgn) === pgn)

    it('probes, then reads every setting the probe confirmed, in the documented shape', async () => {
      const snapshot = await exported()

      expect(snapshot.settings.map((s) => s.id)).toEqual([
        'depthOffset',
        'installationDescription',
        'productInformation',
        'distanceLog'
      ])
      expect(keys(snapshot)).toEqual(propertiesOf(documented('/api/snapshot', 'get')))
    })

    it('finds nothing to change on the device it came from', async () => {
      const snapshot = await exported()

      const diff = await settle(call('post', '/api/snapshot/diff', { body: snapshot }))
      const items = (diff.body as { items: { action: string }[] }).items

      expect(items.map((i) => i.action)).toEqual(['unchanged', 'unchanged', 'excluded', 'excluded'])
      expect(keys(diff.body)).toEqual(propertiesOf(documented('/api/snapshot/diff', 'post')))
      expect(commandsTo(PGN.waterDepth)).toEqual([])
    })

    it('writes the setting that differs and reports what the device stored', async () => {
      const snapshot = await exported()
      const edited = {
        ...snapshot,
        settings: snapshot.settings.map((s) => (s.id === 'depthOffset' ? { ...s, value: 0.5 } : s))
      }

      const response = await settle(call('post', '/api/snapshot/import', { body: edited }))

      expect(response.body).toMatchObject({
        complete: true,
        items: [
          { id: 'depthOffset', action: 'write', outcome: 'applied', result: { stored: 0.5 } },
          { action: 'unchanged' },
          { action: 'excluded' },
          { action: 'excluded' }
        ]
      })
      expect(stored.depthOffset).toBe(0.5)
      expect(commandsTo(PGN.waterDepth)).toHaveLength(1)
      expect(keys(response.body)).toEqual(propertiesOf(documented('/api/snapshot/import', 'post')))
    })

    it('refuses a snapshot of another schema version with 400, before the bus', async () => {
      const snapshot = await exported()
      const before = sent.length

      const response = await call('post', '/api/snapshot/import', {
        body: { ...snapshot, schemaVersion: 99 }
      })

      expect(response.status).toBe(400)
      expect(sent).toHaveLength(before)
    })
  })

  describe('simulate mode', () => {
    let simulating: boolean
    /** The address the simulated sensor answers from. */
    let replyFrom: number

    const simulateReply = (): DecodedPgn => ({
      pgn: PGN.proprietary,
      src: replyFrom,
      dst: GATEWAY,
      fields: {
        manufacturerCode: 'Airmar',
        industryCode: 'Marine Industry',
        proprietaryId: 'Simulate Mode',
        simulateMode: simulating ? 'On' : 'Off'
      }
    })
    /** Grant the unlock, and answer every other request with the simulate state. */
    const answerSimulate = () => {
      app.events.on('nmea2000JsonOut', (message: OutgoingPgn) => {
        const unlock = Number(message.fields.pgn) === PGN.accessLevel
        queueMicrotask(() => {
          deliver(
            unlock
              ? acknowledge({ acknowledgedPgn: PGN.accessLevel }, { src: replyFrom, dst: GATEWAY })
              : simulateReply()
          )
        })
      })
    }
    const readSimulate = async () => {
      const pending = call('get', '/api/settings/:id', { params: { id: 'simulateMode' } })
      await flush()
      return pending
    }
    /** The deltas that carry the simulate notification. */
    const notices = () =>
      app.deltas.filter((d) => JSON.stringify(d).includes(SIMULATE_NOTIFICATION_PATH))
    const notified = (state: string) => ({
      updates: [{ values: [{ path: SIMULATE_NOTIFICATION_PATH, value: { state } }] }]
    })

    beforeEach(() => {
      replyFrom = DST.address
      start({ selectedDevice: DST_KEY })
      heard()
      answerSimulate()
    })

    it('raises a notification while the device simulates, and clears it once it stops', async () => {
      simulating = true
      await readSimulate()

      expect(notices()).toHaveLength(1)
      expect(notices()[0]).toMatchObject(notified('warn'))

      simulating = false
      await readSimulate()
      await readSimulate()

      expect(notices()).toHaveLength(2)
      expect(notices()[1]).toMatchObject(notified('normal'))
    })

    it('keeps the warning while the sensor that raised it simulates, whatever another reports', async () => {
      const second: TreeDevice = { ...DST, address: 30, uniqueNumber: 654321 }
      simulating = true
      await readSimulate()
      app.sources = sourcesTree([DST, second])
      await call('put', '/api/device', {
        body: { device: { manufacturerCode: 135, uniqueNumber: second.uniqueNumber } }
      })
      deliver(pgnReply(PGN.distanceLog, { src: second.address }))
      replyFrom = second.address
      simulating = false
      await readSimulate()

      expect(notices()).toHaveLength(1)
      expect(notices()[0]).toMatchObject(notified('warn'))
    })

    it('reads simulate mode as soon as a console opens, so its warning is not a minute late', async () => {
      simulating = true
      const { stream } = openStream()
      await vi.advanceTimersByTimeAsync(1_000)

      expect(named(stream, 'setting').at(-1)?.data).toMatchObject({
        id: 'simulateMode',
        result: { status: 'answered', value: true }
      })
    })

    it('reads simulate mode once for consoles that open while a read is still waiting', async () => {
      start({ selectedDevice: DST_KEY })
      heard()
      app.events.removeAllListeners('nmea2000JsonOut')
      app.events.on('nmea2000JsonOut', (message: OutgoingPgn) => sent.push(message))
      const before = sent.length

      for (let i = 0; i < 5; i += 1) {
        openStream()
      }
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS * 8)

      expect(sent.length - before).toBe(1)
    })

    it('re-reads simulate mode while a console is open, and only then', async () => {
      simulating = true
      await vi.advanceTimersByTimeAsync(SIMULATE_REREAD_MS)

      expect(sent).toHaveLength(0)

      const { stream, leave } = openStream()
      await vi.advanceTimersByTimeAsync(SIMULATE_REREAD_MS)

      expect(named(stream, 'setting').at(-1)?.data).toMatchObject({
        id: 'simulateMode',
        operation: 'read',
        result: { status: 'answered', value: true }
      })
      expect(notices()).toHaveLength(1)
      expect(notices()[0]).toMatchObject(notified('warn'))

      leave()
      const before = sent.length
      await vi.advanceTimersByTimeAsync(SIMULATE_REREAD_MS)

      expect(sent).toHaveLength(before)
    })
  })

  describe('event stream', () => {
    const OTHER: TreeDevice = {
      address: 30,
      uniqueNumber: 654321,
      manufacturerCode: 'Airmar',
      modelId: 'DST800'
    }

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
      const { stream } = openStream()
      heard()
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
        access: null,
        probe: null
      })
    })

    it('pushes the selected device once a probe completes', async () => {
      start({ selectedDevice: DST_KEY })
      const { stream } = openStream()
      heard()
      respondLikeTheDevice()
      const pending = call('post', '/api/device/probe')
      // Well inside the presence window, so no change of location sends it.
      await vi.advanceTimersByTimeAsync(1_000)
      await pending

      expect(named(stream, 'device').at(-1)?.data).toMatchObject({
        location: { state: 'present' },
        probe: { configurable: 'yes' }
      })
    })

    it('pushes the selected device when the access level changes, with the time left', async () => {
      start({ selectedDevice: DST_KEY })
      const { stream } = openStream()
      heard()
      const before = named(stream, 'device').length
      expect(named(stream, 'device').at(-1)?.data).toMatchObject({ access: { state: 'locked' } })

      const pending = call('get', '/api/settings/:id', { params: { id: 'speedOfSound' } })
      await flush()
      deliver(acknowledge({ acknowledgedPgn: PGN.accessLevel }, from))
      await flush()

      expect(named(stream, 'device')).toHaveLength(before + 1)
      expect(named(stream, 'device').at(-1)?.data).toMatchObject({
        access: { state: 'granted', expiresInMs: expect.any(Number) as unknown }
      })
      await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS)
      await pending
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
