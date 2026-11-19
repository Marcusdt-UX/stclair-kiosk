import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { useKioskStore } from '../store/kioskStore'
import { getSilhouette } from '../services/photoResolver'
import { ATTRACT_SLIDE_MS } from '../constants/bounds'
import { PROXY_BASE } from '../services/aisstream'
import type { ShipDbEntry } from '../types'
import shipsDb from '../data/ships-db.json'
import './AttractScreen.css'

// ── Build slide list from ships-db.json ─────────────────────────────────────

interface SlideEntry extends ShipDbEntry {
  mmsi: string
  photoCredit?: string
  capacity?: string
}

function shuffle<T>(all: T[]): T[] {
  // Fisher-Yates shuffle so order is different each session
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[all[i], all[j]] = [all[j], all[i]]
  }
  return all
}

// Fallback: the curated ships bundled with the app
function buildSlides(): SlideEntry[] {
  return shuffle(Object.entries(shipsDb as unknown as Record<string, ShipDbEntry>)
    .filter(([key, v]) => !key.startsWith('__') && v.photo)
    .map(([mmsi, v]) => ({ mmsi, ...v })))
}

// Full fleet from the proxy (~240 Great Lakes vessels). Precached local
// photos (/ships/...) go first so the slideshow never waits on the network.
let fleetSlidesCache: SlideEntry[] | null = null
async function loadFleetSlides(): Promise<SlideEntry[] | null> {
  if (fleetSlidesCache) return fleetSlidesCache
  try {
    const res = await fetch(`${PROXY_BASE}/fleet`)
    if (!res.ok) return null
    const list = (await res.json()) as SlideEntry[]
    const local = shuffle(list.filter(s => s.photo?.startsWith('/ships/')))
    const remote = shuffle(list.filter(s => s.photo && !s.photo.startsWith('/ships/')))
    fleetSlidesCache = local.length >= 20 ? local : [...local, ...remote]
    return fleetSlidesCache.length ? fleetSlidesCache : null
  } catch {
    return null
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export function AttractScreen() {
  const weather = useKioskStore(s => s.weather)
  const [slides, setSlides] = useState<SlideEntry[]>(() => fleetSlidesCache ?? buildSlides())

  useEffect(() => {
    if (fleetSlidesCache) return
    loadFleetSlides().then(list => { if (list) setSlides(list) })
  }, [])
  const [idx, setIdx] = useState(0)
  const [progress, setProgress] = useState(100)
  const [imgSrc, setImgSrc] = useState<string>('')

  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const progressRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const startTimeRef = useRef<number>(Date.now())

  const slide = slides[idx % slides.length]

  // Advance slide on mount and whenever idx changes
  useEffect(() => {
    if (!slide) return

    setImgSrc(slide.photo ?? getSilhouette(70))
    setProgress(100)
    startTimeRef.current = Date.now()

    // Fine-grained progress ticks
    progressRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current
      const pct = Math.max(0, 100 - (elapsed / ATTRACT_SLIDE_MS) * 100)
      setProgress(pct)
    }, 250)

    // Advance to next slide after duration
    intervalRef.current = setTimeout(() => {
      setIdx(i => i + 1)
    }, ATTRACT_SLIDE_MS)

    return () => {
      if (progressRef.current)  clearInterval(progressRef.current)
      if (intervalRef.current)  clearTimeout(intervalRef.current)
    }
  // also re-run when the slide list is swapped (bundled list → full fleet)
  }, [idx, slide?.mmsi]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!slide) return null

  const secsLeft = Math.ceil((progress / 100) * (ATTRACT_SLIDE_MS / 1000))
  const total    = slides.length

  // Build description parts
  const descParts: string[] = []
  if (slide.yearBuilt)  descParts.push(`Built ${slide.yearBuilt}`)

  // Weather summary for the header strip (supplement to StatusBar)
  const wxSummary = weather
    ? `Port Huron  •  ${weather.tempF}°F  •  ${weather.windDir} ${weather.windSpeed} mph`
    : 'Port Huron, Michigan'

  return (
    <motion.div
      className="attract-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.6 }}
    >
      {/* ── Left: ship photo ── */}
      <div className="attract-photo-wrap">
        <motion.img
          key={slide.mmsi}
          src={imgSrc}
          alt={slide.name}
          className={`attract-photo${imgSrc.startsWith('/silhouettes/') ? ' is-silhouette' : ''}`}
          initial={{ scale: 1.04 }}
          animate={{ scale: 1 }}
          transition={{ duration: ATTRACT_SLIDE_MS / 1000, ease: 'linear' }}
          onError={() => setImgSrc(getSilhouette(70))}
        />
        <div className="attract-photo-gradient" />
        <div className="attract-photo-vignette" />
        {slide.photoCredit && !imgSrc.startsWith('/silhouettes/') && (
          <span className="attract-photo-credit">Photo: {slide.photoCredit}</span>
        )}
      </div>

      {/* ── Right: info ── */}
      <div className="attract-info">
        {/* Slide counter */}
        <div className="attract-counter">
          {(idx % total) + 1} / {total}
        </div>

        {/* Header lozenge */}
        <div className="attract-header">
          St. Clair River &nbsp;·&nbsp; Great Lakes Maritime &nbsp;·&nbsp; {wxSummary}
        </div>

        {/* Ship name */}
        <motion.h1
          key={`name-${slide.mmsi}`}
          className="attract-name"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.15 }}
        >
          {slide.name}
        </motion.h1>

        <div className="attract-divider" />

        {descParts.length > 0 && (
          <p className="attract-desc">{descParts.join('  •  ')}</p>
        )}

        {/* Detail rows */}
        <motion.div
          key={`rows-${slide.mmsi}`}
          className="attract-history"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.25 }}
        >
          {slide.flag && (
            <div className="attract-history-row">
              <span className="attract-history-label">Flag</span>
              <span className="attract-history-value">{slide.flag}</span>
            </div>
          )}
          {slide.operator && (
            <div className="attract-history-row">
              <span className="attract-history-label">Operator</span>
              <span className="attract-history-value">{slide.operator}</span>
            </div>
          )}
          {slide.builder && (
            <div className="attract-history-row">
              <span className="attract-history-label">Shipyard</span>
              <span className="attract-history-value">{slide.builder}</span>
            </div>
          )}
          {slide.homeport && (
            <div className="attract-history-row">
              <span className="attract-history-label">Home Port</span>
              <span className="attract-history-value">{slide.homeport}</span>
            </div>
          )}
          {slide.capacity && (
            <div className="attract-history-row">
              <span className="attract-history-label">Capacity</span>
              <span className="attract-history-value">{slide.capacity}</span>
            </div>
          )}
          {slide.formerNames && slide.formerNames.length > 0 && (
            <div className="attract-history-row">
              <span className="attract-history-label">Also Sailed As</span>
              <span className="attract-history-value">{slide.formerNames.slice(0, 3).join(', ')}</span>
            </div>
          )}
          {slide.imo && (
            <div className="attract-history-row">
              <span className="attract-history-label">IMO</span>
              <span className="attract-history-value">{slide.imo}</span>
            </div>
          )}
        </motion.div>

        {slide.note && (
          <motion.p
            key={`note-${slide.mmsi}`}
            className="attract-note"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.45, delay: 0.35 }}
          >
            {slide.note}
          </motion.p>
        )}

        {/* Progress bar */}
        <div className="attract-progress-wrap">
          <div className="attract-progress-meta">
            <span className="attract-progress-label">Next vessel</span>
            <span className="attract-progress-secs">{secsLeft}s</span>
          </div>
          <div className="attract-progress-track">
            <div
              className="attract-progress-bar"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>
    </motion.div>
  )
}
