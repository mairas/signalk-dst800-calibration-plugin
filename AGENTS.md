# signalk-airmar-dst-config

Signal K server plugin plus embedded webapp: an interactive configuration console for Airmar DST-family NMEA 2000 sensors.

## What this is

The device is authoritative. Every screen reads live from it and every write reports the device's own answer. The plugin stores only which device the console is pointed at; everything else lives in the sensor's EEPROM.

The rewrite is planned in [issue 7](https://github.com/mairas/signalk-dst800-calibration-plugin/issues/7), with one sub-issue per implementation unit. Read the plan before changing protocol behaviour — it records why several non-obvious choices were made.

## Layout

```
src/            plugin sources, built to dist/ by tsc
src/ui/         webapp sources, built to public/ by Vite
src/test/       test helpers shared by the test tree
test/           tests, mirroring src/
tools/          offline analysis, not published
```

Tests live in `test/`, mirroring `src/`, not beside the sources.

## Commands

Use `./run`, never `npm` directly, and never a Makefile. `./run help` lists everything. `./run ci` runs exactly what CI runs.

## Conventions

- Strict TypeScript. No `any`.
- Tests are behavioural. For a bug fix, write the reproducing test first.
- Prettier and ESLint are enforced by lefthook on commit. Run `./run install-hooks` after cloning.

## NMEA 2000

Encode every Request and Command Group Function as canboatjs JSON and emit it on `nmea2000JsonOut`. Receive decoded PGNs on `N2KAnalyzerOut`. Never hand-build Actisense strings: canboatjs produces byte-identical output, which is verified in the codec tests.

Always lead a PGN 126720 parameter list with parameter 1 (manufacturer code 135) and parameter 4 (the proprietary ID). canboatjs narrows the 126720 variant by those match fields and throws `unable to read` without them.

Proprietary IDs 1 (master reset) and 130 (EEPROM restore) have no `@canboat/ts-pgns` definition and are the one exception; see the codec for how they are handled.

`N2KAnalyzerOut`, `nmea2000out` and `nmea2000JsonOut` are not part of the typed `ServerAPI`. They are reached through one adapter module so that a server change breaks one file.

## This repository is public

Never write hostnames, addresses, ports, network layout or account names of local infrastructure into the README, the source, test fixtures, issues or commit messages. Use a placeholder or name the product. Vessel names are ordinary test data.
