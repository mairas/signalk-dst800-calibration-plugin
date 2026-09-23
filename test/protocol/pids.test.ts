import { describe, it, expect } from 'vitest'
import { AirmarCommandValues } from '@canboat/ts-pgns'
import { AirmarPid, CALIBRATE_SPEED_NAME, pidFromName, pidName } from '../../src/protocol/pids.js'

/**
 * The table is pinned against canboat's own lookup, not against a copy of
 * itself. These strings are what canboatjs puts in a reply's `proprietaryId`,
 * so a rename upstream must break this suite rather than the device.
 */
const NAMED = [
  AirmarPid.SimulateMode,
  AirmarPid.CalibrateDepth,
  AirmarPid.CalibrateSpeed,
  AirmarPid.CalibrateTemperature,
  AirmarPid.SpeedFilter,
  AirmarPid.TemperatureFilter,
  AirmarPid.Nmea2000Options
]

describe('proprietary ID names', () => {
  it.each(NAMED)('names PID %i exactly as canboat does', (pid) => {
    const name = pidName(pid)

    expect(name).not.toBeNull()
    expect(AirmarCommandValues[name ?? '']).toBe(pid)
    expect(pidFromName(name)).toBe(pid)
  })

  it('has no name for the two PIDs canboat does not name', () => {
    for (const pid of [AirmarPid.MasterReset, AirmarPid.ResetEeprom]) {
      expect(pidName(pid)).toBeNull()
      expect(Object.values(AirmarCommandValues)).not.toContain(pid)
    }
  })

  it('reads a numeric proprietary ID, which canboatjs reports when it cannot name one', () => {
    expect(pidFromName(AirmarPid.MasterReset)).toBe(AirmarPid.MasterReset)
    expect(pidFromName(AirmarPid.ResetEeprom)).toBe(AirmarPid.ResetEeprom)
  })

  it('rejects a value that names no PID', () => {
    expect(pidFromName('Calibrate Compass')).toBeNull()
    expect(pidFromName(undefined)).toBeNull()
    expect(pidFromName(9999)).toBeNull()
    expect(pidFromName(41.5)).toBeNull()
  })

  it('exposes the Calibrate Speed name as a string, never an empty fallback', () => {
    expect(CALIBRATE_SPEED_NAME).toBe('Calibrate Speed')
    expect(AirmarCommandValues[CALIBRATE_SPEED_NAME]).toBe(AirmarPid.CalibrateSpeed)
  })
})
