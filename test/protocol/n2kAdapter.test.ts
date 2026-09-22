import { describe, it, expect } from 'vitest'
import type { ServerAPI } from '@signalk/server-api'
import type { DecodedPgn } from '../../src/protocol/messages.js'
import { onN2k, sendN2k, sendN2kRaw } from '../../src/protocol/n2kAdapter.js'
import { masterReset, requestSpeedCurve } from '../../src/protocol/codec.js'

interface Emitted {
  event: string
  message: unknown
}

interface FakeBus {
  emitted: Emitted[]
  handlers: Map<string, ((pgn: DecodedPgn) => void)[]>
  deliver(pgn: DecodedPgn): void
}

const createBus = (): FakeBus => {
  const handlers = new Map<string, ((pgn: DecodedPgn) => void)[]>()
  const emitted: Emitted[] = []
  return {
    emitted,
    handlers,
    emit(event: string, message: unknown) {
      emitted.push({ event, message })
      return true
    },
    on(event: string, handler: (pgn: DecodedPgn) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    removeListener(event: string, handler: (pgn: DecodedPgn) => void) {
      handlers.set(
        event,
        (handlers.get(event) ?? []).filter((h) => h !== handler)
      )
    },
    deliver(pgn: DecodedPgn) {
      for (const handler of handlers.get('N2KAnalyzerOut') ?? []) {
        handler(pgn)
      }
    }
  } as FakeBus & { emit: unknown; on: unknown; removeListener: unknown }
}

const asApi = (bus: FakeBus) => bus as unknown as ServerAPI

describe('sending', () => {
  it('sends a group function on the JSON event, unchanged', () => {
    const bus = createBus()
    const message = requestSpeedCurve(35)

    sendN2k(asApi(bus), message)

    expect(bus.emitted).toEqual([{ event: 'nmea2000JsonOut', message }])
  })

  it('sends a pre-encoded frame on the raw event as an Actisense line', () => {
    const bus = createBus()

    sendN2kRaw(asApi(bus), masterReset(35))

    expect(bus.emitted).toHaveLength(1)
    expect(bus.emitted[0].event).toBe('nmea2000out')
    const line = (bus.emitted[0].message as string).split(',')
    // timestamp, prio, pgn, src placeholder, dst, length, then the payload.
    expect(line.slice(1, 6)).toEqual(['3', '126720', '0', '35', '6'])
    expect(line.slice(6).join(',')).toBe('87,98,01,ff,ff,ff')
    expect(Number.isNaN(Date.parse(line[0]))).toBe(false)
  })
})

describe('receiving', () => {
  it('delivers decoded PGNs to the handler', () => {
    const bus = createBus()
    const seen: DecodedPgn[] = []
    onN2k(asApi(bus), (pgn) => seen.push(pgn))

    bus.deliver({ pgn: 65409, src: 35 })

    expect(seen).toEqual([{ pgn: 65409, src: 35 }])
  })

  it('stops delivering once unsubscribed', () => {
    const bus = createBus()
    const seen: DecodedPgn[] = []
    const off = onN2k(asApi(bus), (pgn) => seen.push(pgn))

    off()
    bus.deliver({ pgn: 65409, src: 35 })

    expect(seen).toEqual([])
    expect(bus.handlers.get('N2KAnalyzerOut')).toEqual([])
  })
})
