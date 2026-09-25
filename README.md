# signalk-airmar-dst-config

Interactive configuration console for Airmar DST-family NMEA 2000 sensors, as a Signal K server plugin with an embedded webapp.

The same Airmar hardware is sold under several brands, so this plugin identifies a device by the Airmar proprietary protocol it speaks, not by its model name or the badge on its housing. It probes each device at runtime and shows only the capabilities that device answers, which also covers the depth-only and speed-only variants of the family.

> **What works today:** the REST API. It finds Airmar sensors on the bus, probes what each supports, reads and writes calibration, filter and transmission settings, resets and restores a sensor, and publishes the sensor's telemetry. The webapp console that drives it is [in progress](https://github.com/mairas/signalk-dst800-calibration-plugin/issues/7).

## Requirements

- Signal K server 2.31.0 or later, for plugin WebSockets and per-route permissions
- Node 22 or later
- An NMEA 2000 connection that can **transmit**. A receive-only gateway cannot configure anything.

## Signal K paths

While the plugin runs, it publishes the selected sensor's own telemetry. Each value is published when its frame arrives. Nothing is published while the sensor is silent, and a value is never set to null, so read the timestamp to judge freshness. A value whose field is missing is not published, and a pulse frame with a missing count, or a missing or zero interval, is skipped whole. A pulse count of 0 at rest is published, with a rate of 0.

The sensor values carry the sensor's own NMEA 2000 source, so their `$source` is `<connection>.<CAN NAME>`, the form `@signalk/n2k-signalk` uses for the sensor's standard depth and speed on a connection with "Use Can NAME in source data" on. On a connection with it off, the standard values use `<connection>.<address>` instead; the server shows both forms as one device.

| Path | Unit | Source |
|---|---|---|
| `sensors.airmarDst.speed.pulseRate` | Hz | PGN 65409: pulse count over its interval |
| `sensors.airmarDst.speed.pulseCount` | | PGN 65409, unreduced, so a consumer can add counts across intervals at low speed |
| `sensors.airmarDst.speed.pulseInterval` | s | PGN 65409 |
| `sensors.airmarDst.supplyVoltage` | V | PGN 65410 |
| `sensors.airmarDst.temperature` | K | PGN 65410, the sensor's board |
| `sensors.airmarDst.depth.quality` | ratio | PGN 65408, 0 when the depth is unlocked |
| `notifications.airmarDst.simulateMode` | | `warn` while a sensor is seen in simulate mode |

The sensor sends PGNs 65408 to 65410 only when they are enabled, which `PUT /api/pgns/:pgn` sets. The setting is stored in the sensor's EEPROM.

## Development

```
./run deps           # install dependencies
./run install-hooks  # install the pre-commit hooks
./run build          # build the plugin into dist/ and the webapp into public/
./run test           # run the unit tests
./run test-ui        # run the webapp tests
./run ci             # run every check CI runs
./run help           # list all commands
```

`tools/analyze_stw.ipynb` is the offline notebook used to fit a speed calibration curve from logged pulse rate and speed over ground. The console does not fit curves; it reads and writes them.

## Licence

MIT. Copyright Matti Airas.
