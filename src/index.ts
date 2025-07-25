interface ServerApp {
  debug: (_message: string) => void;
  error: (_message: string, _error?: any) => void;
  getSelfPath: (_path: string) => { value: any } | undefined;
  handleMessage: (_pluginId: string, _message: any) => void;
  registerPutHandler: (_context: string, _path: string, _handler: any) => void;
}

import { NoaaApiService } from './noaa-api';
import { StationFinder } from './station-finder';
import { RouteTracker } from './route-tracker';

interface PluginConfig {
  daysToRetrieve: number;
  enableRouteTracking: boolean;
  routeHours: number[];
  updateInterval: number;
}

module.exports = function(app: ServerApp) {
  const plugin = {
    id: 'signalk-noaa-tide-current',
    name: 'NOAA Tide & Current Data',
    description: 'Provides tide and current data from NOAA stations',
    
    start(options: PluginConfig, _restart: any) {
    app.debug('Starting NOAA Tide & Current plugin');
    
    const noaaApi = new NoaaApiService();
    const stationFinder = new StationFinder(noaaApi);
    const routeTracker = new RouteTracker(app, noaaApi, stationFinder);
    
    let updateTimer: ReturnType<typeof setInterval>;
    
    const updateData = async () => {
      try {
        app.debug('updateData() called');
        const position = app.getSelfPath('navigation.position');
        app.debug(`Position data: ${JSON.stringify(position)}`);
        if (!position?.value) {
          app.debug('No position available');
          return;
        }
        
        const { latitude, longitude } = position.value;
        app.debug(`Position: ${latitude}, ${longitude}`);
        
        // Get nearest stations for tide and current
        app.debug('Finding nearest tide station...');
        const tideStation = await stationFinder.findNearestTideStation(latitude, longitude);
        app.debug(`Tide station: ${JSON.stringify(tideStation)}`);
        
        app.debug('Finding nearest current station...');
        const currentStation = await stationFinder.findNearestCurrentStation(latitude, longitude);
        app.debug(`Current station: ${JSON.stringify(currentStation)}`);
        
        if (tideStation) {
          const tideData = await noaaApi.getTideData(tideStation.id, options.daysToRetrieve);
          const realTimeTideData = await noaaApi.getRealTimeTideData(tideStation.id, 24);
          
          // Create expanded paths for tide data
          const tideValues = [
            {
              path: 'environment.tide.station.id',
              value: tideStation.id
            },
            {
              path: 'environment.tide.station.name',
              value: tideStation.name
            },
            {
              path: 'environment.tide.station.position',
              value: {
                latitude: tideStation.latitude,
                longitude: tideStation.longitude
              }
            },
            {
              path: 'environment.tide.station.distance',
              value: tideStation.distance || 0
            }
          ];
          
          // Add individual tide predictions
          tideData.forEach((prediction, index) => {
            tideValues.push(
              {
                path: `environment.tide.predictions.${index}.time`,
                value: prediction.time
              },
              {
                path: `environment.tide.predictions.${index}.height`,
                value: prediction.height
              },
              {
                path: `environment.tide.predictions.${index}.type`,
                value: prediction.type
              }
            );
          });

          // Add real-time tide observations
          realTimeTideData.forEach((observation, index) => {
            tideValues.push(
              {
                path: `environment.tide.observations.${index}.time`,
                value: observation.time
              },
              {
                path: `environment.tide.observations.${index}.height`,
                value: observation.height
              }
            );
          });
          
          app.handleMessage('plugin', {
            updates: [{
              $source: 'signalk-noaa-tide-current',
              timestamp: new Date().toISOString(),
              values: tideValues,
              meta: [
                {
                  path: 'environment.tide.station.distance',
                  value: { units: 'm' }
                },
                ...tideData.map((_, index) => ({
                  path: `environment.tide.predictions.${index}.height`,
                  value: { units: 'm' }
                })),
                ...realTimeTideData.map((_, index) => ({
                  path: `environment.tide.observations.${index}.height`,
                  value: { units: 'm' }
                }))
              ]
            }]
          });
        }
        
        if (currentStation) {
          const currentData = await noaaApi.getCurrentData(currentStation.id, options.daysToRetrieve);
          const realTimeCurrentData = await noaaApi.getRealTimeCurrentData(currentStation.id, 24);
          
          // Create expanded paths for current data
          const currentValues = [
            {
              path: 'environment.current.station.id',
              value: currentStation.id
            },
            {
              path: 'environment.current.station.name', 
              value: currentStation.name
            },
            {
              path: 'environment.current.station.position',
              value: {
                latitude: currentStation.latitude,
                longitude: currentStation.longitude
              }
            },
            {
              path: 'environment.current.station.distance',
              value: currentStation.distance || 0
            }
          ];
          
          // Add individual current predictions
          currentData.forEach((prediction, index) => {
            currentValues.push(
              {
                path: `environment.current.predictions.${index}.time`,
                value: prediction.time
              },
              {
                path: `environment.current.predictions.${index}.velocity`,
                value: prediction.velocity / 100 // Convert cm/s to m/s
              },
              {
                path: `environment.current.predictions.${index}.direction`,
                value: prediction.direction * (Math.PI / 180) // Convert degrees to radians
              },
              {
                path: `environment.current.predictions.${index}.type`,
                value: prediction.type
              }
            );
          });

          // Add real-time current observations
          realTimeCurrentData.forEach((observation, index) => {
            currentValues.push(
              {
                path: `environment.current.observations.${index}.time`,
                value: observation.time
              },
              {
                path: `environment.current.observations.${index}.speed`,
                value: observation.speed / 100 // Convert cm/s to m/s
              },
              {
                path: `environment.current.observations.${index}.direction`,
                value: observation.direction * (Math.PI / 180) // Convert degrees to radians
              }
            );
          });
          
          app.handleMessage('plugin', {
            updates: [{
              $source: 'signalk-noaa-tide-current',
              timestamp: new Date().toISOString(),
              values: currentValues,
              meta: [
                {
                  path: 'environment.current.station.distance',
                  value: { units: 'm' }
                },
                ...currentData.map((_, index) => [
                  {
                    path: `environment.current.predictions.${index}.velocity`,
                    value: { units: 'm/s' }
                  },
                  {
                    path: `environment.current.predictions.${index}.direction`,
                    value: { units: 'rad' }
                  }
                ]).flat(),
                ...realTimeCurrentData.map((_, index) => [
                  {
                    path: `environment.current.observations.${index}.speed`,
                    value: { units: 'm/s' }
                  },
                  {
                    path: `environment.current.observations.${index}.direction`,
                    value: { units: 'rad' }
                  }
                ]).flat()
              ]
            }]
          });
        }
        
        // Handle route tracking if enabled
        if (options.enableRouteTracking) {
          await routeTracker.updateRouteData(latitude, longitude, options.routeHours);
        }
        
      } catch (error) {
        app.error('Error updating tide/current data:', error);
      }
    };
    
    // Initial update
    updateData();
    
    // Set up periodic updates
    updateTimer = setInterval(updateData, options.updateInterval * 60 * 1000);
    
    // Handle PUT requests for route tracking toggle
    app.registerPutHandler('vessels.self', 'commands.environment.tide.routeTracking', (_context: any, _path: any, value: any, callback: any) => {
      if (typeof value === 'boolean') {
        options.enableRouteTracking = value;
        app.debug(`Route tracking ${value ? 'enabled' : 'disabled'}`);
        callback({ state: 'COMPLETED' });
      } else {
        callback({ state: 'INVALID', message: 'Value must be boolean' });
      }
    });
    
    return () => {
      app.debug('Stopping NOAA Tide & Current plugin');
      if (updateTimer) {
        clearInterval(updateTimer);
      }
    };
    },
    
    stop() {
      // Cleanup handled by start function return
    },
    
    schema: () => require('../schema.json')
  };
  
  return plugin;
};