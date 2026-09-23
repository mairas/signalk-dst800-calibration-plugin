import type { DecodedPgn, OutgoingPgn, OutgoingRaw } from '../../src/protocol/messages.js'
import type { Bus } from '../../src/session/deviceSession.js'

/**
 * A bus that records what was sent and delivers exactly what a test asks for.
 *
 * Dropping, delaying, duplicating and misattributing a frame are all choices
 * about what a test calls `deliver` with, so none needs support here. Failing
 * to send does: the server's `emit` re-throws a listener's exception, and no
 * test can reach that path without a bus that can refuse.
 */
export class FakeBus implements Bus {
  readonly sent: (OutgoingPgn | OutgoingRaw)[] = []
  private handlers: ((pgn: DecodedPgn) => void)[] = []

  /** Throw from the nth send onwards, counting from 1. */
  failFrom: number | null = null

  send(message: OutgoingPgn | OutgoingRaw): void {
    if (this.failFrom !== null && this.sent.length + 1 >= this.failFrom) {
      throw new Error('nmea2000out provider is down')
    }
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
