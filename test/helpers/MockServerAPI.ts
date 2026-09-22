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
  /** Raw options record as the server stores it: { enabled, configuration }. */
  storedOptions: { enabled?: boolean; configuration?: unknown }
  asServerAPI(): ServerAPI
}

export function createMockServerAPI(configuration: unknown = {}): MockServerAPI {
  const mock: MockServerAPI = {
    statuses: [],
    errors: [],
    storedOptions: { configuration },
    asServerAPI() {
      return this as unknown as ServerAPI
    }
  }

  Object.assign(mock, {
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
  handler: (req: unknown, res: unknown) => void
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

/** Minimal express Response double capturing the JSON body a handler sends. */
export function createJsonResponse(): { body: unknown; res: unknown } {
  const captured: { body: unknown; res: unknown } = { body: undefined, res: undefined }
  captured.res = {
    json(value: unknown) {
      captured.body = value
    }
  }
  return captured
}
