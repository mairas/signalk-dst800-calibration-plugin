import { describe, it, expect } from 'vitest'
import { PROBED, capabilityId, type ProbeResult } from '../../src/devices/probe.js'
import { ACCESS_DENIED, type AcknowledgeResult } from '../../src/protocol/codec.js'
import { PGN } from '../../src/protocol/pids.js'
import type { ReadResult, WriteResult } from '../../src/settings/operations.js'
import type { SettingId } from '../../src/settings/registry.js'
import {
  SNAPSHOT_SCHEMA_VERSION,
  applyImport,
  parseSnapshot,
  planImport,
  takeSnapshot,
  type SettingIo,
  type Snapshot
} from '../../src/snapshots/snapshot.js'
import type { DeviceKey } from '../../src/types.js'

const DST800: DeviceKey = { manufacturerCode: 135, uniqueNumber: 123456 }
const TAKEN_AT = new Date('2026-09-24T08:00:00.000Z')
const now = () => TAKEN_AT

/** A probe that found every capability except those in `rejected`. */
/** A probe that found every capability except those in `rejected`, and heard nothing for `unanswered`. */
const probeFinding = (rejected: string[] = [], unanswered: string[] = []): ProbeResult => ({
  level1: { state: 'granted' },
  capabilities: PROBED.map((capability) => {
    const id = capabilityId(capability)
    return {
      capability,
      result: rejected.includes(id)
        ? { state: 'rejected', reason: 'Not supported' }
        : unanswered.includes(id)
          ? { state: 'noAnswer', reason: 'No answer' }
          : { state: 'supported' }
    }
  }),
  configurable: rejected.includes('pid:41')
    ? 'no'
    : unanswered.includes('pid:41')
      ? 'unknown'
      : 'yes',
  interrupted: false
})

/** The device's acknowledgement refusing a request for `pgn`. */
const refusal = (pgn: number, pgnError: string): AcknowledgeResult => ({
  acknowledgedPgn: pgn,
  src: 22,
  ok: false,
  pgnError,
  intervalPriorityError: 'Acknowledge',
  parameterErrors: [],
  missingParameterCodes: 0
})

const CURVE = [
  { hz: 1.5, speed: 0.5 },
  { hz: 12, speed: 4 }
]

/** What the device in these tests holds, keyed by setting id and qualifier. */
const DEVICE_VALUES: Record<string, unknown> = {
  'speedCurve:': CURVE,
  'temperatureOffset:0': 0.5,
  'temperatureOffset:1': 0,
  'temperatureOffset:2': -0.25,
  'depthOffset:': 0.35,
  'speedOfSound:': 1500,
  'transmissionIntervalOverride:': false,
  'installationDescription:': { description1: 'Hull, port side', description2: '' },
  'productInformation:': {
    productCode: 1234,
    modelId: 'DST800',
    softwareVersionCode: '1.0',
    modelVersion: '',
    modelSerialCode: '99'
  },
  'distanceLog:': { log: 12000, tripLog: 150 },
  'simulateMode:': false
}

const slot = (id: string, qualifier?: number) =>
  `${id}:${qualifier === undefined ? '' : String(qualifier)}`

/**
 * A device behind the `SettingIo` seam. A write stores its value and answers
 * `applied`, unless `writeAnswers` scripts another answer for that setting.
 */
function fakeDevice(
  values: Record<string, unknown> = DEVICE_VALUES,
  options: {
    readAnswers?: Record<string, ReadResult>
    writeAnswers?: Record<string, WriteResult>
  } = {}
) {
  const held = structuredClone(values)
  const reads: string[] = []
  const writes: { slot: string; value: unknown }[] = []
  const io: SettingIo = {
    read: (id: SettingId, qualifier?: number) => {
      const key = slot(id, qualifier)
      reads.push(key)
      const scripted = options.readAnswers?.[key]
      if (scripted !== undefined) {
        return Promise.resolve(scripted)
      }
      return Promise.resolve(
        key in held
          ? { status: 'answered', value: held[key], readAt: TAKEN_AT.toISOString() }
          : { status: 'unknown', reason: 'No answer' }
      )
    },
    write: (id: SettingId, value: unknown, qualifier?: number) => {
      const key = slot(id, qualifier)
      writes.push({ slot: key, value })
      const scripted = options.writeAnswers?.[key]
      if (scripted !== undefined) {
        return Promise.resolve(scripted)
      }
      held[key] = value
      return Promise.resolve({ status: 'applied', stored: value, readAt: TAKEN_AT.toISOString() })
    }
  }
  return { io, reads, writes }
}

const exportFrom = (values: Record<string, unknown> = DEVICE_VALUES, probe = probeFinding()) =>
  takeSnapshot(fakeDevice(values).io, DST800, probe, now)

/** A snapshot of the default device with `changes` applied to its values. */
async function snapshotWith(changes: Record<string, unknown>): Promise<Snapshot> {
  return exportFrom({ ...DEVICE_VALUES, ...changes })
}

const parsed = (input: unknown): Snapshot => {
  const result = parseSnapshot(input)
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.value
}

describe('snapshots', () => {
  describe('export', () => {
    it('reads every probed, readable setting, with the schema version, the device and the probe', async () => {
      const snapshot = await exportFrom()

      expect(snapshot.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION)
      expect(snapshot.takenAt).toBe(TAKEN_AT.toISOString())
      expect(snapshot.device).toEqual(DST800)
      expect(snapshot.probed).toEqual(PROBED.map(capabilityId))
      expect(snapshot.settings.map((s) => slot(s.id, s.qualifier ?? undefined))).toEqual(
        Object.keys(DEVICE_VALUES)
      )
      expect(snapshot.settings.find((s) => s.id === 'speedCurve')?.value).toEqual(CURVE)
      expect(snapshot.unread).toEqual([])
    })

    it('reads nothing the probe found unsupported, and nothing write-only', async () => {
      const device = fakeDevice()
      const snapshot = await takeSnapshot(
        device.io,
        DST800,
        probeFinding(['pid:41', 'pid:40']),
        now
      )

      expect(snapshot.probed).not.toContain('pid:41')
      expect(device.reads).not.toContain('speedCurve:')
      expect(device.reads).not.toContain('speedOfSound:')
      expect(device.reads).not.toContain('speedFilter:')
      expect(device.reads).not.toContain('temperatureFilter:')
      expect(snapshot.settings.map((s) => s.id)).toContain('depthOffset')
    })

    it('reads a capability the probe heard nothing for, since one lost frame causes that', async () => {
      const snapshot = await takeSnapshot(
        fakeDevice().io,
        DST800,
        probeFinding([], ['pid:41']),
        now
      )

      expect(snapshot.settings.find((s) => s.id === 'speedCurve')?.value).toEqual(CURVE)
    })

    it('lists a capability the probe heard nothing for as unread when its read goes unanswered too', async () => {
      const values = { ...DEVICE_VALUES }
      delete values['speedCurve:']
      const snapshot = await takeSnapshot(
        fakeDevice(values).io,
        DST800,
        probeFinding([], ['pid:41']),
        now
      )

      expect(snapshot.unread).toEqual([{ id: 'speedCurve', qualifier: null, reason: 'No answer' }])
    })

    it('lists a setting the device did not answer as unread, not as a value', async () => {
      const values = { ...DEVICE_VALUES }
      delete values['speedCurve:']
      const snapshot = await exportFrom(values)

      expect(snapshot.settings.map((s) => s.id)).not.toContain('speedCurve')
      expect(snapshot.unread).toEqual([{ id: 'speedCurve', qualifier: null, reason: 'No answer' }])
    })

    it('survives a round trip through JSON', async () => {
      const snapshot = await exportFrom()

      expect(parsed(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
    })
  })

  describe('reading a snapshot file', () => {
    it('refuses an unknown schema version with an explanation', async () => {
      const snapshot = { ...(await exportFrom()), schemaVersion: SNAPSHOT_SCHEMA_VERSION + 1 }

      const result = parseSnapshot(snapshot)

      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toContain(
        `schema version ${String(SNAPSHOT_SCHEMA_VERSION + 1)}`
      )
    })

    it('refuses a value the setting would refuse, before anything is read or written', async () => {
      const snapshot = await snapshotWith({ 'speedOfSound:': 2000 })

      const result = parseSnapshot(snapshot)

      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toContain('speedOfSound')
    })

    it('refuses the factory curve restore, since a snapshot holds values', async () => {
      const snapshot = await snapshotWith({ 'speedCurve:': 'factory' })

      const result = parseSnapshot(snapshot)

      expect(result.ok).toBe(false)
      expect(!result.ok && result.error).toContain('speedCurve')
    })

    it('refuses a setting it does not know', async () => {
      const snapshot = await exportFrom()
      snapshot.settings.push({ id: 'warpDrive' as SettingId, qualifier: null, value: 1 })

      expect(parseSnapshot(snapshot).ok).toBe(false)
    })

    it('refuses a qualifier the setting does not take', async () => {
      const snapshot = await exportFrom()
      snapshot.settings.push({ id: 'temperatureOffset', qualifier: 9, value: 0 })

      expect(parseSnapshot(snapshot).ok).toBe(false)
    })

    it('refuses the same setting twice', async () => {
      const snapshot = await exportFrom()
      snapshot.settings.push({ id: 'depthOffset', qualifier: null, value: 0.2 })

      expect(parseSnapshot(snapshot).ok).toBe(false)
    })

    it('refuses something that is not a snapshot', () => {
      expect(parseSnapshot([]).ok).toBe(false)
      expect(parseSnapshot({ schemaVersion: SNAPSHOT_SCHEMA_VERSION }).ok).toBe(false)
    })
  })

  describe('import', () => {
    it('finds nothing to change on the device it came from, and writes nothing', async () => {
      const snapshot = await exportFrom()
      const device = fakeDevice()

      const plan = await planImport(device.io, snapshot, probeFinding())
      const result = await applyImport(device.io, snapshot, probeFinding())

      expect(plan.items.filter((i) => i.action === 'write')).toEqual([])
      expect(result.items.filter((i) => i.action === 'write')).toEqual([])
      expect(device.writes).toEqual([])
    })

    it('compares at the device’s resolution', async () => {
      const snapshot = await snapshotWith({ 'speedOfSound:': 1500.04 })

      const plan = await planImport(fakeDevice().io, snapshot, probeFinding())

      expect(plan.items.find((i) => i.id === 'speedOfSound')?.action).toBe('unchanged')
    })

    it('writes exactly the two settings that differ and reports both applied', async () => {
      const snapshot = await snapshotWith({ 'depthOffset:': 0.5, 'temperatureOffset:2': 0.75 })
      const device = fakeDevice()

      const plan = await planImport(device.io, snapshot, probeFinding())
      expect(plan.items.filter((i) => i.action === 'write')).toEqual([
        expect.objectContaining({ id: 'temperatureOffset', qualifier: 2, value: 0.75 }),
        expect.objectContaining({ id: 'depthOffset', qualifier: null, value: 0.5 })
      ])

      const result = await applyImport(device.io, snapshot, probeFinding())

      expect(device.writes).toEqual([
        { slot: 'temperatureOffset:2', value: 0.75 },
        { slot: 'depthOffset:', value: 0.5 }
      ])
      expect(result.items.filter((i) => i.action === 'write').map((i) => i.outcome)).toEqual([
        'applied',
        'applied'
      ])
      expect(result.complete).toBe(true)
    })

    it('shows the device’s current value beside the snapshot’s', async () => {
      const snapshot = await snapshotWith({ 'depthOffset:': 0.5 })

      const plan = await planImport(fakeDevice().io, snapshot, probeFinding())

      expect(plan.items.find((i) => i.id === 'depthOffset')).toEqual({
        id: 'depthOffset',
        qualifier: null,
        value: 0.5,
        action: 'write',
        current: { status: 'answered', value: 0.35, readAt: TAKEN_AT.toISOString() }
      })
    })

    it('skips a setting the target’s probe found unsupported, as a DST800 snapshot on a depth-only unit', async () => {
      const snapshot = await snapshotWith({ 'speedCurve:': [{ hz: 2, speed: 1 }] })
      const device = fakeDevice()

      const result = await applyImport(device.io, snapshot, probeFinding(['pid:41']))

      expect(result.items.find((i) => i.id === 'speedCurve')).toMatchObject({
        action: 'unsupported'
      })
      expect(device.reads).not.toContain('speedCurve:')
      expect(device.writes).toEqual([])
    })

    it('skips a setting the target refuses to read, rather than writing it blind', async () => {
      const snapshot = await snapshotWith({ 'temperatureOffset:2': 1 })
      const device = fakeDevice(DEVICE_VALUES, {
        readAnswers: {
          'temperatureOffset:2': {
            status: 'rejected',
            reason: 'Parameter out of range',
            detail: refusal(PGN.proprietary, 'Parameter out of range')
          }
        }
      })

      const result = await applyImport(device.io, snapshot, probeFinding())

      expect(result.items.find((i) => i.id === 'temperatureOffset' && i.qualifier === 2)).toEqual(
        expect.objectContaining({ action: 'unsupported', reason: 'Parameter out of range' })
      )
      expect(device.writes).toEqual([])
    })

    it.each([
      ['the session', undefined],
      ['a refused unlock', refusal(PGN.accessLevel, 'Access denied')],
      ['an access denial', refusal(PGN.proprietary, ACCESS_DENIED)]
    ])(
      'does not call a setting unsupported when the refusal came from %s, and stops at its write',
      async (_from, detail) => {
        const snapshot = await snapshotWith({ 'speedCurve:': [{ hz: 2, speed: 1 }] })
        const refused: ReadResult = {
          status: 'rejected',
          reason: 'Access Level 1 is unavailable on this device',
          ...(detail === undefined ? {} : { detail })
        }
        const notSent: WriteResult = { status: 'notSent', reason: refused.reason }
        const device = fakeDevice(DEVICE_VALUES, {
          readAnswers: { 'speedCurve:': refused },
          writeAnswers: { 'speedCurve:': notSent }
        })

        const result = await applyImport(device.io, snapshot, probeFinding())

        expect(result.items.find((i) => i.id === 'speedCurve')).toMatchObject({
          action: 'write',
          outcome: 'failed',
          result: notSent
        })
        expect(result.complete).toBe(false)
      }
    )

    it('writes a setting whose current value went unanswered', async () => {
      const snapshot = await exportFrom()
      const device = fakeDevice(DEVICE_VALUES, {
        readAnswers: { 'depthOffset:': { status: 'unknown', reason: 'No answer' } }
      })

      await applyImport(device.io, snapshot, probeFinding())

      expect(device.writes).toEqual([{ slot: 'depthOffset:', value: 0.35 }])
    })

    it('marks excluded settings as not applied and never writes them, however they differ', async () => {
      const snapshot = await snapshotWith({
        'simulateMode:': true,
        'distanceLog:': { log: 1, tripLog: 1 },
        'productInformation:': { ...(DEVICE_VALUES['productInformation:'] as object), modelId: 'X' }
      })
      const device = fakeDevice()

      const result = await applyImport(device.io, snapshot, probeFinding())

      const excluded = result.items.filter((i) => i.action === 'excluded').map((i) => i.id)
      expect(excluded).toEqual(['productInformation', 'distanceLog', 'simulateMode'])
      expect(device.reads).not.toContain('simulateMode:')
      expect(device.writes).toEqual([])
    })

    it('lists a setting the snapshot could not read as missing', async () => {
      const values = { ...DEVICE_VALUES }
      delete values['speedCurve:']
      const snapshot = await exportFrom(values)

      const plan = await planImport(fakeDevice().io, snapshot, probeFinding())

      expect(plan.items.find((i) => i.id === 'speedCurve')).toEqual({
        id: 'speedCurve',
        qualifier: null,
        action: 'missing',
        reason: 'No answer'
      })
    })

    it('stops at the first failure: two applied, one failed, two not attempted', async () => {
      const snapshot = await snapshotWith({
        'speedCurve:': [{ hz: 2, speed: 1 }],
        'temperatureOffset:0': 1,
        'depthOffset:': 0.5,
        'speedOfSound:': 1480,
        'transmissionIntervalOverride:': true
      })
      const refusal: WriteResult = { status: 'unknown', reason: 'No answer' }
      const device = fakeDevice(DEVICE_VALUES, { writeAnswers: { 'depthOffset:': refusal } })

      const result = await applyImport(device.io, snapshot, probeFinding())

      const writes = result.items.filter((i) => i.action === 'write')
      expect(writes.map((i) => [i.id, i.outcome])).toEqual([
        ['speedCurve', 'applied'],
        ['temperatureOffset', 'applied'],
        ['depthOffset', 'failed'],
        ['speedOfSound', 'notAttempted'],
        ['transmissionIntervalOverride', 'notAttempted']
      ])
      expect(writes[2]).toMatchObject({ outcome: 'failed', result: refusal })
      expect(device.writes.map((w) => w.slot)).toEqual([
        'speedCurve:',
        'temperatureOffset:0',
        'depthOffset:'
      ])
      expect(result.complete).toBe(false)
    })

    it('counts a value the device stores differently as a failure', async () => {
      const snapshot = await snapshotWith({
        'speedOfSound:': 1480,
        'transmissionIntervalOverride:': true
      })
      const device = fakeDevice(DEVICE_VALUES, {
        writeAnswers: {
          'speedOfSound:': {
            status: 'storedDiffers',
            requested: 1480,
            stored: 1500,
            readAt: TAKEN_AT.toISOString()
          }
        }
      })

      const result = await applyImport(device.io, snapshot, probeFinding())

      expect(result.items.filter((i) => i.action === 'write').map((i) => i.outcome)).toEqual([
        'failed',
        'notAttempted'
      ])
    })
  })
})
