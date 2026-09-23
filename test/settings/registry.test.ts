import { describe, it, expect } from 'vitest'
import { decode, payload } from '../helpers/canboat.js'
import { curveReply } from '../helpers/replies.js'
import {
  SETTINGS,
  buildCommand,
  buildRead,
  isSettingId,
  setting,
  type SettingId
} from '../../src/settings/registry.js'
import type { DecodedPgn, OutgoingPgn } from '../../src/protocol/messages.js'
import { AirmarPid, PGN, pidName } from '../../src/protocol/pids.js'

const DEVICE = 22

const AIRMAR = { manufacturerCode: 'Airmar', industryCode: 'Marine Industry' }

/** A device reply, encoded and parsed back so field names are canboat's own. */
const reply = (pgn: number, fields: Record<string, unknown>): DecodedPgn => ({
  ...decode({ pgn, dst: 255, prio: 7, fields }),
  src: DEVICE
})

const pidReply = (pid: AirmarPid, fields: Record<string, unknown>): DecodedPgn =>
  reply(PGN.proprietary, { ...AIRMAR, proprietaryId: pidName(pid), ...fields })

/** Build a command from outside input, failing the test on a validation error. */
const commandFor = (id: SettingId, input: unknown, qualifier?: number): OutgoingPgn => {
  const built = buildCommand(id, DEVICE, input, qualifier)
  if (!built.ok) {
    throw new Error(built.error)
  }
  return built.value.message
}

const requestFor = (id: SettingId, qualifier?: number): OutgoingPgn => {
  const spec = buildRead(id, DEVICE, qualifier)
  if (!spec.ok) {
    throw new Error(spec.error)
  }
  return spec.value.message
}

const readValue = (id: SettingId, message: DecodedPgn, qualifier?: number): unknown => {
  const spec = buildRead(id, DEVICE, qualifier)
  if (!spec.ok) {
    throw new Error(spec.error)
  }
  return spec.value.match(message)
}

describe('the settings registry', () => {
  it('describes every capability in the plan once', () => {
    expect(SETTINGS.map((s) => s.id)).toEqual([
      'speedCurve',
      'temperatureOffset',
      'depthOffset',
      'speedOfSound',
      'speedFilter',
      'temperatureFilter',
      'transmissionIntervalOverride',
      'installationDescription',
      'productInformation',
      'distanceLog',
      'simulateMode'
    ])
  })

  /** A valid write for every writable setting, and the source a qualified one needs. */
  const SAMPLE_WRITES: Record<SettingId, { input: unknown; qualifier?: number } | null> = {
    speedCurve: { input: [{ hz: 10, speed: 1 }] },
    temperatureOffset: { input: 0.5, qualifier: 1 },
    depthOffset: { input: 0.3 },
    speedOfSound: { input: 1500 },
    speedFilter: { input: { type: 0 } },
    temperatureFilter: { input: { type: 0 } },
    transmissionIntervalOverride: { input: true },
    installationDescription: { input: { description1: 'Bow' } },
    productInformation: null,
    distanceLog: { input: { tripLog: 0 } },
    simulateMode: { input: false }
  }

  it.each(Object.entries(SAMPLE_WRITES))('addresses the %s command to the device', (id, sample) => {
    if (!isSettingId(id) || sample === null) {
      return
    }
    const built = buildCommand(id, DEVICE, sample.input, sample.qualifier)

    expect(built.ok && built.value.message.dst).toBe(DEVICE)
  })

  it.each(SETTINGS.filter((s) => s.readable).map((s) => s.id))(
    'addresses the %s request to the device',
    (id) => {
      if (!isSettingId(id)) {
        throw new Error(id)
      }
      const read = buildRead(id, DEVICE, setting(id).qualifiers?.[0]?.value)

      expect(read.ok && read.value.message.dst).toBe(DEVICE)
    }
  )

  it.each(Object.entries(SAMPLE_WRITES))(
    'marks %s writable only when it builds a command',
    (id, sample) => {
      if (!isSettingId(id)) {
        throw new Error(id)
      }

      expect(setting(id).writable).toBe(sample !== null)
    }
  )

  it('lists each setting under its own id', () => {
    for (const s of SETTINGS) {
      expect(isSettingId(s.id) && setting(s.id)).toBe(s)
    }
  })

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'does not take the inherited name %s for a setting',
    (name) => {
      expect(isSettingId(name)).toBe(false)
    }
  )

  it('adds the setting’s access level to its request', () => {
    const read = buildRead('speedOfSound', DEVICE)

    expect(read.ok && read.value.requiresLevel1).toBe(true)
  })

  it.each([
    ['speedCurve', 1],
    ['temperatureOffset', 1],
    ['speedOfSound', 1],
    ['speedFilter', 1],
    ['temperatureFilter', 1],
    ['simulateMode', 1],
    ['transmissionIntervalOverride', 0],
    ['depthOffset', 0],
    ['installationDescription', 0],
    ['distanceLog', 0]
  ] as const)('marks %s as needing Access Level %d as the manual does', (id, level) => {
    expect(setting(id).requiresLevel1).toBe(level === 1)
  })
})

describe('building from outside input', () => {
  it('refuses a qualifier on a setting that takes none', () => {
    expect(buildCommand('speedOfSound', DEVICE, 1500, 1).ok).toBe(false)
    expect(buildRead('speedOfSound', DEVICE, 1).ok).toBe(false)
  })

  it('returns the parsed value with the frame, for the read-back to compare', () => {
    const built = buildCommand('speedOfSound', DEVICE, 1500)

    expect(built.ok && built.value.value).toBe(1500)
  })
})

describe('speed of sound (R12)', () => {
  it('requests PID 40', () => {
    expect(payload(requestFor('speedOfSound'))).toBe(
      '00,00,ef,01,ff,ff,ff,ff,ff,ff,03,01,87,00,03,04,04,28'
    )
  })

  it('reads the stored value', () => {
    expect(
      readValue('speedOfSound', pidReply(AirmarPid.CalibrateDepth, { speedOfSoundMode: 1500 }))
    ).toBe(1500)
  })

  it('writes field 5 at 0.1 m/s', () => {
    expect(payload(commandFor('speedOfSound', 1500))).toBe(
      '01,00,ef,01,f8,04,01,87,00,03,04,04,28,05,98,3a'
    )
  })

  it.each([1349.9, 1650.1, Number.NaN, '1500', null])(
    'rejects %s before it reaches the bus',
    (input) => {
      const parsed = setting('speedOfSound').parse(input)

      expect(parsed.ok).toBe(false)
    }
  )

  it('accepts a stored value that differs by less than the resolution', () => {
    expect(setting('speedOfSound').sameAsStored(1500.04, 1500)).toBe(true)
    expect(setting('speedOfSound').sameAsStored(1500.1, 1500)).toBe(false)
  })
})

describe('temperature offset (R10)', () => {
  it('requests PID 42 for one temperature source', () => {
    expect(payload(requestFor('temperatureOffset', 1))).toBe(
      '00,00,ef,01,ff,ff,ff,ff,ff,ff,04,01,87,00,03,04,04,2a,05,01'
    )
  })

  it('reads the offset of the requested source only', () => {
    const fromWater = pidReply(AirmarPid.CalibrateTemperature, {
      temperatureInstance: 'Onboard Water Sensor',
      temperatureOffset: -0.25
    })

    expect(readValue('temperatureOffset', fromWater, 1)).toBe(-0.25)
    expect(readValue('temperatureOffset', fromWater, 0)).toBeNull()
  })

  it('writes the source in field 5 and the offset in field 7 at 0.001 K', () => {
    expect(payload(commandFor('temperatureOffset', 0.5, 1))).toBe(
      '01,00,ef,01,f8,05,01,87,00,03,04,04,2a,05,01,07,f4,01'
    )
  })

  it('offers the three sources the manual names, with canboat’s names for them', () => {
    expect(setting('temperatureOffset').qualifiers).toEqual([
      { value: 0, label: 'Device Sensor' },
      { value: 1, label: 'Onboard Water Sensor' },
      { value: 2, label: 'Optional Water Sensor' }
    ])
  })

  it('compares an offset at 0.001 K, rounding a negative half step as the encoder does', () => {
    expect(setting('temperatureOffset').sameAsStored(0.2504, 0.25)).toBe(true)
    expect(setting('temperatureOffset').sameAsStored(0.251, 0.25)).toBe(false)
    // canboatjs stores -0.0015 K as -2 steps, not -1.
    expect(setting('temperatureOffset').sameAsStored(-0.0015, -0.002)).toBe(true)
  })

  it.each([9.999, -9.999])('accepts %s K, the limit of the manual’s range', (input) => {
    expect(setting('temperatureOffset').parse(input).ok).toBe(true)
  })

  it.each([
    ['no source', undefined],
    ['a source the manual does not name', 3]
  ])('refuses a write with %s', (_name, source) => {
    const built = buildCommand('temperatureOffset', DEVICE, 0.5, source)

    expect(built.ok).toBe(false)
  })

  it.each([10, -10, Number.POSITIVE_INFINITY])('rejects %s K', (input) => {
    expect(setting('temperatureOffset').parse(input).ok).toBe(false)
  })
})

describe('depth offset (R11)', () => {
  it('reads field 3 of the device’s own water depth', () => {
    expect(
      readValue(
        'depthOffset',
        reply(PGN.waterDepth, { sid: 1, depth: 12.3, offset: 0.35, range: 100 })
      )
    ).toBe(0.35)
  })

  it('commands field 3 of PGN 128267 at 1 mm', () => {
    expect(payload(commandFor('depthOffset', -1.2))).toBe('01,0b,f5,01,f8,01,03,50,fb')
  })

  it.each([32.765, -32.765])('rejects %s m, beyond what the field holds', (input) => {
    expect(setting('depthOffset').parse(input).ok).toBe(false)
  })

  it('accepts the limit of what the field holds', () => {
    expect(setting('depthOffset').parse(32.764).ok).toBe(true)
  })

  it('compares an offset at 1 mm', () => {
    expect(setting('depthOffset').sameAsStored(1.2004, 1.2)).toBe(true)
    expect(setting('depthOffset').sameAsStored(1.201, 1.2)).toBe(false)
  })

  it('does not take a reply of another PGN from the device for its depth', () => {
    expect(readValue('depthOffset', reply(PGN.distanceLog, { log: 1000, tripLog: 20 }))).toBeNull()
  })
})

describe('speed calibration curve (R9)', () => {
  it('writes every point in one command', () => {
    const message = commandFor('speedCurve', [
      { hz: 12.2, speed: 1.93 },
      { hz: 75.0, speed: 5.14 }
    ])

    expect(payload(message)).toBe(
      '01,00,ef,01,f8,08,01,87,00,03,04,04,29,05,02,06,7a,00,07,c1,00,08,ee,02,09,02,02'
    )
  })

  it.each([
    ['an empty curve', []],
    [
      'a descending frequency',
      [
        { hz: 20, speed: 2 },
        { hz: 10, speed: 3 }
      ]
    ],
    ['a point without a speed', [{ hz: 10 }]],
    ['something that is not a list', { hz: 10, speed: 1 }]
  ])('rejects %s', (_name, input) => {
    expect(setting('speedCurve').parse(input).ok).toBe(false)
  })

  it('compares a read-back point by point at 0.1 Hz and 0.01 m/s', () => {
    const asked = [{ hz: 12.24, speed: 1.934 }]

    expect(setting('speedCurve').sameAsStored(asked, [{ hz: 12.2, speed: 1.93 }])).toBe(true)
    expect(setting('speedCurve').sameAsStored(asked, [{ hz: 12.3, speed: 1.93 }])).toBe(false)
    expect(setting('speedCurve').sameAsStored(asked, [{ hz: 12.2, speed: 1.94 }])).toBe(false)
    expect(setting('speedCurve').sameAsStored(asked, [])).toBe(false)
  })

  it('accepts 25 points and refuses 26', () => {
    const curve = (n: number) => Array.from({ length: n }, (_, i) => ({ hz: i + 1, speed: i / 10 }))

    expect(setting('speedCurve').parse(curve(25)).ok).toBe(true)
    expect(setting('speedCurve').parse(curve(26)).ok).toBe(false)
  })

  it('reads a curve whose proprietary ID arrives as a raw number', () => {
    const named = curveReply([{ hz: 10, speed: 1 }])
    const raw: DecodedPgn = { ...named, fields: { ...named.fields, proprietaryId: 41 } }

    expect(readValue('speedCurve', raw)).toEqual([{ hz: 10, speed: 1 }])
  })
})

describe('filters (R13, R14)', () => {
  it.each(['speedFilter', 'temperatureFilter'] as const)(
    'cannot read %s back, because canboatjs cannot decode the reply',
    (id) => {
      expect(buildRead(id, DEVICE)).toEqual({ ok: false, error: `${id} cannot be read back` })
    }
  )

  it('writes an IIR speed filter with its interval and duration', () => {
    expect(
      payload(commandFor('speedFilter', { type: 1, sampleInterval: 0.25, filterDuration: 2 }))
    ).toBe('01,00,ef,01,f8,06,01,87,00,03,04,04,2b,05,01,07,19,00,08,c8,00')
  })

  it('switches the speed filter type alone, keeping each type’s stored parameters', () => {
    expect(payload(commandFor('speedFilter', { type: 1 }))).toBe(
      '01,00,ef,01,f8,04,01,87,00,03,04,04,2b,05,01'
    )
  })

  it.each([0.01, 655.32])('accepts a %s s sample interval, the field’s limits', (seconds) => {
    expect(setting('speedFilter').parse({ type: 0, sampleInterval: seconds }).ok).toBe(true)
  })

  it('writes an unfiltered temperature filter with only its interval', () => {
    expect(payload(commandFor('temperatureFilter', { type: 0, sampleInterval: 1 }))).toBe(
      '01,00,ef,01,f8,05,01,87,00,03,04,04,2c,05,00,07,64,00'
    )
  })

  it.each([
    ['a duration shorter than the interval', { type: 1, sampleInterval: 1, filterDuration: 0.5 }],
    ['an IIR filter with an interval but no duration', { type: 1, sampleInterval: 1 }],
    ['an IIR filter with a duration but no interval', { type: 1, filterDuration: 2 }],
    ['a duration on the unfiltered type', { type: 0, sampleInterval: 1, filterDuration: 2 }],
    ['an interval beyond the field', { type: 0, sampleInterval: 655.33 }],
    ['a zero interval, which the manual reserves', { type: 0, sampleInterval: 0 }],
    ['a reserved filter type', { type: 2, sampleInterval: 1 }]
  ])('rejects %s', (_name, input) => {
    expect(setting('speedFilter').parse(input).ok).toBe(false)
  })
})

describe('on/off settings (R15, R19)', () => {
  it('reads simulate mode whether canboatjs names the state or not', () => {
    expect(
      readValue('simulateMode', pidReply(AirmarPid.SimulateMode, { simulateMode: 'On' }))
    ).toBe(true)
    expect(
      readValue('simulateMode', {
        pgn: PGN.proprietary,
        src: DEVICE,
        fields: { proprietaryId: 35, simulateMode: 0 }
      })
    ).toBe(false)
  })

  it('turns simulate mode on through field 5', () => {
    expect(payload(commandFor('simulateMode', true))).toBe(
      '01,00,ef,01,f8,04,01,87,00,03,04,04,23,05,01'
    )
  })

  it('reads the transmission-interval option', () => {
    expect(
      readValue(
        'transmissionIntervalOverride',
        pidReply(AirmarPid.Nmea2000Options, { transmissionInterval: 'Requested by user' })
      )
    ).toBe(true)
  })

  it('rejects anything but a boolean', () => {
    expect(setting('simulateMode').parse('on').ok).toBe(false)
  })

  it('compares on/off exactly', () => {
    expect(setting('simulateMode').sameAsStored(true, true)).toBe(true)
    expect(setting('simulateMode').sameAsStored(true, false)).toBe(false)
  })

  it('does not take another PID’s reply for simulate mode', () => {
    expect(
      readValue(
        'simulateMode',
        pidReply(AirmarPid.Nmea2000Options, { transmissionInterval: 'Requested by user' })
      )
    ).toBeNull()
  })
})

describe('installation description and product information (R16)', () => {
  it('reads both description fields', () => {
    expect(
      readValue(
        'installationDescription',
        reply(PGN.configurationInformation, {
          installationDescription1: 'Bow, port',
          installationDescription2: 'Fitted 2024'
        })
      )
    ).toEqual({ description1: 'Bow, port', description2: 'Fitted 2024' })
  })

  it('writes one description field alone', () => {
    expect(payload(commandFor('installationDescription', { description1: 'Bow, port' }))).toBe(
      '01,16,f0,01,f8,01,01,0b,01,42,6f,77,2c,20,70,6f,72,74'
    )
  })

  it.each([
    ['more than 70 characters', { description1: 'x'.repeat(71) }],
    ['a description that is not text', { description1: 42 }],
    ['a character outside ASCII', { description1: 'Keula ö' }],
    ['neither field', {}]
  ])('rejects %s', (_name, input) => {
    expect(setting('installationDescription').parse(input).ok).toBe(false)
  })

  it('accepts 70 characters', () => {
    expect(setting('installationDescription').parse({ description1: 'x'.repeat(70) }).ok).toBe(true)
  })

  it('writes a description without the edge spaces canboatjs would trim from its read-back', () => {
    expect(setting('installationDescription').parse({ description1: ' Bow ' })).toEqual({
      ok: true,
      value: { description1: 'Bow' }
    })
  })

  it('compares only the descriptions it wrote', () => {
    const stored = { description1: 'Bow', description2: 'Fitted 2024' }

    expect(setting('installationDescription').sameAsStored({ description1: 'Bow' }, stored)).toBe(
      true
    )
    expect(setting('installationDescription').sameAsStored({ description1: 'Stern' }, stored)).toBe(
      false
    )
  })

  it.each([
    ['installationDescription', PGN.configurationInformation],
    ['productInformation', PGN.productInformation],
    ['distanceLog', PGN.distanceLog]
  ] as const)('does not take the device’s depth broadcast for %s', (id, _pgn) => {
    expect(readValue(id, reply(PGN.waterDepth, { sid: 1, depth: 12.3, offset: 0.35 }))).toBeNull()
  })

  it('reads product information and has nothing to write', () => {
    expect(
      readValue(
        'productInformation',
        reply(PGN.productInformation, {
          productCode: 1234,
          modelId: 'DST800',
          softwareVersionCode: '1.0',
          modelVersion: 'A',
          modelSerialCode: 'SN42'
        })
      )
    ).toMatchObject({ modelId: 'DST800', modelSerialCode: 'SN42', productCode: 1234 })
    expect(buildCommand('productInformation', DEVICE, {}).ok).toBe(false)
  })
})

describe('distance log (R17)', () => {
  it('reads the total and the distance since the last reset', () => {
    expect(readValue('distanceLog', reply(PGN.distanceLog, { log: 1000, tripLog: 20 }))).toEqual({
      log: 1000,
      tripLog: 20
    })
  })

  it('resets through field 4 of PGN 128275', () => {
    expect(payload(commandFor('distanceLog', { tripLog: 0 }))).toBe(
      '01,13,f5,01,f8,01,04,00,00,00,00'
    )
  })

  it('accepts a reset read back a few metres on, because the log keeps counting under way', () => {
    const reset = { tripLog: 0 }

    expect(setting('distanceLog').sameAsStored(reset, { log: 1000, tripLog: 0 })).toBe(true)
    expect(setting('distanceLog').sameAsStored(reset, { log: 1000, tripLog: 3 })).toBe(true)
    expect(setting('distanceLog').sameAsStored(reset, { log: 1000, tripLog: 150 })).toBe(false)
    expect(setting('distanceLog').sameAsStored({ tripLog: 50 }, { log: 1000, tripLog: 20 })).toBe(
      false
    )
    expect(setting('distanceLog').sameAsStored(reset, { log: 1000, tripLog: null })).toBe(false)
  })

  it('refuses a distance canboat reserves', () => {
    expect(setting('distanceLog').parse({ tripLog: 0xfffffffc }).ok).toBe(true)
    expect(setting('distanceLog').parse({ tripLog: 0xfffffffd }).ok).toBe(false)
  })
})
