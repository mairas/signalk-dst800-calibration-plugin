/**
 * The console's REST API.
 *
 * Routes that answer from what the plugin already holds are registered
 * through `router.access('readonly')`, so a read-only login can watch the
 * console. Every route that puts a frame on the bus keeps the plugin default,
 * which is admin when server security is enabled: reading a setting too,
 * because a read of a Level 1 setting sends the unlock, and a refused unlock
 * counts toward the two that make Level 1 unavailable for 15 minutes. Never
 * widen these: later routes reboot the sensor and wipe its EEPROM.
 *
 * Device outcomes, including refusals and timeouts, answer 200 with the
 * outcome in the body, because the console needs the device's reason to show
 * it. Only a request the plugin cannot act on gets an error status: 400 for
 * input it refused before the bus, 404 for an unknown setting, 409 when no
 * device is selected, 503 while the plugin is stopped or the device has not
 * been heard, and 500 when the selection could not be saved.
 */

import type { Request, Response } from 'express'
import type { PluginRouter } from '@signalk/server-api'
import type { CapabilityState } from '../devices/probe.js'
import { capabilityId } from '../devices/probe.js'
import type { ConsoleRuntime } from '../runtime.js'
import { readSetting, writeSetting } from '../settings/operations.js'
import { SETTINGS, isSettingId, type AnySetting } from '../settings/registry.js'
import {
  deviceKeyOf,
  type DeviceKey,
  type DeviceResponse,
  type DevicesResponse,
  type SettingInfo,
  type SettingsResponse
} from '../types.js'

export interface RouteContext {
  runtime(): ConsoleRuntime | null
  /** Persist the selection, then point the running console at it. */
  select(key: DeviceKey | null): Promise<void>
}

const NOT_RUNNING = 'The plugin is not running'
const NO_DEVICE = 'No device is selected'
const NOT_PRESENT = 'The device has not been heard at its address'

const AVAILABLE: Record<CapabilityState['state'], SettingInfo['available']> = {
  supported: 'yes',
  rejected: 'no',
  noAnswer: 'unknown'
}

const error = (res: Response, status: number, message: string): void => {
  res.status(status).json({ error: message })
}

const BAD_QUALIFIER = 'The qualifier must be a non-negative integer'

/**
 * A qualifier from the query string or the body: absent, or a non-negative
 * integer. Whether the setting takes that qualifier is the registry's check.
 */
function qualifierOf(value: unknown): { ok: true; value: number | undefined } | { ok: false } {
  if (value === undefined) {
    return { ok: true, value: undefined }
  }
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value
  return typeof parsed === 'number' && Number.isInteger(parsed) && parsed >= 0
    ? { ok: true, value: parsed }
    : { ok: false }
}

function settingInfo(entry: AnySetting, runtime: ConsoleRuntime): SettingInfo {
  const key = runtime.selected
  const result = key === null ? undefined : runtime.probes.get(key)
  const capability = entry.capability
  const state =
    capability === null
      ? undefined
      : result?.capabilities.find((c) => capabilityId(c.capability) === capabilityId(capability))
          ?.result.state
  return {
    id: entry.id,
    requirement: entry.requirement,
    readable: entry.readable,
    writable: entry.writable,
    requiresLevel1: entry.requiresLevel1,
    qualifiers: entry.qualifiers ?? null,
    available: state === undefined ? 'unknown' : AVAILABLE[state]
  }
}

function deviceBody(runtime: ConsoleRuntime): DeviceResponse {
  const key = runtime.selected
  return {
    selected: key,
    location: runtime.location,
    probe: key === null ? null : (runtime.probes.get(key) ?? null)
  }
}

export function registerRoutes(router: PluginRouter, context: RouteContext): void {
  const readonly = router.access('readonly')

  /** The running console, or a 503 already sent. */
  const running = (res: Response): ConsoleRuntime | null => {
    const runtime = context.runtime()
    if (runtime === null) {
      error(res, 503, NOT_RUNNING)
    }
    return runtime
  }

  /** The running console and the selected device's session, or the right error already sent. */
  const sessionOf = (res: Response) => {
    const runtime = running(res)
    if (runtime === null) {
      return null
    }
    if (runtime.selected === null) {
      error(res, 409, NO_DEVICE)
      return null
    }
    const session = runtime.session
    if (session === null) {
      error(res, 503, NOT_PRESENT)
      return null
    }
    return { runtime, session }
  }

  readonly.get('/api/devices', (_req: Request, res: Response) => {
    const runtime = running(res)
    if (runtime !== null) {
      const body: DevicesResponse = { candidates: runtime.registry.candidates() }
      res.json(body)
    }
  })

  readonly.get('/api/device', (_req: Request, res: Response) => {
    const runtime = running(res)
    if (runtime !== null) {
      res.json(deviceBody(runtime))
    }
  })

  router.put('/api/device', async (req: Request, res: Response) => {
    const body: unknown = req.body
    const sent =
      typeof body === 'object' && body !== null
        ? (body as Record<string, unknown>).device
        : undefined
    const device = sent === null ? null : deviceKeyOf(sent)
    if (sent !== null && device === null) {
      error(
        res,
        400,
        'Send { "device": { "manufacturerCode", "uniqueNumber" } }, or { "device": null }'
      )
      return
    }
    const runtime = running(res)
    if (runtime === null) {
      return
    }
    try {
      await context.select(device)
    } catch (failure) {
      error(res, 500, `The selection could not be saved: ${String(failure)}`)
      return
    }
    res.json(deviceBody(runtime))
  })

  router.post('/api/device/probe', async (_req: Request, res: Response) => {
    const selected = sessionOf(res)
    if (selected !== null) {
      res.json(await selected.runtime.probe(selected.session))
    }
  })

  readonly.get('/api/settings', (_req: Request, res: Response) => {
    const runtime = running(res)
    if (runtime !== null) {
      const body: SettingsResponse = {
        settings: SETTINGS.map((entry) => settingInfo(entry, runtime))
      }
      res.json(body)
    }
  })

  router.get('/api/settings/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id)
    if (!isSettingId(id)) {
      error(res, 404, `There is no setting called ${id}`)
      return
    }
    const qualifier = qualifierOf(req.query.qualifier)
    if (!qualifier.ok) {
      error(res, 400, BAD_QUALIFIER)
      return
    }
    const selected = sessionOf(res)
    if (selected === null) {
      return
    }
    const result = await readSetting(selected.session, id, qualifier.value)
    if (result.status === 'invalid') {
      error(res, 400, result.reason)
      return
    }
    res.json(result)
  })

  router.put('/api/settings/:id', async (req: Request, res: Response) => {
    const id = String(req.params.id)
    if (!isSettingId(id)) {
      error(res, 404, `There is no setting called ${id}`)
      return
    }
    const body: unknown = req.body
    if (typeof body !== 'object' || body === null || !('value' in body)) {
      error(res, 400, 'Send { "value": ..., "qualifier"?: n }')
      return
    }
    const { value } = body
    const qualifier = qualifierOf((body as { qualifier?: unknown }).qualifier)
    if (!qualifier.ok) {
      error(res, 400, BAD_QUALIFIER)
      return
    }
    const selected = sessionOf(res)
    if (selected === null) {
      return
    }
    const result = await writeSetting(selected.session, id, value, qualifier.value)
    if (result.status === 'invalid') {
      error(res, 400, result.reason)
      return
    }
    res.json(result)
  })
}
