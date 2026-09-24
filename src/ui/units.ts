/**
 * Display units from the Signal K server's unit preferences.
 *
 * None of the console's values is a Signal K path, so the server cannot
 * resolve them; the console maps each setting to a category itself and
 * applies the preset the server would apply for this user. Conversions are
 * the server's Math.js formulas, compiled with mathjs as the admin UI does.
 */

import { compile } from 'mathjs'

export interface Conversion {
  formula: string
  inverseFormula: string
  symbol: string
}

/** `GET /signalk/v1/unitpreferences/definitions`: conversions from each SI unit. */
export type Definitions = Record<string, { conversions: Record<string, Conversion> } | undefined>

/** `GET /signalk/v1/unitpreferences/presets/<name>`. */
export interface Preset {
  categories: Partial<
    Record<string, { baseUnit: string; targetUnit: string; displayFormat?: string }>
  >
}

export interface Units {
  preset: Preset
  definitions: Definitions
}

/** No preferences: every value in its SI unit. */
export const SI: Units = { preset: { categories: {} }, definitions: {} }

/** The SI unit of each category the console uses. */
const BASE_UNITS: Partial<Record<string, string>> = {
  depth: 'm',
  distance: 'm',
  temperature: 'K'
}

/** The server's fallback when neither the user nor the server names a preset. */
const DEFAULT_PRESET = 'nautical-metric'

export type UnitSpec =
  | {
      category: string
      /** A temperature offset: convert by the scale's slope, not its zero point. */
      difference?: boolean
      /** The sensor's step in SI units; sets the decimals shown. */
      resolution?: number
    }
  /** A unit the preferences do not apply to. */
  | { fixed: { symbol: string; decimals: number } }

export interface DisplayUnit {
  symbol: string
  /** An SI value in this unit, at the decimals the sensor can store. */
  format(si: number): string
  /** What the user typed, in SI units, or null when it is not a number. */
  parse(text: string): number | null
}

function unit(
  symbol: string,
  decimals: number,
  toDisplay: (si: number) => number,
  toSi: (shown: number) => number
): DisplayUnit {
  return {
    symbol,
    format: (si) => toDisplay(si).toFixed(decimals),
    parse: (text) => {
      const shown = text.trim() === '' ? NaN : Number(text)
      return Number.isFinite(shown) ? toSi(shown) : null
    }
  }
}

/** Digits after the point in a pattern such as `0.0`. */
const decimalsOf = (pattern: string | undefined): number =>
  pattern?.includes('.') === true ? pattern.length - pattern.indexOf('.') - 1 : 0

/** Enough decimals to show one step of the sensor's resolution. */
const decimalsFor = (step: number): number => Math.max(0, Math.ceil(-Math.log10(Math.abs(step))))

type Evaluate = (value: number) => number

function compiled(formula: string): Evaluate | null {
  try {
    const code = compile(formula)
    return (value) => Number(code.evaluate({ value }))
  } catch {
    return null
  }
}

/** How to show and read one setting's value under `units`. */
export function unitFor(units: Units, spec: UnitSpec): DisplayUnit {
  if ('fixed' in spec) {
    return unit(
      spec.fixed.symbol,
      spec.fixed.decimals,
      (v) => v,
      (v) => v
    )
  }
  const category = units.preset.categories[spec.category]
  const base = category?.baseUnit ?? BASE_UNITS[spec.category] ?? ''
  const siDecimals =
    spec.resolution === undefined
      ? decimalsOf(category?.displayFormat)
      : decimalsFor(spec.resolution)
  const siUnit = unit(
    base,
    siDecimals,
    (v) => v,
    (v) => v
  )

  const target = category?.targetUnit
  const conversion = target === undefined ? undefined : units.definitions[base]?.conversions[target]
  if (target === undefined || target === base || conversion === undefined) {
    return siUnit
  }
  const toDisplay = compiled(conversion.formula)
  const toSi = compiled(conversion.inverseFormula)
  if (toDisplay === null || toSi === null) {
    return siUnit
  }
  if (spec.difference === true) {
    const slope = toDisplay(1) - toDisplay(0)
    const decimals =
      spec.resolution === undefined
        ? decimalsOf(category?.displayFormat)
        : decimalsFor(spec.resolution * slope)
    return unit(
      conversion.symbol,
      decimals,
      (v) => v * slope,
      (v) => v / slope
    )
  }
  const decimals =
    spec.resolution === undefined
      ? decimalsOf(category?.displayFormat)
      : decimalsFor(toDisplay(spec.resolution) - toDisplay(0))
  return unit(conversion.symbol, decimals, toDisplay, toSi)
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { credentials: 'same-origin' })
  if (!response.ok) {
    throw new Error(`${String(response.status)} ${url}`)
  }
  return response.json()
}

async function activePreset(): Promise<string> {
  for (const url of [
    '/signalk/v1/applicationData/user/unitpreferences/1.0.0',
    '/signalk/v1/unitpreferences/config'
  ]) {
    try {
      const body = (await getJson(url)) as { activePreset?: unknown }
      if (typeof body.activePreset === 'string') {
        return body.activePreset
      }
    } catch {
      // Not logged in, no preferences stored, or a server without them: try the next.
    }
  }
  return DEFAULT_PRESET
}

/**
 * The preset this user's server would apply, and the conversions it names.
 * A server without unit preferences (before 2.23) yields SI units.
 */
export async function loadUnits(): Promise<Units> {
  try {
    const name = await activePreset()
    const [preset, definitions] = await Promise.all([
      getJson(`/signalk/v1/unitpreferences/presets/${encodeURIComponent(name)}`),
      getJson('/signalk/v1/unitpreferences/definitions')
    ])
    return { preset: preset as Preset, definitions: definitions as Definitions }
  } catch {
    return SI
  }
}
