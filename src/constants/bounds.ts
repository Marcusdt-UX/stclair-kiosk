// Geographic bounds for St. Clair River corridor (map view)
export const CORRIDOR_BOUNDS = {
  south: 42.85,
  west: -82.55,
  north: 43.05,
  east: -82.35,
} as const

// Approximate center of the map view
export const MAP_CENTER: [number, number] = [42.975, -82.42]
export const MAP_ZOOM = 12

// Trigger zone: ~2-mile stretch of river directly visible from 100 McMorran Blvd
// Covers from south of the Blue Water Bridge down through downtown Port Huron
export const TRIGGER_ZONE = {
  south: 42.960,
  west: -82.430,
  north: 42.998,
  east: -82.405,
} as const

// Port Huron coordinates for weather API
export const PORT_HURON_LAT = 42.9788
export const PORT_HURON_LON = -82.4197

// How long the vessel popup stays on screen (ms)
export const POPUP_DURATION_MS = 60_000

// How often to refresh weather (ms)
export const WEATHER_REFRESH_MS = 10 * 60 * 1000

// Attract / screensaver mode: activate after this many ms of no AIS position updates
export const ATTRACT_IDLE_MS = 5 * 60 * 1000

// How long each ship card displays in attract mode (ms) — matches popup timer
export const ATTRACT_SLIDE_MS = 60_000
