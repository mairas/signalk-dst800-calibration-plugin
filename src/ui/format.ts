import type { Candidate, DeviceKey } from '../types.js'

/** Minutes and seconds left, rounded up so a grant never reads 0:00 while it still holds. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** A sentence from elsewhere without its full stop, to go inside another sentence. */
export const clause = (text: string): string => text.trim().replace(/\.$/, '')

/** The YYYY-MM-DD `date` falls on where the user is, as a file name should read. */
export const localDay = (date: Date): string =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, i) => String(part).padStart(i === 0 ? 4 : 2, '0'))
    .join('-')

/** The YYYY-MM-DD an ISO timestamp falls on. */
export const dayOf = (iso: string): string => iso.split('T')[0]

export const sameKey = (a: DeviceKey | null, b: DeviceKey | null): boolean =>
  a !== null &&
  b !== null &&
  a.manufacturerCode === b.manufacturerCode &&
  a.uniqueNumber === b.uniqueNumber

/** Manufacturer and model as the device names itself, or its codes where it has not. */
export function deviceName(candidate: Candidate | null, key: DeviceKey): string {
  const manufacturer = candidate?.manufacturerName ?? `Manufacturer ${String(key.manufacturerCode)}`
  const model = candidate?.modelId ?? `unit ${String(key.uniqueNumber)}`
  return `${manufacturer} ${model}`
}
