import { pgnToActisenseSerialFormat, FromPgn } from '@canboat/canboatjs'
import type { PGN } from '@canboat/ts-pgns'
import type { DecodedPgn, OutgoingPgn } from '../../src/protocol/messages.js'
import { requestSpeedCurve } from '../../src/protocol/codec.js'

/**
 * canboatjs types its encoder against an abstract PGN class, while both this
 * codec and the server's own code pass plain object literals. One cast, here.
 */
export const encode = (message: OutgoingPgn): string =>
  pgnToActisenseSerialFormat(message as unknown as PGN)

/** The Actisense line minus its prefix: timestamp, prio, pgn, src, dst, len. */
export const payload = (message: OutgoingPgn): string =>
  encode(message).split(',').slice(6).join(',')

/**
 * canboatjs cannot reassemble a single-line fast packet as a parser's very
 * first input, so prime it once. Without this a suite is order-dependent: a
 * `-t` filter that runs a 126720 case first sees a spurious failure.
 */
const parser = new FromPgn()
let primed = false

export const decode = (message: OutgoingPgn): DecodedPgn => {
  if (!primed) {
    primed = true
    parser.parseString(encode(requestSpeedCurve(35)))
  }
  return parser.parseString(encode(message)) as unknown as DecodedPgn
}
