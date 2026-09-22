import { describe, it, expect } from 'vitest'
import { pgnToActisenseSerialFormat, FromPgn } from '@canboat/canboatjs'
import type { PGN } from '@canboat/ts-pgns'
import type { N2kMessage } from '../../src/protocol/codec.js'
import {
  AirmarPid,
  EepromResetOption,
  commandProprietary,
  commandStandardField,
  decodeAcknowledge,
  decodeSpeedCurve,
  masterReset,
  requestProprietary,
  resetEeprom,
  setSpeedCurve,
  restoreDefaultSpeedCurve,
  unlockLevel1
} from '../../src/protocol/codec.js'

const DST = 35

/**
 * canboatjs types its encoder against an abstract PGN class, while both this
 * codec and the server's own code pass plain object literals. One cast, here.
 */
const encode = (message: N2kMessage) => pgnToActisenseSerialFormat(message as unknown as PGN)

/** The Actisense line minus its leading timestamp, priority, pgn, src, dst, len. */
const payload = (message: N2kMessage) => encode(message).split(',').slice(6).join(',')

/**
 * One parser for the whole file, as the server has one for the whole bus.
 *
 * canboatjs cannot reassemble a single-line fast packet as a parser's very
 * first input: 126720 frames decode as undefined until the parser has seen
 * traffic. A fresh parser per call would therefore fail on frames the server
 * decodes without trouble.
 */
const parser = new FromPgn()
const decode = (message: N2kMessage) => parser.parseString(encode(message))

describe('encoding', () => {
  it('unlocks Access Level 1 with the documented password', () => {
    expect(payload(unlockLevel1(DST))).toBe(
      '01,07,ff,00,f8,05,01,87,00,03,04,04,01,05,01,07,78,56,34,12'
    )
  })

  it('requests the speed calibration curve', () => {
    expect(payload(requestProprietary(DST, AirmarPid.CalibrateSpeed))).toBe(
      '00,00,ef,01,ff,ff,ff,ff,ff,ff,03,01,87,00,03,04,04,29'
    )
  })

  it('restores the factory default curve', () => {
    expect(payload(restoreDefaultSpeedCurve(DST))).toBe(
      '01,00,ef,01,f8,04,01,87,00,03,04,04,29,05,fe'
    )
  })

  it('writes curve points at the device resolutions', () => {
    // 0.1 Hz and 0.01 m/s, per the manual's worked example.
    const pgn = setSpeedCurve(DST, [
      { hz: 12.2, speed: 1.93 },
      { hz: 75.0, speed: 5.14 }
    ])
    const decoded = decode(pgn)
    const list = decoded?.fields as { list: { parameter: number; value: number }[] }
    // The decoder adds parameterId; compare the two fields the protocol defines.
    const pairs = list.list.map((p) => ({ parameter: p.parameter, value: p.value }))

    // The decoder resolves lookup fields to their names.
    expect(pairs.slice(0, 4)).toEqual([
      { parameter: 1, value: 'Airmar' },
      { parameter: 3, value: 'Marine Industry' },
      { parameter: 4, value: 'Calibrate Speed' },
      { parameter: 5, value: 2 }
    ])
    expect(pairs.slice(4).map((p) => p.value)).toEqual([12.2, 1.93, 75, 5.14])
  })

  it('sends master reset as an addressed 126720, not a command group function', () => {
    const message = masterReset(DST)

    expect(message.pgn).toBe(126720)
    expect(payload(message)).toBe('87,98,01,ff,ff,ff')
  })

  it('distinguishes the EEPROM restore options', () => {
    expect(payload(resetEeprom(DST, EepromResetOption.All))).toBe('87,98,82,f0,ff,ff')
    expect(payload(resetEeprom(DST, EepromResetOption.UpdateRates))).toBe('87,98,82,f2,ff,ff')
  })

  it('writes a standard PGN field', () => {
    // Depth offset lives in PGN 128267 field 3, not in an Airmar PID.
    const decoded = decode(commandStandardField(DST, 128267, [{ parameter: 3, value: -0.3 }]))
    const fields = decoded?.fields as { pgn: number; list: { parameter: number; value: number }[] }

    expect(fields.pgn).toBe(128267)
    expect(fields.list.map((p) => ({ parameter: p.parameter, value: p.value }))).toEqual([
      { parameter: 3, value: -0.3 }
    ])
  })

  it('rejects a proprietary parameter list that omits the identifying pairs', () => {
    // canboatjs narrows the 126720 variant by these match fields and throws
    // `unable to read` without them. Fail here, with a name, instead.
    expect(() =>
      commandProprietary(DST, AirmarPid.CalibrateSpeed, [{ parameter: 5, value: 1 }], {
        omitIdentity: true
      })
    ).toThrow(/manufacturer/i)
  })

  it.each([
    ['unlock', () => unlockLevel1(DST)],
    ['curve request', () => requestProprietary(DST, AirmarPid.CalibrateSpeed)],
    ['curve restore', () => restoreDefaultSpeedCurve(DST)],
    ['curve write', () => setSpeedCurve(DST, [{ hz: 12.2, speed: 1.93 }])],
    ['master reset', () => masterReset(DST)],
    ['eeprom reset', () => resetEeprom(DST, EepromResetOption.Priorities)]
  ])('round-trips a %s frame through the decoder', (_name, build) => {
    expect(decode(build())).toBeTruthy()
  })
})

describe('decoding', () => {
  it('trims a curve reply to the number of pairs it declares', () => {
    // The device returns a fixed-length list; only the first N rows are real.
    const reply = {
      pgn: 126720,
      fields: {
        manufacturerCode: 'Airmar',
        industryCode: 'Marine Industry',
        proprietaryId: 'Calibrate Speed',
        numberOfPairsOfDataPointsToFollow: 2,
        list: [
          { inputFrequency: 12.2, outputSpeed: 1.93 },
          { inputFrequency: 75.0, outputSpeed: 5.14 },
          { inputFrequency: 0, outputSpeed: 0 },
          { inputFrequency: 0, outputSpeed: 0 }
        ]
      }
    }

    expect(decodeSpeedCurve(reply)).toEqual([
      { hz: 12.2, speed: 1.93 },
      { hz: 75.0, speed: 5.14 }
    ])
  })

  it('reads an acknowledgement as success', () => {
    const ack = decodeAcknowledge({
      pgn: 126208,
      src: DST,
      fields: {
        functionCode: 'Acknowledge',
        pgn: 126720,
        pgnErrorCode: 'Acknowledge',
        transmissionIntervalPriorityErrorCode: 'Acknowledge',
        list: [{ parameter: 'Acknowledge' }, { parameter: 'Acknowledge' }]
      }
    })

    expect(ack).not.toBeNull()
    expect(ack).toEqual({
      acknowledgedPgn: 126720,
      src: DST,
      ok: true,
      pgnError: 'Acknowledge',
      parameterErrors: []
    })
  })

  it('reports which parameter the device rejected', () => {
    const ack = decodeAcknowledge({
      pgn: 126208,
      src: DST,
      fields: {
        functionCode: 'Acknowledge',
        pgn: 126720,
        pgnErrorCode: 'Acknowledge',
        list: [
          { parameter: 'Acknowledge' },
          { parameter: 'Parameter out of range' },
          { parameter: 'Acknowledge' }
        ]
      }
    })

    expect(ack?.ok).toBe(false)
    expect(ack?.parameterErrors).toEqual([{ index: 2, error: 'Parameter out of range' }])
  })

  it.each([
    ['PGN not supported', 'the PID is not implemented'],
    ['Access denied', 'the device is locked'],
    ['Not supported', 'the device refused it']
  ])('surfaces a %s rejection', (code) => {
    const ack = decodeAcknowledge({
      pgn: 126208,
      src: DST,
      fields: { functionCode: 'Acknowledge', pgn: 126720, pgnErrorCode: code, list: [] }
    })

    expect(ack?.ok).toBe(false)
    expect(ack?.pgnError).toBe(code)
  })

  it('ignores a 126208 that is not an acknowledgement', () => {
    expect(
      decodeAcknowledge({ pgn: 126208, src: DST, fields: { functionCode: 'Request', pgn: 126720 } })
    ).toBeNull()
  })
})
