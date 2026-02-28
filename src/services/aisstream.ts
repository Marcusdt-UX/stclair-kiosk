import type { Vessel } from '../types'
import { TRIGGER_ZONE } from '../constants/bounds'

const WS_URL = 'ws://localhost:2610'
const LOOKUP_URL = 'http://localhost:2610/vessel'

// Fetch cached vessel data from the proxy and push it into the store.
// Called once per MMSI on first position report so the popup has a name
// immediately instead of waiting for ShipStaticData to arrive live.
async function hydratFromCache(
  mmsi: string,
  onVesselUpdate: (v: Vessel) => void,
) {
  try {
    const res = await fetch(`${LOOKUP_URL}/${mmsi}`)
    if (!res.ok) return
    const data = await res.json() as Partial<Vessel> & { destinations?: string[] }
    // Only push if there's actually useful data (name or IMO)
    if (!data.name && !data.imo) return
    const partial: Partial<Vessel> = {
      mmsi,
      ...(data.name        ? { name: data.name }             : {}),
      ...(data.flag        ? { flag: data.flag }             : {}),
      ...(data.flagCode    ? { flagCode: data.flagCode }     : {}),
      ...(data.callSign    ? { callSign: data.callSign }     : {}),
      ...(data.imo         ? { imo: data.imo }               : {}),
      ...(data.shipType    ? { shipType: data.shipType }     : {}),
      ...(data.length      ? { length: data.length }         : {}),
      ...(data.yearBuilt   ? { yearBuilt: data.yearBuilt }   : {}),
      ...(data.operator    ? { operator: data.operator }     : {}),
      ...(data.builder     ? { builder: data.builder }       : {}),
      ...(data.homeport    ? { homeport: data.homeport }     : {}),
      ...(data.grossTonnage ? { grossTonnage: data.grossTonnage } : {}),
      ...(data.deadWeight  ? { deadWeight: data.deadWeight } : {}),
      // Use most recent destination from accumulated history if available
      ...(data.destinations?.length
        ? { destination: data.destinations[data.destinations.length - 1] }
        : {}),
    }
    onVesselUpdate(partial as Vessel)
    console.log(`[AIS] Hydrated ${data.name ?? mmsi} from cache`)
  } catch {
    // proxy not running or network error — silently ignore
  }
}

// AIS numeric type → human-readable
export function shipTypeLabel(typeCode: number): string {
  if (typeCode >= 70 && typeCode <= 79) return 'Cargo Ship'
  if (typeCode >= 80 && typeCode <= 89) return 'Tanker'
  if (typeCode >= 60 && typeCode <= 69) return 'Passenger Ship'
  if (typeCode >= 30 && typeCode <= 39) return 'Fishing Vessel'
  if (typeCode === 52 || typeCode === 21) return 'Tug'
  if (typeCode >= 40 && typeCode <= 49) return 'High Speed Craft'
  if (typeCode >= 50 && typeCode <= 59) return 'Special Craft'
  if (typeCode >= 20 && typeCode <= 29) return 'Wing in Ground'
  return 'Vessel'
}

function isInZone(lat: number, lon: number, zone: typeof TRIGGER_ZONE): boolean {
  return (
    lat >= zone.south &&
    lat <= zone.north &&
    lon >= zone.west &&
    lon <= zone.east
  )
}

export function startAISStream(
  _apiKey: string,
  onVesselUpdate: (vessel: Vessel) => void,
  onVesselEntered: (vessel: Vessel) => void,
): () => void {
  let ws: WebSocket | null = null
  let stopped = false
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let reconnectDelay = 3000

  // Track previous in-zone state to detect entries
  const prevInZone = new Map<string, boolean>()
  // MMSIs we've already fetched from cache this session
  const hydratedMmsi = new Set<string>()

  function connect() {
    if (stopped) return
    ws = new WebSocket(WS_URL)

    ws.onopen = () => {
      reconnectDelay = 3000
      console.log('[AISstream] Connected to local proxy.')
    }

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string)
        const msgType: string = msg.MessageType

        if (msgType === 'PositionReport') {
          const pos = msg.Message?.PositionReport
          const meta = msg.MetaData
          if (!pos || !meta) return

          const mmsi = String(meta.MMSI)
          const lat: number = meta.latitude ?? pos.Latitude
          const lon: number = meta.longitude ?? pos.Longitude
          const inZone = isInZone(lat, lon, TRIGGER_ZONE)
          const wasInZone = prevInZone.get(mmsi) ?? false

          const partial: Partial<Vessel> = {
            mmsi,
            lat,
            lon,
            speed: pos.Sog ?? 0,
            heading: pos.TrueHeading ?? pos.Cog ?? 0,
            course: pos.Cog ?? 0,
            shipType: pos.ShipType ?? 0,
            lastUpdated: Date.now(),
            inTriggerZone: inZone,
          }

          onVesselUpdate(partial as Vessel)

          // On first sighting this session, pull whatever we know from the proxy cache
          if (!hydratedMmsi.has(mmsi)) {
            hydratedMmsi.add(mmsi)
            hydratFromCache(mmsi, onVesselUpdate)
          }

          if (inZone && !wasInZone) {
            // Brief delay so static data can arrive first
            setTimeout(() => onVesselEntered(partial as Vessel), 500)
          }
          prevInZone.set(mmsi, inZone)
        }

        if (msgType === 'ShipStaticData') {
          const stat = msg.Message?.ShipStaticData
          const meta = msg.MetaData
          if (!stat || !meta) return

          const mmsi = String(meta.MMSI)
          const partial: Partial<Vessel> = {
            mmsi,
            name: stat.Name?.trim() || '',
            flag: stat.Flag ?? '',
            callSign: stat.CallSign?.trim() ?? '',
            imo: stat.ImoNumber ? String(stat.ImoNumber) : undefined,
            destination: stat.Destination?.trim() ?? '',
            length: stat.Dimension?.A != null && stat.Dimension?.B != null
              ? stat.Dimension.A + stat.Dimension.B
              : undefined,
            width: stat.Dimension?.C != null && stat.Dimension?.D != null
              ? stat.Dimension.C + stat.Dimension.D
              : undefined,
            draught: stat.MaximumStaticDraught ?? undefined,
            shipType: stat.Type ?? 0,
            lastUpdated: Date.now(),
          }
          onVesselUpdate(partial as Vessel)
        }
      } catch {
        // ignore parse errors
      }
    }

    ws.onerror = () => {
      console.warn('[AISstream] WebSocket error.')
    }

    ws.onclose = () => {
      if (stopped) return
      console.warn(`[AISstream] Disconnected. Reconnecting in ${reconnectDelay / 1000}s…`)
      reconnectTimer = setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, 60_000)
        connect()
      }, reconnectDelay)
    }
  }

  connect()

  return () => {
    stopped = true
    if (reconnectTimer) clearTimeout(reconnectTimer)
    ws?.close()
  }
}
