/**
 * The plugin's REST API and event stream, as the console uses them.
 *
 * Every path is relative to the server origin the console was loaded from,
 * so it works on whichever port and scheme serves the webapp.
 */

import type { ServerEvent } from '../types.js'

export const API_BASE = '/plugins/signalk-airmar-dst-config/api'

/** How long to wait before opening the event stream again after it fails. */
export const RECONNECT_MS = 3000

/** An answer the plugin gave with an error status, with the reason it sent. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function reasonOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === 'string') {
      return body.error
    }
  } catch {
    // Not the plugin's JSON error body, for example the server's own 401.
  }
  return `${String(response.status)} ${response.statusText}`
}

export async function request<T>(
  method: 'GET' | 'PUT' | 'POST',
  path: string,
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal
  })
  if (!response.ok) {
    throw new ApiError(response.status, await reasonOf(response))
  }
  return (await response.json()) as T
}

/** What a failed request means to someone at the console. */
export function describeFailure(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401 || cause.status === 403) {
      return 'This needs an admin login to the Signal K server.'
    }
    return cause.message
  }
  return cause instanceof Error ? cause.message : String(cause)
}

const EVENT_TYPES: readonly ServerEvent['type'][] = ['devices', 'device', 'setting', 'reset']

/**
 * Follow the event stream until `close` is called.
 *
 * An EventSource gives up for good when the server answers anything but 200,
 * which it does while the plugin is stopped, so a failed stream is closed and
 * opened again after `RECONNECT_MS`.
 */
export function followEvents(handlers: {
  onEvent: (event: ServerEvent) => void
  onConnected: (connected: boolean) => void
}): { close: () => void } {
  let source: EventSource | null = null
  let retry: ReturnType<typeof setTimeout> | null = null
  let closed = false

  const open = (): void => {
    const current = new EventSource(`${API_BASE}/events`, { withCredentials: true })
    source = current
    current.onopen = () => {
      handlers.onConnected(true)
    }
    current.onerror = () => {
      current.close()
      handlers.onConnected(false)
      if (!closed) {
        retry = setTimeout(open, RECONNECT_MS)
      }
    }
    for (const type of EVENT_TYPES) {
      current.addEventListener(type, (message: MessageEvent<string>) => {
        const data: unknown = JSON.parse(message.data)
        handlers.onEvent({ type, data } as ServerEvent)
      })
    }
  }

  open()
  return {
    close: () => {
      closed = true
      if (retry !== null) {
        clearTimeout(retry)
      }
      source?.close()
    }
  }
}
