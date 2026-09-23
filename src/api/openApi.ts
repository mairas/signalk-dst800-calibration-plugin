/**
 * OpenAPI description of the console's REST API, served by the Signal K
 * server through the plugin's `getOpenApi`.
 *
 * A TypeScript object rather than a JSON file, so `tsc` emits it to `dist/`
 * with the rest of the plugin and nothing has to copy it. Every enum below is
 * checked against the type it documents, so adding a status to a result type
 * fails to compile until the document lists it.
 */

import type { CapabilityState, Level1State, ProbeResult } from '../devices/probe.js'
import type { ReadResult, WriteResult } from '../settings/operations.js'
import { SETTINGS } from '../settings/registry.js'
import {
  MANUFACTURER_CODE_BITS,
  UNIQUE_NUMBER_BITS,
  type ResetResult,
  type SettingInfo
} from '../types.js'
import { RESTORE_OPTION_NAMES } from './routes.js'

/** The keys of a record the compiler has checked against a union. */
const keysOf = <K extends string>(record: Record<K, true>): K[] => Object.keys(record) as K[]

const READ_STATUSES = keysOf({ answered: true, rejected: true, unknown: true } satisfies Record<
  Exclude<ReadResult['status'], 'invalid'>,
  true
>)

const WRITE_STATUSES = keysOf({
  applied: true,
  storedDiffers: true,
  acknowledged: true,
  rejected: true,
  notSent: true,
  unknown: true
} satisfies Record<Exclude<WriteResult['status'], 'invalid'>, true>)

const CAPABILITY_STATES = keysOf({
  supported: true,
  rejected: true,
  noAnswer: true
} satisfies Record<CapabilityState['state'], true>)

const LEVEL1_STATES = keysOf({ granted: true, refused: true, noAnswer: true } satisfies Record<
  Level1State['state'],
  true
>)

const CONFIGURABLE = keysOf({ yes: true, no: true, unknown: true } satisfies Record<
  ProbeResult['configurable'],
  true
>)

const AVAILABLE = keysOf({ yes: true, no: true, unknown: true } satisfies Record<
  SettingInfo['available'],
  true
>)

const RESET_STATUSES = keysOf({ claimed: true, notSent: true, lost: true } satisfies Record<
  ResetResult['status'],
  true
>)

const settingIds = SETTINGS.map((s) => s.id)

const json = (schema: object) => ({ content: { 'application/json': { schema } } })

const object = (properties: Record<string, object>, optional: string[] = []) => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((key) => !optional.includes(key))
})

const nullable = (schema: object) => ({ ...schema, nullable: true })

const errorResponse = (description: string) => ({
  description,
  ...json(object({ error: { type: 'string' } }))
})

const deviceKey = object({
  manufacturerCode: {
    type: 'integer',
    minimum: 0,
    maximum: 2 ** MANUFACTURER_CODE_BITS - 1,
    description: 'From the Address Claim NAME'
  },
  uniqueNumber: {
    type: 'integer',
    minimum: 0,
    maximum: 2 ** UNIQUE_NUMBER_BITS - 1,
    description: 'From the Address Claim NAME'
  }
})

const location = object({
  state: { type: 'string', enum: ['present', 'waiting'] },
  address: nullable({ type: 'integer', description: 'NMEA 2000 source address' })
})

const candidate = object({
  key: deviceKey,
  location,
  manufacturerName: nullable({ type: 'string' }),
  modelId: nullable({ type: 'string' }),
  serial: nullable({ type: 'string' })
})

const probeResult = object({
  level1: object({ state: { type: 'string', enum: LEVEL1_STATES }, reason: { type: 'string' } }, [
    'reason'
  ]),
  capabilities: {
    type: 'array',
    items: object({
      capability: object(
        {
          kind: { type: 'string', enum: ['pid', 'pgn'] },
          pid: { type: 'integer' },
          pgn: { type: 'integer' }
        },
        ['pid', 'pgn']
      ),
      result: object(
        { state: { type: 'string', enum: CAPABILITY_STATES }, reason: { type: 'string' } },
        ['reason']
      )
    })
  },
  configurable: { type: 'string', enum: CONFIGURABLE },
  interrupted: {
    type: 'boolean',
    description: 'The session closed before the probe finished. An interrupted result is not kept.'
  }
})

const resetResult = object(
  {
    status: { type: 'string', enum: RESET_STATUSES },
    probe: { ...probeResult, description: 'The probe after the claim; only when `claimed`' },
    reason: { type: 'string', description: 'Why not `claimed`' }
  },
  ['probe', 'reason']
)

const selection = object({
  selected: nullable(deviceKey),
  location: nullable(location),
  probe: nullable({ ...probeResult, description: 'The last complete probe of this device' })
})

const settingInfo = object({
  id: { type: 'string', enum: settingIds },
  requirement: { type: 'string' },
  readable: { type: 'boolean' },
  writable: { type: 'boolean' },
  requiresLevel1: { type: 'boolean' },
  qualifiers: nullable({
    type: 'array',
    items: object({ value: { type: 'integer' }, label: { type: 'string' } })
  }),
  available: { type: 'string', enum: AVAILABLE }
})

const acknowledgement = {
  type: 'object',
  description: 'The device’s acknowledgement, for logs',
  additionalProperties: true
}

const readOutcome = {
  ...object(
    {
      status: { type: 'string', enum: READ_STATUSES },
      value: { description: 'The device’s value, when answered' },
      readAt: { type: 'string', format: 'date-time' },
      reason: { type: 'string' },
      detail: acknowledgement
    },
    ['value', 'readAt', 'reason', 'detail']
  ),
  description:
    'The device’s answer. `status` is the discriminant; a refusal or a timeout is a 200 with the reason, because the console shows it.'
}

const writeOutcome = {
  ...object(
    {
      status: { type: 'string', enum: WRITE_STATUSES },
      reason: { type: 'string' },
      requested: { description: 'The value asked for' },
      stored: { description: 'The value the device read back' },
      readAt: { type: 'string', format: 'date-time' },
      refusedFields: {
        type: 'array',
        items: object({ field: { type: 'string' }, error: { type: 'string' } })
      },
      detail: acknowledgement,
      readBack: readOutcome,
      storedMatches: { type: 'boolean' }
    },
    [
      'reason',
      'requested',
      'stored',
      'readAt',
      'refusedFields',
      'detail',
      'readBack',
      'storedMatches'
    ]
  ),
  description:
    'The device’s answer and what it stores. `status` is the discriminant; `notSent` means the command never reached the bus.'
}

const settingId = {
  name: 'id',
  in: 'path',
  required: true,
  schema: { type: 'string', enum: settingIds }
}

const notRunning = errorResponse('The plugin is not running')
const notRunningOrUnheard = errorResponse(
  'The plugin is not running, or the device has not been heard'
)

const resetResponses = {
  '200': { description: 'Whether the device came back', ...json(resetResult) },
  '409': errorResponse('No device is selected'),
  '503': notRunningOrUnheard
}

export const openApi = {
  openapi: '3.0.0',
  info: {
    title: 'Airmar DST Config',
    version: '1.0.0',
    description:
      'Read and write the settings of an Airmar DST-family sensor. Routes that answer from what the plugin holds accept a read-only login; every route that puts a frame on the bus needs admin, reading a setting included, because a read of a Level 1 setting unlocks the device.'
  },
  servers: [{ url: '/plugins/signalk-airmar-dst-config' }],
  paths: {
    '/api/devices': {
      get: {
        summary: 'Every NMEA 2000 device the server knows, configurable or not',
        responses: {
          '200': {
            description: 'Candidates',
            ...json(object({ candidates: { type: 'array', items: candidate } }))
          },
          '503': notRunning
        }
      }
    },
    '/api/device': {
      get: {
        summary: 'The selected device, where it is, and its last probe',
        responses: {
          '200': { description: 'Selection', ...json(selection) },
          '503': notRunning
        }
      },
      put: {
        summary: 'Select a device, or none',
        requestBody: {
          required: true,
          ...json(object({ device: nullable(deviceKey) }))
        },
        responses: {
          '200': { description: 'The new selection', ...json(selection) },
          '400': errorResponse('Not a device key'),
          '500': errorResponse('The selection could not be saved'),
          '503': notRunning
        }
      }
    },
    '/api/device/probe': {
      post: {
        summary: 'Ask the device for each capability it supports',
        responses: {
          '200': { description: 'Probe result', ...json(probeResult) },
          '409': errorResponse('No device is selected'),
          '503': notRunningOrUnheard
        }
      }
    },
    '/api/device/reset': {
      post: {
        summary: 'Reboot the device, then wait for it to claim an address and probe it again',
        description:
          'Needs Access Level 1. The device sends no acknowledgement; it reboots, claims an address, perhaps another one, and leaves simulate mode. Waits up to 30 s for the claim and answers `claimed`, which is what a reboot looks like but not proof of one: the device also claims when another display asks.',
        responses: resetResponses
      }
    },
    '/api/device/restore': {
      post: {
        summary: 'Restore part of the device’s EEPROM to factory settings, then follow its reboot',
        description:
          'Needs Access Level 1. `all` includes the speed calibration curve. Otherwise as `/api/device/reset`.',
        requestBody: {
          required: true,
          ...json(object({ option: { type: 'string', enum: RESTORE_OPTION_NAMES } }))
        },
        responses: { ...resetResponses, '400': errorResponse('Not a restore option') }
      }
    },
    '/api/settings': {
      get: {
        summary: 'Every setting, whether it can be read and written, and what the last probe found',
        responses: {
          '200': {
            description: 'Settings',
            ...json(object({ settings: { type: 'array', items: settingInfo } }))
          },
          '503': notRunning
        }
      }
    },
    '/api/events': {
      get: {
        summary: 'Server-Sent Events for every open console',
        description:
          'Starts with `devices` and `device`. Then `devices` when the device list changes, `device` when the selection, the selected device’s location or its cached probe changes (each carries the same body as the matching GET), `setting` after each read or write of a setting that reached the session, carrying `{ id, qualifier, operation, result }`, and `reset` after a reset or restore that reached the bus, carrying its result: every value a console holds for the device is then stale. While a console is open, the plugin reads simulate mode every minute and pushes it as a `setting` event. A comment line every 25 s keeps idle proxies from closing the stream. The stream ends when the plugin stops.',
        responses: {
          '200': {
            description: 'An event stream',
            content: { 'text/event-stream': { schema: { type: 'string' } } }
          },
          '503': notRunning
        }
      }
    },
    '/api/settings/{id}': {
      get: {
        summary: 'Read a setting from the device',
        parameters: [
          settingId,
          {
            name: 'qualifier',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 0 }
          }
        ],
        responses: {
          '200': { description: 'The device’s answer', ...json(readOutcome) },
          '400': errorResponse('Unknown qualifier, or the setting cannot be read back'),
          '404': errorResponse('No such setting'),
          '409': errorResponse('No device is selected'),
          '503': notRunningOrUnheard
        }
      },
      put: {
        summary: 'Write a setting, then read it back once',
        parameters: [settingId],
        requestBody: {
          required: true,
          ...json(object({ value: {}, qualifier: { type: 'integer', minimum: 0 } }, ['qualifier']))
        },
        responses: {
          '200': { description: 'The device’s answer and what it stores', ...json(writeOutcome) },
          '400': errorResponse('Refused before it reached the bus'),
          '404': errorResponse('No such setting'),
          '409': errorResponse('No device is selected'),
          '503': notRunningOrUnheard
        }
      }
    }
  }
}
