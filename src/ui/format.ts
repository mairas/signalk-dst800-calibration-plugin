import type { Candidate, DeviceKey } from '../types.js'

/** Minutes and seconds left, rounded up so a grant never reads 0:00 while it still holds. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, '0')}`
}

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
