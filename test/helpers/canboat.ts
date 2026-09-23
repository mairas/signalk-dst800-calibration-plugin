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
 * A parser that primes itself before its first real input.
 *
 * canboatjs cannot reassemble a single-line fast packet as a parser's very
 * first input. Without priming a suite is order-dependent: a `-t` filter that
 * runs a 126720 case first sees a spurious failure.
 */
function primedParser(options: { resolveEnums?: boolean }): (line: string) => DecodedPgn {
  const parser = new FromPgn(options)
  let primed = false
  return (line) => {
    if (!primed) {
      primed = true
      parser.parseString(encode(requestSpeedCurve(35)))
    }
    return parser.parseString(line) as unknown as DecodedPgn
  }
}

const named = primedParser({})
const raw = primedParser({ resolveEnums: false })

export const decode = (message: OutgoingPgn): DecodedPgn => named(encode(message))

/**
 * Decode a literal Actisense line, as a device's frame arrives.
 *
 * `resolveEnums: false` is a real `FromPgn` option, and the server passes a
 * provider's options straight through to `FromPgn`, so a lookup field can
 * reach the plugin as its raw number.
 */
export const decodeLine = (line: string, options: { resolveEnums?: boolean } = {}): DecodedPgn =>
  options.resolveEnums === false ? raw(line) : named(line)
