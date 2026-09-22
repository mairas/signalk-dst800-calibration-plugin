/**
 * Minimal ServerAPI stand-in for tests.
 *
 * Records what the plugin does to the server so tests can assert on it, and
 * counts listener registrations so a start/stop cycle can be checked for leaks.
 */
export interface MockServerAPI {
  statuses: string[]
  errors: string[]
  listeners: Map<string, ((...args: unknown[]) => void)[]>
  setPluginStatus(message: string): void
  setPluginError(message: string): void
  on(event: string, handler: (...args: unknown[]) => void): void
  removeListener(event: string, handler: (...args: unknown[]) => void): void
  listenerCount(): number
}

export function createMockServerAPI(): MockServerAPI {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()

  return {
    statuses: [],
    errors: [],
    listeners,
    setPluginStatus(message) {
      this.statuses.push(message)
    },
    setPluginError(message) {
      this.errors.push(message)
    },
    on(event, handler) {
      const existing = listeners.get(event) ?? []
      existing.push(handler)
      listeners.set(event, existing)
    },
    removeListener(event, handler) {
      const existing = listeners.get(event) ?? []
      const index = existing.indexOf(handler)
      if (index !== -1) {
        existing.splice(index, 1)
      }
      listeners.set(event, existing)
    },
    listenerCount() {
      let total = 0
      for (const handlers of listeners.values()) {
        total += handlers.length
      }
      return total
    }
  }
}
