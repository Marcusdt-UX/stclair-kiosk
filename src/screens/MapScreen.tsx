import { useEffect, useRef, useState, type MutableRefObject } from 'react'
import { MapContainer, TileLayer, Marker, Tooltip, useMap } from 'react-leaflet'
import { DivIcon } from 'leaflet'
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
import { useKioskMode } from '../services/kioskMode'
import {
  MAP_CENTER,
  MAP_ZOOM,
  HOME_VIEW,
  HOME_POINT,
  HOME_LABEL,
  WEATHER_REFRESH_MS,
  ATTRACT_IDLE_MS,
  VESSEL_STALE_MS,
} from '../constants/bounds'
import type { Vessel } from '../types'
import './MapScreen.css'

// API keys live only on the proxy server (see proxy-server.js). Nothing here
// should ever read import.meta.env.VITE_*_API_KEY — Vite would publish it.

const HOME_ICON = new DivIcon({
  html: '<div class="home-pin"><div class="home-pin-dot"></div></div>',
  className: '',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
})

// Sets zoom limits and fits the home view to whatever screen this is on
// (and again when the screen rotates). Panning is unrestricted.
function MapSetup({ mapRef }: { mapRef: MutableRefObject<LeafletMap | null> }) {
  const map = useMap()
  useEffect(() => {
    mapRef.current = map
    map.setMinZoom(9)
    map.setMaxZoom(19)
    map.fitBounds(HOME_VIEW, { padding: [12, 12], animate: false })

    let t: ReturnType<typeof setTimeout> | null = null
    const onResize = () => {
      if (t) clearTimeout(t)
      t = setTimeout(() => {
        map.invalidateSize()
        map.fitBounds(HOME_VIEW, { padding: [12, 12] })
      }, 300)
    }
    window.addEventListener('orientationchange', onResize)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('orientationchange', onResize)
      window.removeEventListener('resize', onResize)
      if (t) clearTimeout(t)
    }
  }, [map, mapRef])
  return null
}

export function MapScreen() {
  const { vessels, activePopup, updateVessel, hydrateVessels, pruneStale, triggerPopup, dismissPopup, setWeather } =
    useKioskStore()
  useKioskMode()
  const lastActivityAt = useKioskStore(s => s.lastActivityAt)
  const stopRef = useRef<(() => void) | null>(null)
  const mapRef = useRef<LeafletMap | null>(null)
  const [attract, setAttract] = useState(false)
  // Add ?attract to the URL to preview the screensaver without waiting 5 minutes
  const [forceAttract] = useState(() => new URLSearchParams(window.location.search).has('attract'))

  function flyHome() {
    mapRef.current?.flyToBounds(HOME_VIEW, { padding: [12, 12], duration: 1.2 })
  }

  // Start AIS stream
  useEffect(() => {
    stopRef.current = startAISStream(
      (partial: Vessel) => updateVessel(partial),
      (vessel: Vessel) => {
        // Get latest merged data from store before triggering popup
        const full = useKioskStore.getState().vessels[vessel.mmsi] ?? vessel
        triggerPopup(full)
      },
      (list: Vessel[]) => hydrateVessels(list),
    )

    return () => stopRef.current?.()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Weather polling
  useEffect(() => {
    const load = () => {
      fetchWeather()
        .then(setWeather)
        .catch(e => console.warn('[Weather]', e))
    }
    load()
    const interval = setInterval(load, WEATHER_REFRESH_MS)
    return () => clearInterval(interval)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Clear ships that have gone quiet (left coverage)
  useEffect(() => {
    const t = setInterval(() => pruneStale(VESSEL_STALE_MS), 60_000)
    return () => clearInterval(t)
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
        attributionControl={true}
      >
        <MapSetup mapRef={mapRef} />

        {/* Esri World Topo — keyless base map (CARTO now requires an API key) */}
        <TileLayer
          url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}"
          attribution="Tiles &copy; Esri"
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

        {/* Jazmyn's office — the MOC */}
        <Marker position={HOME_POINT} icon={HOME_ICON} interactive={false}>
          <Tooltip permanent direction="right" offset={[10, 0]} className="home-pin-label">
            {HOME_LABEL}
          </Tooltip>
        </Marker>

        {/* Vessels */}
        {vesselList.map(v => (
          <VesselMarker
            key={v.mmsi}
            vessel={v}
            onClick={vessel => triggerPopup(vessel)}
          />
        ))}
      </MapContainer>

      {/* Empty state — when no live vessels are in the area */}
      {vesselList.length === 0 && !attract && !forceAttract && (
        <div className="no-vessels-overlay">
          <div className="no-vessels-card">
            <span className="no-vessels-icon">🔭</span>
            <p className="no-vessels-text">Scanning for vessels…</p>
            <p className="no-vessels-sub">
              No ships currently detected in the St.&nbsp;Clair River corridor.
              Vessels will appear automatically when they enter the area.
            </p>
          </div>
        </div>
      )}

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
        {(attract || forceAttract) && <AttractScreen key="attract" />}
      </AnimatePresence>

      {/* Status bar — rendered above attract overlay (z-index 1200) */}
      <StatusBar />
    </div>
  )
}
