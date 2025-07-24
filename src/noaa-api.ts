import axios from 'axios';

export interface Station {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  distance?: number;
}

export interface TidePrediction {
  time: string;
  height: number;
  type: 'H' | 'L'; // High or Low
}

export interface CurrentPrediction {
  time: string;
  velocity: number;
  direction: number;
  type: 'slack' | 'max';
}

export class NoaaApiService {
  private readonly baseUrl = 'https://api.tidesandcurrents.noaa.gov/api/prod';
  private readonly metadataUrl = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod';
  
  async getTideStations(): Promise<Station[]> {
    try {
      // Use the metadata endpoint to get all stations
      const stationsResponse = await axios.get(`${this.metadataUrl}/webapi/stations.json`);
      
      // Filter for stations that support tide predictions
      const tideStations = stationsResponse.data.stations.filter((station: any) => 
        station.tideType || station.affiliations?.includes('NWLON') || station.type === 'primary'
      );
      
      return tideStations.map((station: any) => ({
        id: station.id,
        name: station.name,
        latitude: parseFloat(station.lat || station.latitude),
        longitude: parseFloat(station.lng || station.longitude)
      }));
    } catch (error) {
      console.error('Error fetching tide stations:', error);
      return [];
    }
  }
  
  async getCurrentStations(): Promise<Station[]> {
    try {
      const response = await axios.get(`${this.metadataUrl}/webapi/stations.json`);
      
      // Filter for stations that support current predictions
      const currentStations = response.data.stations.filter((station: any) => 
        station.type === 'current' || station.products?.includes('currents') || 
        station.affiliations?.includes('PORTS')
      );
      
      return currentStations.map((station: any) => ({
        id: station.id,
        name: station.name,
        latitude: parseFloat(station.lat || station.latitude),
        longitude: parseFloat(station.lng || station.longitude)
      }));
    } catch (error) {
      console.error('Error fetching current stations:', error);
      return [];
    }
  }
  
  async getTideData(stationId: string, days: number): Promise<TidePrediction[]> {
    try {
      const startDate = new Date();
      const endDate = new Date();
      endDate.setDate(startDate.getDate() + days);
      
      const response = await axios.get(`${this.baseUrl}/datagetter`, {
        params: {
          product: 'predictions',
          application: 'SignalK',
          format: 'json',
          station: stationId,
          begin_date: startDate.toISOString().split('T')[0],
          end_date: endDate.toISOString().split('T')[0],
          datum: 'MLLW',
          units: 'metric',
          time_zone: 'gmt',
          interval: 'hilo'
        }
      });
      
      if (!response.data.predictions) {
        return [];
      }
      
      return response.data.predictions.map((pred: any) => ({
        time: pred.t,
        height: parseFloat(pred.v),
        type: pred.type as 'H' | 'L'
      }));
    } catch (error) {
      // console.error(`Error fetching tide data for station ${stationId}:`, error);
      return [];
    }
  }
  
  async getCurrentData(stationId: string, days: number): Promise<CurrentPrediction[]> {
    try {
      const startDate = new Date();
      const endDate = new Date();
      endDate.setDate(startDate.getDate() + days);
      
      const response = await axios.get(`${this.baseUrl}/datagetter`, {
        params: {
          product: 'currents_predictions',
          application: 'SignalK',
          format: 'json',
          station: stationId,
          begin_date: startDate.toISOString().split('T')[0],
          end_date: endDate.toISOString().split('T')[0],
          units: 'metric',
          time_zone: 'gmt',
          interval: 'max_slack'
        }
      });
      
      if (!response.data.current_predictions) {
        return [];
      }
      
      return response.data.current_predictions.map((pred: any) => ({
        time: pred.Time,
        velocity: parseFloat(pred.Velocity_Major || '0'),
        direction: parseFloat(pred.meanFloodDir || '0'),
        type: pred.Type === 'slack' ? 'slack' : 'max'
      }));
    } catch (error) {
      // console.error(`Error fetching current data for station ${stationId}:`, error);
      return [];
    }
  }
}