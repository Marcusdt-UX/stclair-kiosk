/**
 * AISStream WebSocket Proxy + Vessel Lookup HTTP API
 * Runs locally alongside Vite. Connects to aisstream.io (server-side,
 * so CORS is not an issue) and forwards messages to browser clients.
 * Also serves GET /vessel/:mmsi for vessel history lookups.
 */

import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createDashboard } from './server/dashboard.js'

// Dates on the dashboard (calendar days, "today") are Port Huron local time
process.env.TZ = process.env.KIOSK_TZ || 'America/Detroit'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load env vars from .env manually (no dotenv dependency needed)
function loadEnv() {
  try {
    const raw = readFileSync(resolve(__dirname, '.env'), 'utf8')
    const vars = {}
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      vars[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim()
    }
    return vars
  } catch {
    return {}
  }
}

const env = loadEnv()
// Keys are SERVER-ONLY. Never prefix them with VITE_ — Vite bakes any
// referenced VITE_* variable into the public JS bundle.
// (The old VITE_* names are still accepted here so existing .env files keep working.)
const AIS_KEY =
  process.env.AISSTREAM_API_KEY ||
  env.AISSTREAM_API_KEY ||
  process.env.VITE_AISSTREAM_API_KEY ||
  env.VITE_AISSTREAM_API_KEY ||
  ''
const WX_KEY =
  process.env.OPENWEATHER_API_KEY ||
  env.OPENWEATHER_API_KEY ||
  process.env.VITE_OPENWEATHER_API_KEY ||
  env.VITE_OPENWEATHER_API_KEY ||
  ''
const PROXY_PORT = parseInt(process.env.PORT || '2610', 10)
const AIS_URL = process.env.AIS_URL || 'wss://stream.aisstream.io/v0/stream'
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || existsSync(resolve(__dirname, 'dist', 'index.html'))

// Persistent data directory. On Railway, attach a volume and it is picked up
// automatically via RAILWAY_VOLUME_MOUNT_PATH (or set DATA_DIR yourself).
// Without a volume, files live next to this script and are lost on redeploy.
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname
try { mkdirSync(DATA_DIR, { recursive: true }) } catch {}

// Bounding box: full shipping corridor — Detroit River through Lake Huron south
// Covers: Detroit, Lake St. Clair, St. Clair River, southern Lake Huron
const BOUNDING_BOX = [[[42.0, -83.5], [44.0, -81.5]]]

// Keep these in sync with src/constants/bounds.ts
// St. Clair River corridor (what the map shows)
const CORRIDOR = { south: 42.85, west: -82.55, north: 43.05, east: -82.35 }
// Stretch of river visible from the MOC (100 McMorran Blvd) — the "outside her window" zone
const WINDOW_ZONE = { south: 42.955, west: -82.432, north: 43.003, east: -82.398 }
// AIS TrueHeading 511 means "not available" — fall back to course over ground
// AIS SOG 102.3 (raw 1023) means "speed not available"
const sogOf = pos => (pos?.Sog != null && pos.Sog < 102.2) ? pos.Sog : null
const headingOf = pos => (pos?.TrueHeading != null && pos.TrueHeading < 360) ? pos.TrueHeading : (pos?.Cog ?? 0)
const inBox = (lat, lon, b) => lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east

// Weather location (the MOC)
const WX_LAT = 42.9788
const WX_LON = -82.4197

console.log(`[Proxy] NODE_ENV=${process.env.NODE_ENV}, IS_PRODUCTION=${IS_PRODUCTION}, PORT=${PROXY_PORT}`)
console.log(`[Proxy] AIS_KEY present: ${!!AIS_KEY && AIS_KEY !== 'your_aisstream_key_here'}, WX_KEY present: ${!!WX_KEY && WX_KEY !== 'your_openweather_key_here'}`)

if (!AIS_KEY || AIS_KEY === 'your_aisstream_key_here') {
  console.error('[Proxy] ERROR: AIS API key not found. Set AISSTREAM_API_KEY in your environment (or .env).')
  process.exit(1)
}

// Load local ships DB
let shipsDb = {}
try {
  const raw = readFileSync(resolve(__dirname, 'src/data/ships-db.json'), 'utf8')
  shipsDb = JSON.parse(raw)
  console.log(`[Proxy] Loaded ${Object.keys(shipsDb).length} vessels from ships-db.json`)
} catch (e) {
  console.warn('[Proxy] Could not load ships-db.json:', e.message)
}

// ── Fleet database (built from Boatnerd by scripts/build-fleet-db.mjs) ─────
// ~240 active Great Lakes vessels keyed by slug. Boatnerd has no MMSIs, so we
// match on the name AIS broadcasts: current name first, then former names.
let fleetDb = {}
try {
  fleetDb = JSON.parse(readFileSync(resolve(__dirname, 'src/data/fleet-db.json'), 'utf8'))
  console.log(`[Proxy] Loaded ${Object.keys(fleetDb).length} vessels from fleet-db.json`)
} catch (e) {
  console.warn('[Proxy] Could not load fleet-db.json:', e.message)
}

function normaliseName(name = '') {
  return name
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[čć]/gi, 'e')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
const fleetByName = new Map()
const fleetByFormerName = new Map()
for (const [slug, f] of Object.entries(fleetDb)) {
  const k = normaliseName(f.name)
  if (k && !fleetByName.has(k)) fleetByName.set(k, slug)
  for (const fn of f.formerNames ?? []) {
    const fk = normaliseName(fn)
    if (fk && !fleetByFormerName.has(fk)) fleetByFormerName.set(fk, slug)
  }
}

/** AIS name → fleet slug (or undefined). AIS names are max 20 chars, so long names arrive truncated. */
function matchFleet(name) {
  const n = normaliseName(name)
  if (!n) return undefined
  if (fleetByName.has(n)) return fleetByName.get(n)
  if (name.trim().length >= 19) {
    for (const [k, slug] of fleetByName) if (k.startsWith(n)) return slug
  }
  return fleetByFormerName.get(n)
}

// Map the hand-curated ships-db entries to fleet slugs too (for local photos)
const shipsDbSlug = {}
for (const [mmsi, e] of Object.entries(shipsDb)) {
  const slug = e?.name ? fleetByName.get(normaliseName(e.name)) : undefined
  if (slug) shipsDbSlug[mmsi] = slug
}

/** Everything we know about one MMSI. Priority: ships-db (curated) > live AIS cache > fleet DB. */
function vesselInfo(mmsi) {
  const cached = vesselCache[mmsi] ?? {}
  const curated = shipsDb[mmsi] ?? {}
  const slug = shipsDbSlug[mmsi] || cached.fleetSlug || (cached.name ? matchFleet(cached.name) : undefined)
  const fleet = slug ? fleetDb[slug] ?? {} : {}
  const merged = { mmsi, ...fleet, ...cached, ...curated }
  // Display name: curated > fleet (proper case) > AIS (all caps)
  merged.name = curated.name || fleet.name || cached.name || ''
  // Photo: a locally stored copy beats any remote URL
  const local = fleet.photo?.startsWith('/ships/') ? fleet.photo : undefined
  merged.photo = local || curated.photo || fleet.photo
  merged.photoCredit = local || (!curated.photo && fleet.photo) ? fleet.photoCredit : undefined
  if (slug) merged.fleetSlug = slug
  if (!merged.operator && fleet.operator) merged.operator = fleet.operator
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
  return merged
}

// ── Persistent vessel cache (vessel-cache.json) ────────────────────────────
// Auto-built from live AIS traffic. Grows with every session.
// Separate from ships-db.json (hand-curated, always wins on merge).
const VESSEL_CACHE_PATH = resolve(DATA_DIR, 'vessel-cache.json')
const SEED_CACHE_PATH = resolve(__dirname, 'vessel-cache.json')
console.log(`[Proxy] Data directory: ${DATA_DIR}${DATA_DIR === __dirname ? ' (no volume — cache is lost on redeploy)' : ''}`)

let vesselCache = {}
try {
  // Prefer the persistent copy; fall back to a seed file shipped next to the script
  const path = existsSync(VESSEL_CACHE_PATH) ? VESSEL_CACHE_PATH : SEED_CACHE_PATH
  const raw = readFileSync(path, 'utf8')
  vesselCache = JSON.parse(raw)
  console.log(`[Proxy] Loaded ${Object.keys(vesselCache).length} vessels from ${path}`)
} catch {
  console.log('[Proxy] No vessel-cache.json found — will create one as vessels are seen')
}

// Debounced disk write — batches rapid updates, writes at most once per 5s
let flushTimer = null
function scheduleCacheFlush() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      writeFileSync(VESSEL_CACHE_PATH, JSON.stringify(vesselCache, null, 2), 'utf8')
      console.log(`[Proxy] 💾 vessel-cache.json saved (${Object.keys(vesselCache).length} vessels)`)
    } catch (e) {
      console.error('[Proxy] Failed to write vessel-cache.json:', e.message)
    }
  }, 5000)
}

// Flush on shutdown. Railway sends SIGTERM on every redeploy/restart.
function shutdown() {
  if (flushTimer) clearTimeout(flushTimer)
  try { writeFileSync(VESSEL_CACHE_PATH, JSON.stringify(vesselCache, null, 2), 'utf8') } catch {}
  try { writeCoverageHour(true) } catch {}
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ── Coverage log ─────────────────────────────────────────────────────────────
// Answers "is the internet AIS feed good enough here?" One JSON line per hour
// in coverage-log.jsonl, plus live numbers at GET /coverage.
const COVERAGE_LOG_PATH = resolve(DATA_DIR, 'coverage-log.jsonl')
const startedAt = Date.now()
let aisConnected = false
let lastAisMessageAt = null
const lifetime = { messages: 0, positionReports: 0, windowPasses: 0 }

function newHour() {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  return {
    hour: d.toISOString(),
    messages: 0,
    positionReports: 0,
    staticReports: 0,
    vessels: new Set(),
    corridorVessels: new Set(),
    windowVessels: new Set(),
    windowPasses: [],          // names/MMSIs of moving ships that passed the MOC
    disconnects: 0,
  }
}
let hour = newHour()
const recentHours = []         // last 7 days of hourly summaries (in memory)

function summarize(h) {
  return {
    hour: h.hour,
    messages: h.messages,
    positionReports: h.positionReports,
    staticReports: h.staticReports,
    vessels: h.vessels.size,
    corridorVessels: h.corridorVessels.size,
    windowVessels: h.windowVessels.size,
    windowPasses: h.windowPasses,
    disconnects: h.disconnects,
  }
}

function writeCoverageHour(partial = false) {
  const line = { ...summarize(hour), partial }
  try { appendFileSync(COVERAGE_LOG_PATH, JSON.stringify(line) + '\n', 'utf8') } catch (e) {
    console.error('[Coverage] Failed to write log:', e.message)
  }
  return line
}

// Roll the hourly bucket over
setInterval(() => {
  const nowHour = new Date(); nowHour.setMinutes(0, 0, 0)
  if (nowHour.toISOString() !== hour.hour) {
    const line = writeCoverageHour()
    recentHours.push(line)
    while (recentHours.length > 24 * 7) recentHours.shift()
    console.log(`[Coverage] ${line.hour}: ${line.messages} msgs, ${line.vessels} vessels, ${line.corridorVessels} in corridor, ${line.windowPasses.length} passed the MOC`)
    hour = newHour()
  }
}, 60_000)

// Load previous history so /coverage survives restarts
try {
  const lines = readFileSync(COVERAGE_LOG_PATH, 'utf8').trim().split('\n').slice(-24 * 7)
  for (const l of lines) { try { recentHours.push(JSON.parse(l)) } catch {} }
} catch {}

// Remember the last position per MMSI so we can detect ships crossing the window zone
const lastPos = new Map()

function recordCoverage(msg) {
  lastAisMessageAt = Date.now()
  hour.messages++
  lifetime.messages++
  const meta = msg.MetaData
  if (!meta) return
  const mmsi = String(meta.MMSI)
  hour.vessels.add(mmsi)

  if (msg.MessageType === 'ShipStaticData') hour.staticReports++
  if (msg.MessageType !== 'PositionReport') return

  hour.positionReports++
  lifetime.positionReports++
  const pos = msg.Message?.PositionReport ?? {}
  const lat = meta.latitude ?? pos.Latitude
  const lon = meta.longitude ?? pos.Longitude
  if (lat == null || lon == null) return
  if (inBox(lat, lon, CORRIDOR)) hour.corridorVessels.add(mmsi)

  const inWin = inBox(lat, lon, WINDOW_ZONE)
  if (inWin) hour.windowVessels.add(mmsi)

  // A "pass" = a moving ship entering the window zone (or jumping across it between reports)
  const prev = lastPos.get(mmsi)
  lastPos.set(mmsi, { lat, lon, inWin })
  const moving = (sogOf(pos) ?? 0) >= 1
  const crossed = prev && !prev.inWin && !inWin &&
    lon >= WINDOW_ZONE.west && lon <= WINDOW_ZONE.east &&
    ((prev.lat > WINDOW_ZONE.north && lat < WINDOW_ZONE.south) ||
     (prev.lat < WINDOW_ZONE.south && lat > WINDOW_ZONE.north))
  if (moving && ((inWin && (!prev || !prev.inWin)) || crossed)) {
    const name = vesselCache[mmsi]?.name || shipsDb[mmsi]?.name || mmsi
    hour.windowPasses.push(name)
    lifetime.windowPasses++
    console.log(`[Coverage] 🚢 ${name} passing the MOC`)
    try { dash?.recordPass(mmsi, { heading: headingOf(pos), speed: sogOf(pos) ?? 0 }) } catch {}
  }
}

// ── Weather (server-side so the OpenWeather key never reaches the browser) ──
let wxCache = null
let wxCachedAt = 0
async function getWeather() {
  if (!WX_KEY) throw new Error('No OPENWEATHER_API_KEY set')
  if (wxCache && Date.now() - wxCachedAt < 10 * 60 * 1000) return wxCache
  const url = `https://api.openweathermap.org/data/2.5/weather?lat=${WX_LAT}&lon=${WX_LON}&units=imperial&appid=${WX_KEY}`
  const r = await fetch(url)
  if (!r.ok) throw new Error(`OpenWeather ${r.status}`)
  wxCache = await r.json()
  wxCachedAt = Date.now()
  return wxCache
}

// Recently-seen vessels, sent to each browser on connect so the map isn't
// blank while waiting for the next live AIS report (coverage can be sparse).
const SNAPSHOT_MAX_AGE_MS = 20 * 60 * 1000
function buildSnapshot() {
  const cutoff = Date.now() - SNAPSHOT_MAX_AGE_MS
  const out = []
  for (const [mmsi, v] of Object.entries(vesselCache)) {
    if (!v.lastSeen || v.lastSeen < cutoff || v.lastLat == null || v.lastLon == null) continue
    const info = vesselInfo(mmsi)
    out.push({
      mmsi,
      name: info.name || '',
      lat: v.lastLat,
      lon: v.lastLon,
      speed: v.lastSpeed ?? 0,
      heading: v.lastHeading ?? 0,
      shipType: v.shipType ?? 0,
      length: v.length,
      imo: v.imo,
      callSign: v.callSign,
      destination: v.destinations?.length ? v.destinations[v.destinations.length - 1] : undefined,
      lastSeen: v.lastSeen,
    })
  }
  return out
}

// ── Dashboard panels (ship's log, ETAs, conditions, bridge, calendar, photos, ask)
const dash = createDashboard({ dataDir: DATA_DIR, vesselCache, vesselInfo, wxKey: WX_KEY })

// ── HTTP server (handles both HTTP requests and WebSocket upgrades) ──────────
const httpServer = createServer(async (req, res) => {
  if (req.url?.startsWith('/dash/') || req.url === '/admin' || req.url?.startsWith('/admin/')) {
    const handled = await dash(req, res)
    if (handled !== false) return
  }

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Content-Type', 'application/json')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const match = req.url?.match(/^\/vessel\/(\d+)$/)
  if (req.method === 'GET' && match) {
    const mmsi = match[1]
    res.writeHead(200)
    res.end(JSON.stringify(vesselInfo(mmsi)))
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200)
    res.end(JSON.stringify({ ok: true, aisConnected, lastAisMessageAt }))
    return
  }

  if (req.method === 'GET' && req.url === '/coverage') {
    const now = Date.now()
    res.writeHead(200)
    res.end(JSON.stringify({
      startedAt: new Date(startedAt).toISOString(),
      uptimeMinutes: Math.round((now - startedAt) / 60000),
      aisConnected,
      lastAisMessageAt: lastAisMessageAt ? new Date(lastAisMessageAt).toISOString() : null,
      minutesSinceLastMessage: lastAisMessageAt ? Math.round((now - lastAisMessageAt) / 60000) : null,
      lifetime,
      currentHour: summarize(hour),
      recentHours: recentHours.slice(-48),
      windowZone: WINDOW_ZONE,
      dataDir: DATA_DIR,
      persistent: DATA_DIR !== __dirname,
    }, null, 2))
    return
  }

  if (req.method === 'GET' && req.url === '/weather') {
    getWeather()
      .then(data => { res.writeHead(200); res.end(JSON.stringify(data)) })
      .catch(e => { res.writeHead(502); res.end(JSON.stringify({ error: e.message })) })
    return
  }

  // Screensaver slides: every known vessel that has a photo (local copies first)
  if (req.method === 'GET' && req.url === '/fleet') {
    const slides = []
    const seenSlugs = new Set()
    for (const mmsi of Object.keys(shipsDb)) {
      if (mmsi.startsWith('__')) continue
      const v = vesselInfo(mmsi)
      if (!v.photo) continue
      if (v.fleetSlug) seenSlugs.add(v.fleetSlug)
      slides.push(v)
    }
    for (const [slug, f] of Object.entries(fleetDb)) {
      if (seenSlugs.has(slug) || !f.photo) continue
      slides.push({ mmsi: `fleet:${slug}`, fleetSlug: slug, ...f })
    }
    res.setHeader('Cache-Control', 'public, max-age=3600')
    res.writeHead(200)
    res.end(JSON.stringify(slides))
    return
  }

  if (req.method === 'GET' && req.url === '/vessels') {
    const result = {}
    const allMmsi = new Set([...Object.keys(vesselCache), ...Object.keys(shipsDb)])
    for (const mmsi of allMmsi) {
      result[mmsi] = vesselInfo(mmsi)
    }
    res.writeHead(200)
    res.end(JSON.stringify(result))
    return
  }

  // ── Production: serve built frontend from dist/ ──────────────────
  if (IS_PRODUCTION) {
    const distDir = resolve(__dirname, 'dist')
    const url = req.url === '/' ? '/index.html' : req.url
    const filePath = resolve(distDir, url.replace(/^\//, ''))

    // Only serve files under dist/ (basic path-traversal guard)
    if (filePath.startsWith(distDir)) {
      try {
        const content = readFileSync(filePath)
        const ext = filePath.split('.').pop()
        const mimeTypes = {
          html: 'text/html', js: 'application/javascript', css: 'text/css',
          json: 'application/json', svg: 'image/svg+xml', png: 'image/png',
          ico: 'image/x-icon', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', webmanifest: 'application/manifest+json',
          woff2: 'font/woff2', woff: 'font/woff',
        }
        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream')
        if (url.startsWith('/ships/') || url.startsWith('/assets/')) {
          res.setHeader('Cache-Control', 'public, max-age=2592000, immutable')
        }
        res.writeHead(200)
        res.end(content)
        return
      } catch {
        // File not found — fall through to SPA fallback
      }
    }

    // SPA fallback: serve index.html for client-side routes
    try {
      const index = readFileSync(resolve(distDir, 'index.html'))
      res.setHeader('Content-Type', 'text/html')
      res.writeHead(200)
      res.end(index)
      return
    } catch { /* dist not built yet */ }
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: 'Not found' }))
})

httpServer.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(`[Proxy] HTTP + WebSocket listening on port ${PROXY_PORT}${IS_PRODUCTION ? ' (production)' : ''}`)
})

// ── WebSocket server (reuses the HTTP server) ────────────────────────────────
const wss = new WebSocketServer({ server: httpServer })

let aisWs = null
let reconnectTimer = null
let reconnectDelay = 3000
const clients = new Set()

function connectToAIS() {
  console.log('[Proxy] Connecting to AISStream...')
  aisWs = new WebSocket(AIS_URL)

  aisWs.on('open', () => {
    reconnectDelay = 3000
    aisConnected = true
    console.log('[Proxy] AISStream connected. Subscribing...')
    const sub = JSON.stringify({
      APIKey: AIS_KEY,
      BoundingBoxes: BOUNDING_BOX,
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    })
    console.log('[Proxy] Subscription payload:', sub.replace(AIS_KEY, '***'))
    aisWs.send(sub)

    // Keep connection alive — ping every 30s
    aisWs._pingInterval = setInterval(() => {
      if (aisWs.readyState === WebSocket.OPEN) {
        aisWs.ping()
      }
    }, 30_000)
  })

  let msgCount = 0
  aisWs.on('message', (data) => {
    msgCount++
    const preview = data.toString().slice(0, 200)
    if (msgCount <= 5 || msgCount % 50 === 0) {
      console.log(`[Proxy] AIS msg #${msgCount}: ${preview}`)
    }
    const raw = data.toString()
    // Update vessel cache from every AIS message
    try {
      const msg = JSON.parse(raw)
      const now = Date.now()
      recordCoverage(msg)

      // ── PositionReport: record sighting even before static data arrives ──
      if (msg.MessageType === 'PositionReport') {
        const pos = msg.Message?.PositionReport
        const meta = msg.MetaData
        if (pos && meta) {
          const mmsi = String(meta.MMSI)
          const existing = vesselCache[mmsi] ?? {}
          const isNew = !existing.firstSeen

          vesselCache[mmsi] = {
            ...existing,
            firstSeen: existing.firstSeen ?? now,
            lastSeen: now,
            lastLat: meta.latitude ?? pos.Latitude,
            lastLon: meta.longitude ?? pos.Longitude,
            lastSpeed: sogOf(pos) ?? existing.lastSpeed,
            lastHeading: headingOf(pos) ?? existing.lastHeading,
            positionCount: (existing.positionCount ?? 0) + 1,
          }

          if (isNew) {
            console.log(`[Cache] New vessel spotted: MMSI ${mmsi} — awaiting static data`)
            scheduleCacheFlush()
          } else if (vesselCache[mmsi].positionCount % 50 === 0) {
            // Periodic flush every 50 position updates per vessel
            scheduleCacheFlush()
          }
        }
      }

      // ── ShipStaticData: enrich with name, IMO, flag, dimensions ──
      if (msg.MessageType === 'ShipStaticData') {
        const stat = msg.Message?.ShipStaticData
        const meta = msg.MetaData
        if (stat && meta) {
          const mmsi = String(meta.MMSI)
          const now = Date.now()
          const existing = vesselCache[mmsi] ?? {}

          const name = stat.Name?.trim() || existing.name || ''
          const callSign = stat.CallSign?.trim() || existing.callSign || ''
          const imo = stat.ImoNumber ? String(stat.ImoNumber) : existing.imo
          const flag = stat.Flag || existing.flag
          const shipType = stat.Type ?? existing.shipType
          const length = (stat.Dimension?.A != null && stat.Dimension?.B != null)
            ? stat.Dimension.A + stat.Dimension.B
            : existing.length

          // Track unique destinations seen
          const dest = stat.Destination?.trim()
          const destinations = existing.destinations ?? []
          if (dest && dest !== '' && dest.toUpperCase() !== 'UNKNOWN' && !destinations.includes(dest)) {
            destinations.push(dest)
          }

          const fleetSlug = existing.fleetSlug || (name ? matchFleet(name) : undefined)
          if (fleetSlug && !existing.fleetSlug) {
            console.log(`[Fleet] ${name} (MMSI ${mmsi}) → ${fleetDb[fleetSlug]?.name}`)
          }

          vesselCache[mmsi] = {
            ...existing,
            name,
            fleetSlug,
            callSign,
            imo,
            flag,
            shipType,
            length,
            destinations,
            firstSeen: existing.firstSeen ?? now,
            lastSeen: now,
            seenCount: (existing.seenCount ?? 0) + 1,
          }

          // Remove undefined fields to keep file clean
          for (const key of Object.keys(vesselCache[mmsi])) {
            if (vesselCache[mmsi][key] === undefined) delete vesselCache[mmsi][key]
          }

          if (name && name !== existing.name) {
            console.log(`[Cache] ${name} (MMSI ${mmsi}) — seen ${vesselCache[mmsi].seenCount}x`)
          }

          scheduleCacheFlush()
        }
      }
    } catch { /* not JSON, ignore */ }

    // Forward raw message to all connected browser clients
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(raw)
      }
    }
  })

  aisWs.on('error', (err) => {
    console.error('[Proxy] AISStream error:', err.message)
  })

  aisWs.on('close', (code, reason) => {
    if (aisWs._pingInterval) clearInterval(aisWs._pingInterval)
    aisConnected = false
    hour.disconnects++
    console.warn(`[Proxy] AISStream disconnected. Code: ${code}, Reason: "${reason?.toString() || ''}", Messages received: ${msgCount}. Reconnecting in ${reconnectDelay / 1000}s...`)
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000)
      connectToAIS()
    }, reconnectDelay)
  })
}

wss.on('connection', (clientWs) => {
  console.log('[Proxy] Browser client connected')
  clients.add(clientWs)
  try {
    clientWs.send(JSON.stringify({ MessageType: 'Snapshot', Vessels: buildSnapshot() }))
  } catch {}

  clientWs.on('close', () => {
    clients.delete(clientWs)
    console.log('[Proxy] Browser client disconnected')
  })
})

connectToAIS()
