// Geographic bounds for St. Clair River corridor (map view)
export const CORRIDOR_BOUNDS = {
  south: 42.85,
  west: -82.55,
  north: 43.05,
  east: -82.35,
} as const

// Approximate center of the map view (initial render only)
export const MAP_CENTER: [number, number] = [42.99, -82.42]
export const MAP_ZOOM = 12

// Home view: the map fits this box on load and when "Home" is tapped, so it
// adapts to any screen (phone portrait/landscape, tablet). Covers the river
// from the MOC up through the bridge to the Lake Huron approach, where
// downbound ships are first seen.
export const HOME_VIEW: [[number, number], [number, number]] = [
  [42.955, -82.44],   // south-west
  [43.055, -82.395],  // north-east
]

// "You are here" — Port Huron Municipal Office Center (100 McMorran Blvd),
// Jazmyn's office, looking out over the St. Clair River.
export const HOME_POINT: [number, number] = [42.9788, -82.4197]
export const HOME_LABEL = 'You are here'

// Trigger zone: the stretch of river visible from the MOC windows —
// roughly the Blue Water Bridge (north) down past the Seaway Terminal (south),
// shore to shore. A moving ship entering this box (or jumping across it between
// AIS reports) gets the full-screen popup. Keep in sync with proxy-server.js.
export const TRIGGER_ZONE = {
  south: 42.955,
  west: -82.432,
  north: 43.003,
  east: -82.398,
} as const

// Ships slower than this are docked or anchored — no popup for them
export const TRIGGER_MIN_SPEED_KN = 1

// Drop vessels from the map if we haven't heard from them in this long
export const VESSEL_STALE_MS = 30 * 60 * 1000

// Port Huron coordinates for weather API (the MOC)
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
