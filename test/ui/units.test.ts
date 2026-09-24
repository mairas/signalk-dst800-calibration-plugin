import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  SI,
  loadUnits,
  unitFor,
  unitNamed,
  type Definitions,
  type Preset,
  type Units
} from '../../src/ui/units.js'

/** Shaped like signalk-server's standard-units-definitions.json. */
const DEFINITIONS: Definitions = {
  m: {
    conversions: {
      foot: { formula: 'value * 3.28084', inverseFormula: 'value / 3.28084', symbol: 'ft' },
      'naut-mile': {
        formula: 'value * 0.0005399568034557236',
        inverseFormula: 'value / 0.0005399568034557236',
        symbol: 'nmi'
      },
      kilometer: { formula: 'value / 1000', inverseFormula: 'value * 1000', symbol: 'km' }
    }
  },
  K: {
    conversions: {
      C: { formula: 'value - 273.15', inverseFormula: 'value + 273.15', symbol: '°C' },
      F: {
        formula: '(value - 273.15) * 9/5 + 32',
        inverseFormula: '(value - 32) * 5/9 + 273.15',
        symbol: '°F'
      }
    }
  }
}

const preset = (depth: string, distance: string, temperature: string): Preset => ({
  categories: {
    depth: { baseUnit: 'm', targetUnit: depth },
    distance: { baseUnit: 'm', targetUnit: distance, displayFormat: '0.0' },
    temperature: { baseUnit: 'K', targetUnit: temperature }
  }
})

const units = (p: Preset): Units => ({ preset: p, definitions: DEFINITIONS })

describe('units', () => {
  describe('a category the preset maps', () => {
    it('shows metres unconverted where the preset keeps the SI unit', () => {
      const depth = unitFor(units(preset('m', 'naut-mile', 'C')), {
        category: 'depth',
        resolution: 0.001
      })

      expect(depth.symbol).toBe('m')
      expect(depth.format(0.35)).toBe('0.350')
      expect(depth.parse('0.5')).toBe(0.5)
    })

    it('converts to the preset’s unit and back, with decimals from the sensor’s resolution', () => {
      const depth = unitFor(units(preset('foot', 'naut-mile', 'F')), {
        category: 'depth',
        resolution: 0.001
      })

      expect(depth.symbol).toBe('ft')
      expect(depth.format(0.35)).toBe('1.148')
      expect(depth.parse('1.148')).toBeCloseTo(0.3499, 4)
    })

    it('converts a temperature offset as a difference, without the scale’s zero point', () => {
      const fahrenheit = unitFor(units(preset('m', 'naut-mile', 'F')), {
        category: 'temperature',
        difference: true,
        resolution: 0.001
      })
      const celsius = unitFor(units(preset('m', 'naut-mile', 'C')), {
        category: 'temperature',
        difference: true,
        resolution: 0.001
      })

      expect(fahrenheit.symbol).toBe('°F')
      expect(fahrenheit.format(0.5)).toBe('0.900')
      expect(fahrenheit.parse('-1.8')).toBeCloseTo(-1, 9)
      expect(celsius.symbol).toBe('°C')
      expect(celsius.format(0.5)).toBe('0.500')
    })

    it('uses the preset’s display format where no resolution is given', () => {
      const distance = unitFor(units(preset('m', 'naut-mile', 'C')), { category: 'distance' })

      expect(distance.format(18520)).toBe('10.0')
      expect(distance.symbol).toBe('nmi')
    })
  })

  describe('falling back to SI', () => {
    it('keeps a fixed unit whatever the preset says', () => {
      const sound = unitFor(units(preset('foot', 'mile', 'F')), {
        fixed: { symbol: 'm/s', decimals: 1 }
      })

      expect(sound.symbol).toBe('m/s')
      expect(sound.format(1500)).toBe('1500.0')
      expect(sound.parse('1480')).toBe(1480)
    })

    it('shows SI units when the preset names a conversion the definitions lack', () => {
      const depth = unitFor(units(preset('fathom', 'naut-mile', 'C')), {
        category: 'depth',
        resolution: 0.001
      })

      expect(depth.symbol).toBe('m')
      expect(depth.format(0.35)).toBe('0.350')
    })

    it('shows SI units when a formula does not compile', () => {
      const broken: Units = {
        preset: preset('foot', 'naut-mile', 'C'),
        definitions: {
          m: { conversions: { foot: { formula: 'value *', inverseFormula: '', symbol: 'ft' } } }
        }
      }

      expect(unitFor(broken, { category: 'depth', resolution: 0.001 }).symbol).toBe('m')
    })

    it('shows SI units before the preferences have loaded', () => {
      expect(unitFor(SI, { category: 'depth', resolution: 0.001 }).symbol).toBe('m')
    })

    it('refuses what is not a number rather than writing zero', () => {
      const depth = unitFor(SI, { category: 'depth', resolution: 0.001 })

      expect(depth.parse('')).toBeNull()
      expect(depth.parse('abc')).toBeNull()
    })
  })

  describe('loading', () => {
    beforeEach(() => {
      vi.spyOn(globalThis, 'fetch')
    })

    afterEach(() => {
      vi.restoreAllMocks()
    })

    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

    /** Answers each URL from `routes`, 404 otherwise, and records what was asked. */
    const answer = (routes: Record<string, Response>) => {
      const asked: string[] = []
      vi.mocked(fetch).mockImplementation((input) => {
        const url = input as string
        asked.push(url)
        return Promise.resolve(routes[url] ?? new Response('', { status: 404 }))
      })
      return asked
    }

    it('uses the logged-in user’s own preset', async () => {
      const asked = answer({
        '/signalk/v1/applicationData/user/unitpreferences/1.0.0': json({
          activePreset: 'imperial-us'
        }),
        '/signalk/v1/unitpreferences/presets/imperial-us': json(preset('foot', 'mile', 'F')),
        '/signalk/v1/unitpreferences/definitions': json(DEFINITIONS)
      })

      const loaded = await loadUnits()

      expect(loaded.preset.categories.depth?.targetUnit).toBe('foot')
      expect(asked).not.toContain('/signalk/v1/unitpreferences/config')
    })

    it('falls back to the server’s preset, then to nautical-metric', async () => {
      answer({
        '/signalk/v1/unitpreferences/config': json({ activePreset: 'metric' }),
        '/signalk/v1/unitpreferences/presets/metric': json(preset('m', 'kilometer', 'C')),
        '/signalk/v1/unitpreferences/definitions': json(DEFINITIONS)
      })
      expect((await loadUnits()).preset.categories.distance?.targetUnit).toBe('kilometer')

      const asked = answer({
        '/signalk/v1/unitpreferences/presets/nautical-metric': json(preset('m', 'naut-mile', 'C')),
        '/signalk/v1/unitpreferences/definitions': json(DEFINITIONS)
      })
      expect((await loadUnits()).preset.categories.distance?.targetUnit).toBe('naut-mile')
      expect(asked).toContain('/signalk/v1/unitpreferences/presets/nautical-metric')
    })

    it('settles for SI units when the server has no unit preferences', async () => {
      answer({})

      expect(await loadUnits()).toBe(SI)
    })
  })

  describe('unitNamed', () => {
    const units: Units = {
      preset: { categories: {} },
      definitions: {
        'm/s': {
          conversions: {
            knot: { formula: 'value * 1.94384', inverseFormula: 'value * 0.514444', symbol: 'kn' },
            'km/h': { formula: 'value * 3.6', inverseFormula: 'value / 3.6', symbol: 'km/h' }
          }
        }
      }
    }
    const speed = { category: 'speed', resolution: 0.01 } as const

    it.each([
      ['a key', 'km/h', 'km/h'],
      ['a symbol that is not the key', 'kn', 'kn'],
      ['the base unit', 'm/s', 'm/s'],
      ['any case', 'KM/H', 'km/h']
    ])('finds %s', (_case, name, symbol) => {
      expect(unitNamed(units, speed, name)?.symbol).toBe(symbol)
    })

    it('converts by the named unit', () => {
      expect(unitNamed(units, speed, 'kn')?.parse('1')).toBeCloseTo(0.514444, 6)
    })

    it('knows no unit the server does not, and none for a fixed unit', () => {
      expect(unitNamed(units, speed, 'furlongs')).toBeNull()
      expect(unitNamed(units, { fixed: { symbol: 'm/s', decimals: 1 } }, 'm/s')).toBeNull()
    })
  })
})
