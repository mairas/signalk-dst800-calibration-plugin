# signalk-airmar-dst-config

Signal K server plugin plus embedded webapp: an interactive configuration console for Airmar DST-family NMEA 2000 sensors.

## What this is

The device is authoritative. Every screen reads live from it and every write reports the device's own answer. The plugin stores only which device the console is pointed at; everything else lives in the sensor's EEPROM.

The rewrite is planned in [issue 7](https://github.com/mairas/signalk-dst800-calibration-plugin/issues/7), with one sub-issue per implementation unit. Read the plan before changing protocol behaviour — it records why several non-obvious choices were made.

## Layout

```
src/            plugin sources, built to dist/ by tsc
src/ui/         webapp sources, built to public/ by Vite
test/           unit tests, mirroring src/
test/helpers/   shared test doubles
test/ui/        webapp tests, run under happy-dom
tools/          offline analysis, not published
```

Tests live under `test/`, never beside the sources: `tsconfig.json` compiles everything under `src/`, so a helper placed there is emitted into `dist/` and published to every device.

Three TypeScript projects, because they need different libs and different decorator semantics:

- `tsconfig.json` emits `dist/` from `src/`, excluding `src/ui/`.
- `tsconfig.lint.json` type-checks `src/` and `test/` without emitting.
- `src/ui/tsconfig.json` covers `src/ui/` and `test/ui/`. It sits next to the webapp sources because esbuild resolves compiler options from the nearest file named `tsconfig.json` — a root-level copy would type-check the webapp under one decorator model while Vite compiled it under another.

## Commands

Use `./run`, never `npm` directly, and never a Makefile. `./run help` lists everything.

`./run ci` is what CI runs plus nothing: the cross-platform matrix runs `ci:portable` (type-check, lint, format, unit tests, webapp tests) and a separate Linux job runs the packaging suite.

`./run install-hooks` after cloning, so lefthook checks types, lint and formatting on commit.

## Conventions

- Strict TypeScript. No `any`, in the webapp as much as in the plugin.
- Tests are behavioural. For a bug fix, write the reproducing test before the fix.
- A test that cannot fail is worth less than no test, because it suppresses the question. Assertions that loop over a possibly-empty list, or that key on a path prefix the build rewrites, have both shipped here already.

## Publishing

`main.yml` stages a draft release behind the full matrix. Publishing that draft starts `release.yml`, which calls `halos-org/shared-workflows`' `publish-npm.yml`. Merging publishes nothing.

`VERSION` and `package.json`'s version must agree; `publish-npm.yml` refuses to publish otherwise, and a test checks it.

## NMEA 2000

The protocol layer does not exist yet — these are the rules it will be held to, established while planning and verified against canboatjs 3.20.0 and `@canboat/ts-pgns` 1.11.11.

Encode every Request and Command Group Function as canboatjs JSON and emit it on `nmea2000JsonOut`. Receive decoded PGNs on `N2KAnalyzerOut`. Do not hand-build Actisense strings: canboatjs produces byte-identical output for every message the old plugin sent, which the codec tests will pin against captured bytes.

Always lead a PGN 126720 parameter list with parameter 1 (manufacturer code 135) and parameter 4 (the proprietary ID). canboatjs narrows the 126720 variant by those match fields and throws `unable to read` without them.

Proprietary IDs 1 (master reset) and 130 (EEPROM restore) have no `@canboat/ts-pgns` definition. Both currently encode to the same wrong frame, `87,98,ff`, with the proprietary ID dropped as not-available, so they need a custom definition or a hand-built frame. They are also sent as PGN 126720 addressed to the device, not wrapped in a 126208 Command.

`N2KAnalyzerOut`, `nmea2000out` and `nmea2000JsonOut` are not part of the typed `ServerAPI`. Reach them through one adapter module so that a server change breaks one file.

## HTTP routes

Read routes are registered through `router.access('readonly')` so a non-admin login can use the console. A route registered with a plain `router.get` records no permission, and the server falls through to admin-only.

Routes that write to a sensor keep that admin default. Do not widen them: later units add routes that wipe EEPROM, reboot the sensor and put simulated depth on the bus for every autopilot and anchor alarm on the vessel.

## This repository is public

Never write hostnames, addresses, ports, network layout or account names of local infrastructure into the README, the source, test fixtures, issues or commit messages. Use a placeholder or name the product. Vessel names are ordinary test data.
