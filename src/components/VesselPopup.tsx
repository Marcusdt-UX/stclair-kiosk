import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { Vessel } from '../types'
import { resolvePhoto, getSilhouette, getDbEntry } from '../services/photoResolver'
import { shipTypeLabel } from '../services/aisstream'
import { POPUP_DURATION_MS } from '../constants/bounds'
import './VesselPopup.css'

interface Props {
  vessel: Vessel | null
  onDismiss: () => void
}

function formatDestination(dest?: string): string {
  if (!dest || dest.trim() === '' || dest.toUpperCase() === 'UNKNOWN') return 'Unknown'
  return dest.trim()
}

// Convert 2-letter ISO country code (from AIS/VesselFinder) to emoji + name.
// If already a full string (from ships-db.json), pass through unchanged.
const FLAG_NAMES: Record<string, string> = {
  US: '🇺🇸 United States', CA: '🇨🇦 Canada', BS: '🇧🇸 Bahamas',
  MH: '🇲🇭 Marshall Islands', PA: '🇵🇦 Panama', LR: '🇱🇷 Liberia',
  MT: '🇲🇹 Malta', CY: '🇨🇾 Cyprus', BS2: '🇧🇸 Bahamas',
  NL: '🇳🇱 Netherlands', DE: '🇩🇪 Germany', NO: '🇳🇴 Norway',
  GB: '🇬🇧 United Kingdom', JP: '🇯🇵 Japan', KR: '🇰🇷 South Korea',
  CN: '🇨🇳 China', HK: '🇭🇰 Hong Kong', SG: '🇸🇬 Singapore',
}
function formatFlag(flag?: string): string | null {
  if (!flag) return null
  if (flag.length > 3) return flag   // already "🇨🇦 Canada" etc.
  return FLAG_NAMES[flag.toUpperCase()] ?? `🏳 ${flag}`
}

export function VesselPopup({ vessel, onDismiss }: Props) {
  const [progress, setProgress] = useState(100)
  const [imgSrc, setImgSrc] = useState<string>('')
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!vessel) return

    const photo = resolvePhoto(vessel.mmsi, vessel.shipType)
    setImgSrc(photo)
    setProgress(100)

    const startTime = Date.now()
    intervalRef.current = setInterval(() => {
      const elapsed = Date.now() - startTime
      const pct = Math.max(0, 100 - (elapsed / POPUP_DURATION_MS) * 100)
      setProgress(pct)
    }, 200)

    timerRef.current = setTimeout(() => {
      onDismiss()
    }, POPUP_DURATION_MS)

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [vessel, onDismiss])

  const dbEntry = vessel ? getDbEntry(vessel.mmsi) : null
  const displayName = vessel
    ? (dbEntry?.name || vessel.name || `MMSI ${vessel.mmsi}`)
    : ''

  // Prefer local db data over AIS/cache for history fields
  const yearBuilt    = dbEntry?.yearBuilt   ?? vessel?.yearBuilt
  const flag         = dbEntry?.flag        ?? vessel?.flag
  const flagCode     = vessel?.flagCode
  const imo          = dbEntry?.imo         ?? vessel?.imo
  const builder      = dbEntry?.builder     ?? vessel?.builder
  const homeport     = dbEntry?.homeport    ?? vessel?.homeport
  const operator     = dbEntry?.operator    ?? vessel?.operator
  const grossTonnage = vessel?.grossTonnage
  const flagDisplay  = formatFlag(flag ?? flagCode)

  const typeStr  = vessel ? shipTypeLabel(vessel.shipType) : ''
  const lengthStr = vessel?.length ? `${vessel.length}m` : ''
  const grossStr  = grossTonnage ? `${grossTonnage.toLocaleString()} GT` : ''
  const yearStr   = yearBuilt ? `Built ${yearBuilt}` : ''
  const descParts = [typeStr, lengthStr, grossStr, yearStr].filter(Boolean)

  const destination = vessel ? formatDestination(vessel.destination) : ''
  const departure = vessel ? formatDestination(vessel.departure) : ''

  const secsLeft = Math.ceil((progress / 100) * (POPUP_DURATION_MS / 1000))

  return (
    <AnimatePresence>
      {vessel && (
        <>
          {/* Dim overlay */}
          <motion.div
            className="popup-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          />

          {/* Card */}
          <motion.div
            className="popup-card"
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 260, damping: 28 }}
          >
            {/* Left: photo */}
            <div className="popup-photo-wrap">
              <img
                key={vessel.mmsi}
                src={imgSrc}
                alt={displayName}
                className="popup-photo"
                onError={() => setImgSrc(getSilhouette(vessel.shipType))}
              />
              <div className="popup-photo-gradient" />
            </div>

            {/* Right: info */}
            <div className="popup-info">
              <button className="popup-close" onClick={onDismiss} aria-label="Close">✕</button>

              <h1 className="popup-name">{displayName}</h1>
              <div className="popup-divider" />

              <p className="popup-desc">{descParts.join('  •  ')}</p>

              {/* Historical detail rows */}
              <div className="popup-history">
                {flagDisplay && (
                  <div className="popup-history-row">
                    <span className="popup-history-label">Flag:</span>
                    <span className="popup-history-value">{flagDisplay}</span>
                  </div>
                )}
                {operator && (
                  <div className="popup-history-row">
                    <span className="popup-history-label">Operator:</span>
                    <span className="popup-history-value">{operator}</span>
                  </div>
                )}
                {builder && (
                  <div className="popup-history-row">
                    <span className="popup-history-label">Shipyard:</span>
                    <span className="popup-history-value">{builder}</span>
                  </div>
                )}
                {homeport && (
                  <div className="popup-history-row">
                    <span className="popup-history-label">Home Port:</span>
                    <span className="popup-history-value">{homeport}</span>
                  </div>
                )}
                {imo && (
                  <div className="popup-history-row">
                    <span className="popup-history-label">IMO:</span>
                    <span className="popup-history-value">{imo}</span>
                  </div>
                )}
              </div>

              <div className="popup-route">
                <div className="popup-route-row">
                  <span className="popup-route-icon">⚓</span>
                  <span className="popup-route-label">From:</span>
                  <span className="popup-route-value">{departure}</span>
                </div>
                <div className="popup-route-row">
                  <span className="popup-route-icon">📍</span>
                  <span className="popup-route-label">To:</span>
                  <span className="popup-route-value">{destination}</span>
                </div>
              </div>

              {dbEntry?.note && (
                <p className="popup-note">{dbEntry.note}</p>
              )}

              {/* Progress bar */}
              <div className="popup-progress-wrap">
                <span className="popup-progress-label">Auto-dismiss</span>
                <span className="popup-progress-secs">{secsLeft}s</span>
              </div>
              <div className="popup-progress-track">
                <div
                  className="popup-progress-bar"
                  style={{ width: `${progress}%` }}
                />
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
