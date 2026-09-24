/**
 * The console's REST API.
 *
 * Routes that answer from what the plugin already holds are registered
 * through `router.access('readonly')`, so a read-only login can watch the
 * console. Every route that puts a frame on the bus keeps the plugin default,
 * which is admin when server security is enabled: reading a setting too,
 * because a read of a Level 1 setting sends the unlock, and a refused unlock
 * counts toward the two that make Level 1 unavailable for 15 minutes. Never
 * widen these: the reset and restore routes reboot the sensor and wipe its
 * EEPROM.
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
import { masterReset, resetEeprom } from '../protocol/codec.js'
import type { OutgoingRaw } from '../protocol/messages.js'
import { EepromResetOption } from '../protocol/pids.js'
import type { ConsoleRuntime } from '../runtime.js'
import type { EventStream } from './events.js'
import { readSetting, writeSetting } from '../settings/operations.js'
import { readPgns, writeInterval, writePriority } from '../settings/pgnIntervals.js'
import { MAX_PGN } from '../protocol/pids.js'
import { SETTINGS, isSettingId, type AnySetting } from '../settings/registry.js'
import {
  deviceKeyOf,
  type DeviceKey,
  type ServerEvent,
  type SettingInfo,
  type SettingsResponse
} from '../types.js'

export interface RouteContext {
  runtime(): ConsoleRuntime | null
  /** Persist the selection, then point the running console at it. */
  select(key: DeviceKey | null): Promise<void>
  /** The open consoles. */
  events: EventStream
  /** Push `event` to the open consoles, and act on what it says about simulate mode. */
  publish(event: ServerEvent): void
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
 * The EEPROM sections a restore may name. The unique number is left out: it
 * is half of the key the console follows the device by.
 */
const RESTORE_OPTIONS = {
  all: EepromResetOption.All,
  priorities: EepromResetOption.Priorities,
  updateRates: EepromResetOption.UpdateRates,
  prioritiesAndUpdateRates: EepromResetOption.PrioritiesAndUpdateRates
} as const

export const RESTORE_OPTION_NAMES = Object.keys(RESTORE_OPTIONS)

function restoreOptionOf(body: unknown): EepromResetOption | null {
  const name =
    typeof body === 'object' && body !== null ? (body as { option?: unknown }).option : null
  return typeof name === 'string' && Object.hasOwn(RESTORE_OPTIONS, name)
    ? RESTORE_OPTIONS[name as keyof typeof RESTORE_OPTIONS]
    : null
}

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
      res.json(runtime.devicesView())
    }
  })

  readonly.get('/api/device', (_req: Request, res: Response) => {
    const runtime = running(res)
    if (runtime !== null) {
      res.json(runtime.deviceView())
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
    res.json(runtime.deviceView())
  })

  router.post('/api/device/probe', async (_req: Request, res: Response) => {
    const selected = sessionOf(res)
    if (selected !== null) {
      res.json(await selected.runtime.probe(selected.session))
    }
  })

  /** Send `message` to the selected device and follow it through the reboot. */
  const restart = async (res: Response, message: (address: number) => OutgoingRaw) => {
    const selected = sessionOf(res)
    if (selected === null) {
      return
    }
    const { runtime, session } = selected
    const result = await runtime.restart(session, message(session.address))
    if (result.status !== 'notSent') {
      context.publish({ type: 'reset', data: result })
    }
    res.json(result)
  }

  router.post('/api/device/reset', (_req: Request, res: Response) => restart(res, masterReset))

  router.post('/api/device/restore', async (req: Request, res: Response) => {
    const option = restoreOptionOf(req.body)
    if (option === null) {
      error(res, 400, `Send { "option": one of ${RESTORE_OPTION_NAMES.join(', ')} }`)
      return
    }
    await restart(res, (address) => resetEeprom(address, option))
  })

  router.get('/api/pgns', async (_req: Request, res: Response) => {
    const selected = sessionOf(res)
    if (selected === null) {
      return
    }
    const { runtime, session } = selected
    const key = runtime.selected
    res.json(await readPgns(session, key === null ? undefined : runtime.probes.get(key)))
  })

  router.put('/api/pgns/:pgn', async (req: Request, res: Response) => {
    const raw = String(req.params.pgn)
    const body: unknown = req.body
    const fields =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
    const interval = 'intervalMs' in fields
    if (!/^\d+$/.test(raw) || Number(raw) > MAX_PGN || interval === 'priority' in fields) {
      error(res, 400, 'Send { "intervalMs": n } or { "priority": n } to /api/pgns/<pgn>')
      return
    }
    const selected = sessionOf(res)
    if (selected === null) {
      return
    }
    const { runtime, session } = selected
    const pgn = Number(raw)
    const result = interval
      ? await writeInterval(runtime.pgnContext(session), pgn, fields.intervalMs)
      : await writePriority(session, pgn, fields.priority)
    if (result.status === 'invalid') {
      error(res, 400, result.reason)
      return
    }
    res.json(result)
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
    context.publish({
      type: 'setting',
      data: { id, qualifier: qualifier.value ?? null, operation: 'read', result }
    })
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
    context.publish({
      type: 'setting',
      data: { id, qualifier: qualifier.value ?? null, operation: 'write', result }
    })
    res.json(result)
  })

  readonly.get('/api/events', (req: Request, res: Response) => {
    const runtime = running(res)
    if (runtime !== null) {
      context.events.attach(req, res, [
        { type: 'devices', data: runtime.devicesView() },
        { type: 'device', data: runtime.deviceView() }
      ])
    }
  })
}
