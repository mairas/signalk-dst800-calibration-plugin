import { describe, it, expect } from 'vitest'
import type { ServerAPI } from '@signalk/server-api'
import { onN2k, sendN2k, type DecodedPgn } from '../../src/protocol/n2kAdapter.js'
import { masterReset } from '../../src/protocol/codec.js'

interface FakeBus extends Record<string, unknown> {
  emitted: { event: string; message: unknown }[]
  handlers: Map<string, ((pgn: DecodedPgn) => void)[]>
  deliver(pgn: DecodedPgn): void
}

const createBus = (): FakeBus => {
  const handlers = new Map<string, ((pgn: DecodedPgn) => void)[]>()
  const emitted: { event: string; message: unknown }[] = []
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
  }
}

describe('n2k adapter', () => {
  it('sends on the JSON event, never the raw one', () => {
    const bus = createBus()

    sendN2k(bus as unknown as ServerAPI, masterReset(35))

    expect(bus.emitted.map((e) => e.event)).toEqual(['nmea2000JsonOut'])
  })

  it('delivers decoded PGNs to the handler', () => {
    const bus = createBus()
    const seen: DecodedPgn[] = []
    onN2k(bus as unknown as ServerAPI, (pgn) => seen.push(pgn))

    bus.deliver({ pgn: 65409, src: 35 })

    expect(seen).toEqual([{ pgn: 65409, src: 35 }])
  })

  it('stops delivering once unsubscribed', () => {
    const bus = createBus()
    const seen: DecodedPgn[] = []
    const off = onN2k(bus as unknown as ServerAPI, (pgn) => seen.push(pgn))

    off()
    bus.deliver({ pgn: 65409, src: 35 })

    expect(seen).toEqual([])
    expect(bus.handlers.get('N2KAnalyzerOut')).toEqual([])
  })
})
