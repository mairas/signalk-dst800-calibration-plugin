import { EventEmitter } from 'node:events'
import type { ServerAPI } from '@signalk/server-api'

/**
 * Minimal ServerAPI stand-in.
 *
 * Only the members the plugin actually calls are implemented. The single cast
 * lives here rather than at each call site, so a ServerAPI signature change
 * breaks one file.
 */
export interface MockServerAPI {
  statuses: string[]
  errors: string[]
  debugged: string[]
  /** Raw options record as the server stores it: { enabled, configuration }. */
  storedOptions: { enabled?: boolean; configuration?: unknown }
  /** What `getPath('/sources')` returns. */
  sources: unknown
  /** Set to make the next `savePluginOptions` fail. */
  saveError: Error | null
  /** The server's event bus: `N2KAnalyzerOut`, `nmea2000JsonOut`, `nmea2000out`. */
  events: EventEmitter
  asServerAPI(): ServerAPI
}

export function createMockServerAPI(configuration: unknown = {}): MockServerAPI {
  const events = new EventEmitter()
  const mock: MockServerAPI = {
    statuses: [],
    errors: [],
    debugged: [],
    storedOptions: { configuration },
    sources: {},
    saveError: null,
    events,
    asServerAPI() {
      return this as unknown as ServerAPI
    }
  }

  Object.assign(mock, {
    on: events.on.bind(events),
    removeListener: events.removeListener.bind(events),
    emit: events.emit.bind(events),
    getPath(path: string) {
      return path === '/sources' ? mock.sources : undefined
    },
    debug(message: string) {
      mock.debugged.push(message)
    },
    savePluginOptions(options: object, callback: (error: Error | null) => void) {
      const failure = mock.saveError
      if (failure === null) {
        mock.storedOptions = { ...mock.storedOptions, configuration: options }
      }
      callback(failure)
    },
    setPluginStatus(message: string) {
      mock.statuses.push(message)
    },
    setPluginError(message: string) {
      mock.errors.push(message)
    },
    readPluginOptions() {
      return mock.storedOptions
    }
  })

  return mock
}

/** Captures the routes a plugin registers, and the access level of each. */
export interface RecordedRoute {
  method: string
  path: string
  access: 'admin' | 'readonly' | 'readwrite'
  handler: (req: unknown, res: unknown) => unknown
}

export function createRecordingRouter(): {
  routes: RecordedRoute[]
  router: Parameters<NonNullable<import('@signalk/server-api').Plugin['registerWithRouter']>>[0]
} {
  const routes: RecordedRoute[] = []

  const register =
    (access: RecordedRoute['access'], method: string) =>
    (path: string, handler: RecordedRoute['handler']) => {
      routes.push({ method, path, access, handler })
    }

  const router = {
    get: register('admin', 'get'),
    post: register('admin', 'post'),
    put: register('admin', 'put'),
    delete: register('admin', 'delete'),
    access(level: RecordedRoute['access']) {
      return {
        get: register(level, 'get'),
        post: register(level, 'post'),
        put: register(level, 'put'),
        delete: register(level, 'delete')
      }
    }
  }

  return { routes, router: router as never }
}

/** Minimal express Response double capturing the status and JSON body a handler sends. */
export function createJsonResponse(): { status: number; body: unknown; res: unknown } {
  const captured: { status: number; body: unknown; res: unknown } = {
    status: 200,
    body: undefined,
    res: undefined
  }
  const res = {
    status(code: number) {
      captured.status = code
      return res
    },
    json(value: unknown) {
      captured.body = value
      return res
    }
  }
  captured.res = res
  return captured
}

/** One Server-Sent Event as a client would parse it. */
export interface StreamedEvent {
  event: string
  data: unknown
}

/**
 * Express Response double for an event stream: captures the head, every
 * chunk written, and whether the stream was ended. Falls back to the JSON
 * double's `status` and `json` for a handler that answers with an error.
 */
export function createStreamResponse(): {
  status: number
  headers: Record<string, string>
  chunks: string[]
  ended: boolean
  /** The complete events written so far, in order. */
  events: () => StreamedEvent[]
  res: unknown
} {
  const captured = {
    status: 200,
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    ended: false,
    body: undefined as unknown,
    events: (): StreamedEvent[] =>
      captured.chunks
        .join('')
        .split('\n\n')
        .filter((block) => block.startsWith('event: '))
        .map((block) => {
          const [eventLine, dataLine] = block.split('\n')
          return {
            event: eventLine.slice('event: '.length),
            data: JSON.parse(dataLine.slice('data: '.length)) as unknown
          }
        }),
    res: undefined as unknown
  }
  const res = {
    status(code: number) {
      captured.status = code
      return res
    },
    json(value: unknown) {
      captured.body = value
      return res
    },
    writeHead(code: number, headers: Record<string, string>) {
      captured.status = code
      captured.headers = headers
      return res
    },
    write(chunk: string) {
      if (captured.ended) {
        throw new Error('write after end')
      }
      captured.chunks.push(chunk)
      return true
    },
    end() {
      captured.ended = true
    }
  }
  captured.res = res
  return captured
}
