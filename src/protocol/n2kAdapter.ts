/**
 * The boundary with the server's untyped NMEA 2000 events.
 *
 * `nmea2000JsonOut` and `N2KAnalyzerOut` are real and used by the server
 * itself, but neither is part of the typed `ServerAPI`. The server widens its
 * own app type the same way. Keep that widening here, so a server change
 * breaks one file.
 */

import type { ServerAPI } from '@signalk/server-api'
import type { N2kMessage } from './codec.js'

/** A PGN as canboatjs hands it to `N2KAnalyzerOut`. */
export interface DecodedPgn {
  pgn: number
  src?: number
  dst?: number
  prio?: number
  fields?: Record<string, unknown>
  [key: string]: unknown
}

type N2kHandler = (pgn: DecodedPgn) => void

interface N2kEvents {
  emit(event: 'nmea2000JsonOut', message: N2kMessage): boolean
  on(event: 'N2KAnalyzerOut', handler: N2kHandler): unknown
  removeListener(event: 'N2KAnalyzerOut', handler: N2kHandler): unknown
}

const events = (app: ServerAPI): N2kEvents => app as unknown as N2kEvents

/** Put a message on the bus. The server's provider encodes it with canboatjs. */
export function sendN2k(app: ServerAPI, message: N2kMessage): void {
  events(app).emit('nmea2000JsonOut', message)
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
