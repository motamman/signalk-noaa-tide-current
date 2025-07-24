interface ServerApp {
  debug: (_message: string) => void;
  error: (_message: string, _error?: any) => void;
  getSelfPath: (_path: string) => { value: any } | undefined;
  handleMessage: (_pluginId: string, _message: any) => void;
}
import { NoaaApiService } from './noaa-api';
import { StationFinder } from './station-finder';

interface RoutePoint {
  latitude: number;
  longitude: number;
  time: Date;
  hour: number;
}

export class RouteTracker {
  constructor(
    private _app: ServerApp,
    private _noaaApi: NoaaApiService,
    private _stationFinder: StationFinder
  ) {}
  
  private calculateFuturePosition(
    currentLat: number,
    currentLon: number,
    heading: number,
    speed: number,
    hours: number
  ): { latitude: number; longitude: number } {
    // Convert speed from m/s to km/h if needed
    const speedKmh = speed * 3.6; // assuming speed is in m/s
    const distanceKm = speedKmh * hours;
    
    // Convert heading to radians
    const headingRad = heading * (Math.PI / 180);
    
    // Earth's radius in km
    const R = 6371;
    
    // Calculate new position using spherical trigonometry
    const lat1 = currentLat * (Math.PI / 180);
    const lon1 = currentLon * (Math.PI / 180);
    
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(distanceKm / R) +
      Math.cos(lat1) * Math.sin(distanceKm / R) * Math.cos(headingRad)
    );
    
    const lon2 = lon1 + Math.atan2(
      Math.sin(headingRad) * Math.sin(distanceKm / R) * Math.cos(lat1),
      Math.cos(distanceKm / R) - Math.sin(lat1) * Math.sin(lat2)
    );
    
    return {
      latitude: lat2 * (180 / Math.PI),
      longitude: lon2 * (180 / Math.PI)
    };
  }
  
  private generateRoutePoints(
    currentLat: number,
    currentLon: number,
    heading: number,
    speed: number,
    hours: number[]
  ): RoutePoint[] {
    const points: RoutePoint[] = [];
    const now = new Date();
    
    for (const hour of hours) {
      const position = this.calculateFuturePosition(currentLat, currentLon, heading, speed, hour);
      const futureTime = new Date(now.getTime() + hour * 60 * 60 * 1000);
      
      points.push({
        latitude: position.latitude,
        longitude: position.longitude,
        time: futureTime,
        hour
      });
    }
    
    return points;
  }
  
  async updateRouteData(currentLat: number, currentLon: number, hours: number[]): Promise<void> {
    try {
      // Get current navigation data
      const headingPath = this._app.getSelfPath('navigation.headingMagnetic');
      const speedPath = this._app.getSelfPath('navigation.speedOverGround');
      
      if (!headingPath?.value || !speedPath?.value) {
        this._app.debug('Missing navigation data for route tracking');
        return;
      }
      
      const heading = headingPath.value * (180 / Math.PI); // Convert from radians to degrees
      const speed = speedPath.value; // Should be in m/s
      
      // Generate route points
      const routePoints = this.generateRoutePoints(currentLat, currentLon, heading, speed, hours);
      
      // Find stations along the route
      const routeCoords = routePoints.map(p => ({ lat: p.latitude, lon: p.longitude }));
      await this._stationFinder.findStationsAlongRoute(routeCoords);
      
      // Get tide and current data for each station
      const routeData = [];
      
      for (const point of routePoints) {
        const nearestTide = await this._stationFinder.findNearestTideStation(point.latitude, point.longitude);
        const nearestCurrent = await this._stationFinder.findNearestCurrentStation(point.latitude, point.longitude);
        
        let tideData = null;
        let currentData = null;
        
        if (nearestTide) {
          const tides = await this._noaaApi.getTideData(nearestTide.id, 1);
          // Find tide data closest to the predicted time
          tideData = this.findClosestPrediction(tides, point.time);
        }
        
        if (nearestCurrent) {
          const currents = await this._noaaApi.getCurrentData(nearestCurrent.id, 1);
          // Find current data closest to the predicted time
          currentData = this.findClosestPrediction(currents, point.time);
        }
        
        routeData.push({
          position: {
            latitude: point.latitude,
            longitude: point.longitude
          },
          time: point.time.toISOString(),
          hour: point.hour,
          tide: tideData ? {
            station: nearestTide,
            prediction: tideData
          } : null,
          current: currentData ? {
            station: nearestCurrent,
            prediction: currentData
          } : null
        });
      }
      
      // Send route data to Signal K with expanded paths
      const routeValues: any[] = [];
      
      routeData.forEach((point, index) => {
        // Position data
        routeValues.push(
          {
            path: `navigation.route.predictions.${index}.position.latitude`,
            value: point.position.latitude
          },
          {
            path: `navigation.route.predictions.${index}.position.longitude`, 
            value: point.position.longitude
          },
          {
            path: `navigation.route.predictions.${index}.time`,
            value: point.time
          },
          {
            path: `navigation.route.predictions.${index}.hour`,
            value: point.hour
          }
        );
        
        // Tide data if available
        if (point.tide && point.tide.station) {
          routeValues.push(
            {
              path: `navigation.route.predictions.${index}.tide.station.id`,
              value: point.tide.station.id
            },
            {
              path: `navigation.route.predictions.${index}.tide.station.name`,
              value: point.tide.station.name
            },
            {
              path: `navigation.route.predictions.${index}.tide.prediction.time`,
              value: point.tide.prediction.time
            },
            {
              path: `navigation.route.predictions.${index}.tide.prediction.height`,
              value: point.tide.prediction.height
            },
            {
              path: `navigation.route.predictions.${index}.tide.prediction.type`,
              value: point.tide.prediction.type
            }
          );
        }
        
        // Current data if available
        if (point.current && point.current.station) {
          routeValues.push(
            {
              path: `navigation.route.predictions.${index}.current.station.id`,
              value: point.current.station.id
            },
            {
              path: `navigation.route.predictions.${index}.current.station.name`,
              value: point.current.station.name
            },
            {
              path: `navigation.route.predictions.${index}.current.prediction.time`,
              value: point.current.prediction.time
            },
            {
              path: `navigation.route.predictions.${index}.current.prediction.velocity`,
              value: point.current.prediction.velocity
            },
            {
              path: `navigation.route.predictions.${index}.current.prediction.direction`,
              value: point.current.prediction.direction
            },
            {
              path: `navigation.route.predictions.${index}.current.prediction.type`,
              value: point.current.prediction.type
            }
          );
        }
      });
      
      this._app.handleMessage('plugin', {
        updates: [{
          source: { label: 'signalk-tide-current' },
          timestamp: new Date().toISOString(),
          values: routeValues
        }]
      });
      
    } catch (error) {
      this._app.error('Error updating route tide/current data:', error);
    }
  }
  
  private findClosestPrediction(predictions: any[], targetTime: Date): any {
    if (!predictions || predictions.length === 0) {
      return null;
    }
    
    let closest = predictions[0];
    let minDiff = Math.abs(new Date(predictions[0].time).getTime() - targetTime.getTime());
    
    for (const prediction of predictions) {
      const diff = Math.abs(new Date(prediction.time).getTime() - targetTime.getTime());
      if (diff < minDiff) {
        minDiff = diff;
        closest = prediction;
      }
    }
    
    return closest;
  }
}