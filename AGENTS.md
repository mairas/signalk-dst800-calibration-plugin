# signalk-airmar-dst-config

Signal K server plugin plus embedded webapp: an interactive configuration console for Airmar DST-family NMEA 2000 sensors.

## What this is

The device is authoritative. Every screen reads live from it and every write reports the device's own answer. The plugin stores only which device the console is pointed at; everything else lives in the sensor's EEPROM.

The rewrite is planned in [issue 7](https://github.com/mairas/signalk-dst800-calibration-plugin/issues/7), with one sub-issue per implementation unit. Read the plan before changing protocol behaviour — it records why several non-obvious choices were made.

How the plugin works, and why, is in [docs/architecture.md](docs/architecture.md). Read the section for the area you are changing before you change it.

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

`VERSION` and `package.json`'s version must agree; `publish-npm.yml` refuses to publish otherwise, and a test checks it. Bump with `./run bumpversion patch|minor|major`, which moves both, refreshes `package-lock.json` and commits them. It needs bump2version (`uv tool install bump2version`).

## This repository is public

Never write hostnames, addresses, ports, network layout or account names of local infrastructure into the README, the source, test fixtures, issues or commit messages. Use a placeholder or name the product. Vessel names are ordinary test data.
