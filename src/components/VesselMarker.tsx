import { DivIcon } from 'leaflet'
import { Marker, Tooltip } from 'react-leaflet'
import type { Vessel } from '../types'

interface Props {
  vessel: Vessel
  onClick: (vessel: Vessel) => void
}

function vesselColor(shipType: number): string {
  if (shipType >= 70 && shipType <= 79) return '#1a1a2e'  // cargo → chart black
  if (shipType >= 80 && shipType <= 89) return '#8b0000'  // tanker → nautical red
  if (shipType >= 60 && shipType <= 69) return '#1a4a1a'  // passenger → chart green
  if (shipType === 52 || shipType === 21) return '#7a4a00' // tug → copper brown
  return '#1a3a5c' // default → navy
}

function createArrowIcon(heading: number, color: string): DivIcon {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 24 24">
      <polygon points="12,2 18,20 12,16 6,20"
        fill="${color}" stroke="#f4ecd2" stroke-width="1.2"
        transform="rotate(${heading}, 12, 12)" />
    </svg>`

  return new DivIcon({
    html: svg,
    className: '',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
    popupAnchor: [0, -20],
  })
}

export function VesselMarker({ vessel, onClick }: Props) {
  const color = vesselColor(vessel.shipType ?? 0)
  const icon = createArrowIcon(vessel.heading ?? 0, color)

  return (
    <Marker
      position={[vessel.lat, vessel.lon]}
      icon={icon}
      eventHandlers={{ click: () => onClick(vessel) }}
    >
      <Tooltip direction="top" offset={[0, -12]} opacity={0.92}>
        <span style={{ fontWeight: 700 }}>
          {vessel.name || `MMSI ${vessel.mmsi}`}
        </span>
        <br />
        <span style={{ fontSize: '0.85em', color: '#ccc' }}>
          {(vessel.speed ?? 0).toFixed(1)} kn
        </span>
      </Tooltip>
    </Marker>
  )
}
