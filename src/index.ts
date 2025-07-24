interface ServerApp {
  debug: (_message: string) => void;
  error: (_message: string, _error?: any) => void;
  getSelfPath: (_path: string) => { value: any } | undefined;
  handleMessage: (_pluginId: string, _message: any) => void;
  registerPutHandler: (_context: string, _path: string, _handler: any) => void;
}

interface Plugin {
  id: string;
  name: string;
  description: string;
  start: (_app: ServerApp, _options: any) => () => void;
  stop: () => void;
  schema: () => any;
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

const plugin: Plugin = {
  id: 'signalk-tide-current',
  name: 'NOAA Tide & Current Data',
  description: 'Provides tide and current data from NOAA stations',
  
  start(app: ServerApp, options: PluginConfig) {
    app.debug('Starting NOAA Tide & Current plugin');
    
    const noaaApi = new NoaaApiService();
    const stationFinder = new StationFinder(noaaApi);
    const routeTracker = new RouteTracker(app, noaaApi, stationFinder);
    
    let updateTimer: ReturnType<typeof setInterval>;
    
    const updateData = async () => {
      try {
        const position = app.getSelfPath('navigation.position');
        if (!position?.value) {
          app.debug('No position available');
          return;
        }
        
        const { latitude, longitude } = position.value;
        
        // Get nearest stations for tide and current
        const tideStation = await stationFinder.findNearestTideStation(latitude, longitude);
        const currentStation = await stationFinder.findNearestCurrentStation(latitude, longitude);
        
        if (tideStation) {
          const tideData = await noaaApi.getTideData(tideStation.id, options.daysToRetrieve);
          
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
          
          app.handleMessage('plugin', {
            updates: [{
              source: { label: plugin.id },
              timestamp: new Date().toISOString(),
              values: tideValues
            }]
          });
        }
        
        if (currentStation) {
          const currentData = await noaaApi.getCurrentData(currentStation.id, options.daysToRetrieve);
          
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
                value: prediction.velocity
              },
              {
                path: `environment.current.predictions.${index}.direction`,
                value: prediction.direction
              },
              {
                path: `environment.current.predictions.${index}.type`,
                value: prediction.type
              }
            );
          });
          
          app.handleMessage('plugin', {
            updates: [{
              source: { label: plugin.id },
              timestamp: new Date().toISOString(),
              values: currentValues
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

module.exports = plugin;