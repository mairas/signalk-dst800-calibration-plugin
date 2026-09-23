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

## Device session

`src/session/` owns every conversation with a device. One `DeviceSession` per device, one request in flight at a time, one session per device — two sessions on one address each see the other's replies and can adopt them.

A session is bound to one source address for its life. The address changes on an NMEA 2000 re-claim, and this plugin's own master reset causes one, so the owner closes the session and builds a new one rather than expecting it to follow the device.

Correlation is structural, because Airmar's messages carry no transaction id. A reply must come from the device's address, be global or addressed to the gateway, and — for a 126720 — name the proprietary ID that was requested. The serial queue is what makes those enough. Do not add concurrency to the queue.

**A timeout does not end the exchange, and it does not mean a reply is coming either.** Both cases are real and they pull opposite ways. canboatjs drops a fast-packet message that lost a frame, so most timeouts are a reply that will never arrive; a loaded bus also produces replies that are merely late. The session therefore _mutes_ the shape of an abandoned request for one timeout and does not send the next request of that shape until the mute lapses. Nothing is consumed and nothing is counted.

Counting the outstanding replies and consuming them was tried and is wrong in both directions. Where the reply was lost, the debt is paid off by the next request's legitimate reply and a working device fails. Where the device is slow, the debt is consumed by whichever reply lands first, which is as often the fresh one, and the caller is handed the stale value under `answered`. Muting costs latency after a timeout and never a wrong value.

**A reply that arrives inside a mute widens the timeout.** It proves the device answers and that the wait was too short for this bus. Without that, a device slower than the timeout fails every request for ever: each timeout mutes the shape, the mute covers the next reply, and the next request times out in turn. The timeout doubles to a cap of 8 s.

A read is owed data and a command an acknowledgement, never both, and a mute matching an unknown data shape matches nothing. Get either wrong and a timed-out read swallows the next write's acknowledgement, or the device's own depth and speed frames — several a second — count as late replies.

**The gateway's own source address is inferred, and the inference is not sound — only recoverable.** Nothing in the Signal K server exposes the address canboatjs claimed. The session learns it from the `dst` of the reply that _settled_ a request, and adopts it only when two settled requests agree. While it is unknown every `dst` is accepted, so a reply the device sent to another plotter can settle a request and teach that plotter's address. What bounds the damage is that a wrong address makes every request time out, and two consecutive timeouts discard it. One timeout does not: probing a PID the device does not implement is an ordinary event, and resetting on each would make the degraded state permanent.

Learn only from a settled reply. `finish` runs once per attempt, so two observations are always two exchanges; learning from every matching reply would let one multi-reply read adopt an address from a single foreign answer.

Every message from the device reaches `onObservation`, including replies that answer nobody and replies that arrive after their request timed out. They cannot resolve a request, but they are still the device's true state. It runs _after_ correlation and inside a `try`, so a broken cache cannot cost a request its answer.

**Nothing in the bus handler may throw.** It runs inside the server's own event dispatch, where an uncaught exception stops the Signal K process — on a vessel, the process feeding the autopilot and the anchor alarm. The same applies to `bus.send`: `app.emit` re-throws a listener's exception synchronously, so a canboatjs encode failure becomes an `unknown` outcome rather than a rejected promise. A queued task always settles its caller; a task that escaped would leave the drain loop flagged busy and every later request pending for ever.

**Silence is `unknown`, never failure, and a refusal is never downgraded to silence.** canboatjs drops a fast-packet message that lost a frame without reporting it, which on the wire is indistinguishable from an unimplemented PID. The converse matters as much: after the device denies an operation, a re-unlock that then goes unanswered must not replace the denial with "no answer".

Reads coalesce, commands never. Two reads join only when their frame, decoder and options all match: the same frame is not the same operation, and a caller that asks one question expecting a different answer must not be handed someone else's. Two writes under one key would otherwise send one frame and report the first one's success for the second.

Duplicate replies are recognised by the frame's own fields, not by what a decoder made of them. Two filter types carrying identical settings decode equal, and deduping on that would discard a genuinely distinct reply and strand a two-reply read one short.

Nothing the host supplies may take the process down: `onObservation` and `onError` both run inside `try`, `onError` is never called outside one, and the drain's promise carries a `catch`. A logger that throws during shutdown would otherwise leave a caller's promise pending for ever and raise an unhandled rejection.

A full queue is `rejected`, not `unknown`. The session knows that frame never reached the bus, and a console that cannot tell a refused slot from a lost write will invite the user to write EEPROM again.

Parameter error `Temporary error` and access denied each get exactly one retry, the latter after re-unlocking. Everything else surfaces as the device sent it, with the decoded acknowledgement attached — its 1-based parameter indices are the only way to say which field of a multi-parameter write was refused.

Access Level 1 expires 15 minutes after the unlock and lives in RAM, so the session unlocks lazily and re-unlocks at 14 minutes. It counts refusals rather than acting on the first: an unlock is addressed, and until the gateway address is known the device's refusal of another node's unlock is indistinguishable from a refusal of ours. An unanswered unlock counts as nothing. The refusals lapse after one grant lifetime, so a product that truly has no Level 1 is asked again every fifteen minutes rather than being written off for the session on evidence that may not have been about it at all.

The Access Level clock is monotonic, not the wall clock. A vessel's Pi has no RTC, so it boots stale and steps when GPS lands — caused by the GPS this plugin sits beside.

## canboatjs cannot encode every proprietary message

Three so far: proprietary IDs 1 and 130 have no definition at all (see above), and **Speed Filter (43) cannot be encoded in any field combination** — its variants match on `filterType`, and the encoder throws `Cannot read properties of undefined` for every shape, including the exact field sets `@canboat/ts-pgns` declares. Temperature Filter (44) is defined the same way and is likely the same.

This is an encoder limit, not a decoder one. It matters for test fixtures — the multi-reply tests use PGN 126464, which encodes — and it will matter for Unit 5, which has to _write_ filter settings. Check before designing around a proprietary message: build it, encode it, parse it back.

## HTTP routes

Read routes are registered through `router.access('readonly')` so a non-admin login can use the console. A route registered with a plain `router.get` records no permission, and the server falls through to admin-only.

Routes that write to a sensor keep that admin default. Do not widen them: later units add routes that wipe EEPROM, reboot the sensor and put simulated depth on the bus for every autopilot and anchor alarm on the vessel.

## This repository is public

Never write hostnames, addresses, ports, network layout or account names of local infrastructure into the README, the source, test fixtures, issues or commit messages. Use a placeholder or name the product. Vessel names are ordinary test data.
