import { NoaaApiService, Station } from './noaa-api';

export class StationFinder {
  private nearbyTideStations: Station[] = [];
  private nearbyCurrentStations: Station[] = [];
  private lastUpdate = 0;
  private lastPosition: { lat: number, lon: number } | null = null;
  private readonly cacheTimeout = 6 * 60 * 60 * 1000; // 6 hours
  private readonly positionThreshold = 0.1; // degrees (~11km)
  
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
  
  private async updateNearbyStationsCache(latitude: number, longitude: number): Promise<void> {
    const now = Date.now();
    const positionChanged = !this.lastPosition || 
      Math.abs(this.lastPosition.lat - latitude) > this.positionThreshold ||
      Math.abs(this.lastPosition.lon - longitude) > this.positionThreshold;
    
    if (!positionChanged && now - this.lastUpdate < this.cacheTimeout) {
      return; // Cache is still valid and position hasn't changed significantly
    }
    
    try {
      console.log(`Updating nearby stations cache for position ${latitude}, ${longitude}...`);
      
      // Find a reference station first - use a well-known station or find closest from small sample
      const referenceStation = await this.findReferenceStation(latitude, longitude);
      if (!referenceStation) {
        console.error('Could not find reference station');
        return;
      }
      
      console.log(`Using reference station ${referenceStation.id} (${referenceStation.name})`);
      
      // Get nearby stations within 50 nautical miles
      this.nearbyTideStations = await this._noaaApi.getNearbyStations(referenceStation.id, 50, 'tide');
      this.nearbyCurrentStations = await this._noaaApi.getNearbyStations(referenceStation.id, 50, 'current');
      
      this.lastUpdate = now;
      this.lastPosition = { lat: latitude, lon: longitude };
      
      console.log(`Loaded ${this.nearbyTideStations.length} nearby tide stations and ${this.nearbyCurrentStations.length} nearby current stations`);
    } catch (error) {
      console.error('Failed to update nearby stations cache:', error);
    }
  }
  
  private async findReferenceStation(latitude: number, longitude: number): Promise<Station | null> {
    try {
      // Use a small sample of well-known stations to find closest reference point
      const sampleStations = await this._noaaApi.getTideStations();
      
      if (sampleStations.length === 0) {
        return null;
      }
      
      // Find closest station from the sample
      let closestStation = sampleStations[0];
      let minDistance = this.calculateDistance(latitude, longitude, closestStation.latitude, closestStation.longitude);
      
      for (const station of sampleStations.slice(1, Math.min(100, sampleStations.length))) {
        const distance = this.calculateDistance(latitude, longitude, station.latitude, station.longitude);
        if (distance < minDistance) {
          minDistance = distance;
          closestStation = station;
        }
      }
      
      return { ...closestStation, distance: minDistance };
    } catch (error) {
      console.error('Error finding reference station:', error);
      return null;
    }
  }
  
  async findNearestTideStation(latitude: number, longitude: number): Promise<Station | null> {
    await this.updateNearbyStationsCache(latitude, longitude);
    
    if (this.nearbyTideStations.length === 0) {
      return null;
    }
    
    // Sort stations by distance
    const stationsByDistance = this.nearbyTideStations
      .map(station => ({
        ...station,
        distance: this.calculateDistance(latitude, longitude, station.latitude, station.longitude)
      }))
      .sort((a, b) => a.distance - b.distance);
    
    // Try only the 3 closest stations to avoid excessive API calls
    for (const station of stationsByDistance.slice(0, 3)) {
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
    await this.updateNearbyStationsCache(latitude, longitude);
    
    console.log(`Looking for current station near ${latitude}, ${longitude}`);
    console.log(`Available nearby current stations: ${this.nearbyCurrentStations.length}`);
    
    if (this.nearbyCurrentStations.length === 0) {
      console.log('No nearby current stations available');
      return null;
    }
    
    // Sort stations by distance
    const stationsByDistance = this.nearbyCurrentStations
      .map(station => ({
        ...station,
        distance: this.calculateDistance(latitude, longitude, station.latitude, station.longitude)
      }))
      .sort((a, b) => a.distance - b.distance);
    
    // Try only the 3 closest stations to avoid excessive API calls
    for (const station of stationsByDistance.slice(0, 3)) {
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
    
    console.log('No working nearby current stations found');
    return null;
  }
  
  async findStationsAlongRoute(route: Array<{lat: number, lon: number}>): Promise<{
    tideStations: Station[],
    currentStations: Station[]
  }> {
    // For route tracking, we'll use the first point to update nearby cache
    if (route.length > 0) {
      await this.updateNearbyStationsCache(route[0].lat, route[0].lon);
    }
    
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