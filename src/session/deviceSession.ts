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
import { AccessLevelState, type AccessView } from './accessLevel.js'
import { ACK_OK, TEMPORARY_ERROR, isAccessDenied } from './outcome.js'
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

/**
 * The longest the session will stretch its own timeout.
 *
 * A reply that arrives inside the mute window proves the device answers and
 * that the timeout was too short for this bus, so the session widens it rather
 * than repeating the same failure. The cap stops a device that answers once an
 * hour from making every control feel broken.
 */
export const MAX_ADAPTIVE_TIMEOUT_MS = 8000

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
export interface CommandSpec extends BaseSpec {
  /**
   * The device acknowledges only a refusal, so silence is acceptance. A
   * transmission interval Request is one (manual p.15). Silence then costs
   * none of what a timeout costs: no mute, and no count toward forgetting
   * the gateway address.
   */
  silenceMeansAccepted?: boolean
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
   * answer a request, but they can keep the console's cache current. Called
   * after correlation, so a throw here cannot cost a request its answer.
   */
  onObservation?: (pgn: DecodedPgn) => void
  /** Reported instead of thrown, so a bad reply never reaches the server. */
  onError?: (error: unknown) => void
  /**
   * Called after the session unlocks, is refused, or drops its grant. A grant
   * or a refusal lapsing with time is not a change: read `access` for the
   * time left.
   */
  onAccessChange?: () => void
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
  abort(outcome: Outcome<never>): void
}

/**
 * The shape of a reply an abandoned attempt may still receive.
 *
 * The protocol has nothing in a reply naming the request it answers, so once
 * an attempt gives up, any later reply of the same shape is ambiguous. The
 * session mutes that shape for one timeout and, crucially, does not send the
 * next request of it until the mute lapses.
 *
 * Counting the outstanding replies and consuming them was tried and is wrong.
 * The commonest cause of a timeout is a reply that will never arrive —
 * canboatjs drops a fast-packet message that lost a frame — so a debt is
 * usually paid off by the *next* request's legitimate reply, which fails a
 * working device. Where the device is merely slow, the debt is consumed by
 * whichever reply lands first, which is as likely to be the fresh one, and the
 * caller is then handed the stale value under `answered`.
 *
 * Muting and delaying costs latency after a timeout and never a wrong value.
 */
interface Muted {
  acknowledgedPgn: number
  wantsAck: boolean
  dataPgn: number | null
  pid: AirmarPid | null
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
  // Parameter 4 is the proprietary ID only when the target is 126720. It is
  // the access format code in an unlock, whose value 1 would otherwise read
  // back as the master-reset PID.
  if (targetPgn(message) !== PGN.proprietary) {
    return null
  }
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
  if (ack.missingParameterCodes > 0) {
    parts.push(
      `${String(ack.missingParameterCodes)} parameter code(s) missing, so the positions above may be shifted`
    )
  }
  return parts.length > 0 ? parts.join('; ') : 'The device reported an unnamed error'
}

const classify = (ack: AcknowledgeResult): RetryClass => {
  if (isAccessDenied(ack)) {
    return 'accessDenied'
  }
  return ack.parameterErrors.some((e) => e.error === TEMPORARY_ERROR) ? 'temporary' : 'none'
}

const CLOSED_REASON = 'The session was closed'

export class DeviceSession {
  /** The source address this session is bound to for its life. */
  readonly address: number
  private readonly bus: Bus
  private readonly onObservation: ((pgn: DecodedPgn) => void) | undefined
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly timeoutMs: number
  private readonly now: () => number
  private readonly unsubscribe: () => void

  private readonly level1 = new AccessLevelState()
  private readonly onAccessChange: (() => void) | undefined
  private readonly queue: (() => Promise<void>)[] = []
  private readonly coalesced = new Map<
    string,
    { spec: ReadSpec<never>; promise: Promise<Outcome<unknown[]>> }
  >()
  private muted: Muted[] = []
  private adaptiveTimeoutMs: number
  private draining = false
  private inFlight: InFlight | null = null
  /** Null while the session is open; what every later operation reports once closed. */
  private closedOutcome: { status: 'unknown'; reason: string } | null = null

  private consecutiveTimeouts = 0
  private gateway: number | null = null
  private gatewayCandidate: number | null = null

  constructor(options: DeviceSessionOptions) {
    this.address = options.address
    this.bus = options.bus
    this.onObservation = options.onObservation
    this.onError = options.onError
    this.onAccessChange = options.onAccessChange
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.adaptiveTimeoutMs = this.timeoutMs
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

  /** Why the session was closed, or null while it is open. */
  get closedReason(): string | null {
    return this.closedOutcome?.reason ?? null
  }

  /** How long the next request waits for its answer, after any widening. */
  get currentTimeoutMs(): number {
    return this.adaptiveTimeoutMs
  }

  /** Tell the owner the access level changed. Never throws: it runs inside the queue. */
  private accessChanged(): void {
    try {
      this.onAccessChange?.()
    } catch (error) {
      this.report(error)
    }
  }

  get access(): AccessView {
    return this.level1.view(this.now())
  }

  get level1Unavailable(): boolean {
    return this.level1.isUnavailable(this.now())
  }

  /**
   * Ask the device for data.
   *
   * Identical reads coalesce: several browser tabs opening one panel put a
   * single frame on the bus. Two reads join only when their frame, decoder and
   * options all match, so a caller never receives values decoded for someone
   * else. A decoder built fresh at each call site never joins, which costs a
   * frame rather than correctness.
   */
  read<T>(spec: ReadSpec<T>): Promise<Outcome<T[]>> {
    const key = JSON.stringify(spec.message)
    const existing = this.coalesced.get(key)
    // The same frame is not the same operation: two callers can ask one
    // question and want different things decoded out of the answer. Join only
    // when the decoder and the reply budget agree as well.
    if (
      existing !== undefined &&
      existing.spec.match === (spec.match as unknown) &&
      existing.spec.expectedReplies === spec.expectedReplies &&
      existing.spec.timeoutMs === spec.timeoutMs &&
      existing.spec.requiresLevel1 === spec.requiresLevel1
    ) {
      return existing.promise as Promise<Outcome<T[]>>
    }
    if (existing !== undefined) {
      return this.enqueue(() => this.run(spec))
    }
    const promise = this.enqueue(() => this.run(spec))
    this.coalesced.set(key, { spec: spec as unknown as ReadSpec<never>, promise })
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
   * anyway so they cannot land while a request is in flight. With no reply,
   * a refused frame looks like any other, so the session unlocks right before
   * sending one. Both drop the device's access level, so the session forgets
   * its grant and its learned address afterwards.
   */
  async sendRaw(
    message: OutgoingRaw,
    options: { requiresLevel1?: boolean } = {}
  ): Promise<Outcome<void>> {
    const outcome = await this.enqueue(async () => {
      const closed = this.refusedAfterClose()
      if (closed !== null) {
        return closed
      }
      if (options.requiresLevel1 === true) {
        // Nothing answers this frame, so a grant the device dropped at a power
        // cycle would cost it silently. Unlock afresh rather than trust the record.
        this.level1.forget()
        this.accessChanged()
        const blocked = await this.ensureLevel1()
        if (blocked !== null) {
          return blocked
        }
      }
      try {
        this.bus.send(message)
      } catch (error) {
        this.report(error)
        return { status: 'unknown', reason: 'The frame could not be put on the bus' }
      }
      this.level1.forget()
      this.accessChanged()
      this.forgetGateway()
      return { status: 'answered', value: [] }
    })
    return outcome.status === 'answered' ? { status: 'answered', value: undefined } : outcome
  }

  /**
   * Send a command and then, if `readAfter` asks for one, a read, in one queue
   * slot.
   *
   * Nothing queued behind the command can run between the two. As separate
   * operations, a second write to the same setting would land between the
   * first write and its read-back, and the first would report the second's
   * value as what the device stored. `readAfter` sees the command's outcome
   * and returns null to skip the read.
   */
  commandThenRead<T>(
    command: CommandSpec,
    readAfter: (outcome: Outcome<void>) => ReadSpec<T> | null
  ): Promise<{ command: Outcome<void>; read: Outcome<T[]> | null }> {
    return this.enqueueTask(
      async () => {
        const sent = await this.run(command)
        const outcome: Outcome<void> =
          sent.status === 'answered' ? { status: 'answered', value: undefined } : sent
        const spec = readAfter(outcome)
        return { command: outcome, read: spec === null ? null : await this.run(spec) }
      },
      (outcome) => ({ command: outcome, read: null })
    )
  }

  /**
   * Raise the access level now, with no operation to protect.
   *
   * For a caller that needs the grant held before a sequence of reads, such
   * as a capability probe, whose reads do not ask for Level 1 themselves.
   */
  async unlock(): Promise<Outcome<void>> {
    const outcome = await this.enqueue<never>(async () => {
      const closed = this.refusedAfterClose()
      if (closed !== null) {
        return closed
      }
      return (await this.ensureLevel1()) ?? { status: 'answered', value: [] }
    })
    return outcome.status === 'answered' ? { status: 'answered', value: undefined } : outcome
  }

  /**
   * Stop listening and fail everything outstanding. Safe to call twice.
   *
   * `reason` reaches every caller still waiting, so the owner can say why —
   * that the device moved, rather than that something closed.
   */
  close(reason: string = CLOSED_REASON): void {
    if (this.closedOutcome !== null) {
      return
    }
    const outcome = { status: 'unknown' as const, reason }
    this.closedOutcome = outcome
    this.unsubscribe()
    this.inFlight?.abort(outcome)
  }

  /**
   * The session's own refusal of a frame it has not sent by `close()`.
   *
   * Rejected, not unknown, for the same reason as a full queue: the frame never
   * reached the bus. A request already in flight when the session closes stays
   * unknown, because its frame did.
   */
  private refusedAfterClose(): Outcome<never> | null {
    return this.closedOutcome === null
      ? null
      : { status: 'rejected', reason: this.closedOutcome.reason }
  }

  private enqueue<T>(task: () => Promise<Outcome<T[]>>): Promise<Outcome<T[]>> {
    return this.enqueueTask(task, (outcome) => outcome)
  }

  /**
   * Queue one task, whatever it returns.
   *
   * `refused` turns the session's own refusal into the task's result type:
   * the queue was full, or the task threw.
   */
  private enqueueTask<R>(
    task: () => Promise<R>,
    refused: (outcome: Outcome<never>) => R
  ): Promise<R> {
    if (this.queue.length >= MAX_QUEUE_DEPTH) {
      // Rejected, not unknown: the session knows this frame never reached the
      // bus, and a console that cannot tell that from a lost write will
      // encourage the user to write EEPROM again.
      return Promise.resolve(
        refused({ status: 'rejected', reason: 'The device has a backlog of unanswered requests' })
      )
    }
    return new Promise<R>((resolve) => {
      this.queue.push(async () => {
        try {
          resolve(await task())
        } catch (error) {
          // Settle first, report second. A task must always settle its caller,
          // and `onError` belongs to the host: a logger that throws during
          // shutdown would otherwise leave the promise pending for ever and
          // raise an unhandled rejection out of the drain.
          resolve(
            refused({ status: 'unknown', reason: 'The operation failed before it was answered' })
          )
          this.report(error)
        }
      })
      this.startDraining()
    })
  }

  /** A drain failure must never surface as an unhandled rejection. */
  private startDraining(): void {
    this.drain().catch((error: unknown) => {
      this.report(error)
    })
  }

  /** Report a failure to the host without letting the host's failure escape. */
  private report(error: unknown): void {
    try {
      this.onError?.(error)
    } catch {
      // A reporter that throws is not worth losing the process over.
    }
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
    const closed = this.refusedAfterClose()
    if (closed !== null) {
      return closed
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
        this.level1.recordDenied()
        this.accessChanged()
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
    if (this.level1.isUnavailable(this.now())) {
      return { status: 'rejected', reason: 'Access Level 1 is unavailable on this device' }
    }
    if (!this.level1.needsUnlock(this.now())) {
      return null
    }
    const result = await this.attempt<never>({ message: unlockLevel1(this.address) })
    const closed = this.refusedAfterClose()
    if (closed !== null) {
      // The operation that needed the unlock never went out.
      return closed
    }
    if (result.outcome.status === 'answered') {
      this.level1.recordUnlock(this.now())
      this.accessChanged()
      return null
    }
    if (result.outcome.status === 'rejected') {
      const final = this.level1.recordRefusal(this.now())
      this.accessChanged()
      const reason = final
        ? `Access Level 1 is unavailable on this device: ${result.outcome.reason}`
        : `Access Level 1 refused: ${result.outcome.reason}`
      return { status: 'rejected', reason, detail: result.detail }
    }
    return result.outcome
  }

  private async attempt<T>(spec: ReadSpec<T> | CommandSpec): Promise<AttemptResult<T>> {
    // Do not race a reply that may still be coming for an abandoned request of
    // this shape. Waiting costs latency once; sending into the ambiguity costs
    // a wrong answer or a working device that never succeeds again.
    const quietIn = this.muteRemaining(spec)
    if (quietIn > 0) {
      await new Promise<void>((wake) => setTimeout(wake, quietIn))
    }
    return this.startAttempt(spec)
  }

  private startAttempt<T>(spec: ReadSpec<T> | CommandSpec): Promise<AttemptResult<T>> {
    return new Promise<AttemptResult<T>>((resolve) => {
      const closed = this.refusedAfterClose()
      if (closed !== null) {
        // Not sent. Nothing earlier in this operation was applied either: a
        // retry follows only a refusal the device gave.
        resolve({ outcome: closed, retry: 'none' })
        return
      }

      const match = 'match' in spec ? spec.match : undefined
      const expected = 'expectedReplies' in spec ? (spec.expectedReplies ?? 1) : 1
      const wantPid = requestedPid(spec.message)
      const ackPgn = targetPgn(spec.message)
      const timeoutMs = spec.timeoutMs ?? this.adaptiveTimeoutMs
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
        if ('silenceMeansAccepted' in spec && spec.silenceMeansAccepted === true) {
          // Not through finish(): silence proves nothing about the address,
          // so it must not clear the timeouts that came before it.
          settled = true
          this.inFlight = null
          resolve({ outcome: { status: 'answered', value: collected }, retry: 'none' })
          return
        }
        // Remember what this attempt is still owed, so the next request of the
        // same shape cannot adopt a reply that was meant for this one.
        this.muted.push({
          acknowledgedPgn: ackPgn,
          wantsAck: match === undefined,
          dataPgn: match === undefined ? null : ackPgn,
          pid: wantPid,
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
        abort: (outcome) => {
          finish({ outcome, retry: 'none' })
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
          // A repeated reply is one reply. Keyed on the frame's own fields,
          // not on the decoded value: two filter types carrying identical
          // settings decode equal, and deduping on that would discard a
          // genuinely distinct reply and strand the read one short.
          const token = JSON.stringify(pgn.fields)
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
        this.report(error)
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
    if (this.closedOutcome !== null || pgn.src !== this.address) {
      return
    }
    try {
      const ack = decodeAcknowledge(pgn)
      // Settle the debt first, and always. A late reply usually arrives while
      // the session is idle, and leaving the debt outstanding would make the
      // *next* request pay it with its own legitimate reply.
      if (this.isMuted(pgn, ack)) {
        // The device answered a request this session gave up on. That is
        // evidence the timeout is short for this bus, not that the device is
        // unreliable, so widen it before the next attempt.
        this.widenTimeout()
      } else if (this.inFlight !== null && this.addressedHere(pgn)) {
        this.inFlight.onReply(pgn, ack)
      }
    } catch (error) {
      this.report(error)
    }
    try {
      this.onObservation?.(pgn)
    } catch (error) {
      this.report(error)
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

  /** Every mute that has not lapsed. */
  private liveMutes(): Muted[] {
    const now = this.now()
    this.muted = this.muted.filter((m) => m.expiresAt > now)
    return this.muted
  }

  private matches(m: Muted, pgn: DecodedPgn, ack: AcknowledgeResult | null): boolean {
    if (ack !== null) {
      return m.wantsAck && ack.acknowledgedPgn === m.acknowledgedPgn
    }
    // Never match on an unknown data shape: a null PID would otherwise match
    // every depth and speed frame the device emits several times a second.
    return m.dataPgn !== null && pgn.pgn === m.dataPgn && replyPid(pgn) === m.pid
  }

  /** Whether this reply could belong to an attempt that already gave up. */
  private isMuted(pgn: DecodedPgn, ack: AcknowledgeResult | null): boolean {
    return this.liveMutes().some((m) => this.matches(m, pgn, ack))
  }

  /** How long until no mute covers the shape this spec will ask for. */
  private muteRemaining(spec: ReadSpec<unknown> | CommandSpec): number {
    const wantsAck = !('match' in spec)
    const ackPgn = targetPgn(spec.message)
    const pid = requestedPid(spec.message)
    const now = this.now()
    return this.liveMutes()
      .filter((m) =>
        wantsAck
          ? m.wantsAck && m.acknowledgedPgn === ackPgn
          : m.dataPgn === ackPgn && m.pid === pid
      )
      .reduce((longest, m) => Math.max(longest, m.expiresAt - now), 0)
  }

  private widenTimeout(): void {
    this.adaptiveTimeoutMs = Math.min(this.adaptiveTimeoutMs * 2, MAX_ADAPTIVE_TIMEOUT_MS)
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
    // Those timeouts may have been caused by the wrong address rather than by
    // the device, so the shapes they muted prove nothing about what is still
    // in flight. Keeping them would delay every request of the recovery.
    this.muted = []
  }
}
