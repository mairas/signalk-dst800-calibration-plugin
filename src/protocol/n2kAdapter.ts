/**
 * The boundary with the server's untyped NMEA 2000 events.
 *
 * `nmea2000out`, `nmea2000JsonOut` and `N2KAnalyzerOut` are real and used by
 * the server itself, but none is part of the typed `ServerAPI`. The server
 * widens its own app type the same way. Keep that widening here, so a server
 * change breaks one file.
 */

import type { ServerAPI } from '@signalk/server-api'
import type { DecodedPgn, OutgoingPgn, OutgoingRaw } from './messages.js'

export type { DecodedPgn, OutgoingPgn, OutgoingRaw } from './messages.js'

type N2kHandler = (pgn: DecodedPgn) => void

interface N2kEvents {
  emit(event: 'nmea2000JsonOut', message: OutgoingPgn): boolean
  emit(event: 'nmea2000out', line: string): boolean
  on(event: 'N2KAnalyzerOut', handler: N2kHandler): unknown
  removeListener(event: 'N2KAnalyzerOut', handler: N2kHandler): unknown
}

const events = (app: ServerAPI): N2kEvents => app as unknown as N2kEvents

/** Put a message on the bus. The server's provider encodes it with canboatjs. */
export function sendN2k(app: ServerAPI, message: OutgoingPgn): void {
  events(app).emit('nmea2000JsonOut', message)
}

/**
 * Put a pre-encoded frame on the bus, bypassing canboatjs.
 *
 * Only for the two messages canboatjs cannot encode; see pids.ts. The provider
 * passes a string through untouched apart from rewriting the source address,
 * so the placeholder below is replaced with the gateway's own.
 */
export function sendN2kRaw(app: ServerAPI, message: OutgoingRaw): void {
  const line = [
    new Date().toISOString(),
    message.prio,
    message.pgn,
    0,
    message.dst,
    message.payload.split(',').length,
    message.payload
  ].join(',')
  events(app).emit('nmea2000out', line)
}

/**
 * Subscribe to every decoded PGN on the bus.
 *
 * This is a firehose covering every device, so filter by `pgn` and `src`
 * immediately. Returns the unsubscribe; callers must invoke it in stop().
 */
export function onN2k(app: ServerAPI, handler: N2kHandler): () => void {
  events(app).on('N2KAnalyzerOut', handler)
  return () => {
    events(app).removeListener('N2KAnalyzerOut', handler)
  }
}

/**
 * The server's events as a session bus.
 *
 * A pre-encoded frame carries a `payload` and goes out untouched; everything
 * else is canboatjs JSON.
 */
export function createBus(app: ServerAPI): {
  send(message: OutgoingPgn | OutgoingRaw): void
  subscribe(handler: N2kHandler): () => void
} {
  return {
    send: (message) => {
      if ('payload' in message) {
        sendN2kRaw(app, message)
      } else {
        sendN2k(app, message)
      }
    },
    subscribe: (handler) => onN2k(app, handler)
  }
}
