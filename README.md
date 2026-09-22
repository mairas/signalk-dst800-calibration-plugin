# signalk-airmar-dst-config

Interactive configuration console for Airmar DST-family NMEA 2000 sensors, as a Signal K server plugin with an embedded webapp.

The same Airmar hardware is sold under several brands, so this plugin identifies a device by the Airmar proprietary protocol it speaks, not by its model name or the badge on its housing. It probes each device at runtime and shows only the capabilities that device answers, which also covers the depth-only and speed-only variants of the family.

> **Status: under development.** The rewrite is tracked in [issue 7](https://github.com/mairas/signalk-dst800-calibration-plugin/issues/7). This scaffold does not yet talk to a device.

## Requirements

- Signal K server 2.31.0 or later, for plugin WebSockets and per-route permissions
- Node 22 or later
- An NMEA 2000 connection that can **transmit**. A receive-only gateway cannot configure anything.

## Development

```
./run deps           # install dependencies
./run install-hooks  # install the pre-commit hooks
./run build          # build the plugin into dist/ and the webapp into public/
./run test           # run the test suite
./run ci             # run every check CI runs
./run help           # list all commands
```

`tools/analyze_stw.ipynb` is the offline notebook used to fit a speed calibration curve from logged pulse rate and speed over ground. The console does not fit curves; it reads and writes them.

## Licence

MIT. Copyright Matti Airas.
