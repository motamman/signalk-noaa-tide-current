import { NoaaApiService, Station } from './noaa-api';

export class StationFinder {
  private tideStations: Station[] = [];
  private currentStations: Station[] = [];
  private lastUpdate = 0;
  private readonly cacheTimeout = 24 * 60 * 60 * 1000; // 24 hours
  
  constructor(private _noaaApi: NoaaApiService) {}
  
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371; // Earth's radius in kilometers
    const dLat = this.toRadians(lat2 - lat1);
    const dLon = this.toRadians(lon2 - lon1);
    const a = 
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(this.toRadians(lat1)) * Math.cos(this.toRadians(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
  
  private toRadians(degrees: number): number {
    return degrees * (Math.PI / 180);
  }
  
  private async updateStationCache(): Promise<void> {
    const now = Date.now();
    if (now - this.lastUpdate < this.cacheTimeout) {
      return; // Cache is still valid
    }
    
    try {
      console.log('Updating station cache...');
      this.tideStations = await this._noaaApi.getTideStations();
      this.currentStations = await this._noaaApi.getCurrentStations();
      this.lastUpdate = now;
      console.log(`Loaded ${this.tideStations.length} tide stations and ${this.currentStations.length} current stations`);
    } catch (error) {
      console.error('Failed to update station cache:', error);
    }
  }
  
  async findNearestTideStation(latitude: number, longitude: number): Promise<Station | null> {
    await this.updateStationCache();
    
    if (this.tideStations.length === 0) {
      return null;
    }
    
    // Sort stations by distance
    const stationsByDistance = this.tideStations
      .map(station => ({
        ...station,
        distance: this.calculateDistance(latitude, longitude, station.latitude, station.longitude)
      }))
      .sort((a, b) => a.distance - b.distance);
    
    // Try each station in order of distance until we find one with data
    for (const station of stationsByDistance) {
      try {
        const testData = await this._noaaApi.getTideData(station.id, 1);
        if (testData && testData.length > 0) {
          return station;
        }
      } catch (error) {
        // This station doesn't have tide data, try the next one
        continue;
      }
    }
    
    return null;
  }
  
  async findNearestCurrentStation(latitude: number, longitude: number): Promise<Station | null> {
    await this.updateStationCache();
    
    console.log(`Looking for current station near ${latitude}, ${longitude}`);
    console.log(`Available current stations: ${this.currentStations.length}`);
    
    if (this.currentStations.length === 0) {
      console.log('No current stations available');
      return null;
    }
    
    // Sort stations by distance
    const stationsByDistance = this.currentStations
      .map(station => ({
        ...station,
        distance: this.calculateDistance(latitude, longitude, station.latitude, station.longitude)
      }))
      .sort((a, b) => a.distance - b.distance);
    
    // Try each station in order of distance until we find one with data
    for (const station of stationsByDistance) {
      try {
        console.log(`Testing current station ${station.id} (${station.name}) at distance ${station.distance?.toFixed(2)}km`);
        const testData = await this._noaaApi.getCurrentData(station.id, 1);
        if (testData && testData.length > 0) {
          console.log(`Found working current station: ${station.id} with ${testData.length} data points`);
          return station;
        } else {
          console.log(`Station ${station.id} returned no current data`);
        }
      } catch (error) {
        console.log(`Station ${station.id} failed:`, error);
        continue;
      }
    }
    
    console.log('No working current stations found');
    return null;
  }
  
  async findStationsAlongRoute(route: Array<{lat: number, lon: number}>): Promise<{
    tideStations: Station[],
    currentStations: Station[]
  }> {
    await this.updateStationCache();
    
    const foundTideStations = new Set<string>();
    const foundCurrentStations = new Set<string>();
    const tideStations: Station[] = [];
    const currentStations: Station[] = [];
    
    for (const point of route) {
      const nearestTide = await this.findNearestTideStation(point.lat, point.lon);
      const nearestCurrent = await this.findNearestCurrentStation(point.lat, point.lon);
      
      if (nearestTide && !foundTideStations.has(nearestTide.id)) {
        foundTideStations.add(nearestTide.id);
        tideStations.push(nearestTide);
      }
      
      if (nearestCurrent && !foundCurrentStations.has(nearestCurrent.id)) {
        foundCurrentStations.add(nearestCurrent.id);
        currentStations.push(nearestCurrent);
      }
    }
    
    return { tideStations, currentStations };
  }
}