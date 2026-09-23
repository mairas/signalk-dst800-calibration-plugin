/**
 * Which devices are on the bus, and where each one is now.
 *
 * The server offers plugins no NMEA 2000 device list, so identity comes from
 * the `/sources` tree, where `@signalk/n2k-signalk` files every Address Claim
 * and Product Information it decodes under `sources[label][address].n2k`.
 * That entry carries a `canName`: the 64-bit NAME printed as hex, from which
 * the numeric manufacturer code and unique number are read exactly.
 * canboatjs renders the manufacturer as a name wherever it knows one, so the
 * decoded claim alone cannot give the number a `DeviceKey` persists.
 *
 * The tree lags the bus and the server restores it from a cache at boot, so
 * it is never the last word on where a device is. Address Claims heard on the
 * bus override it, and presence comes only from frames heard since start.
 *
 * Candidates are not filtered by manufacturer. The same Airmar hardware is
 * sold under other brands, and a rebadged unit claims its brand's code while
 * still speaking Airmar's proprietary protocol. Whether a device is
 * configurable is the probe's question, not this module's.
 */

import type { DecodedPgn } from '../protocol/messages.js'
import { PGN } from '../protocol/pids.js'
import { MANUFACTURER_CODE_BITS, UNIQUE_NUMBER_BITS, type DeviceKey } from '../types.js'

/**
 * How long a device stays present after its last frame.
 *
 * Ten periods of the DST's 1 s default transmission rate, so a few lost
 * frames on a loaded bus do not make the console flicker to "waiting".
 */
export const PRESENCE_WINDOW_MS = 10_000

/**
 * How often the registry rereads the tree and ages out silent devices.
 *
 * The tree is updated by the server after the plugin has already heard the
 * claim, and a device that falls silent sends nothing to react to, so both
 * are caught by polling.
 */
const SWEEP_MS = 1000

/** Unicast addresses only: 254 is "cannot claim" and 255 is global. */
const MAX_UNICAST_ADDRESS = 253

const UNIQUE_NUMBER_SHIFT = BigInt(UNIQUE_NUMBER_BITS)
const UNIQUE_NUMBER_MASK = (1n << UNIQUE_NUMBER_SHIFT) - 1n
const MANUFACTURER_MASK = (1n << BigInt(MANUFACTURER_CODE_BITS)) - 1n
const CAN_NAME = /^[0-9a-f]{1,16}$/i

/** A device as the console offers it for selection. */
export interface Candidate {
  key: DeviceKey
  location: Location
  /**
   * The name canboatjs gives the manufacturer, or null where it has only
   * the code, which `key` already carries.
   */
  manufacturerName: string | null
  modelId: string | null
  serial: string | null
}

/**
 * Where a device is now.
 *
 * `waiting` keeps the last known address, if any, so the console can say
 * which address it is waiting on rather than showing stale values as current.
 */
export type Location =
  { state: 'present'; address: number } | { state: 'waiting'; address: number | null }

export interface DeviceRegistryOptions {
  /** The server's `/sources` tree, read fresh on every call. */
  sources: () => unknown
  /** Every decoded PGN on the bus. Returns the unsubscribe. */
  subscribe: (handler: (pgn: DecodedPgn) => void) => () => void
  /** Monotonic milliseconds. */
  now?: () => number
  onError?: (error: unknown) => void
}

interface Claim {
  uniqueNumber: number
  manufacturer: string | number
}

/** A claim heard on the bus, and the address it claimed. 254 means none. */
interface LiveClaim {
  claim: Claim
  address: number
}

interface TreeEntry {
  key: DeviceKey
  address: number
  /** As canboatjs rendered it, which is how a live claim names it too. */
  manufacturer: string | number | null
  modelId: string | null
  serial: string | null
}

/** Read the manufacturer code and unique number out of a CAN NAME in hex. */
export function parseCanName(canName: string): DeviceKey | null {
  if (!CAN_NAME.test(canName)) {
    return null
  }
  const name = BigInt(`0x${canName}`)
  return {
    uniqueNumber: Number(name & UNIQUE_NUMBER_MASK),
    manufacturerCode: Number((name >> UNIQUE_NUMBER_SHIFT) & MANUFACTURER_MASK)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

export const sameKey = (a: DeviceKey, b: DeviceKey): boolean =>
  a.manufacturerCode === b.manufacturerCode && a.uniqueNumber === b.uniqueNumber

/** Distinguishes a manufacturer rendered as the string '135' from the code 135. */
const claimId = (claim: Claim): string => JSON.stringify([claim.uniqueNumber, claim.manufacturer])

const isUnicast = (address: number): boolean =>
  Number.isInteger(address) && address >= 0 && address <= MAX_UNICAST_ADDRESS

/**
 * Every NMEA 2000 leaf in the tree, in tree order, duplicates included.
 *
 * The tree's layout is not ours, so nothing is assumed about it.
 */
function readTree(sources: unknown): TreeEntry[] {
  const entries: TreeEntry[] = []
  if (!isRecord(sources)) {
    return entries
  }
  for (const provider of Object.values(sources)) {
    if (!isRecord(provider)) {
      continue
    }
    for (const leaf of Object.values(provider)) {
      const n2k = isRecord(leaf) ? leaf.n2k : undefined
      if (!isRecord(n2k) || typeof n2k.canName !== 'string') {
        continue
      }
      const key = parseCanName(n2k.canName)
      const address = Number(n2k.src)
      if (key === null || !isUnicast(address)) {
        continue
      }
      const manufacturer = n2k.manufacturerCode
      entries.push({
        key,
        address,
        manufacturer:
          typeof manufacturer === 'string' || typeof manufacturer === 'number'
            ? manufacturer
            : null,
        modelId: text(n2k.modelId),
        serial: text(n2k.modelSerialCode)
      })
    }
  }
  return entries
}

function claimOf(pgn: DecodedPgn): Claim | null {
  const fields = pgn.fields ?? {}
  const { uniqueNumber, manufacturerCode } = fields
  if (
    typeof uniqueNumber !== 'number' ||
    (typeof manufacturerCode !== 'string' && typeof manufacturerCode !== 'number')
  ) {
    return null
  }
  return { uniqueNumber, manufacturer: manufacturerCode }
}

export class DeviceRegistry {
  private readonly sources: () => unknown
  private readonly now: () => number
  private readonly onError: ((error: unknown) => void) | undefined
  private readonly unsubscribe: () => void
  private readonly sweepTimer: ReturnType<typeof setInterval>

  private readonly listeners = new Set<() => void>()
  /**
   * Each device's latest claim heard on the bus since start.
   *
   * Keyed by device, not by address. When a newcomer claims an address that
   * a device already holds, the two arbitrate and the loser claims elsewhere.
   * Until then the incumbent is still at that address, and dropping it on
   * the newcomer's claim would tell the console it had moved.
   */
  private readonly claims = new Map<string, LiveClaim>()
  private readonly lastHeard = new Map<number, number>()
  private signature = ''

  constructor(options: DeviceRegistryOptions) {
    this.sources = options.sources
    this.now = options.now ?? (() => performance.now())
    this.onError = options.onError
    this.signature = this.currentSignature()
    this.unsubscribe = options.subscribe((pgn) => {
      this.onBusMessage(pgn)
    })
    this.sweepTimer = setInterval(() => {
      this.publishIfChanged()
    }, SWEEP_MS)
  }

  /** Every device the tree knows, configurable or not. */
  candidates(): Candidate[] {
    return this.entries().map((entry) => {
      const location = this.locateEntry(entry.key, entry)
      return {
        key: entry.key,
        location,
        manufacturerName: typeof entry.manufacturer === 'string' ? entry.manufacturer : null,
        modelId: entry.modelId,
        serial: entry.serial
      }
    })
  }

  locate(key: DeviceKey): Location {
    return this.locateEntry(
      key,
      this.entries().find((e) => sameKey(e.key, key))
    )
  }

  /**
   * Called when any device appears, moves, or falls silent.
   *
   * Carries no payload: listeners re-read what they track. Returns the
   * unsubscribe.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  close(): void {
    this.unsubscribe()
    clearInterval(this.sweepTimer)
    this.listeners.clear()
  }

  /**
   * One entry per device.
   *
   * A device can appear under several leaves: once per gateway label, and
   * at an old address if the server has not yet dropped it. Where they
   * disagree on the address, the one the device is heard at wins.
   */
  private entries(): TreeEntry[] {
    let leaves: TreeEntry[]
    try {
      leaves = readTree(this.sources())
    } catch (error) {
      this.report(error)
      return []
    }
    const chosen: TreeEntry[] = []
    for (const leaf of leaves) {
      const at = chosen.findIndex((e) => sameKey(e.key, leaf.key))
      if (at === -1) {
        chosen.push(leaf)
      } else if (!this.isPresent(chosen[at].address) && this.isPresent(leaf.address)) {
        chosen[at] = leaf
      }
    }
    return chosen
  }

  private locateEntry(key: DeviceKey, entry: TreeEntry | undefined): Location {
    const address = this.addressOf(key, entry)
    if (address === null) {
      return { state: 'waiting', address: null }
    }
    return this.isPresent(address) ? { state: 'present', address } : { state: 'waiting', address }
  }

  /**
   * A claim heard on the bus wins over the tree, which lags it.
   *
   * A claim is matched to the key by its unique number and by the
   * manufacturer as canboatjs rendered it: either the number itself, where
   * canboatjs has no name for it, or the name the tree records for the same
   * device, which the same canboatjs rendered.
   */
  private addressOf(key: DeviceKey, entry: TreeEntry | undefined): number | null {
    const isKey = (claim: Claim): boolean =>
      claim.uniqueNumber === key.uniqueNumber &&
      (claim.manufacturer === key.manufacturerCode || claim.manufacturer === entry?.manufacturer)

    for (const { claim, address } of this.claims.values()) {
      if (isKey(claim)) {
        return isUnicast(address) ? address : null
      }
    }
    if (entry === undefined) {
      return null
    }
    // The tree is weaker evidence than any claim heard since start.
    const taken = [...this.claims.values()].some(
      (live) => live.address === entry.address && !isKey(live.claim)
    )
    return taken ? null : entry.address
  }

  private isPresent(address: number): boolean {
    const heard = this.lastHeard.get(address)
    if (heard === undefined) {
      return false
    }
    const age = this.now() - heard
    return age >= 0 && age < PRESENCE_WINDOW_MS
  }

  /**
   * The bus subscription.
   *
   * Nothing here may throw: this runs inside the server's own event dispatch,
   * where an exception stops the Signal K process. Runs on every frame from
   * every device, so it rereads the tree only when something changed.
   */
  private onBusMessage(pgn: DecodedPgn): void {
    try {
      const src = pgn.src
      if (src === undefined) {
        return
      }
      const wasPresent = this.isPresent(src)
      if (isUnicast(src)) {
        this.lastHeard.set(src, this.now())
      }
      const claim = pgn.pgn === PGN.addressClaim ? claimOf(pgn) : null
      if (claim !== null) {
        this.recordClaim(claim, src)
      }
      if (claim !== null || (isUnicast(src) && !wasPresent)) {
        this.publishIfChanged()
      }
    } catch (error) {
      this.report(error)
    }
  }

  private recordClaim(claim: Claim, address: number): void {
    this.claims.set(claimId(claim), { claim, address })
  }

  private currentSignature(): string {
    return JSON.stringify(this.candidates())
  }

  private publishIfChanged(): void {
    const next = this.currentSignature()
    if (next === this.signature) {
      return
    }
    this.signature = next
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        this.report(error)
      }
    }
  }

  private report(error: unknown): void {
    try {
      this.onError?.(error)
    } catch {
      // A reporter that throws is not worth losing the process over.
    }
  }
}
