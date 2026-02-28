import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import { AnimatePresence } from 'framer-motion'
import type { Map as LeafletMap } from 'leaflet'
import 'leaflet/dist/leaflet.css'

import { useKioskStore } from '../store/kioskStore'
import { startAISStream } from '../services/aisstream'
import { fetchWeather } from '../services/weather'
import { VesselMarker } from '../components/VesselMarker'
import { VesselPopup } from '../components/VesselPopup'
import { StatusBar } from '../components/StatusBar'
import { AttractScreen } from './AttractScreen'
import {
  MAP_CENTER,
  MAP_ZOOM,
  WEATHER_REFRESH_MS,
  ATTRACT_IDLE_MS,
} from '../constants/bounds'
import type { Vessel } from '../types'
import './MapScreen.css'

const AIS_KEY = import.meta.env.VITE_AISSTREAM_API_KEY as string
const WX_KEY = import.meta.env.VITE_OPENWEATHER_API_KEY as string

// Sets zoom limits only — panning is unrestricted
function MapSetup({ mapRef }: { mapRef: MutableRefObject<LeafletMap | null> }) {
  const map = useMap()
  useEffect(() => {
    mapRef.current = map
    map.setMinZoom(10)
    map.setMaxZoom(19)
  }, [map, mapRef])
  return null
}

export function MapScreen() {
  const { vessels, activePopup, updateVessel, triggerPopup, dismissPopup, setWeather } =
    useKioskStore()
  const lastActivityAt = useKioskStore(s => s.lastActivityAt)
  const stopRef = useRef<(() => void) | null>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const [attract, setAttract] = useState(false)

  function flyHome() {
    mapRef.current?.flyTo(MAP_CENTER, MAP_ZOOM, { duration: 1.2 })
  }

  // Start AIS stream
  useEffect(() => {
    if (!AIS_KEY) {
      console.warn('Missing VITE_AISSTREAM_API_KEY')
      return
    }

    stopRef.current = startAISStream(
      AIS_KEY,
      (partial: Vessel) => updateVessel(partial),
      (vessel: Vessel) => {
        // Get latest merged data from store before triggering popup
        const full = useKioskStore.getState().vessels[vessel.mmsi] ?? vessel
        triggerPopup(full)
      },
    )

    return () => stopRef.current?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Weather polling
  useEffect(() => {
    if (!WX_KEY) return

    const load = () => {
      fetchWeather(WX_KEY)
        .then(setWeather)
        .catch(e => console.warn('[Weather]', e))
    }
    load()
    const interval = setInterval(load, WEATHER_REFRESH_MS)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Idle detection: activate attract mode after ATTRACT_IDLE_MS of no AIS activity
  useEffect(() => {
    const check = setInterval(() => {
      const idle = Date.now() - useKioskStore.getState().lastActivityAt
      if (idle >= ATTRACT_IDLE_MS && !useKioskStore.getState().activePopup) {
        setAttract(true)
      }
    }, 10_000)
    return () => clearInterval(check)
  }, [])

  // Dismiss attract mode as soon as a new AIS position arrives
  useEffect(() => {
    setAttract(false)
  }, [lastActivityAt])

  // Only render vessels that have a valid position
  const vesselList = Object.values(vessels).filter(v => v.lat != null && v.lon != null)

  return (
    <div className="map-screen">
      <MapContainer
        center={MAP_CENTER}
        zoom={MAP_ZOOM}
        className="map-container"
        zoomControl={false}
        attributionControl={false}
      >
        <MapSetup mapRef={mapRef} />

        {/* CARTO Voyager — high-res base, crisp at all zoom levels */}
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png"
          subdomains="abcd"
          maxZoom={19}
        />

        {/* ESRI Ocean Reference — nautical labels, depth contours, shipping lanes */}
        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Reference/MapServer/tile/{z}/{y}/{x}"
          maxNativeZoom={13}
          maxZoom={19}
          opacity={0.6}
        />

        {/* OpenSeaMap — buoys, beacons, channels (high zoom detail) */}
        <TileLayer
          url="https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png"
          minZoom={12}
          maxZoom={19}
          opacity={0.8}
        />

        {/* Vessels */}
        {vesselList.map(v => (
          <VesselMarker
            key={v.mmsi}
            vessel={v}
            onClick={vessel => triggerPopup(vessel)}
          />
        ))}
      </MapContainer>

      {/* Popup — always use live vessel from store so name/data updates reactively */}
      <VesselPopup
        vessel={activePopup ? (vessels[activePopup.mmsi] ?? activePopup) : null}
        onDismiss={dismissPopup}
      />

      {/* Home button */}
      <button className="home-btn" onClick={flyHome} title="Return to St. Clair River">
        <span className="home-btn-icon">⚓</span>
        <span className="home-btn-label">Home</span>
      </button>

      {/* Attract / screensaver mode */}
      <AnimatePresence>
        {attract && <AttractScreen key="attract" />}
      </AnimatePresence>

      {/* Status bar — rendered above attract overlay (z-index 1200) */}
      <StatusBar />
    </div>
  )
}
