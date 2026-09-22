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

/** Body of `GET /api/health`. Shared so the plugin and the webapp cannot drift. */
export interface HealthResponse {
  running: boolean
  selectedDevice: DeviceKey | null
}

function isDeviceKey(value: unknown): value is DeviceKey {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.manufacturerCode === 'number' &&
    Number.isFinite(candidate.manufacturerCode) &&
    typeof candidate.uniqueNumber === 'number' &&
    Number.isFinite(candidate.uniqueNumber)
  )
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
  const { selectedDevice } = options as Record<string, unknown>
  return isDeviceKey(selectedDevice) ? { selectedDevice } : {}
}
