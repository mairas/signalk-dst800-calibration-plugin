/**
 * The three message shapes that cross the boundary with the server.
 *
 * Declared here rather than in either module that uses them: the codec builds
 * the outgoing shapes and consumes the incoming one, while the adapter emits
 * the outgoing shapes and produces the incoming one, so neither can own all
 * three without a cycle.
 */

/** A canboatjs JSON message, for `nmea2000JsonOut`. */
export interface OutgoingPgn {
  pgn: number
  dst: number
  prio: number
  fields: Record<string, unknown>
}

/** A pre-encoded frame, for `nmea2000out`. */
export interface OutgoingRaw {
  pgn: number
  dst: number
  prio: number
  /** Comma-separated payload bytes, without the Actisense line prefix. */
  payload: string
}

/** A PGN as canboatjs hands it to `N2KAnalyzerOut`. */
export interface DecodedPgn {
  pgn: number
  src?: number
  dst?: number
  prio?: number
  fields?: Record<string, unknown>
}
