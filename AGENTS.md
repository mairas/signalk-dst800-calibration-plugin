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

The wire layer is `src/protocol/`. `codec.ts` builds and reads messages, `pids.ts` holds the protocol constants, `messages.ts` declares the three shapes that cross the server boundary, and `n2kAdapter.ts` is the only file that widens the app type — `nmea2000out`, `nmea2000JsonOut` and `N2KAnalyzerOut` are real but untyped, and the server widens its own type the same way.

Build group functions as canboatjs JSON and emit them on `nmea2000JsonOut`. canboatjs produces byte-identical output to a hand-built Actisense string for every such message, and the codec tests pin three of them against the manual's worked examples.

Always lead a PGN 126720 parameter list with parameter 1 (manufacturer code 135) and parameter 4 (the proprietary ID), in that order. canboatjs narrows the 126720 variant by those match fields as it walks the list, and throws an opaque `unable to read` when they are absent or come after the fields they narrow. `assertIdentity` turns that into a named failure.

**Proprietary IDs 1 (master reset) and 130 (EEPROM restore) are fixed byte strings sent on `nmea2000out`.** They have no `@canboat/ts-pgns` definition, and registering custom ones was tried and rejected for two independent reasons. canboatjs keeps one module-scoped registry, so a plugin installed under the server's config directory registers into a copy the server's encoder never reads. And where the copy is shared, the registration corrupts every other 126720 in the process: definitions whose match fields carry no `Description` act as wildcards, so another component's Airmar Simulate Mode command encodes as a device reboot and a Garmin 126720 has its manufacturer rewritten. These two frames are six fixed bytes each; `sendN2kRaw` passes them through untouched.

The plugin has **no runtime dependencies**. Everything canboatjs does happens inside the server. A packaging test fails if shipped code imports anything the manifest does not declare — that check exists because an undeclared canboatjs import would resolve in this repo and nowhere on a device.

Validate before encoding, never clamp. canboatjs truncates silently: an out-of-range frequency wraps into a plausible one, and `NaN` — what an empty number input yields — defeats every comparison and stores as zero. A clamped point is still a curve the user did not ask for, written to EEPROM, with no error from the device.

Treat any acknowledgement code that is not the literal string `Acknowledge` as a failure, including numbers. canboatjs leaves a lookup it cannot name as a raw number, and the error fields are wider than the enumerated values, so defaulting the unknown case to success reports a refused command as applied.

## HTTP routes

Read routes are registered through `router.access('readonly')` so a non-admin login can use the console. A route registered with a plain `router.get` records no permission, and the server falls through to admin-only.

Routes that write to a sensor keep that admin default. Do not widen them: later units add routes that wipe EEPROM, reboot the sensor and put simulated depth on the bus for every autopilot and anchor alarm on the vessel.

## This repository is public

Never write hostnames, addresses, ports, network layout or account names of local infrastructure into the README, the source, test fixtures, issues or commit messages. Use a placeholder or name the product. Vessel names are ordinary test data.
