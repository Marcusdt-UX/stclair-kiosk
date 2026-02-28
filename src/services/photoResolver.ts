import shipsDb from '../data/ships-db.json'
import type { ShipDbEntry } from '../types'

const db = shipsDb as Record<string, ShipDbEntry>

// Ship type silhouette fallbacks (inline SVG data URIs stored as paths)
const SILHOUETTES: Record<string, string> = {
  cargo: '/silhouettes/cargo.svg',
  tanker: '/silhouettes/tanker.svg',
  passenger: '/silhouettes/passenger.svg',
  tug: '/silhouettes/tug.svg',
  default: '/silhouettes/default.svg',
}

function silhouetteForType(shipType: number): string {
  if (shipType >= 70 && shipType <= 79) return SILHOUETTES.cargo
  if (shipType >= 80 && shipType <= 89) return SILHOUETTES.tanker
  if (shipType >= 60 && shipType <= 69) return SILHOUETTES.passenger
  if (shipType === 52 || shipType === 21) return SILHOUETTES.tug
  return SILHOUETTES.default
}

/**
 * Returns the best photo URL for a vessel.
 * Order: local DB → MarineTraffic thumbnail → ship-type silhouette
 */
export function resolvePhoto(mmsi: string, _shipType = 0): string {
  // 1. Local database
  if (db[mmsi]?.photo) return db[mmsi].photo

  // 2. MarineTraffic publicly accessible photo (may 404 for unknown vessels)
  //    We return it optimistically — the <img> onerror handler falls back
  return `https://photos.marinetraffic.com/ais/showphoto.aspx?mmsi=${mmsi}&size=thumb800`
}

export function getSilhouette(shipType: number): string {
  return silhouetteForType(shipType)
}

export function getDbEntry(mmsi: string): ShipDbEntry | undefined {
  return db[mmsi]
}
