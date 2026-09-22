import type { DecodedPgn, OutgoingPgn, OutgoingRaw } from '../../src/protocol/messages.js'
import type { Bus } from '../../src/session/deviceSession.js'

/**
 * A bus that records what was sent and delivers exactly what a test asks for.
 *
 * Dropping, delaying, duplicating and misattributing a frame are all just
 * choices about what the test does or does not call `deliver` with, so none of
 * them needs support here.
 */
export class FakeBus implements Bus {
  readonly sent: (OutgoingPgn | OutgoingRaw)[] = []
  private handlers: ((pgn: DecodedPgn) => void)[] = []

  send(message: OutgoingPgn | OutgoingRaw): void {
    this.sent.push(message)
  }

  subscribe(handler: (pgn: DecodedPgn) => void): () => void {
    this.handlers.push(handler)
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler)
    }
  }

  deliver(message: DecodedPgn): void {
    for (const handler of [...this.handlers]) {
      handler(message)
    }
  }

  /** The target PGNs of the group functions sent so far, in order. */
  targets(): number[] {
    return this.sent.map((m) => ('fields' in m ? Number(m.fields.pgn) : m.pgn))
  }
}
