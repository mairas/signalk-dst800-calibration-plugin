/**
 * One serial conversation with one device.
 *
 * Airmar's messages carry no transaction id, so a reply can only be tied to a
 * request structurally: by the source address it came from, the address it was
 * sent to, and the fact that exactly one request is outstanding. Everything
 * here follows from that — the queue exists to keep the correlation sound, not
 * to pace the bus.
 */

import { decodeAcknowledge, unlockLevel1 } from '../protocol/codec.js'
import type { AcknowledgeResult } from '../protocol/codec.js'
import type { DecodedPgn, OutgoingPgn, OutgoingRaw } from '../protocol/messages.js'
import { PGN } from '../protocol/pids.js'
import { AccessLevelState } from './accessLevel.js'
import { ACCESS_DENIED, ACK_OK, TEMPORARY_ERROR } from './outcome.js'
import type { Outcome } from './outcome.js'

/** Long enough for a fast-packet reply over a loaded bus, short enough to retry. */
export const DEFAULT_TIMEOUT_MS = 2000

const GLOBAL_ADDRESS = 255

export interface Bus {
  send(message: OutgoingPgn | OutgoingRaw): void
  /** Every decoded PGN on the bus, from every device. Returns the unsubscribe. */
  subscribe(handler: (pgn: DecodedPgn) => void): () => void
}

export interface RequestSpec<T> {
  /**
   * Coalescing key. Two operations with the same key are the same operation:
   * several browser tabs opening the same panel put one frame on the bus.
   */
  key: string
  message: OutgoingPgn
  /** The PGN a 126208 Acknowledge names when it answers this operation. */
  acknowledgedPgn: number
  /**
   * Recognise a data reply and decode it. Leave it out for a command, which is
   * answered by the acknowledgement alone.
   */
  match?: (reply: DecodedPgn) => T | null
  /**
   * How many data replies this operation expects. PID 43 and 44 requested
   * without the filter-type qualifier answer once per filter type, and PGN
   * 126464 without a function code answers with two lists.
   */
  expectedReplies?: number
  requiresLevel1?: boolean
  timeoutMs?: number
}

export interface DeviceSessionOptions {
  /** The device's current NMEA 2000 source address. */
  address: number
  bus: Bus
  /**
   * Every message from this device, correlated or not.
   *
   * A reply addressed to another node, and a reply that arrives after its
   * request timed out, are both still the device's true state. They cannot
   * answer a request, but they can keep the console's cache current.
   */
  onObservation?: (pgn: DecodedPgn) => void
  timeoutMs?: number
}

interface InFlight {
  onReply(reply: DecodedPgn): void
  abort(): void
}

type RetryClass = 'none' | 'temporary' | 'accessDenied'

interface AttemptResult<T> {
  outcome: Outcome<T[]>
  retry: RetryClass
}

const describeAcknowledge = (ack: AcknowledgeResult): string => {
  const parts: string[] = []
  if (ack.pgnError !== ACK_OK) {
    parts.push(ack.pgnError)
  }
  if (ack.intervalPriorityError !== ACK_OK) {
    parts.push(`interval or priority: ${ack.intervalPriorityError}`)
  }
  for (const error of ack.parameterErrors) {
    parts.push(`parameter ${String(error.index)}: ${error.error}`)
  }
  return parts.join('; ')
}

const classify = (ack: AcknowledgeResult): RetryClass => {
  const denied =
    ack.pgnError === ACCESS_DENIED || ack.parameterErrors.some((e) => e.error === ACCESS_DENIED)
  if (denied) {
    return 'accessDenied'
  }
  return ack.parameterErrors.some((e) => e.error === TEMPORARY_ERROR) ? 'temporary' : 'none'
}

export class DeviceSession {
  private readonly address: number
  private readonly bus: Bus
  private readonly onObservation: ((pgn: DecodedPgn) => void) | undefined
  private readonly timeoutMs: number
  private readonly unsubscribe: () => void

  private readonly access = new AccessLevelState()
  private readonly queue: (() => Promise<void>)[] = []
  private readonly coalesced = new Map<string, Promise<Outcome<unknown[]>>>()
  private draining = false
  private inFlight: InFlight | null = null
  private closed = false

  private gateway: number | null = null
  private gatewayCandidate: number | null = null

  constructor(options: DeviceSessionOptions) {
    this.address = options.address
    this.bus = options.bus
    this.onObservation = options.onObservation
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.unsubscribe = options.bus.subscribe((pgn) => {
      this.handle(pgn)
    })
  }

  /**
   * The gateway's own source address, once two replies have agreed on it.
   *
   * Null until then: nothing in the Signal K server exposes the address
   * canboatjs claimed, so it is inferred from the `dst` of replies that
   * answered this plugin's own requests. One observation is not enough —
   * another configurator's reply arriving mid-request would teach the wrong
   * address and then filter out every real reply. Two agreeing observations
   * cost one extra round trip, and any timeout discards what was learned.
   */
  get gatewayAddress(): number | null {
    return this.gateway
  }

  get level1Unavailable(): boolean {
    return this.access.isUnavailable
  }

  request<T>(spec: RequestSpec<T>): Promise<Outcome<T[]>> {
    const existing = this.coalesced.get(spec.key)
    if (existing !== undefined) {
      return existing as Promise<Outcome<T[]>>
    }
    const promise = this.enqueue(spec)
    this.coalesced.set(spec.key, promise)
    void promise.finally(() => {
      this.coalesced.delete(spec.key)
    })
    return promise
  }

  /** Stop listening and fail everything outstanding. Safe to call twice. */
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.unsubscribe()
    this.inFlight?.abort()
  }

  private enqueue<T>(spec: RequestSpec<T>): Promise<Outcome<T[]>> {
    return new Promise<Outcome<T[]>>((resolve) => {
      this.queue.push(async () => {
        resolve(await this.run(spec))
      })
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return
    }
    this.draining = true
    let task = this.queue.shift()
    while (task !== undefined) {
      await task()
      task = this.queue.shift()
    }
    this.draining = false
  }

  private async run<T>(spec: RequestSpec<T>): Promise<Outcome<T[]>> {
    if (this.closed) {
      return { status: 'unknown', reason: 'The session was closed' }
    }
    if (spec.requiresLevel1 === true) {
      const blocked = await this.ensureLevel1()
      if (blocked !== null) {
        return blocked
      }
    }

    // One retry per cause, not one retry in total: a temporary error after an
    // access-denied retry is a different failure and deserves its own attempt.
    let retriedTemporary = false
    let retriedDenied = false
    for (;;) {
      const result = await this.attempt(spec)
      if (result.retry === 'temporary' && !retriedTemporary) {
        retriedTemporary = true
        continue
      }
      if (result.retry === 'accessDenied' && !retriedDenied) {
        retriedDenied = true
        this.access.recordDenied()
        const blocked = await this.ensureLevel1()
        if (blocked !== null) {
          return blocked
        }
        continue
      }
      return result.outcome
    }
  }

  /**
   * Hold Access Level 1, unlocking if needed.
   *
   * Returns null when the caller may proceed, or the outcome to report when it
   * may not. A refused unlock is sticky: the device has said this product does
   * not offer Level 1, and retrying it would repeat on every later operation.
   * A silent unlock is not sticky, because silence is not a refusal.
   */
  private async ensureLevel1(): Promise<Outcome<never[]> | null> {
    if (this.access.isUnavailable) {
      return { status: 'rejected', reason: 'Access Level 1 is unavailable on this device' }
    }
    if (!this.access.needsUnlock(Date.now())) {
      return null
    }
    const result = await this.attempt<never>({
      key: 'accessLevel1',
      message: unlockLevel1(this.address),
      acknowledgedPgn: PGN.accessLevel
    })
    if (result.outcome.status === 'answered') {
      this.access.recordUnlock(Date.now())
      return null
    }
    if (result.outcome.status === 'rejected') {
      this.access.markUnavailable()
      return { status: 'rejected', reason: `Access Level 1 refused: ${result.outcome.reason}` }
    }
    return result.outcome
  }

  private attempt<T>(spec: RequestSpec<T>): Promise<AttemptResult<T>> {
    return new Promise<AttemptResult<T>>((resolve) => {
      const collected: T[] = []
      const expected = spec.expectedReplies ?? 1
      let settled = false

      const finish = (result: AttemptResult<T>): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        this.inFlight = null
        resolve(result)
      }

      const timer = setTimeout(() => {
        // The learned gateway address is one of the things that can cause
        // silence, so a timeout discards it rather than letting a wrong guess
        // filter out every reply from here on.
        this.forgetGateway()
        finish({
          outcome: { status: 'unknown', reason: 'The device did not answer' },
          retry: 'none'
        })
      }, spec.timeoutMs ?? this.timeoutMs)

      this.inFlight = {
        abort: () => {
          finish({
            outcome: { status: 'unknown', reason: 'The session was closed' },
            retry: 'none'
          })
        },
        onReply: (reply) => {
          const ack = decodeAcknowledge(reply)
          if (ack !== null) {
            if (ack.acknowledgedPgn !== spec.acknowledgedPgn) {
              return
            }
            this.learnGateway(reply)
            if (ack.ok) {
              // A Request Group Function is answered by the data, not by an
              // acknowledgement, so an ok one here means nothing to a read.
              if (spec.match === undefined) {
                finish({ outcome: { status: 'answered', value: collected }, retry: 'none' })
              }
              return
            }
            finish({
              outcome: { status: 'rejected', reason: describeAcknowledge(ack) },
              retry: classify(ack)
            })
            return
          }
          if (spec.match === undefined) {
            return
          }
          const value = spec.match(reply)
          if (value === null) {
            return
          }
          this.learnGateway(reply)
          collected.push(value)
          if (collected.length >= expected) {
            finish({ outcome: { status: 'answered', value: collected }, retry: 'none' })
          }
        }
      }

      this.bus.send(spec.message)
    })
  }

  private handle(reply: DecodedPgn): void {
    if (this.closed || reply.src !== this.address) {
      return
    }
    this.onObservation?.(reply)
    if (this.inFlight === null || !this.addressedHere(reply)) {
      return
    }
    this.inFlight.onReply(reply)
  }

  /**
   * Whether a reply could be an answer to this plugin's request.
   *
   * A global reply cannot be attributed to anyone, so it is allowed through;
   * the serial queue is what makes it usable. An addressed reply belongs to
   * whichever node it names, which is only checkable once the gateway's own
   * address is known.
   */
  private addressedHere(reply: DecodedPgn): boolean {
    if (reply.dst === undefined || reply.dst === GLOBAL_ADDRESS) {
      return true
    }
    return this.gateway === null || reply.dst === this.gateway
  }

  private learnGateway(reply: DecodedPgn): void {
    if (this.gateway !== null || reply.dst === undefined || reply.dst === GLOBAL_ADDRESS) {
      return
    }
    if (this.gatewayCandidate === reply.dst) {
      this.gateway = reply.dst
      return
    }
    this.gatewayCandidate = reply.dst
  }

  private forgetGateway(): void {
    this.gateway = null
    this.gatewayCandidate = null
  }
}
