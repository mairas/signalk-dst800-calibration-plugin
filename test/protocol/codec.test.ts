import { describe, it, expect } from 'vitest'
import { decode, decodeLine, payload } from '../helpers/canboat.js'
import { curveReply } from '../helpers/replies.js'
import type { DecodedPgn } from '../../src/protocol/messages.js'
import { CALIBRATE_SPEED_NAME } from '../../src/protocol/pids.js'
import type { CurvePoint } from '../../src/protocol/codec.js'
import {
  AirmarPid,
  EepromResetOption,
  MAX_CURVE_HZ,
  MAX_CURVE_POINTS,
  MAX_CURVE_SPEED,
  assertIdentity,
  commandProprietary,
  commandStandardField,
  decodeAcknowledge,
  decodeSpeedCurve,
  masterReset,
  requestAirmarPgn,
  requestSpeedCurve,
  requestStandardPgn,
  resetEeprom,
  restoreDefaultSpeedCurve,
  setSpeedCurve,
  unlockLevel1
} from '../../src/protocol/codec.js'

const DST = 35

describe('addressing', () => {
  it.each([
    ['request', () => requestSpeedCurve(DST)],
    ['command', () => restoreDefaultSpeedCurve(DST)],
    ['standard field command', () => commandStandardField(DST, 128267, [])],
    ['unlock', () => unlockLevel1(DST)]
  ])('addresses a %s to the device, not the bus', (_name, build) => {
    // A broadcast write reaches every Airmar sensor on the bus.
    expect(build()).toMatchObject({ dst: DST, prio: 3, pgn: 126208 })
  })

  it.each([
    ['master reset', () => masterReset(DST)],
    ['eeprom reset', () => resetEeprom(DST, EepromResetOption.Priorities)]
  ])('addresses a %s as a bare 126720', (_name, build) => {
    expect(build()).toMatchObject({ dst: DST, prio: 3, pgn: 126720 })
  })
})

describe('encoding', () => {
  it('unlocks Access Level 1 with the documented password', () => {
    expect(payload(unlockLevel1(DST))).toBe(
      '01,07,ff,00,f8,05,01,87,00,03,04,04,01,05,01,07,78,56,34,12'
    )
  })

  it('requests the speed calibration curve', () => {
    expect(payload(requestSpeedCurve(DST))).toBe(
      '00,00,ef,01,ff,ff,ff,ff,ff,ff,03,01,87,00,03,04,04,29'
    )
    expect(decode(requestSpeedCurve(DST)).fields?.functionCode).toBe('Request')
  })

  it('restores the factory default curve', () => {
    expect(payload(restoreDefaultSpeedCurve(DST))).toBe(
      '01,00,ef,01,f8,04,01,87,00,03,04,04,29,05,fe'
    )
  })

  it('writes curve pairs at the documented parameter numbers and resolutions', () => {
    // The manual's worked example: 12.2 Hz -> 1.93 m/s, 75.0 Hz -> 5.14 m/s,
    // stored as raw 122/193 and 750/514, at parameters 6/7 and 8/9.
    expect(
      payload(
        setSpeedCurve(DST, [
          { hz: 12.2, speed: 1.93 },
          { hz: 75.0, speed: 5.14 }
        ])
      )
    ).toBe('01,00,ef,01,f8,08,01,87,00,03,04,04,29,05,02,06,7a,00,07,c1,00,08,ee,02,09,02,02')
  })

  it('commands rather than requests when writing a standard PGN field', () => {
    const decoded = decode(commandStandardField(DST, 128267, [{ parameter: 3, value: -0.3 }]))
    interface Pair {
      parameter: number
      value: number
    }
    const fields = decoded.fields as { pgn: number; functionCode: string; list: Pair[] }

    expect(fields.functionCode).toBe('Command')
    expect(fields.pgn).toBe(128267)
    expect(fields.list.map((p) => ({ parameter: p.parameter, value: p.value }))).toEqual([
      { parameter: 3, value: -0.3 }
    ])
  })

  it('commands rather than requests when writing a proprietary field', () => {
    const decoded = decode(commandProprietary(DST, AirmarPid.SimulateMode, []))

    expect(decoded.fields?.functionCode).toBe('Command')
  })

  it.each([
    ['master reset', () => masterReset(DST), '87,98,01,ff,ff,ff'],
    ['eeprom wipe', () => resetEeprom(DST, EepromResetOption.All), '87,98,82,f0,ff,ff'],
    ['eeprom rates', () => resetEeprom(DST, EepromResetOption.UpdateRates), '87,98,82,f2,ff,ff'],
    ['eeprom priorities', () => resetEeprom(DST, EepromResetOption.Priorities), '87,98,82,f1,ff,ff']
  ])('builds the %s frame from fixed bytes', (_name, build, expected) => {
    expect(build().payload).toBe(expected)
  })

  it('round-trips a group function through the decoder as the right function', () => {
    expect(decode(unlockLevel1(DST)).fields?.functionCode).toBe('Command')
    expect(decode(requestSpeedCurve(DST)).fields?.functionCode).toBe('Request')
  })
})

describe('identity guard', () => {
  const check = (params: { parameter: number; value: number }[]) => () => {
    assertIdentity(params)
  }

  it('accepts a list that leads with the identifying pairs', () => {
    expect(
      check([
        { parameter: 1, value: 135 },
        { parameter: 3, value: 4 },
        { parameter: 4, value: 41 },
        { parameter: 5, value: 1 }
      ])
    ).not.toThrow()
  })

  it('rejects a list that omits the manufacturer code', () => {
    expect(check([{ parameter: 4, value: 41 }])).toThrow(/manufacturer/i)
  })

  it('rejects an empty list', () => {
    expect(check([])).toThrow(/manufacturer/i)
  })

  it('rejects a list that omits the proprietary ID', () => {
    expect(
      check([
        { parameter: 1, value: 135 },
        { parameter: 3, value: 4 }
      ])
    ).toThrow(/proprietary/i)
  })

  it('rejects a narrowed field placed before the proprietary ID', () => {
    // canboatjs resolves the variant as it walks the list, so order matters.
    expect(
      check([
        { parameter: 1, value: 135 },
        { parameter: 5, value: 1 },
        { parameter: 4, value: 41 }
      ])
    ).toThrow(/must precede/i)
  })
})

describe('curve validation', () => {
  const point = { hz: 10, speed: 1 }

  it('rejects an empty curve', () => {
    expect(() => setSpeedCurve(DST, [])).toThrow(/1 to 25/)
  })

  it(`rejects more than ${String(MAX_CURVE_POINTS)} points`, () => {
    const many = Array.from({ length: MAX_CURVE_POINTS + 1 }, (_, i) => ({ hz: i + 1, speed: 1 }))
    expect(() => setSpeedCurve(DST, many)).toThrow(/1 to 25/)
  })

  it(`accepts exactly ${String(MAX_CURVE_POINTS)} points`, () => {
    const many = Array.from({ length: MAX_CURVE_POINTS }, (_, i) => ({ hz: i + 1, speed: 1 }))
    expect(() => setSpeedCurve(DST, many)).not.toThrow()
  })

  it('rejects a descending frequency', () => {
    expect(() => setSpeedCurve(DST, [{ hz: 20, speed: 1 }, point])).toThrow(/must increase/)
  })

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['negative', -5],
    ['above the field range', MAX_CURVE_HZ + 0.1]
  ])('rejects a %s frequency', (_name, hz) => {
    // NaN defeats every comparison, so the monotonic guard cannot see it, and
    // an out-of-range value truncates to 16 bits rather than erroring.
    expect(() => setSpeedCurve(DST, [{ hz, speed: 1 }])).toThrow(/frequency must be between/)
  })

  it.each([
    ['NaN', NaN],
    ['negative', -1],
    ['above the field range', MAX_CURVE_SPEED + 0.01]
  ])('rejects a %s speed', (_name, speed) => {
    expect(() => setSpeedCurve(DST, [{ hz: 10, speed }])).toThrow(/speed must be between/)
  })

  it('rejects points that collide at the stored resolution', () => {
    // 12.2 and 12.24 Hz both store as 122, giving a zero-width segment.
    expect(() =>
      setSpeedCurve(DST, [
        { hz: 12.2, speed: 1 },
        { hz: 12.24, speed: 2 }
      ])
    ).toThrow(/stored 0.1 Hz resolution/)
  })
})

describe('eeprom reset validation', () => {
  it.each([16, 0.5, -1, 7])('rejects %s, which truncates onto a real option', (option) => {
    expect(() => resetEeprom(DST, option)).toThrow(/not an EEPROM reset option/)
  })
})

describe('decoding a curve reply', () => {
  const realReply = (points: CurvePoint[], declared = points.length): DecodedPgn =>
    curveReply(points, {}, declared)

  it('reads the points the device reports', () => {
    const reply = realReply([
      { hz: 12.2, speed: 1.93 },
      { hz: 75.0, speed: 5.14 }
    ])

    expect(reply.fields).toHaveProperty('numberOfPairsOfDataPoints')
    expect(decodeSpeedCurve(reply)).toEqual([
      { hz: 12.2, speed: 1.93 },
      { hz: 75.0, speed: 5.14 }
    ])
  })

  it('drops the padding rows the device pads its list with', () => {
    const reply = realReply(
      [
        { hz: 12.2, speed: 1.93 },
        { hz: 75.0, speed: 5.14 },
        { hz: 0, speed: 0 },
        { hz: 0, speed: 0 }
      ],
      2
    )

    expect(decodeSpeedCurve(reply)).toEqual([
      { hz: 12.2, speed: 1.93 },
      { hz: 75.0, speed: 5.14 }
    ])
  })

  it('trims a list longer than the declared count', () => {
    // canboatjs already bounds the repeating set by the count field, so this
    // is defensive — but it is the only case where reading the wrong field
    // name changes the answer, which is how the original defect hid.
    const reply: DecodedPgn = {
      pgn: 126720,
      fields: {
        proprietaryId: CALIBRATE_SPEED_NAME,
        numberOfPairsOfDataPoints: 1,
        list: [
          { inputFrequency: 12.2, outputSpeed: 1.93 },
          { inputFrequency: 0, outputSpeed: 0 },
          { inputFrequency: 0, outputSpeed: 0 }
        ]
      }
    }

    expect(decodeSpeedCurve(reply)).toEqual([{ hz: 12.2, speed: 1.93 }])
  })

  it('clamps a count larger than the list', () => {
    const reply: DecodedPgn = {
      pgn: 126720,
      fields: {
        proprietaryId: CALIBRATE_SPEED_NAME,
        numberOfPairsOfDataPoints: 5,
        list: [{ inputFrequency: 12.2, outputSpeed: 1.93 }]
      }
    }

    expect(decodeSpeedCurve(reply)).toHaveLength(1)
  })

  it('falls back to the list when no count is declared', () => {
    const reply: DecodedPgn = {
      pgn: 126720,
      fields: {
        proprietaryId: CALIBRATE_SPEED_NAME,
        list: [{ inputFrequency: 12.2, outputSpeed: 1.93 }]
      }
    }

    expect(decodeSpeedCurve(reply)).toHaveLength(1)
  })

  it.each([
    ['a different PGN', { pgn: 65409, fields: { proprietaryId: CALIBRATE_SPEED_NAME, list: [] } }],
    ['a different proprietary ID', { pgn: 126720, fields: { proprietaryId: 'Simulate Mode' } }]
  ])('returns null for %s', (_name, reply) => {
    expect(decodeSpeedCurve(reply as DecodedPgn)).toBeNull()
  })
})

describe('decoding an acknowledgement', () => {
  const ack = (fields: Record<string, unknown>): DecodedPgn => ({
    pgn: 126208,
    src: DST,
    fields: {
      functionCode: 'Acknowledge',
      pgn: 126720,
      pgnErrorCode: 'Acknowledge',
      transmissionIntervalPriorityErrorCode: 'Acknowledge',
      ...fields
    }
  })

  it('reads a clean acknowledgement as success', () => {
    const result = decodeAcknowledge(
      ack({
        pgnErrorCode: 'Acknowledge',
        transmissionIntervalPriorityErrorCode: 'Acknowledge',
        list: [{ parameter: 'Acknowledge' }]
      })
    )

    expect(result).toEqual({
      acknowledgedPgn: 126720,
      src: DST,
      ok: true,
      pgnError: 'Acknowledge',
      intervalPriorityError: 'Acknowledge',
      parameterErrors: [],
      missingParameterCodes: 0
    })
  })

  it('reports which parameter the device rejected', () => {
    const result = decodeAcknowledge(
      ack({
        list: [
          { parameter: 'Acknowledge' },
          { parameter: 'Parameter out of range' },
          { parameter: 'Acknowledge' }
        ]
      })
    )

    expect(result?.ok).toBe(false)
    expect(result?.parameterErrors).toEqual([{ index: 2, error: 'Parameter out of range' }])
  })

  it.each(['PGN not supported', 'Access denied', 'Not supported'])(
    'surfaces a %s rejection',
    (code) => {
      const result = decodeAcknowledge(ack({ pgnErrorCode: code }))

      expect(result?.ok).toBe(false)
      expect(result?.pgnError).toBe(code)
    }
  )

  it('fails on an error code canboatjs cannot name', () => {
    // PGN_ERROR_CODE enumerates 0-6 while the field is four bits wide, so a
    // reserved or vendor code arrives as a number. Defaulting that to success
    // would report a refused command as applied.
    const result = decodeAcknowledge(ack({ pgnErrorCode: 7 }))

    expect(result?.ok).toBe(false)
    expect(result?.pgnError).toBe('Unknown code 7')
  })

  it('fails when the device rejects the priority or interval', () => {
    const result = decodeAcknowledge(
      ack({ transmissionIntervalPriorityErrorCode: 'Transmit Interval too low' })
    )

    expect(result?.ok).toBe(false)
    expect(result?.intervalPriorityError).toBe('Transmit Interval too low')
  })

  /**
   * An Acknowledge of a five-parameter 126720 Command, refusing parameter 4
   * as out of range: function code 2, PGN 0x01EF00 little-endian, the PGN
   * and interval error codes in one byte, five parameters, then one 4-bit
   * code per parameter padded with ones.
   */
  const OUT_OF_RANGE_LINE = '2026-01-01T00:00:00.000Z,3,126208,22,100,9,02,00,ef,01,00,05,00,30,f0'

  it.each([
    ['names', true],
    ['raw numbers', false]
  ])('reads a device frame the same when canboatjs gives the codes as %s', (_name, resolve) => {
    const result = decodeAcknowledge(decodeLine(OUT_OF_RANGE_LINE, { resolveEnums: resolve }))

    expect(result).toEqual({
      acknowledgedPgn: 126720,
      src: 22,
      ok: false,
      pgnError: 'Acknowledge',
      intervalPriorityError: 'Acknowledge',
      parameterErrors: [{ index: 4, error: 'Parameter out of range' }],
      missingParameterCodes: 0
    })
  })

  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  const line = (length: number, bytes: string): string =>
    `2026-01-01T00:00:00.000Z,3,126208,22,100,${String(length)},02,00,ef,01,${bytes}`
  const bothWays = (text: string) => ({
    named: decodeAcknowledge(decodeLine(text)),
    raw: decodeAcknowledge(decodeLine(text, { resolveEnums: false }))
  })
  const CODES = Array.from({ length: 16 }, (_, code) => code)

  // The error-code byte holds the PGN code in its low nibble and the interval
  // code in its high nibble.
  it.each(CODES)('reads PGN error code %d the same with and without names', (code) => {
    const { named, raw } = bothWays(line(6, `${hex(code)},00`))

    expect(named).toEqual(raw)
    expect(named?.ok).toBe(code === 0)
  })

  it.each(CODES)('reads interval error code %d the same with and without names', (code) => {
    const { named, raw } = bothWays(line(6, `${hex(code << 4)},00`))

    expect(named).toEqual(raw)
    expect(named?.ok).toBe(code === 0)
  })

  it.each(CODES)('reads parameter code %d as a failure unless it is 0, either way', (code) => {
    const { named, raw } = bothWays(line(7, `00,01,${hex(0xf0 | code)}`))

    expect(named?.ok).toBe(code === 0)
    expect(raw?.ok).toBe(code === 0)
    // canboatjs drops an entry it cannot name, so only the named codes agree
    // on the error itself.
    if (code !== 0xf) {
      expect(named).toEqual(raw)
    }
  })

  it('fails an acknowledgement whose codes are all ones', () => {
    const { named, raw } = bothWays(line(6, 'ff,00'))

    expect(named?.pgnError).toBe('No code')
    expect(raw?.pgnError).toBe('No code')
  })

  it('fails a frame cut off before its error codes', () => {
    const { named, raw } = bothWays(line(4, '').replace(/,$/, ''))

    expect(named?.ok).toBe(false)
    expect(raw?.ok).toBe(false)
  })

  it('fails when fewer parameter codes arrive than the device declared', () => {
    // Three declared, one code byte: canboatjs yields two entries.
    const { named } = bothWays(line(7, '00,03,f0'))

    expect(named?.ok).toBe(false)
    expect(named?.missingParameterCodes).toBeGreaterThan(0)
  })

  it('reads a clean acknowledgement given as raw numbers as success', () => {
    const result = decodeAcknowledge(
      ack({
        pgnErrorCode: 0,
        transmissionIntervalPriorityErrorCode: 0,
        list: [{ parameter: 0 }, { parameter: 0 }]
      })
    )

    expect(result?.ok).toBe(true)
  })

  it.each([
    ['pgnErrorCode', 3, 'Access denied'],
    ['pgnErrorCode', 1, 'PGN not supported'],
    ['transmissionIntervalPriorityErrorCode', 2, 'Transmit Interval too low']
  ])('names a raw %s %d as %s', (field, code, name) => {
    const result = decodeAcknowledge(ack({ [field]: code }))

    expect(result?.ok).toBe(false)
    expect(field === 'pgnErrorCode' ? result?.pgnError : result?.intervalPriorityError).toBe(name)
  })

  it.each([
    [2, 'Temporary error'],
    [4, 'Access denied']
  ])('names a raw parameter code %d as %s', (code, name) => {
    const result = decodeAcknowledge(ack({ list: [{ parameter: code }] }))

    expect(result?.parameterErrors).toEqual([{ index: 1, error: name }])
  })

  it('reports an uncorrelatable reply rather than inventing a PGN', () => {
    const result = decodeAcknowledge({
      pgn: 126208,
      src: DST,
      fields: { functionCode: 'Acknowledge' }
    })

    expect(result?.acknowledgedPgn).toBeUndefined()
  })

  it.each([
    [
      'a 126208 that is not an acknowledgement',
      { pgn: 126208, fields: { functionCode: 'Request' } }
    ],
    [
      'a 126720 carrying an Acknowledge field',
      { pgn: 126720, fields: { functionCode: 'Acknowledge' } }
    ],
    ['an unrelated PGN', { pgn: 65409, fields: {} }]
  ])('ignores %s', (_name, message) => {
    expect(decodeAcknowledge(message as DecodedPgn)).toBeNull()
  })
})

describe('requesting a whole PGN', () => {
  it('names the manufacturer and industry when requesting an Airmar proprietary PGN', () => {
    // The manual: "Fields 1 and 3 must both be fully specified in the request
    // in order for this PGN to be transmitted." None answers an ISO Request.
    expect(payload(requestAirmarPgn(DST, 65409))).toBe(
      '00,81,ff,00,ff,ff,ff,ff,ff,ff,02,01,87,00,03,04'
    )
  })

  it('requests a standard PGN with no qualifiers', () => {
    expect(payload(requestStandardPgn(DST, 126996))).toBe('00,14,f0,01,ff,ff,ff,ff,ff,ff,00')
  })

  it.each([
    ['proprietary', () => requestAirmarPgn(DST, 130944)],
    ['standard', () => requestStandardPgn(DST, 128275)]
  ])('addresses a %s request to the device', (_name, build) => {
    const decoded = decode(build())
    expect(build()).toMatchObject({ dst: DST, pgn: 126208 })
    expect(decoded.fields?.functionCode).toBe('Request')
  })
})
