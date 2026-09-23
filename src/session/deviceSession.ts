/**
 * One serial conversation with one device.
 *
 * Airmar's messages carry no transaction id, so a reply can only be tied to a
 * request structurally: by the source address it came from, the address it was
 * sent to, the proprietary ID it carries, and the fact that exactly one
 * request is outstanding. The queue exists to keep that correlation sound, not
 * to pace the bus.
 *
 * A session is bound to one source address for its life. The address changes
 * on an NMEA 2000 re-claim, and this plugin's own master reset causes one, so
 * the owner must close the session and build a new one rather than expect it
 * to follow the device.
 *
 * One session per device. Two sessions on one address each see the other's
 * replies and can adopt them, because nothing on the wire says which of them
 * asked.
 */

import { decodeAcknowledge, unlockLevel1 } from '../protocol/codec.js'
import type { AcknowledgeResult } from '../protocol/codec.js'
import type { DecodedPgn, OutgoingPgn, OutgoingRaw } from '../protocol/messages.js'
import { AirmarPid, PARAM, PGN, pidFromName } from '../protocol/pids.js'
import { AccessLevelState } from './accessLevel.js'
import { ACCESS_DENIED, ACK_OK, TEMPORARY_ERROR } from './outcome.js'
import type { Outcome } from './outcome.js'

/**
 * Long enough for a fast-packet reply over a loaded bus.
 *
 * Do not shorten it. A timeout is not only a retry trigger here: it abandons a
 * reply the device may still send, and two in a row discard the learned
 * gateway address.
 */
export const DEFAULT_TIMEOUT_MS = 2000

/**
 * How many queued operations before the session refuses more.
 *
 * A silent device costs a full timeout per queued operation, so an unbounded
 * queue turns an offline sensor into a console whose every control is stuck
 * behind minutes of backlog. Refusing is information the UI can show.
 */
export const MAX_QUEUE_DEPTH = 32

/** Two consecutive timeouts before the learned gateway address is discarded. */
const TIMEOUTS_BEFORE_FORGETTING_GATEWAY = 2

const GLOBAL_ADDRESS = 255

export interface Bus {
  send(message: OutgoingPgn | OutgoingRaw): void
  /** Every decoded PGN on the bus, from every device. Returns the unsubscribe. */
  subscribe(handler: (pgn: DecodedPgn) => void): () => void
}

interface BaseSpec {
  message: OutgoingPgn
  requiresLevel1?: boolean
  timeoutMs?: number
}

/** An operation answered by the device's data. */
export interface ReadSpec<T> extends BaseSpec {
  /** Recognise and decode a data reply. Return null for anything else. */
  match: (reply: DecodedPgn) => T | null
  /**
   * How many distinct data replies this operation expects. PID 43 and 44
   * requested without the filter-type qualifier answer once per filter type,
   * and PGN 126464 without a function code answers with two lists.
   */
  expectedReplies?: number
}

/** An operation answered by the acknowledgement alone. */
export type CommandSpec = BaseSpec

export interface DeviceSessionOptions {
  /** The device's current NMEA 2000 source address. */
  address: number
  bus: Bus
  /**
   * Every message from this device, correlated or not.
   *
   * A reply addressed to another node, and a reply that arrives after its
   * request timed out, are both still the device's true state. They cannot
   * answer a request, but they can keep the console's cache current. Called
   * after correlation, so a throw here cannot cost a request its answer.
   */
  onObservation?: (pgn: DecodedPgn) => void
  /** Reported instead of thrown, so a bad reply never reaches the server. */
  onError?: (error: unknown) => void
  timeoutMs?: number
  /**
   * Monotonic milliseconds, for the Access Level lifetime and the late-reply
   * window. Not the wall clock: a vessel's Pi has no RTC and steps its clock
   * when GPS lands.
   */
  now?: () => number
}

interface InFlight {
  onReply(pgn: DecodedPgn, ack: AcknowledgeResult | null): void
  abort(): void
}

/**
 * A reply an abandoned attempt is still owed.
 *
 * Without this the next request adopts the previous one's late reply: the
 * shapes are identical, because the protocol has nothing in a reply that says
 * which request it answers.
 */
interface Abandoned {
  acknowledgedPgn: number
  pid: AirmarPid | null
  owed: number
  expiresAt: number
}

type RetryClass = 'none' | 'temporary' | 'accessDenied'

interface AttemptResult<T> {
  outcome: Outcome<T[]>
  retry: RetryClass
  detail?: AcknowledgeResult
}

/** The PGN a group function targets, which is also the PGN its Acknowledge names. */
function targetPgn(message: OutgoingPgn): number {
  const pgn = message.fields.pgn
  if (typeof pgn !== 'number') {
    throw new Error('A group function must name the PGN it targets in fields.pgn')
  }
  return pgn
}

/**
 * The proprietary ID a 126720 request asks for, read back out of the frame.
 *
 * Derived rather than declared: a caller that restated it could disagree with
 * the message, and the disagreement would show up only as a silent timeout.
 */
function requestedPid(message: OutgoingPgn): AirmarPid | null {
  const list = message.fields.list
  if (!Array.isArray(list)) {
    return null
  }
  const entry = (list as { parameter?: unknown; value?: unknown }[]).find(
    (p) => p.parameter === PARAM.proprietaryId
  )
  return entry === undefined ? null : pidFromName(entry.value)
}

const replyPid = (pgn: DecodedPgn): AirmarPid | null =>
  pgn.pgn === PGN.proprietary ? pidFromName(pgn.fields?.proprietaryId) : null

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
  return parts.length > 0 ? parts.join('; ') : 'The device reported an unnamed error'
}

const classify = (ack: AcknowledgeResult): RetryClass => {
  const denied =
    ack.pgnError === ACCESS_DENIED || ack.parameterErrors.some((e) => e.error === ACCESS_DENIED)
  if (denied) {
    return 'accessDenied'
  }
  return ack.parameterErrors.some((e) => e.error === TEMPORARY_ERROR) ? 'temporary' : 'none'
}

const CLOSED: Outcome<never> = { status: 'unknown', reason: 'The session was closed' }

export class DeviceSession {
  private readonly address: number
  private readonly bus: Bus
  private readonly onObservation: ((pgn: DecodedPgn) => void) | undefined
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly unsubscribe: () => void

  private readonly access = new AccessLevelState()
  private readonly queue: (() => Promise<void>)[] = []
  private readonly coalesced = new Map<string, Promise<Outcome<unknown[]>>>()
  private abandoned: Abandoned[] = []
  private draining = false
  private inFlight: InFlight | null = null
  private closed = false

  private consecutiveTimeouts = 0
  private gateway: number | null = null
  private gatewayCandidate: number | null = null

  constructor(options: DeviceSessionOptions) {
    this.address = options.address
    this.bus = options.bus
    this.onObservation = options.onObservation
    this.onError = options.onError
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.now = options.now ?? (() => performance.now())
    this.unsubscribe = options.bus.subscribe((pgn) => {
      this.onBusMessage(pgn)
    })
  }

  /**
   * The gateway's own source address, once two separate exchanges agree.
   *
   * Null until then, because nothing in the Signal K server exposes the
   * address canboatjs claimed. It is inferred from the `dst` of the reply that
   * settled a request.
   *
   * The inference is not sound, only recoverable. While the address is unknown
   * every `dst` is accepted, so a reply the device sent to another plotter can
   * settle our request and teach that plotter's address. Requiring the two
   * observations to come from *different* exchanges raises the cost of that to
   * two foreign replies in a row; two consecutive timeouts then discard what
   * was learned, which is what bounds a wrong guess — a wrong address makes
   * every request time out, so recovery is immediate.
   */
  get gatewayAddress(): number | null {
    return this.gateway
  }

  get level1Unavailable(): boolean {
    return this.access.isUnavailable
  }

  /**
   * Ask the device for data.
   *
   * Identical reads coalesce: several browser tabs opening one panel put a
   * single frame on the bus. The key is derived from the frame, so equal keys
   * mean equal frames by construction and two callers can never be joined onto
   * an operation that is not theirs.
   */
  read<T>(spec: ReadSpec<T>): Promise<Outcome<T[]>> {
    const key = JSON.stringify(spec.message)
    const existing = this.coalesced.get(key)
    if (existing !== undefined) {
      return existing as Promise<Outcome<T[]>>
    }
    const promise = this.enqueue(() => this.run(spec))
    this.coalesced.set(key, promise)
    void promise.finally(() => {
      this.coalesced.delete(key)
    })
    return promise
  }

  /**
   * Tell the device to do something.
   *
   * Never coalesced. Two writes under one key carry different values, and
   * joining them would report the first one's success for the second while its
   * value never reached the device.
   */
  async command(spec: CommandSpec): Promise<Outcome<void>> {
    const outcome = await this.enqueue(() => this.run(spec))
    return outcome.status === 'answered' ? { status: 'answered', value: undefined } : outcome
  }

  /**
   * Put a pre-encoded frame on the bus and wait for nothing.
   *
   * Master reset and EEPROM restore are the only two, and neither is
   * acknowledged, so there is no reply to correlate. They go through the queue
   * anyway so they cannot land while a request is in flight, and both drop the
   * device's access level, so the session forgets its grant and its learned
   * address afterwards.
   */
  async sendRaw(
    message: OutgoingRaw,
    options: { requiresLevel1?: boolean } = {}
  ): Promise<Outcome<void>> {
    const outcome = await this.enqueue(async () => {
      if (this.closed) {
        return CLOSED
      }
      if (options.requiresLevel1 === true) {
        const blocked = await this.ensureLevel1()
        if (blocked !== null) {
          return blocked
        }
      }
      try {
        this.bus.send(message)
      } catch (error) {
        this.onError?.(error)
        return { status: 'unknown', reason: 'The frame could not be put on the bus' }
      }
      this.access.forget()
      this.forgetGateway()
      return { status: 'answered', value: [] }
    })
    return outcome.status === 'answered' ? { status: 'answered', value: undefined } : outcome
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

  private enqueue<T>(task: () => Promise<Outcome<T[]>>): Promise<Outcome<T[]>> {
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      return Promise.resolve({
        status: 'unknown',
        reason: 'The device has a backlog of unanswered requests'
      })
    }
    return new Promise<Outcome<T[]>>((resolve) => {
      this.queue.push(async () => {
        try {
          resolve(await task())
        } catch (error) {
          // A task must always settle its caller. Letting the rejection escape
          // would leave the promise pending for ever and, before the finally
          // below existed, wedge the drain loop for every later request.
          this.onError?.(error)
          resolve({ status: 'unknown', reason: 'The operation failed before it was answered' })
        }
      })
      void this.drain()
    })
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return
    }
    this.draining = true
    // The finally is redundant while the task below catches its own failures,
    // and it stays because the failure it prevents has no recovery: a drain
    // left flagged busy never runs again, so every later request waits for
    // ever with no timeout to end it.
    try {
      let task = this.queue.shift()
      while (task !== undefined) {
        await task()
        task = this.queue.shift()
      }
    } finally {
      this.draining = false
    }
  }

  private async run<T>(spec: ReadSpec<T> | CommandSpec): Promise<Outcome<T[]>> {
    if (this.closed) {
      return CLOSED
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
        if (blocked === null) {
          continue
        }
        // The device refused the operation outright. That is firm information,
        // and a re-unlock that then fails must not replace it with silence.
        return result.outcome
      }
      return result.outcome
    }
  }

  /**
   * Hold Access Level 1, unlocking if needed.
   *
   * Returns null when the caller may proceed, or the outcome to report when it
   * may not. Refusals are counted rather than acted on at once, because an
   * unlock is addressed and, before the gateway address is known, the device's
   * refusal of another node's unlock is indistinguishable from a refusal of
   * ours. A silent unlock counts as nothing: silence is not a refusal.
   */
  private async ensureLevel1(): Promise<Outcome<never[]> | null> {
    if (this.access.isUnavailable) {
      return { status: 'rejected', reason: 'Access Level 1 is unavailable on this device' }
    }
    if (!this.access.needsUnlock(this.now())) {
      return null
    }
    const result = await this.attempt<never>({ message: unlockLevel1(this.address) })
    if (result.outcome.status === 'answered') {
      this.access.recordUnlock(this.now())
      return null
    }
    if (result.outcome.status === 'rejected') {
      const final = this.access.recordRefusal()
      const reason = final
        ? `Access Level 1 is unavailable on this device: ${result.outcome.reason}`
        : `Access Level 1 refused: ${result.outcome.reason}`
      return { status: 'rejected', reason, detail: result.detail }
    }
    return result.outcome
  }

  private attempt<T>(spec: ReadSpec<T> | CommandSpec): Promise<AttemptResult<T>> {
    return new Promise<AttemptResult<T>>((resolve) => {
      if (this.closed) {
        resolve({ outcome: CLOSED, retry: 'none' })
        return
      }

      const match = 'match' in spec ? spec.match : undefined
      const expected = 'expectedReplies' in spec ? (spec.expectedReplies ?? 1) : 1
      const wantPid = requestedPid(spec.message)
      const ackPgn = targetPgn(spec.message)
      const timeoutMs = spec.timeoutMs ?? this.timeoutMs
      const collected: T[] = []
      const seen = new Set<string>()
      let settled = false

      const finish = (result: AttemptResult<T>, settledBy?: DecodedPgn): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        this.inFlight = null
        this.consecutiveTimeouts = 0
        if (settledBy !== undefined) {
          this.learnGateway(settledBy)
        }
        resolve(result)
      }

      const timer = setTimeout(() => {
        if (settled) {
          return
        }
        // Remember what this attempt is still owed, so the next request of the
        // same shape cannot adopt a reply that was meant for this one.
        this.abandoned.push({
          acknowledgedPgn: ackPgn,
          pid: wantPid,
          owed: Math.max(1, expected - collected.length),
          expiresAt: this.now() + timeoutMs
        })
        this.consecutiveTimeouts += 1
        if (this.consecutiveTimeouts >= TIMEOUTS_BEFORE_FORGETTING_GATEWAY) {
          this.forgetGateway()
        }
        settled = true
        this.inFlight = null
        resolve({
          outcome: {
            status: 'unknown',
            reason:
              collected.length > 0
                ? `The device answered ${String(collected.length)} of ${String(expected)} times`
                : 'The device did not answer'
          },
          retry: 'none'
        })
      }, timeoutMs)

      this.inFlight = {
        abort: () => {
          finish({ outcome: CLOSED, retry: 'none' })
        },
        onReply: (pgn, ack) => {
          if (ack !== null) {
            if (ack.acknowledgedPgn !== ackPgn) {
              return
            }
            if (ack.ok) {
              // A read is answered by the data, not by an acknowledgement, so
              // an ok one says only that the request was understood.
              if (match === undefined) {
                finish({ outcome: { status: 'answered', value: collected }, retry: 'none' }, pgn)
              }
              return
            }
            finish(
              {
                outcome: {
                  status: 'rejected',
                  reason: describeAcknowledge(ack),
                  detail: ack
                },
                retry: classify(ack),
                detail: ack
              },
              pgn
            )
            return
          }
          if (match === undefined) {
            return
          }
          // A 126720 reply that names a different proprietary ID answers some
          // other question the device was asked.
          if (wantPid !== null && replyPid(pgn) !== wantPid) {
            return
          }
          const value = match(pgn)
          if (value === null) {
            return
          }
          // A repeated reply is one reply. Without this a retransmission, or a
          // copy the device sent to another node, fills the reply budget and
          // the genuinely different reply is dropped after the attempt settles.
          const token = JSON.stringify(value)
          if (seen.has(token)) {
            return
          }
          seen.add(token)
          collected.push(value)
          if (collected.length >= expected) {
            finish({ outcome: { status: 'answered', value: collected }, retry: 'none' }, pgn)
          }
        }
      }

      try {
        this.bus.send(spec.message)
      } catch (error) {
        this.onError?.(error)
        clearTimeout(timer)
        settled = true
        this.inFlight = null
        resolve({
          outcome: { status: 'unknown', reason: 'The request could not be put on the bus' },
          retry: 'none'
        })
      }
    })
  }

  /**
   * The bus subscription.
   *
   * Nothing here may throw: this runs inside the server's own event dispatch,
   * where an exception is an uncaught error that stops the Signal K process —
   * on a vessel, the process feeding the autopilot and the anchor alarm.
   */
  private onBusMessage(pgn: DecodedPgn): void {
    if (this.closed || pgn.src !== this.address) {
      return
    }
    try {
      const ack = decodeAcknowledge(pgn)
      if (this.inFlight !== null && this.addressedHere(pgn) && !this.owedElsewhere(pgn, ack)) {
        this.inFlight.onReply(pgn, ack)
      }
    } catch (error) {
      this.onError?.(error)
    }
    try {
      this.onObservation?.(pgn)
    } catch (error) {
      this.onError?.(error)
    }
  }

  /**
   * Whether a reply could be an answer to this plugin's request.
   *
   * A global reply cannot be attributed to anyone, so it is allowed through;
   * the serial queue is what makes it usable. An addressed reply belongs to
   * whichever node it names, which is only checkable once the gateway's own
   * address is known.
   */
  private addressedHere(pgn: DecodedPgn): boolean {
    if (pgn.dst === undefined || pgn.dst === GLOBAL_ADDRESS) {
      return true
    }
    return this.gateway === null || pgn.dst === this.gateway
  }

  /** Whether this reply settles a debt left by an attempt that already gave up. */
  private owedElsewhere(pgn: DecodedPgn, ack: AcknowledgeResult | null): boolean {
    const now = this.now()
    this.abandoned = this.abandoned.filter((a) => a.expiresAt > now && a.owed > 0)
    const waiting = this.abandoned.find((a) =>
      ack !== null ? ack.acknowledgedPgn === a.acknowledgedPgn : replyPid(pgn) === a.pid
    )
    if (waiting === undefined) {
      return false
    }
    waiting.owed -= 1
    return true
  }

  private learnGateway(pgn: DecodedPgn): void {
    if (this.gateway !== null || pgn.dst === undefined || pgn.dst === GLOBAL_ADDRESS) {
      return
    }
    // Only a reply that settled an attempt gets here, and an attempt settles
    // once, so two observations are always two separate exchanges. A
    // multi-reply read cannot teach an address from one foreign answer.
    if (this.gatewayCandidate === pgn.dst) {
      this.gateway = pgn.dst
      return
    }
    this.gatewayCandidate = pgn.dst
  }

  private forgetGateway(): void {
    this.gateway = null
    this.gatewayCandidate = null
  }
}
