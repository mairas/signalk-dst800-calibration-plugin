import type { Candidate, Location } from './devices/registry.js'
import type { ProbeResult } from './devices/probe.js'
import type { ReadResult, WriteResult } from './settings/operations.js'
import type { Qualifier } from './settings/registry.js'

export type { Candidate, Location } from './devices/registry.js'
export type { ProbeResult } from './devices/probe.js'
export type { ReadResult, WriteResult } from './settings/operations.js'

/** Widths of the two Address Claim NAME fields a device key is made of. */
export const UNIQUE_NUMBER_BITS = 21
export const MANUFACTURER_CODE_BITS = 11

/**
 * A device is keyed by manufacturer code and unique number, both from the
 * Address Claim. Not by source address, which changes, and not by the full
 * NAME, whose instance fields this plugin's own EEPROM restore rewrites.
 */
export interface DeviceKey {
  manufacturerCode: number
  uniqueNumber: number
}

/**
 * Plugin configuration.
 *
 * The device is authoritative for everything it can store, so this holds only
 * what the device cannot: which device the console is pointed at.
 */
export interface PluginConfig {
  selectedDevice?: DeviceKey
}

/*
 * Response bodies, shared so the plugin and the webapp cannot drift. The
 * reads and writes of a setting answer `ReadResult` and `WriteResult`.
 */

/** Body of `GET /api/health`. */
export interface HealthResponse {
  running: boolean
  selectedDevice: DeviceKey | null
}

/** Body of `GET /api/devices`. */
export interface DevicesResponse {
  candidates: Candidate[]
}

/** Body of `GET` and `PUT /api/device`. */
export interface DeviceResponse {
  selected: DeviceKey | null
  /** Null when no device is selected. */
  location: Location | null
  /** The last complete probe of the selected device. */
  probe: ProbeResult | null
}

/** A setting as the console lists it. */
export interface SettingInfo {
  id: string
  requirement: string
  readable: boolean
  writable: boolean
  requiresLevel1: boolean
  qualifiers: readonly Qualifier[] | null
  /**
   * What the last probe found: `yes`, `no`, or `unknown` when it went
   * unanswered, was never probed, or is not a probed capability.
   */
  available: 'yes' | 'no' | 'unknown'
}

/** Body of `GET /api/settings`. */
export interface SettingsResponse {
  settings: SettingInfo[]
}

/** A read or write of a setting, pushed to every open console once it completes. */
export interface SettingEvent {
  id: string
  qualifier: number | null
  operation: 'read' | 'write'
  result: ReadResult | WriteResult
}

/** An event on `GET /api/events`: `type` is the event name, `data` its body. */
export type ServerEvent =
  | { type: 'devices'; data: DevicesResponse }
  | { type: 'device'; data: DeviceResponse }
  | { type: 'setting'; data: SettingEvent }

const isField = (value: unknown, bits: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** bits

/**
 * The device key in `value`, or null. Copies the two fields, so nothing else
 * a client sent reaches the stored configuration.
 */
export function deviceKeyOf(value: unknown): DeviceKey | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { manufacturerCode, uniqueNumber } = value as Record<string, unknown>
  return isField(manufacturerCode, MANUFACTURER_CODE_BITS) &&
    isField(uniqueNumber, UNIQUE_NUMBER_BITS)
    ? { manufacturerCode, uniqueNumber }
    : null
}

/**
 * Narrow the server's stored options into a PluginConfig.
 *
 * The server JSON-parses the config file without checking it against the
 * schema, so a hand-edited or stale file reaches the plugin unvalidated. A
 * `selectedDevice` that is not a complete DeviceKey is dropped rather than
 * passed on as a value whose declared type it does not satisfy.
 */
export function parsePluginConfig(options: unknown): PluginConfig {
  if (typeof options !== 'object' || options === null) {
    return {}
  }
  const selectedDevice = deviceKeyOf((options as Record<string, unknown>).selectedDevice)
  return selectedDevice === null ? {} : { selectedDevice }
}
