module.exports = function (app) {
    var plugin = {};
  
    plugin.id = 'signalk-dst800-calibration-plugin';
    plugin.name = 'Airmar DST800 calibration settings';
    plugin.description = 'Set a DST800 triducer in-device calibration values';
  
    plugin.start = function (options, restartPlugin) {
      // Here we put our plugin logic
      app.debug('Plugin started');
    };
  
    plugin.stop = function () {
      // Here we put logic we need when the plugin stops
      app.debug('Plugin stopped');
    };
  
    plugin.schema = {
      // The plugin schema
    };
  
    return plugin;
  };