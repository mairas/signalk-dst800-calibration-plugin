import { describe, it, expect } from 'vitest'
import { AirmarPid, pidFromName, pidName } from '../../src/protocol/pids.js'

describe('proprietary ID names', () => {
  it('maps every named PID back from the string canboatjs reports', () => {
    for (const [name, pid] of [
      ['Simulate Mode', AirmarPid.SimulateMode],
      ['Calibrate Depth', AirmarPid.CalibrateDepth],
      ['Calibrate Speed', AirmarPid.CalibrateSpeed],
      ['Calibrate Temperature', AirmarPid.CalibrateTemperature],
      ['Speed Filter', AirmarPid.SpeedFilter],
      ['Temperature Filter', AirmarPid.TemperatureFilter],
      ['NMEA 2000 options', AirmarPid.Nmea2000Options]
    ] as const) {
      expect(pidFromName(name)).toBe(pid)
      expect(pidName(pid)).toBe(name)
    }
  })

  it('reads a numeric proprietary ID, which canboatjs reports when it cannot name one', () => {
    expect(pidFromName(AirmarPid.MasterReset)).toBe(AirmarPid.MasterReset)
    expect(pidFromName(AirmarPid.ResetEeprom)).toBe(AirmarPid.ResetEeprom)
  })

  it('has no name for the two PIDs canboatjs cannot name', () => {
    expect(pidName(AirmarPid.MasterReset)).toBeNull()
    expect(pidName(AirmarPid.ResetEeprom)).toBeNull()
  })

  it('rejects a value that names no PID', () => {
    expect(pidFromName('Calibrate Compass')).toBeNull()
    expect(pidFromName(undefined)).toBeNull()
    expect(pidFromName(9999)).toBeNull()
    expect(pidFromName(41.5)).toBeNull()
  })
})
