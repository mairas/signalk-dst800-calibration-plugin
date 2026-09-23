import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FakeBus } from '../helpers/FakeBus.js'
import { addressClaim, curveReply, pgnReply } from '../helpers/replies.js'
import { sourcesTree, type TreeDevice } from '../helpers/sources.js'
import { DeviceConnection } from '../../src/devices/connection.js'
import { DeviceRegistry, PRESENCE_WINDOW_MS } from '../../src/devices/registry.js'
import { DeviceSession } from '../../src/session/deviceSession.js'
import { decodeSpeedCurve, requestSpeedCurve } from '../../src/protocol/codec.js'
import type { CurvePoint } from '../../src/protocol/codec.js'
import { PGN } from '../../src/protocol/pids.js'
import type { DeviceKey } from '../../src/types.js'

const DST: TreeDevice = { address: 22, uniqueNumber: 123456, manufacturerCode: 'Airmar' }
const DST_KEY: DeviceKey = { manufacturerCode: 135, uniqueNumber: 123456 }
const SECOND: TreeDevice = { address: 23, uniqueNumber: 654321, manufacturerCode: 'Airmar' }
const SECOND_KEY: DeviceKey = { manufacturerCode: 135, uniqueNumber: 654321 }

const CURVE: CurvePoint[] = [{ hz: 10, speed: 1.2 }]
const OTHER_CURVE: CurvePoint[] = [{ hz: 44, speed: 3.5 }]

describe('DeviceConnection', () => {
  let bus: FakeBus
  let registry: DeviceRegistry
  let connections: DeviceConnection[]

  const heard = (src: number) => {
    bus.deliver(pgnReply(PGN.distanceLog, { src }))
  }

  const connect = (key: DeviceKey) => {
    const connection = new DeviceConnection({
      registry,
      key,
      createSession: (address) => new DeviceSession({ address, bus, now: () => Date.now() })
    })
    connections.push(connection)
    return connection
  }

  const readCurve = (connection: DeviceConnection) => {
    const session = connection.session
    if (session === null) {
      throw new Error('no session')
    }
    return session.read({ message: requestSpeedCurve(session.address), match: decodeSpeedCurve })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    bus = new FakeBus()
    connections = []
    registry = new DeviceRegistry({
      sources: () => sourcesTree([DST, SECOND]),
      subscribe: (handler) => bus.subscribe(handler),
      now: () => Date.now()
    })
  })

  afterEach(() => {
    for (const connection of connections) {
      connection.close()
    }
    registry.close()
    vi.useRealTimers()
  })

  it('opens no session while waiting for the device, and one when it is heard', () => {
    const connection = connect(DST_KEY)

    expect(connection.location).toEqual({ state: 'waiting', address: 22 })
    expect(connection.session).toBeNull()

    heard(22)

    expect(connection.location).toEqual({ state: 'present', address: 22 })
    expect(connection.session?.address).toBe(22)
  })

  it('tells an in-flight request the device moved, and talks to the new address', async () => {
    const connection = connect(DST_KEY)
    heard(22)
    const pending = readCurve(connection)
    await vi.advanceTimersByTimeAsync(0)

    bus.deliver(addressClaim(DST, 31))

    expect(await pending).toEqual({
      status: 'unknown',
      reason: 'The device moved from address 22 to 31'
    })
    expect(connection.session?.address).toBe(31)

    const next = readCurve(connection)
    await vi.advanceTimersByTimeAsync(0)
    bus.deliver(curveReply(CURVE, { src: 31, dst: 100 }))

    expect(await next).toEqual({ status: 'answered', value: [CURVE] })
    expect(bus.sent.at(-1)?.dst).toBe(31)
  })

  it('closes the session when the device gives up its address', async () => {
    const connection = connect(DST_KEY)
    heard(22)
    const pending = readCurve(connection)
    await vi.advanceTimersByTimeAsync(0)

    bus.deliver(addressClaim(DST, 254))

    expect((await pending).status).toBe('unknown')
    expect(connection.session).toBeNull()
    expect(connection.location).toEqual({ state: 'waiting', address: null })
  })

  it('keeps its session through a silence at the same address', async () => {
    const connection = connect(DST_KEY)
    heard(22)
    const session = connection.session

    await vi.advanceTimersByTimeAsync(PRESENCE_WINDOW_MS + 1000)

    expect(connection.location.state).toBe('waiting')
    expect(connection.session).toBe(session)
  })

  it('tracks two devices without attributing one’s replies to the other', async () => {
    const first = connect(DST_KEY)
    const second = connect(SECOND_KEY)
    heard(22)
    heard(23)

    const fromFirst = readCurve(first)
    const fromSecond = readCurve(second)
    await vi.advanceTimersByTimeAsync(0)
    bus.deliver(curveReply(OTHER_CURVE, { src: 23, dst: 100 }))
    bus.deliver(curveReply(CURVE, { src: 22, dst: 100 }))

    expect(await fromFirst).toEqual({ status: 'answered', value: [CURVE] })
    expect(await fromSecond).toEqual({ status: 'answered', value: [OTHER_CURVE] })
  })

  it('reports each change of location to its owner', () => {
    const seen: string[] = []
    const connection = new DeviceConnection({
      registry,
      key: DST_KEY,
      createSession: (address) => new DeviceSession({ address, bus, now: () => Date.now() }),
      onChange: (location) => seen.push(`${location.state}@${String(location.address)}`)
    })
    connections.push(connection)

    heard(22)
    heard(23)
    bus.deliver(addressClaim(DST, 31))

    expect(seen).toEqual(['present@22', 'present@31'])
  })

  it('tells an in-flight request when another device takes the address', async () => {
    const connection = connect(DST_KEY)
    heard(22)
    const pending = readCurve(connection)
    await vi.advanceTimersByTimeAsync(0)

    bus.deliver(addressClaim({ uniqueNumber: 5, manufacturerCode: 'Garmin' }, 22))

    expect(await pending).toEqual({
      status: 'unknown',
      reason: 'The device no longer holds address 22'
    })
    expect(connection.session).toBeNull()
  })

  it('opens the session on a later change when creating it failed', () => {
    let failures = 1
    const connection = new DeviceConnection({
      registry,
      key: DST_KEY,
      createSession: (address) => {
        if (failures > 0) {
          failures -= 1
          throw new Error('subscribe failed')
        }
        return new DeviceSession({ address, bus, now: () => Date.now() })
      }
    })
    connections.push(connection)

    heard(22)

    expect(connection.session).toBeNull()

    heard(23)

    expect(connection.session?.address).toBe(22)
    expect(connection.location).toEqual({ state: 'present', address: 22 })
  })

  it('closes its session and stops following the device when closed', async () => {
    const connection = connect(DST_KEY)
    heard(22)
    const pending = readCurve(connection)
    await vi.advanceTimersByTimeAsync(0)

    connection.close()
    bus.deliver(addressClaim(DST, 31))

    expect((await pending).status).toBe('unknown')
    expect(connection.session).toBeNull()
  })
})
