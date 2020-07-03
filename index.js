const _ = require('lodash')
const Concentrate2 = require('concentrate2')

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
      dst: options.instance,
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
            "Value": 1000 * offset
          }
        ]
      }
    }
    app.debug('Changing depth offset')
    app.emit('nmea2000JsonOut', cmd_msg)
  }
  
  function setDST800AccessLevel(dst) {
    // only supports setting access level to 1
    const pgn = 126208
    const prio = 3
    const now = (new Date()).toISOString()

    const msg = `${now},${prio},${pgn},00,${dst},00`
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

  function requestSTWCalibrationCurve(dst) {
    const pgn = 126208
    const prio = 3
    const now = (new Date()).toISOString()

    const msg = `${now},${prio},${pgn},00,${dst},00`
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

  plugin.start = function (options, restartPlugin) {
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
          if ( options.depth_offset.request_value ) {
            app.debug('XXX READING DEPTH OFFSET VALUE')
            options.depth_offset.value = fields['Offset']
            options.depth_offset.request_value = false
            app.savePluginOptions(options, () => {app.debug('DST 800 plugin options saved')});
          }
        }
        else if (msg.pgn == 126208  // Acknowledge Group Function
          && fields['Function Code'] == "Acknowledge"
          && fields['PGN'] == 126720) {
            let msg_str = JSON.stringify(msg, null, 2)
            app.debug(`Acknowledge Group Function: ${msg_str}`)
        }
        else if (msg.pgn == 126208  // Acknowledge Group Function
          && fields['Function Code'] == "Acknowledge"
          && fields['PGN'] == 65287) {
            let msg_str = JSON.stringify(msg, null, 2)
            app.debug(`Acknowledge Group Function: ${msg_str}`)
        }
        else if (msg.pgn == 126720
          && fields['Manufacturer Code'] == 'Airmar'
          && fields['Industry Code'] == 'Marine Industry'
          && fields['Proprietary ID'] == 'Calibrate Depth') {
          calibrate_depth_response = JSON.stringify(msg, null, 2);
          app.debug(`DST800 calibrate_depth_response: ${calibrate_depth_response}`)
        }
        else if (msg.pgn == 126720
          && fields['Manufacturer Code'] == 'Airmar'
          && fields['Industry Code'] == 'Marine Industry'
          && fields['Proprietary ID'] == 'Calibrate Speed') {
          calibrate_speed_response = JSON.stringify(msg, null, 2);
          options.speed_through_water.response = calibrate_depth_response
          app.debug(`DST800 calibrate_speed_response: ${calibrate_speed_response}`)
          app.savePluginOptions(options, () => {app.debug('DST 800 plugin options saved')});
        }
        else if (msg.pgn == 126720
          && fields['Manufacturer Code'] == 'Airmar'
          && fields['Industry Code'] == 'Marine Industry'
          && fields['Proprietary ID'] == 'Calibrate Temperature') {
          calibrate_temperature_response = JSON.stringify(msg, null, 2);
          app.debug(`DST800 calibrate_temperature_response: ${calibrate_temperature_response}`)
        };
      } catch (e) {
        console.error(e)
      }
    }
    app.on("N2KAnalyzerOut", n2kCallback)

    if ( options.depth_offset.set_value ) {
      if ( typeof options.instance === 'undefined' || typeof options.depth_offset.value === 'undefined' ) {
        console.error("address or depth offset is not defined")
      } else {
        setDepthOffset(options.instance, options.depth_offset.value)
        options.depth_offset.set_value = false
        app.savePluginOptions(options, () => {app.debug('DST 800 plugin options saved')});
      }
    }

    if ( options.speed_through_water.request_value ) {
      if ( typeof options.instance === 'undefined' ) {
        console.error("address is not defined")
      } else {
        setDST800AccessLevel(options.instance)
        requestSTWCalibrationCurve(options.instance)
        options.speed_through_water.request_value = false
        // need to save options to update the request_value field change above
        app.savePluginOptions(options, () => {app.debug('DST 800 plugin options saved')});
      }
    }
  };

  plugin.stop = function () {
    // Here we put logic we need when the plugin stops

    if ( n2kCallback ) {
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
            title: 'Request stored value from the device',
            type: 'boolean',
            default: false
          },
          set_value: {
            title: 'Store this value on the device',
            type: 'boolean',
            default: false
          },
          value: {
            title: 'Value',
            type: 'number'
          }
        }
      },
      speed_through_water: {
        title: "Speed through water",
        type: "object",
        description: "Piecewise linear calibration curve for STW.",
        properties: {
          request_value: {
            title: 'Request stored value from the device',
            type: 'boolean',
            default: false
          },
          restore_defaults: {
            title: 'Restore factory defaults for this value',
            type: 'boolean',
            default: false
          },
          set_value: {
            title: 'Store this value on the device',
            type: 'boolean',
            default: false
          },
          value: {
            title: 'Value',
            type: 'string'
          },
          response: {
            title: 'Response',
            type: 'string',
            default: config.speed_through_water.response
          }
        }
      }
    }
  });

  plugin.uiSchema = {
    depth_offset: {
      response: {
        "ui:widget": "textarea"
      }
    },
    speed_through_water: {
      value: {
        "ui:widget": "textarea"
      },
      response: {
        "ui:widget": "textarea"
      }
    }
  }

  return plugin;
};