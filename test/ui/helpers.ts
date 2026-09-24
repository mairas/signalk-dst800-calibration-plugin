import { vi } from 'vitest'
import type {
  Candidate,
  DeviceResponse,
  DevicesResponse,
  ProbeResult,
  ServerEvent,
  SettingInfo,
  SettingsResponse
} from '../../src/types.js'
import { API_BASE } from '../../src/ui/api.js'

/** Stands in for the browser's EventSource; each instance is one connection. */
export class FakeEventSource {
  static instances: FakeEventSource[] = []
  onopen: (() => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  private readonly listeners = new Map<string, ((message: MessageEvent<string>) => void)[]>()

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (message: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  close(): void {
    this.closed = true
  }

  push(event: ServerEvent): void {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(new MessageEvent(event.type, { data: JSON.stringify(event.data) }))
    }
  }

  static get latest(): FakeEventSource {
    const latest = FakeEventSource.instances.at(-1)
    if (latest === undefined) {
      throw new Error('No event stream was opened')
    }
    return latest
  }
}

export const DST = { manufacturerCode: 135, uniqueNumber: 123456 }
export const OTHER = { manufacturerCode: 137, uniqueNumber: 42 }

export const candidates: Candidate[] = [
  {
    key: DST,
    location: { state: 'present', address: 22 },
    manufacturerName: 'Airmar',
    modelId: 'DST800',
    serial: '0123456'
  },
  {
    key: OTHER,
    location: { state: 'present', address: 35 },
    manufacturerName: 'Maretron',
    modelId: 'DSM150',
    serial: null
  }
]

export const probe: ProbeResult = {
  level1: { state: 'granted' },
  capabilities: [
    { capability: { kind: 'pid', pid: 41 }, result: { state: 'supported' } },
    { capability: { kind: 'pid', pid: 40 }, result: { state: 'noAnswer', reason: 'No answer' } }
  ],
  configurable: 'yes',
  interrupted: false
}

export const selected = (overrides: Partial<DeviceResponse> = {}): DeviceResponse => ({
  selected: DST,
  location: { state: 'present', address: 22 },
  access: { state: 'locked' },
  probe: null,
  ...overrides
})

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export type Handler = (path: string, init?: RequestInit) => Response | Promise<Response>

/**
 * Answer the plugin API: GET /devices, /device and /settings from the
 * arguments, and anything else through `other`.
 */
export function serve(device: DeviceResponse, other?: Handler, settings: SettingInfo[] = []): void {
  vi.mocked(fetch).mockImplementation((input, init) => {
    const path = (input as string).slice(API_BASE.length)
    const method = init?.method ?? 'GET'
    if (method === 'GET' && path === '/devices') {
      return Promise.resolve(json({ candidates } satisfies DevicesResponse))
    }
    if (method === 'GET' && path === '/device') {
      return Promise.resolve(json(device))
    }
    if (method === 'GET' && path === '/settings') {
      return Promise.resolve(json({ settings } satisfies SettingsResponse))
    }
    if (other !== undefined) {
      return Promise.resolve(other(path, init))
    }
    return Promise.reject(new Error(`Unexpected ${method} ${path}`))
  })
}

export const settle = async () => {
  await vi.advanceTimersByTimeAsync(0)
}

export const mount = async () => {
  const el = document.createElement('dst-app')
  document.body.appendChild(el)
  await settle()
  return el
}

export const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, ' ')

export const button = (el: Element, label: string): HTMLButtonElement => {
  const found = [...el.querySelectorAll('button')].find((b) => b.textContent.trim() === label)
  if (found === undefined) {
    throw new Error(`No button labelled ${label}`)
  }
  return found
}
