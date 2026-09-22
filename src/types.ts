/**
 * Plugin configuration.
 *
 * The device is authoritative for everything it can store, so this holds only
 * what the device cannot: which device the console is pointed at. A device is
 * keyed by manufacturer code and unique number, both from the Address Claim,
 * because the source address changes and the NAME's instance fields are
 * rewritten by this plugin's own EEPROM restore.
 */
export interface DeviceKey {
  manufacturerCode: number
  uniqueNumber: number
}

export interface PluginConfig {
  selectedDevice?: DeviceKey
}
