export interface Vessel {
  mmsi: string
  name: string
  lat: number
  lon: number
  speed: number       // knots
  heading: number     // degrees true
  course: number      // degrees
  shipType: number    // AIS numeric type
  length?: number     // metres
  width?: number
  yearBuilt?: number
  flag?: string
  flagCode?: string   // raw ISO 2-letter code from AIS / VesselFinder
  callSign?: string
  destination?: string
  departure?: string  // last known departure port (from ShipStaticData)
  draught?: number
  imo?: string
  operator?: string   // company operating the vessel
  builder?: string    // shipyard name
  homeport?: string
  grossTonnage?: number
  deadWeight?: number
  formerNames?: string[]
  lastUpdated: number // unix ms
  inTriggerZone: boolean
}

export interface WeatherData {
  tempF: number
  windSpeed: number   // mph
  windDeg: number     // degrees
  windDir: string     // e.g. "NW"
  visibility: number  // miles
  description: string
  iconCode: string
  feelsLikeF: number
}

export interface ShipDbEntry {
  name: string
  photo: string
  operator?: string
  note?: string
  yearBuilt?: number
  flag?: string        // e.g. "🇺🇸 United States" or "🇨🇦 Canada"
  imo?: string
  builder?: string     // shipyard name
  homeport?: string
}
