/**
 * Every readable setting of a device as one JSON document, and the way back.
 *
 * A snapshot is a read of each registry entry the probe confirmed. Import is
 * one write per setting, because each is its own command: the diff is shown
 * first, the writes run in registry order, and the first write that does not
 * store exactly what the snapshot holds stops the import. Every setting then
 * reports applied, failed or not attempted, so a half-applied import says how
 * far it got.
 *
 * Not everything readable is re-appliable. Simulate mode would put simulated
 * depth on the bus from a file, the distance log counts this boat's own
 * travel, and product information cannot be written; these appear in the diff
 * as excluded and are never written.
 */

import { capabilityId, type ProbeResult } from '../devices/probe.js'
import { PGN } from '../protocol/pids.js'
import { isAccessDenied } from '../session/outcome.js'
import type { ReadResult, WriteResult } from '../settings/operations.js'
import {
  SETTINGS,
  checkQualifier,
  isSettingId,
  setting,
  type AnySetting,
  type ParseResult,
  type SettingId
} from '../settings/registry.js'
import { deviceKeyOf, type DeviceKey } from '../types.js'

export const SNAPSHOT_SCHEMA_VERSION = 1

/** A setting's value as the device reported it, per qualifier. */
export interface SnapshotSetting {
  id: SettingId
  qualifier: number | null
  value: unknown
}

/** A setting the snapshot tried to read and could not. */
export interface SnapshotGap {
  id: SettingId
  qualifier: number | null
  reason: string
}

export interface Snapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
  takenAt: string
  device: DeviceKey
  /** The capabilities the probe confirmed, by `capabilityId`. */
  probed: string[]
  settings: SnapshotSetting[]
  unread: SnapshotGap[]
}

/** Reads and writes one setting of the target device. */
export interface SettingIo {
  read(id: SettingId, qualifier?: number): Promise<ReadResult>
  write(id: SettingId, value: unknown, qualifier?: number): Promise<WriteResult>
}

interface Slot {
  id: SettingId
  qualifier: number | null
}

/** What an import will do with one setting of the snapshot. */
export type ImportItem = Slot &
  (
    | /** The device holds something else, or did not say what it holds. */
      { action: 'write'; value: unknown; current: ReadResult }
    | { action: 'unchanged'; value: unknown; current: unknown }
    /** Never re-applied from a snapshot. */
    | { action: 'excluded'; value: unknown; reason: string }
    /** The target's probe, or the target itself, refused this setting. */
    | { action: 'unsupported'; value: unknown; reason: string }
    /** The snapshot could not read this setting from its source. */
    | { action: 'missing'; reason: string }
  )

export interface ImportPlan {
  /** The device the snapshot was taken from, which need not be the target. */
  source: DeviceKey
  items: ImportItem[]
}

/**
 * `failed` is any write that did not store the snapshot's value: a refusal, a
 * timeout, a stored value that differs, or a write the device acknowledged
 * but whose read-back went unanswered.
 */
export type WriteOutcome =
  { outcome: 'applied' | 'failed'; result: WriteResult } | { outcome: 'notAttempted' }

export type ImportResultItem =
  | Exclude<ImportItem, { action: 'write' }>
  | (Extract<ImportItem, { action: 'write' }> & WriteOutcome)

export interface ImportResult {
  source: DeviceKey
  items: ImportResultItem[]
  /** Every write was applied. */
  complete: boolean
}

const EXCLUDED: Partial<Record<SettingId, string>> = {
  simulateMode:
    'Simulate mode puts simulated data on the bus, so it is only ever turned on by hand',
  distanceLog: 'The distance log counts this boat’s own travel'
}

const exclusionOf = (entry: AnySetting): string | null =>
  EXCLUDED[entry.id as SettingId] ?? (entry.writable ? null : `${entry.id} is read-only`)

const optional = (qualifier: number | null): number | undefined => qualifier ?? undefined

/** Each qualifier of a qualified setting, or the one unqualified slot. */
const slotsOf = (entry: AnySetting): Slot[] =>
  (entry.qualifiers?.map((q) => q.value) ?? [null]).map((qualifier) => ({
    id: entry.id as SettingId,
    qualifier
  }))

/** What the probe found for `entry`; undefined for a setting that is not probed. */
function stateOf(entry: AnySetting, probe: ProbeResult) {
  if (entry.capability === null) {
    return undefined
  }
  const wanted = capabilityId(entry.capability)
  return probe.capabilities.find((c) => capabilityId(c.capability) === wanted)?.result
}

export async function takeSnapshot(
  io: SettingIo,
  device: DeviceKey,
  probe: ProbeResult,
  now: () => Date
): Promise<Snapshot> {
  const snapshot: Snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    takenAt: now().toISOString(),
    device: { ...device },
    probed: probe.capabilities
      .filter((c) => c.result.state === 'supported')
      .map((c) => capabilityId(c.capability)),
    settings: [],
    unread: []
  }
  // Only a refusal rules a capability out: one lost fast-packet frame leaves
  // it unanswered, and an unanswered read still lands in `unread`.
  const offered = SETTINGS.filter(
    (entry) => entry.readable && stateOf(entry, probe)?.state !== 'rejected'
  )
  for (const slot of offered.flatMap(slotsOf)) {
    const read = await io.read(slot.id, optional(slot.qualifier))
    if (read.status === 'answered') {
      snapshot.settings.push({ ...slot, value: read.value })
    } else {
      snapshot.unread.push({ ...slot, reason: read.reason })
    }
  }
  return snapshot
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const fail = <T>(error: string): ParseResult<T> => ({ ok: false, error })

/** A slot from a snapshot file, checked against the registry. */
function slotOf(value: Record<string, unknown>, where: string): ParseResult<Slot> {
  const { id, qualifier } = value
  if (typeof id !== 'string' || !isSettingId(id)) {
    return fail(`${where}: there is no setting called ${String(id)}`)
  }
  if (qualifier !== null && typeof qualifier !== 'number') {
    return fail(`${where}: the qualifier must be a number or null`)
  }
  const qualified = checkQualifier(setting(id), qualifier ?? undefined)
  return qualified.ok
    ? { ok: true, value: { id, qualifier } }
    : fail(`${where}: ${qualified.error}`)
}

/**
 * Check a snapshot from outside the plugin.
 *
 * Every value that would be written passes its entry's `parse` here, so a
 * snapshot with one bad value is refused whole rather than applied up to it.
 */
export function parseSnapshot(input: unknown): ParseResult<Snapshot> {
  if (!isRecord(input)) {
    return fail('A snapshot is a JSON object')
  }
  if (input.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return fail(
      `This plugin reads snapshot schema version ${String(SNAPSHOT_SCHEMA_VERSION)}, and this file is schema version ${String(input.schemaVersion)}`
    )
  }
  const device = deviceKeyOf(input.device)
  const { takenAt, probed, settings, unread } = input
  if (
    device === null ||
    typeof takenAt !== 'string' ||
    !Array.isArray(probed) ||
    !probed.every((p) => typeof p === 'string') ||
    !Array.isArray(settings) ||
    !Array.isArray(unread)
  ) {
    return fail('A snapshot needs takenAt, device, probed, settings and unread')
  }

  const seen = new Set<string>()
  const claim = (slot: Slot, where: string): string | null => {
    const key = `${slot.id}:${String(slot.qualifier)}`
    if (seen.has(key)) {
      return `${where}: ${slot.id} appears twice`
    }
    seen.add(key)
    return null
  }

  const values: SnapshotSetting[] = []
  for (const [index, entry] of settings.entries()) {
    const where = `settings[${String(index)}]`
    if (!isRecord(entry) || !('value' in entry)) {
      return fail(`${where} needs an id, a qualifier and a value`)
    }
    const slot = slotOf(entry, where)
    if (!slot.ok) {
      return slot
    }
    const twice = claim(slot.value, where)
    if (twice !== null) {
      return fail(twice)
    }
    const target = setting(slot.value.id) as AnySetting
    if (exclusionOf(target) === null) {
      const checked = target.parse(entry.value)
      if (!checked.ok) {
        return fail(`${where} (${slot.value.id}): ${checked.error}`)
      }
      if (target.isRestore?.(checked.value) === true) {
        return fail(`${where} (${slot.value.id}): a snapshot holds values, not a restore`)
      }
    }
    values.push({ ...slot.value, value: entry.value })
  }

  const gaps: SnapshotGap[] = []
  for (const [index, entry] of unread.entries()) {
    const where = `unread[${String(index)}]`
    if (!isRecord(entry) || typeof entry.reason !== 'string') {
      return fail(`${where} needs an id, a qualifier and a reason`)
    }
    const slot = slotOf(entry, where)
    if (!slot.ok) {
      return slot
    }
    const twice = claim(slot.value, where)
    if (twice !== null) {
      return fail(twice)
    }
    gaps.push({ ...slot.value, reason: entry.reason })
  }

  return {
    ok: true,
    value: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      takenAt,
      device,
      probed,
      settings: values,
      unread: gaps
    }
  }
}

/**
 * The target itself refused the read.
 *
 * A refusal without the device's acknowledgement is the session's own, such
 * as Level 1 marked unavailable or a full queue; one naming PGN 65287 is a
 * refused unlock; and an access denial means the device parsed the request,
 * which the probe counts as support. None says the device lacks the setting.
 */
const refusedByDevice = (read: ReadResult): read is Extract<ReadResult, { status: 'rejected' }> =>
  read.status === 'rejected' &&
  read.detail !== undefined &&
  read.detail.acknowledgedPgn !== PGN.accessLevel &&
  !isAccessDenied(read.detail)

/** Decide what to do with one setting, reading the target only where the answer depends on it. */
async function itemFor(
  io: SettingIo,
  entry: SnapshotSetting,
  probe: ProbeResult
): Promise<ImportItem> {
  const target = setting(entry.id) as AnySetting
  const slot = { id: entry.id, qualifier: entry.qualifier }
  const excluded = exclusionOf(target)
  if (excluded !== null) {
    return { ...slot, action: 'excluded', value: entry.value, reason: excluded }
  }
  const probed = stateOf(target, probe)
  if (probed?.state === 'rejected') {
    return { ...slot, action: 'unsupported', value: entry.value, reason: probed.reason }
  }
  const current = await io.read(entry.id, optional(entry.qualifier))
  if (refusedByDevice(current)) {
    return { ...slot, action: 'unsupported', value: entry.value, reason: current.reason }
  }
  const parsed = target.parse(entry.value)
  if (
    current.status === 'answered' &&
    parsed.ok &&
    target.sameAsStored(parsed.value, current.value)
  ) {
    return { ...slot, action: 'unchanged', value: entry.value, current: current.value }
  }
  return { ...slot, action: 'write', value: entry.value, current }
}

/** The diff an import would apply to the device behind `io`. Reads, never writes. */
export async function planImport(
  io: SettingIo,
  snapshot: Snapshot,
  probe: ProbeResult
): Promise<ImportPlan> {
  const found = new Map<string, ImportItem>()
  for (const entry of snapshot.settings) {
    found.set(`${entry.id}:${String(entry.qualifier)}`, await itemFor(io, entry, probe))
  }
  for (const gap of snapshot.unread) {
    found.set(`${gap.id}:${String(gap.qualifier)}`, {
      id: gap.id,
      qualifier: gap.qualifier,
      action: 'missing',
      reason: gap.reason
    })
  }
  // Registry order, which is also the order the writes run in.
  const items = SETTINGS.flatMap(slotsOf).flatMap((slot) => {
    const item = found.get(`${slot.id}:${String(slot.qualifier)}`)
    return item === undefined ? [] : [item]
  })
  return { source: snapshot.device, items }
}

/** Plan the import afresh, then write the settings that differ until one fails. */
export async function applyImport(
  io: SettingIo,
  snapshot: Snapshot,
  probe: ProbeResult
): Promise<ImportResult> {
  const plan = await planImport(io, snapshot, probe)
  let stopped = false
  const items: ImportResultItem[] = []
  for (const item of plan.items) {
    if (item.action !== 'write') {
      items.push(item)
    } else if (stopped) {
      items.push({ ...item, outcome: 'notAttempted' })
    } else {
      const result = await io.write(item.id, item.value, optional(item.qualifier))
      stopped = result.status !== 'applied'
      items.push({ ...item, outcome: stopped ? 'failed' : 'applied', result })
    }
  }
  return { source: plan.source, items, complete: !stopped }
}
