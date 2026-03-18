/**
 * AISStream WebSocket Proxy + Vessel Lookup HTTP API
 * Runs locally alongside Vite. Connects to aisstream.io (server-side,
 * so CORS is not an issue) and forwards messages to browser clients.
 * Also serves GET /vessel/:mmsi for vessel history lookups.
 */

import { WebSocketServer, WebSocket } from 'ws'
import { createServer } from 'http'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

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
const AIS_KEY = env.VITE_AISSTREAM_API_KEY || process.env.VITE_AISSTREAM_API_KEY || ''
const PROXY_PORT = parseInt(process.env.PORT || '2610', 10)
const AIS_URL = 'wss://stream.aisstream.io/v0/stream'
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || existsSync(resolve(__dirname, 'dist', 'index.html'))

// Bounding box: full St. Clair River corridor
const BOUNDING_BOX = [[[42.85, -82.55], [43.05, -82.35]]]

if (!AIS_KEY || AIS_KEY === 'your_aisstream_key_here') {
  console.error('[Proxy] ERROR: VITE_AISSTREAM_API_KEY is not set in .env')
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

// ── Persistent vessel cache (vessel-cache.json) ────────────────────────────
// Auto-built from live AIS traffic. Grows with every session.
// Separate from ships-db.json (hand-curated, always wins on merge).
const VESSEL_CACHE_PATH = resolve(__dirname, 'vessel-cache.json')

let vesselCache = {}
try {
  const raw = readFileSync(VESSEL_CACHE_PATH, 'utf8')
  vesselCache = JSON.parse(raw)
  console.log(`[Proxy] Loaded ${Object.keys(vesselCache).length} vessels from vessel-cache.json`)
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

// Flush on clean shutdown
process.on('SIGINT', () => {
  if (flushTimer) {
    clearTimeout(flushTimer)
    try { writeFileSync(VESSEL_CACHE_PATH, JSON.stringify(vesselCache, null, 2), 'utf8') } catch {}
  }
  process.exit(0)
})

// ── HTTP server (handles both HTTP requests and WebSocket upgrades) ──────────
const httpServer = createServer((req, res) => {
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
    // Merge order: vesselCache (accumulated AIS) ← shipsDb (curated, wins)
    const merged = { mmsi, ...vesselCache[mmsi], ...shipsDb[mmsi] }
    res.writeHead(200)
    res.end(JSON.stringify(merged))
    return
  }

  if (req.method === 'GET' && req.url === '/vessels') {
    const result = {}
    const allMmsi = new Set([...Object.keys(vesselCache), ...Object.keys(shipsDb)])
    for (const mmsi of allMmsi) {
      result[mmsi] = { mmsi, ...vesselCache[mmsi], ...shipsDb[mmsi] }
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
          ico: 'image/x-icon', webmanifest: 'application/manifest+json',
          woff2: 'font/woff2', woff: 'font/woff',
        }
        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream')
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
    console.log('[Proxy] AISStream connected. Subscribing...')
    aisWs.send(JSON.stringify({
      APIKey: AIS_KEY,
      BoundingBoxes: BOUNDING_BOX,
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    }))
  })

  aisWs.on('message', (data) => {
    const raw = data.toString()
    // Update vessel cache from every AIS message
    try {
      const msg = JSON.parse(raw)
      const now = Date.now()

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
            lastSpeed: pos.Sog ?? existing.lastSpeed,
            lastHeading: pos.TrueHeading ?? pos.Cog ?? existing.lastHeading,
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

          vesselCache[mmsi] = {
            ...existing,
            name,
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

  aisWs.on('close', () => {
    console.warn(`[Proxy] AISStream disconnected. Reconnecting in ${reconnectDelay / 1000}s...`)
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000)
      connectToAIS()
    }, reconnectDelay)
  })
}

wss.on('connection', (clientWs) => {
  console.log('[Proxy] Browser client connected')
  clients.add(clientWs)

  clientWs.on('close', () => {
    clients.delete(clientWs)
    console.log('[Proxy] Browser client disconnected')
  })
})

connectToAIS()
