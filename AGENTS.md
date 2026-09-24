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

Treat any acknowledgement code that is not `Acknowledge` as a failure. Codes arrive as canboat's names, or as raw numbers when canboatjs has no name or a provider sets `resolveEnums: false`, which the server passes straight to canboatjs. The codec maps numbers through canboat's lookups, so code 0 is still success and code 3 is still access denied. A number the lookups do not name stays a failure: the error fields are wider than the enumerated values, and defaulting that case to success reports a refused command as applied.

A code that is absent is a failure too. With names resolved, canboatjs drops a 4-bit code of 15 (data not available) from the decoded message, the same as a field a truncated frame never carried, and drops a parameter entry of 15 from the list without leaving a gap. So `decodeAcknowledge` reads an absent code and a raw 15 alike as `No code`, and counts parameter codes missing against `numberOfParameters`. A test decodes all sixteen values of every code field through canboatjs with and without names, which also pins the copied name tables to the installed canboat.

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

A full queue is `rejected`, not `unknown`. The session knows that frame never reached the bus, and a console that cannot tell a refused slot from a lost write will invite the user to write EEPROM again. For the same reason a frame the session has not sent by `close()` is `rejected`, whether its task was still queued, waiting for the unlock it needs, or waiting out a mute before a retry. The request in flight when the session closes stays `unknown`, because its frame did go out.

Parameter error `Temporary error` and access denied each get exactly one retry, the latter after re-unlocking. Everything else surfaces as the device sent it, with the decoded acknowledgement attached — its 1-based parameter indices are the only way to say which field of a multi-parameter write was refused.

Access Level 1 expires 15 minutes after the unlock and lives in RAM, so the session unlocks lazily and re-unlocks at 14 minutes. It counts refusals rather than acting on the first: an unlock is addressed, and until the gateway address is known the device's refusal of another node's unlock is indistinguishable from a refusal of ours. An unanswered unlock counts as nothing. The refusals lapse after one grant lifetime, so a product that truly has no Level 1 is asked again every fifteen minutes rather than being written off for the session on evidence that may not have been about it at all.

The Access Level clock is monotonic, not the wall clock. A vessel's Pi has no RTC, so it boots stale and steps when GPS lands — caused by the GPS this plugin sits beside.

## Devices

`src/devices/` finds devices, follows one across address changes, and asks it what it supports. `registry.ts` knows every device, `connection.ts` owns the session for one, and `probe.ts` asks one for its capabilities.

**Identity comes from the `/sources` tree, because only the tree has the numeric manufacturer code.** The server files each Address Claim under `sources[label][address].n2k` with a `canName`: the 64-bit NAME as unpadded hex, whose bits 0–20 are the unique number and 21–31 the manufacturer code. canboatjs renders the manufacturer in a decoded claim as a name where it knows one (`Airmar`, not 135), so a claim heard on the bus cannot produce the number a `DeviceKey` persists. The plugin has no runtime dependencies, so it cannot import canboat's manufacturer lookup, and that list is too long and changes too often to copy the way the codec copies the three acknowledgement lookups.

**Claims heard on the bus win over the tree.** The tree lags the bus, and the server restores it from a cache file at boot, so an entry can name an address the device has left. A live claim is matched to a key by unique number and by the manufacturer as canboatjs rendered it — the number itself, or the name the tree records for the same device. A claim at address 254 means the device holds no address.

Live claims are kept per device, not per address. When a newcomer claims an address a device already holds, the two arbitrate and the loser claims elsewhere; evicting the incumbent on the newcomer's claim would close its session with a false "moved". A tree entry, by contrast, loses to any live claim by another device at its address. Where the tree holds one device at two addresses, the address it is heard at wins.

Frames on `N2KAnalyzerOut` carry no provider label, so the registry and the session both key on address alone. One server serves one NMEA 2000 network: two separate networks under one server would share one address space.

**Presence comes only from frames heard since start**, never from the tree. A device is present for 10 s after its last frame of any PGN, ten periods of the DST's 1 s default rate. The registry rereads the tree every second, which is how it catches both a silence, which sends nothing to react to, and a tree update that lands after the claim that caused it.

**Do not filter candidates by manufacturer.** Rebadged Airmar hardware claims its brand's code and still speaks Airmar's protocol. Whether a device is configurable is the probe's answer.

A session is bound to one address, so `DeviceConnection` closes it when the device moves and builds a new one, telling every waiting caller where the device went. A silence at the same address keeps the session.

**The probe unlocks first and counts an access-denied refusal as support.** The manual marks PIDs 35 and 40–44 Access Level 1 without saying whether that gates reads. A refusal with any other code is `rejected` with the device's reason; silence is `noAnswer`, never unsupported. A refusal the session made itself, such as a full queue, carries no acknowledgement and is `noAnswer` too, because the device was never asked.

`configurable` is `unknown`, not `no`, when PID 41 goes unanswered. A probe whose session closed mid-run is marked `interrupted`, and `ProbeCache` will not keep it: its unanswered capabilities were never asked, and the cache is keyed by identity, so it would outlive the move that interrupted it.

Airmar's proprietary PGNs (65287, 65408–65410, 130944) answer only a 126208 Request naming fields 1 and 3, never an ISO Request. `requestAirmarPgn` builds that; standard PGNs take `requestStandardPgn`.

## Settings

`src/settings/registry.ts` describes each configurable capability once: how to request it, decode the reply, validate outside input, build the command, and compare a read-back with what was asked for. Each entry also declares whether it is `readable` and `writable`, and a qualified entry lists its qualifiers with canboat's names. Anything that handles settings should be generic over the entries, so that a new capability is a new entry.

**Nothing from outside the plugin reaches the bus without passing an entry's `parse`.** `buildCommand` is the one path from a request body to a frame; it also checks the qualifier, such as a temperature source. Ranges are the manual's allowable ranges, not the field's width: speed of sound 1350–1650 m/s, temperature offset ±9.999 K. A value the field could hold but the manual forbids is refused here, before the device can store it.

**Compare a read-back at the device's resolution, never exactly.** The device stores the curve at 0.1 Hz and 0.01 m/s, speed of sound at 0.1 m/s and offsets at 1 mm or 0.001 K, so an exact comparison fails every successful write. `sameAsStored` rounds both sides to the stored step the way canboatjs does, half away from zero; `Math.round` disagrees on a negative half step. Two values do not read back as written: canboatjs trims a decoded string, so `parse` trims the installation description before it is written, and the trip log keeps counting under way, so a reset matches a read-back up to 100 m on.

Every lookup in a reply is read as canboat's name or as its raw number, for the same reason as the acknowledgement codes: a provider can turn name resolution off.

**Every write follows one contract** (`src/settings/operations.ts`): send the command, wait for the Acknowledge, then read the value back once. The Acknowledge is the only commit signal the protocol has, and the read-back is what the console shows as the truth. A stored value that differs beyond resolution is `storedDiffers`, not a failure: the device's value is what the device will use. A refusal from the device is read back too, because the manual does not say whether a curve with one bad point is stored in part. A timeout is not read back; it says nothing about whether the frame arrived. Nor is an access denial: it stores nothing, and the read-back would need the unlock the device has just refused, spending the second refusal that marks Level 1 unavailable.

**The command and its read-back run in one queue slot** (`DeviceSession.commandThenRead`). As two queue entries, a second write to the same setting would land between them, and the first would report the second's value as stored.

A refusal counts as the device's only when its acknowledgement names the command's own PGN. The session also reports a refused unlock, which carries the 65287 acknowledgement, and a full queue, which carries none; in both the command never went out, and the result is `notSent`. A device refusal names the refused fields in the user's terms through each entry's `fieldName`, because the acknowledgement's indices count positions in the 126208 list, which starts with the identity fields.

**The speed and temperature filters are write-only.** Their commands encode and the device acknowledges them, but canboatjs 3.20.0 cannot decode a 126720-43 or -44 reply, and the server runs that version, so the stored value never reaches the plugin (issue 22). Their `read` returns null. The device stores the parameters per filter type, so a write may carry the type alone to switch filters without overwriting parameters the plugin cannot read. Do not add a decoder that reads `canboatjs:unparsed:data`: its chunk format depends on the provider, and it also carries every intermediate fast-packet frame.

The depth offset is field 3 of the standard PGN 128267, not PID 40. PID 40 is the speed of sound. The manual's "distance since last reset" is canboat's `tripLog` in PGN 128275.

## canboatjs cannot encode or decode every proprietary message

Proprietary IDs 1 and 130 have no definition at all (see above). **The Speed Filter (43) and Temperature Filter (44) replies can be neither encoded nor decoded**, in any field combination. Their variants match on `filterType`, and at that field canboatjs's variant filter still holds a four-field 126720 definition, so `f.Fields[4].Match` throws. The 126208 Command and Request that carry the same fields encode correctly, so the plugin can write filters but not read them.

This matters for test fixtures, because the multi-reply tests use PGN 126464, which encodes. Check before designing around a proprietary message: build it, encode it, parse it back.

## HTTP routes

Routes that answer from what the plugin already holds (health, the device list, the selection, the settings list, the event stream) are registered through `router.access('readonly')` so a non-admin login can watch the console. A route registered with a plain `router.get` records no permission, and the server falls through to admin-only.

Every route that puts a frame on the bus keeps that admin default, reading a setting included: a read of a Level 1 setting sends the unlock, and a refused unlock counts toward the two that make Level 1 unavailable for 15 minutes. Do not widen them: the reset and restore routes reboot the sensor and wipe its EEPROM, and the simulate mode setting puts simulated depth on the bus for every autopilot and anchor alarm on the vessel.

A device outcome is a 200 with the outcome in the body, a refusal and a timeout included, because the console shows the device's reason. Error statuses are only for a request the plugin cannot act on: 400 for input refused before the bus, 404 for an unknown setting, 409 when no device is selected, 503 while the plugin is stopped or the device has not been heard, and 500 when the selection cannot be saved.

The routes are registered once at plugin load, before and independently of `start()`, so they reach the `ConsoleRuntime` (`src/runtime.ts`) through a getter. `start()` builds the runtime and `stop()` closes it, removing every bus listener. The selection is saved with `savePluginOptions`, merged into the stored configuration, and does not restart the plugin. Selecting the device already selected keeps its session.

The console gets changes from `GET /api/events`, a Server-Sent Events stream on the plugin router (`src/api/events.ts`), not from a plugin WebSocket. The server leaves a plugin socket's authentication to the plugin and offers nothing to do it with, while a router route goes through the server's own. The stream carries `devices` and `device` whenever the runtime reports a change, `setting` after each read or write that reached the session, and `reset` after a reset or restore that reached the bus. A `device` event can repeat an unchanged body; clients just render it again. The stream is readonly, so with the server's `allow_readonly` it also reaches anonymous clients, including the values an admin reads and writes. It sends `Cache-Control: no-transform`, because the server's `compression()` would otherwise buffer it, and a comment line every 25 s for idle proxies. `stop()` ends every stream, and the route answers 503 while stopped. An EventSource gives up for good on a non-200 answer, so the console recreates it after an error.

Master reset and EEPROM restore are not acknowledged, so `ConsoleRuntime.restart` waits for the device's next Address Claim from the same unique number and answers `claimed`. The claim is what a reboot looks like, not proof of one: a device that ignored the frame also claims when another display asks for claims, so the status names what was seen. It drops the cached probe when the frame goes out and probes again after the claim. The restore route does not offer the unique-number option, because the unique number is half of the key the console follows the device by.

Simulate mode has a Signal K notification at `notifications.airmarDst.simulateMode`, raised when a read or write shows a sensor simulating and cleared once every sensor seen simulating reads off (`src/simulate.ts`, `src/index.ts`). It is tracked per sensor, so switching the console to another sensor cannot clear it. A completed reset does not clear it: the only evidence of the reboot is an Address Claim, which a device that ignored the reset also sends when another display asks for claims. While any console holds the event stream open, the plugin reads PID 35 every minute, because another display can turn simulate mode on and a power cycle turns it off without telling the plugin. That read sends the Level 1 unlock on a readonly viewer's behalf; the session's refusal limit still applies to it. The confirmation before entering simulate mode or restoring EEPROM belongs to the console UI.

PGN transmission intervals and priorities live in `src/settings/pgnIntervals.ts`. A priority is a Command Group Function, confirmed by its acknowledgement. An interval is a Request Group Function, which the device acknowledges only to refuse (manual p.15), so the session's `silenceMeansAccepted` flag turns silence into acceptance without the costs of a timeout. The write then times three frames of the PGN on the bus and reports the last gap. `GET /api/pgns` joins PGN 126464's transmit list with the Airmar PGNs the probe confirmed, because 126464 excludes proprietary PGNs (manual p.16). The single-frame table in `src/protocol/pids.ts` sets the 50 ms or 100 ms minimum, and a test checks it against canboat. Restoring defaults goes through `/api/device/restore`.

The OpenAPI document is `src/api/openApi.ts`. A test fails when a registered route is missing from it, when a list, selection or probe body's fields differ from its schema, or when a setting's read or write body carries a field its schema does not list. The status enums are checked against the result types at compile time. The response types live in `src/types.ts` beside `HealthResponse`, for the webapp to share.

## Snapshots

`src/snapshots/snapshot.ts` exports every readable registry entry the probe did not reject, including the depth offset, which is not probed, and each temperature source separately. A capability the probe heard nothing for is still read, because one lost fast-packet frame causes that. PGN intervals and priorities are not in a snapshot: the plugin has no way to read them back. A read that fails lands in `unread`, so a snapshot missing its curve says so instead of looking complete.

A snapshot file is outside input. `parseSnapshot` refuses an unknown schema version, an unknown setting or qualifier, a slot listed twice, and any re-appliable value its entry's `parse` refuses, so a bad file is refused whole before anything is read or written.

Import reads the target, compares with each entry's `sameAsStored`, and writes only what differs, in registry order. Simulate mode, the distance log and product information are `excluded`, and neither read nor written. A setting the target's probe rejected, or whose read the target itself refuses, is `unsupported`. Only an acknowledgement from the device counts as that refusal, and not one naming PGN 65287 or denying access: a read the session refused, because Level 1 is unavailable or its queue is full, says nothing about the device. Such a setting is written like one whose read went unanswered, and its write fails for the same reason and stops the import. Anything but `applied` stops the import, `storedDiffers` and an unconfirmed `acknowledged` included, because the device then holds something other than the snapshot, and every later write reports `notAttempted`. `/api/snapshot/import` works out the diff afresh rather than trusting the one the console showed.

The three snapshot routes read the device, so they stay admin.

## This repository is public

Never write hostnames, addresses, ports, network layout or account names of local infrastructure into the README, the source, test fixtures, issues or commit messages. Use a placeholder or name the product. Vessel names are ordinary test data.
