import { encode } from './canboat.js'
import type { Claim } from './replies.js'
import { PGN } from '../../src/protocol/pids.js'

/**
 * The CAN NAME the server derives from an Address Claim.
 *
 * `@signalk/n2k-signalk` re-encodes the decoded claim and prints its eight
 * payload bytes as one little-endian 64-bit number in hex, with no zero
 * padding. Built the same way here rather than by bit arithmetic, so the
 * fixture cannot share a mistake with the parser it tests.
 */
export function canNameOf(claim: Claim): string {
  const bytes = encode({
    pgn: PGN.addressClaim,
    dst: 255,
    prio: 6,
    fields: {
      uniqueNumber: claim.uniqueNumber,
      manufacturerCode: claim.manufacturerCode,
      deviceInstanceLower: 0,
      deviceInstanceUpper: 0,
      deviceFunction: 130,
      deviceClass: 'Sensor Communication Interface',
      systemInstance: 0,
      industryGroup: 'Marine',
      arbitraryAddressCapable: 'Yes'
    }
  })
    .split(',')
    .slice(6)
  return BigInt(`0x${bytes.reverse().join('')}`).toString(16)
}

export interface TreeDevice extends Claim {
  address: number
  modelId?: string
  serial?: string
  /** The provider label the server files the device under. */
  label?: string
}

/**
 * A `/sources` tree as the server builds it: `sources[label][src].n2k`, with
 * the Address Claim fields, the derived `canName`, and Product Information.
 */
export function sourcesTree(devices: TreeDevice[]): Record<string, unknown> {
  const tree: Record<string, Record<string, unknown>> = {}
  for (const device of devices) {
    const label = device.label ?? 'can0'
    tree[label] ??= { label, type: 'NMEA2000' }
    tree[label][String(device.address)] = {
      n2k: {
        src: String(device.address),
        canName: canNameOf(device),
        uniqueNumber: device.uniqueNumber,
        manufacturerCode: device.manufacturerCode,
        ...(device.modelId === undefined ? {} : { modelId: device.modelId }),
        ...(device.serial === undefined ? {} : { modelSerialCode: device.serial }),
        pgns: {}
      }
    }
  }
  return tree
}
