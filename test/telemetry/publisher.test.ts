import { describe, it, expect, beforeEach } from 'vitest'
import { getSourceId } from '@signalk/server-api'
import { FakeBus } from '../helpers/FakeBus.js'
import { decode, decodeLine } from '../helpers/canboat.js'
import type { DecodedPgn } from '../../src/protocol/messages.js'
import { PGN } from '../../src/protocol/pids.js'
import {
  TELEMETRY_META,
  startTelemetry,
  type TelemetrySource
} from '../../src/telemetry/publisher.js'

const DEVICE = 22
const OTHER_DST = 30
const CAN_NAME = 'c097820010e1e240'

const airmar = (pgn: number, fields: Record<string, unknown>, src = DEVICE): DecodedPgn => ({
  ...decode({
    pgn,
    dst: 255,
    prio: 7,
    fields: { manufacturerCode: 'Airmar', industryCode: 'Marine Industry', sid: 1, ...fields }
  }),
  src,
  dst: 255
})

/** A 65409 frame from its payload bytes, for the not-available sentinels canboat cannot encode. */
const pulseLine = (bytes: string): DecodedPgn =>
  decodeLine(`2026-09-23T12:00:00.000Z,7,65409,${String(DEVICE)},255,8,87,98,01,${bytes}`)

describe('telemetry', () => {
  let bus: FakeBus
  let published: { path: string; value: unknown }[][]
  let sources: (TelemetrySource | null)[]
  let address: number | null
  let canName: string | null

  beforeEach(() => {
    bus = new FakeBus()
    published = []
    sources = []
    address = DEVICE
    canName = CAN_NAME
    startTelemetry({
      subscribe: (handler) => bus.subscribe(handler),
      address: () => address,
      canName: () => canName,
      publish: (values, source) => {
        published.push(values)
        sources.push(source)
      }
    })
  })

  const pulses = (): DecodedPgn =>
    airmar(PGN.speedPulseCount, { durationOfInterval: 2, numberOfPulsesReceived: 40 })

  it('names the sensor as n2k-signalk does, so the server derives the same $source', () => {
    bus.deliver({ ...pulses(), providerId: 'can0' })

    expect(sources).toEqual([
      { label: 'can0', type: 'NMEA2000', pgn: PGN.speedPulseCount, src: '22', canName: CAN_NAME }
    ])
    expect(getSourceId(sources[0])).toBe(`can0.${CAN_NAME}`)
  })

  it('publishes no source for a frame with no provider, or a sensor with no CAN NAME', () => {
    bus.deliver(pulses())
    canName = null
    bus.deliver({ ...pulses(), providerId: 'can0' })

    expect(published).toHaveLength(2)
    expect(sources).toEqual([null, null])
  })

  it('publishes the pulse rate, and the count and interval unreduced', () => {
    bus.deliver(airmar(PGN.speedPulseCount, { durationOfInterval: 2, numberOfPulsesReceived: 40 }))

    expect(published).toEqual([
      [
        { path: 'sensors.airmarDst.speed.pulseRate', value: 20 },
        { path: 'sensors.airmarDst.speed.pulseCount', value: 40 },
        { path: 'sensors.airmarDst.speed.pulseInterval', value: 2 }
      ]
    ])
  })

  it('reads a fractional interval', () => {
    bus.deliver(pulseLine('f4,01,05,00,ff'))

    expect(published[0]).toContainEqual({
      path: 'sensors.airmarDst.speed.pulseInterval',
      value: 0.5
    })
    expect(published[0]).toContainEqual({ path: 'sensors.airmarDst.speed.pulseRate', value: 10 })
  })

  it('publishes supply voltage in volts and board temperature in kelvin', () => {
    bus.deliver(
      airmar(PGN.deviceInformation, { internalDeviceTemperature: 300.15, supplyVoltage: 12.34 })
    )

    expect(published).toEqual([
      [
        { path: 'sensors.airmarDst.supplyVoltage', value: 12.34 },
        { path: 'sensors.airmarDst.temperature', value: 300.15 }
      ]
    ])
  })

  it('publishes a zero pulse count at rest, with a rate of zero', () => {
    bus.deliver(airmar(PGN.speedPulseCount, { durationOfInterval: 2, numberOfPulsesReceived: 0 }))

    expect(published[0]).toContainEqual({ path: 'sensors.airmarDst.speed.pulseRate', value: 0 })
  })

  it('publishes the one reading a 65410 frame carries when the other is not available', () => {
    bus.deliver(airmar(PGN.deviceInformation, { supplyVoltage: 12.34 }))

    expect(published).toEqual([[{ path: 'sensors.airmarDst.supplyVoltage', value: 12.34 }]])
  })

  it('publishes an unlocked depth as quality 0', () => {
    bus.deliver(airmar(PGN.depthQualityFactor, { depthQualityFactor: 0 }))

    expect(published).toEqual([[{ path: 'sensors.airmarDst.depth.quality', value: 0 }]])
  })

  it.each([
    ['named', airmar(PGN.depthQualityFactor, { depthQualityFactor: 3 })],
    [
      'as its raw number',
      decodeLine('2026-09-23T12:00:00.000Z,7,65408,22,255,8,87,98,01,f3,ff,ff,ff,ff', {
        resolveEnums: false
      })
    ]
  ])('publishes the depth quality factor %s as a ratio', (_name, frame) => {
    bus.deliver(frame)

    expect(published).toEqual([[{ path: 'sensors.airmarDst.depth.quality', value: 0.3 }]])
  })

  it.each([
    ['a zero interval', '00,00,05,00,ff'],
    ['a not-available interval', 'ff,ff,28,00,ff'],
    ['a not-available pulse count', 'd0,07,ff,ff,ff']
  ])('publishes nothing for %s', (_name, bytes) => {
    expect(() => {
      bus.deliver(pulseLine(bytes))
    }).not.toThrow()
    expect(published).toEqual([])
  })

  it('publishes nothing from another device, or with no device located', () => {
    bus.deliver(
      airmar(PGN.speedPulseCount, { durationOfInterval: 2, numberOfPulsesReceived: 40 }, OTHER_DST)
    )
    address = null
    bus.deliver(airmar(PGN.speedPulseCount, { durationOfInterval: 2, numberOfPulsesReceived: 40 }))

    expect(published).toEqual([])
  })

  it('describes the unit of every path it publishes', () => {
    bus.deliver(airmar(PGN.speedPulseCount, { durationOfInterval: 2, numberOfPulsesReceived: 40 }))
    bus.deliver(
      airmar(PGN.deviceInformation, { internalDeviceTemperature: 300.15, supplyVoltage: 12.34 })
    )
    bus.deliver(airmar(PGN.depthQualityFactor, { depthQualityFactor: 3 }))
    const paths = [...new Set(published.flat().map((v) => v.path))].sort()
    const units = Object.fromEntries(TELEMETRY_META.map((m) => [m.path, m.units]))

    expect(Object.keys(units).sort()).toEqual(paths)
    expect(units).toEqual({
      'sensors.airmarDst.speed.pulseRate': 'Hz',
      'sensors.airmarDst.speed.pulseCount': undefined,
      'sensors.airmarDst.speed.pulseInterval': 's',
      'sensors.airmarDst.supplyVoltage': 'V',
      'sensors.airmarDst.temperature': 'K',
      'sensors.airmarDst.depth.quality': 'ratio'
    })
  })
})
