"use strict"

const _ = require('lodash')

const pgnToActisenseSerialFormat = require("@canboat/canboatjs").pgnToActisenseSerialFormat;


function paddb(n, p, c) {
  // supports negative integers up to 32 bits, breaks after that
  const pad_char = typeof c !== 'undefined' ? c : '0';
  const pad = new Array(1 + p).join(pad_char);
  return (pad + (Math.round(n)>>>0).toString(16)).slice(-pad.length);
}

function uint16le(n) {
  const pad = paddb(n, 4)
  return pad.slice(2, 4) + "," + pad.slice(0, 2)
}

function uint32le(n) {
  const pad = paddb(n, 8)
  return [[6,8],[4,6],[2,4],[0,2]]
    .map((arr) => pad.slice(arr[0], arr[1]))
    .join(",")
}

function getFreqSTWTuples(input) {
  return input.map((row) => [row["Input frequency"], row["Output speed"]])
}

function freqSTWTuplesAsString(input) {
  return (input.map((row) => `${ row[0] } ${ row[1] }`)).join("\n")
}

function parseSTWCalibrationString(string) {
  const values = string.trim().split("\n").map((row) => {
    const words = row.trim().split(/\s+/)
    if (words.length != 2) {
      throw ("Must have exactly two values on a row: " + row)
    }
    return words.map((s) => parseFloat(s))
  })
  return values
}


module.exports = function (app) {
  let plugin = {};
  let n2kCallback = undefined

  let config = undefined

  let depth_response = ""
  let calibrate_depth_response = ""
  let calibrate_speed_response = ""
  let calibrate_temperature_response = ""


  plugin.id = 'signalk-dst800-calibration-plugin';
  plugin.name = 'Airmar DST800 calibration settings';
  plugin.description = 'Set a DST800 triducer in-device calibration values';

  function setDepthOffset(dst, offset) {
    let cmd_msg = {
      pgn: 126208,
      dst: dst,
      prio: 3,
      fields: {
        "Function Code": "Command",
        "PGN": 128267,
        "Priority": 8,
        //"Reserved": 8,
        "# of Parameters": 1,
        "list": [
          {
            "Parameter": 3,
            "Value": offset
          }
        ]
      }
    }
    const rawMsg = pgnToActisenseSerialFormat(cmd_msg);
    app.debug('Changing depth offset to', offset)
    app.debug(`raw message: ${rawMsg}`);
    app.emit('nmea2000JsonOut', cmd_msg)
  }

  function setDST800AccessLevel(dst) {
    // only supports setting access level to 1
    const pgn = 126208
    const prio = 3
    const now = (new Date()).toISOString()

    const msg = `${ now },${ prio },${ pgn },00,${ dst },00`
      + ",01"  // Command
      + ",07,ff,00" // Commanded PGN: 65287 - Proprietary: Access Level
      + ",f8"  // Priority: Leave unchanged
      + ",05"  // number of parameter pairs
      + ",01,87,00" // Manufacturer Code: Airmar
      + ",03,04" // Industry Group: Marine Industry
      + ",04,01" // Format Code: 1
      + ",05,01" // Access Level: 1
      + ",07,78,56,34,12"  // Seed: 0x12345678

    app.debug("Setting DST800 Access Level to 1")
    app.emit('nmea2000out', msg)
  }

  function enableSpeedPulseCount(dst, interval) {
    const pgn = 126208
    const prio = 3
    const now = (new Date()).toISOString()

    const msg = `${ now },${ prio },${ pgn },00,${ dst },00`
      + ",00"  // Request
      + ",81,ff,00" // Requested PGN: 65409
      + "," + uint32le(1000 * interval)  // Transmission interval: immediate/no change
      + ",00,00"  // Transm. interv. offset: immediate/no change
      + ",02"  // number of parameter pairs
      + ",01,87,00" // Manufacturer Code: Airmar
      + ",03,04" // Industry Group: Marine Industry

    app.debug("Setting speed pulse count transmit interval to 2s")
    app.emit('nmea2000out', msg)
  }

  function requestSTWCalibrationCurve(dst) {
    const pgn = 126208
    const prio = 3
    const now = (new Date()).toISOString()

    const msg = `${ now },${ prio },${ pgn },00,${ dst },00`
      + ",00"  // Request
      + ",00,ef,01" // Requested PGN: 126720
      + ",ff,ff,ff,ff"  // Transmission interval: immediate/no change
      + ",ff,ff"  // Transm. interv. offset: immediate/no change
      + ",03"  // number of parameter pairs
      + ",01,87,00" // Manufacturer Code: Airmar
      + ",03,04" // Industry Group: Marine Industry
      + ",04,29"  // Proprietary ID: Calibrate Speed (0x29==41)

    app.debug("Requesting speed calibration information")
    app.emit('nmea2000out', msg)
  }

  function resetSTWCalibrationCurve(dst) {
    const pgn = 126208
    const prio = 3
    const now = (new Date()).toISOString()

    const msg = `${ now },${ prio },${ pgn },00,${ dst },00`
      + ",01"  // Command
      + ",00,ef,01" // Requested PGN: 126720
      + ",f8"  // Priority: Leave unchanged
      + ",04"  // number of parameter pairs
      + ",01,87,00" // Manufacturer Code: Airmar
      + ",03,04" // Industry Group: Marine Industry
      + ",04,29" // Proprietary ID: Calibrate Speed (0x29==41)
      + ",05,fe" // Number of data points

    app.debug("Resetting STW calibration pairs to factory defaults")
    app.emit('nmea2000out', msg)
  }

  function setSTWCalibrationCurve(dst, values) {
    const data_point_parameters = values.flatMap(
      (r, idx) => (
        [
          {
            "Parameter": 6 + 2 * idx,
            "Value": r[0]  // Pulse Frequency (Hz)
          },
          {
            "Parameter": 6 + 2 * idx + 1,
            "Value": r[1]  // Speed (m/s)
          },
        ]
      )
    );

    app.debug("Data points:", JSON.stringify(data_point_parameters, null, 2));

    const parameters = [].concat(
      [
        {
          "Parameter": 1,  // Manufacturer Code
          "Value": 135     // Airmar
        },
        {
          "Parameter": 3,  // Industry Code
          "Value": 4       // Marine Industry  
        },
        {
          "Parameter": 4,  // Proprietary ID
          "Value": 41      // Calibrate Speed
        },
        {
          "Parameter": 5,  // Number of pairs of data points to follow
          "Value": values.length
        }
      ],
      data_point_parameters
    );

    app.debug("Parameters:", JSON.stringify(parameters, null, 2));

    const cmd_msg = {
      pgn: 126208,  // NMEA - Command group function
      dst: dst,
      prio: 3,
      fields: {
        "Function Code": "Command",
        "PGN": 126720,
        "Priority": 8,
        "Number of Parameters": 4 + 2 * values.length,
        "list": parameters
      }
    }

    app.debug("Command message:", JSON.stringify(cmd_msg, null, 2));

    app.debug("Setting STW calibration pairs")
    const raw_msg = pgnToActisenseSerialFormat(cmd_msg);
    app.debug("raw message:", raw_msg);
    app.emit('nmea2000out', raw_msg)
  }

  function requestTemperatureOffset(dst) {
    const pgn = 126208
    const prio = 3
    const now = (new Date()).toISOString()

    const msg = `${ now },${ prio },${ pgn },00,${ dst },00`
      + ",00"  // Request
      + ",00,ef,01" // Requested PGN: 126720
      + ",ff,ff,ff,ff"  // Transmission interval: immediate/no change
      + ",ff,ff"  // Transm. interv. offset: immediate/no change
      + ",04"  // number of parameter pairs
      + ",01,87,00" // Manufacturer Code: Airmar
      + ",03,04" // Industry Group: Marine Industry
      + ",04,2a"  // Proprietary ID: Calibrate Temperature (0x2a==42)
      + ",05,01"  // Onboard Water Sensor

    app.debug("Requesting temperature offset information")
    app.emit('nmea2000out', msg)
  }

  function setTemperatureOffset(dst, offset) {
    const pgn = 126208
    const prio = 3
    const now = (new Date()).toISOString()

    const msg = `${ now },${ prio },${ pgn },00,${ dst },00`
      + ",01"  // Command
      + ",00,ef,01" // Commanded PGN: 126720
      + ",f8"  // Priority: Leave unchanged
      + ",05"  // number of parameter pairs
      + ",01,87,00" // Manufacturer Code: Airmar
      + ",03,04" // Industry Group: Marine Industry
      + ",04,2a" // Proprietary ID: Calibrate Temperature (0x2a==42)
      + ",05,01"  // Onboard water sensor
      + ",07," + uint16le(offset)  // Temperature offset

    app.debug("Setting STW calibration pairs")
    app.emit('nmea2000out', msg)
  }

  plugin.start = async function (options, restartPlugin) {
    // Here we put our plugin logic
    app.debug('DST800 plugin started');

    // provide the schema function access to the configuration object
    config = options

    app.debug(JSON.stringify(options))

    n2kCallback = (msg) => {
      try {
        let fields = msg['fields']

        //if (msg.pgn == 126720) {
        //  let msg_str = JSON.stringify(msg, null, 2)
        //  app.debug(msg_str)
        //}

        if (msg.pgn == 128267) {
          // depth is being transmitted continuously, so if requested,
          // just store the first value we receive
          if (options.depth_offset.request_value) {
            app.debug("Reading depth offset")
            options.depth_offset.value = fields['Offset']
            options.depth_offset.request_value = false
            app.savePluginOptions(options, () => { app.debug('DST 800 plugin options saved') });
          }
        }
        else if (msg.pgn == 65409) {  // Speed Pulse Count
          const num_pulses = fields['Number of pulses received']
          const duration = fields['Duration of interval']
          const pulse_rate = num_pulses / duration
          app.handleMessage('signalk-dst800-calibration-plugin', {
            updates: [
              {
                values: [
                  {
                    path: "navigation.speedSensorPulseRate",
                    value: pulse_rate
                  }
                ]
              }
            ]
          })
        }
        else if (msg.pgn == 126208  // Acknowledge Group Function
          && fields['Function Code'] == "Acknowledge"
          && fields['PGN'] == 126720) {
          let msg_str = JSON.stringify(msg, null, 2)
          app.debug(`Acknowledge Group Function: ${ msg_str }`)
        }
        else if (msg.pgn == 126208  // Acknowledge Group Function
          && fields['Function Code'] == "Acknowledge"
          && fields['PGN'] == 65409) {
          let msg_str = JSON.stringify(msg, null, 2)
          app.debug(`Acknowledge Group Function: ${ msg_str }`)
        }
        else if (msg.pgn == 126208  // Acknowledge Group Function
          && fields['Function Code'] == "Acknowledge"
          && fields['PGN'] == 65287) {
          let msg_str = JSON.stringify(msg, null, 2)
          app.debug(`Acknowledge Group Function: ${ msg_str }`)
        }
        else if (msg.pgn == 126720
          && fields['Manufacturer Code'] == 'Airmar'
          && fields['Industry Code'] == 'Marine Industry'
          && fields['Proprietary ID'] == 'Calibrate Depth') {
          calibrate_depth_response = JSON.stringify(msg, null, 2);
          app.debug(`DST800 calibrate_depth_response: ${ calibrate_depth_response }`)
        }
        else if (msg.pgn == 126720
          && fields['Manufacturer Code'] == 'Airmar'
          && fields['Industry Code'] == 'Marine Industry'
          && fields['Proprietary ID'] == 'Calibrate Speed') {
          calibrate_speed_response = JSON.stringify(msg, null, 2);
          app.debug(`DST800 calibrate_speed_response: ${ calibrate_speed_response }`)
          let freqSTWTuples = getFreqSTWTuples(fields["list"])
          options.speed_through_water.value = freqSTWTuplesAsString(freqSTWTuples)
          app.savePluginOptions(options, () => { app.debug('DST 800 plugin options saved') });
        }
        else if (msg.pgn == 126720
          && fields['Manufacturer Code'] == 'Airmar'
          && fields['Industry Code'] == 'Marine Industry'
          && fields['Proprietary ID'] == 'Calibrate Temperature') {
          calibrate_temperature_response = JSON.stringify(msg, null, 2);
          app.debug(`DST800 calibrate_temperature_response: ${ calibrate_temperature_response }`)
        };
      } catch (e) {
        console.error(e)
      }
    }
    app.on("N2KAnalyzerOut", n2kCallback)

    if (options.depth_offset && options.depth_offset.set_value) {
      if (typeof options.instance === 'undefined' || typeof options.depth_offset.value === 'undefined') {
        console.error("address or depth offset is not defined")
      } else {
        setDepthOffset(options.instance, options.depth_offset.value)
        options.depth_offset.set_value = false
        app.savePluginOptions(options, () => { app.debug('DST 800 plugin options saved') });
      }
    }

    if (options.speed_pulse_count && options.speed_pulse_count.enable) {
      enableSpeedPulseCount(options.instance, options.speed_pulse_count.interval)
    }

    if (options.speed_through_water && options.speed_through_water.request_value) {
      if (typeof options.instance === 'undefined') {
        console.error("address is not defined")
      } else {
        setDST800AccessLevel(options.instance)
        // sleep for a second to allow the access level request to go through
        await new Promise(r => setTimeout(r, 1000));
        requestSTWCalibrationCurve(options.instance)
        options.speed_through_water.request_value = false
        // need to save options to update the request_value field change above
        app.savePluginOptions(options, () => { app.debug('DST 800 plugin options saved') });
      }
    }

    if (options.speed_through_water && options.speed_through_water.restore_defaults) {
      setDST800AccessLevel(options.instance)
      // sleep for a second to allow the access level request to go through
      await new Promise(r => setTimeout(r, 1000));

      resetSTWCalibrationCurve(options.instance)

      options.speed_through_water.restore_defaults = false
      // need to save options to update the restore_defaults field change above
      app.savePluginOptions(options, () => { app.debug('DST 800 plugin options saved') });
    }

    if (options.speed_through_water && options.speed_through_water.set_value) {
      let values = undefined
      values = parseSTWCalibrationString(options.speed_through_water.value)

      setDST800AccessLevel(options.instance)
      // sleep for a second to allow the access level request to go through
      await new Promise(r => setTimeout(r, 1000));

      setSTWCalibrationCurve(options.instance, values)

      options.speed_through_water.set_value = false
      // need to save options to update the set_value field change above
      app.savePluginOptions(options, () => { app.debug('DST 800 plugin options saved') });
    }

    if (options.temperature_offset && options.temperature_offset.request_value) {
      if (typeof options.instance === 'undefined') {
        console.error("address is not defined")
      } else {
        setDST800AccessLevel(options.instance)
        // sleep for a second to allow the access level request to go through
        await new Promise(r => setTimeout(r, 1000));
        requestTemperatureOffset(options.instance)
        options.temperature_offset.request_value = false
        // need to save options to update the request_value field change above
        app.savePluginOptions(options, () => { app.debug('DST 800 plugin options saved') });
      }
    }

    if (options.temperature_offset && options.temperature_offset.set_value) {
      setDST800AccessLevel(options.instance)
      // sleep for a second to allow the access level request to go through
      await new Promise(r => setTimeout(r, 1000));

      setTemperatureOffset(options.instance, options.temperature_offset.value)

      options.temperature_offset.set_value = false
      // need to save options to update the set_value field change above
      app.savePluginOptions(options, () => { app.debug('DST 800 plugin options saved') });
    }

  };

  plugin.stop = function () {
    // Here we put logic we need when the plugin stops

    if (n2kCallback) {
      app.removeListener("N2KAnalyzerOut", n2kCallback)
      n2kCallback = undefined
    }

    app.debug('DST800 plugin stopped');
  };

  plugin.schema = () => ({
    title: "Airmar DST800 calibration settings",
    type: "object",
    required: [
      "instance"
    ],
    properties: {
      instance: {
        title: "NMEA 2000 Device Address",
        description: "This is the NMEA 2000 address of your transducer.",
        type: "number"
      },
      depth_offset: {
        title: "Depth offset",
        type: "object",
        description: "The transducer offset from the water surface or the keel in meters. Should be a positive number for water surface offset or a negative number for keel offset. This does not reflect the current configured value, it only reflects the last value configured by this plugin. ",
        properties: {
          request_value: {
            title: 'Request current offset from the device',
            type: 'boolean',
            default: false
          },
          set_value: {
            title: 'Store the offset on the device',
            type: 'boolean',
            default: false
          },
          value: {
            title: 'Offset, in meters',
            type: 'number'
          }
        }
      },
      speed_pulse_count: {
        title: "Speed pulse count",
        type: "object",
        description: "Enable reporting of speed pulse counts for STW calibration purposes",
        properties: {
          enable: {
            title: "Enable",
            type: 'boolean',
            default: false
          },
          interval: {
            title: "Transmission interval",
            description: "How often the PGN should be sent, in seconds",
            type: "number",
            default: 2.0
          }
        }
      },
      speed_through_water: {
        title: "Speed through water",
        type: "object",
        description: "Piecewise linear calibration curve for STW",
        properties: {
          request_value: {
            title: 'Request the stored calibration curve from the device',
            type: 'boolean',
            default: false
          },
          restore_defaults: {
            title: 'Restore the factory default calibration curve',
            type: 'boolean',
            default: false
          },
          set_value: {
            title: 'Store the calibration curve on the device',
            type: 'boolean',
            default: false
          },
          value: {
            title: 'Values',
            description: 'Enter values as rows of space-delimited pairs of pulse rate and STW, in 1/s and m/s',
            type: 'string'
          }
        }
      },
      temperature_offset: {
        title: "Temperature offset",
        type: "object",
        description: "Offset to be added to the sensor temperature reading",
        properties: {
          request_value: {
            title: 'Request the stored offset value from the device',
            type: 'boolean',
            default: false
          },
          set_value: {
            title: 'Store the offset value on the device',
            type: 'boolean',
            default: false
          },
          value: {
            title: 'Value',
            description: 'Offset value, in K (or °C)',
            type: 'string'
          }
        }
      }
    }
  });

  plugin.uiSchema = {
    speed_through_water: {
      value: {
        "ui:widget": "textarea"
      }
    }
  }

  return plugin;
};