/**
 * Dashboard endpoints for the St. Clair kiosk ("ship's bridge" panels).
 *
 * Public (no key needed): ship's log, coming-up ETAs, river conditions,
 * Blue Water Bridge waits. These only expose public data.
 *
 * Private (need the kiosk key): calendar, family photos, Ask the Captain.
 * The key is the KIOSK_TOKEN env var. The device unlocks once by opening
 * https://<site>/?k=<KIOSK_TOKEN>; the page stores it in a cookie.
 * If KIOSK_TOKEN is not set, private endpoints stay switched off.
 *
 * Optional env:
 *   KIOSK_TOKEN        unlock key for private panels
 *   ADMIN_TOKEN        key for the photo upload page (/admin); defaults to KIOSK_TOKEN
 *   CALENDAR_ICS_URL   Google Calendar "secret address in iCal format" (office; more links,
 *                      and the Home-mode calendar, are set at /admin and kept on the volume)
 *   GEMINI_API_KEY     Gemini API key from a billing-linked project (paid tier = not used for training)
 *
 * Privacy of "Ask the Captain": questions are never written to disk or logs
 * here, and every Gemini call is sent with store:false so it never appears in
 * the key owner's AI Studio logs. Only token counts show up in billing.
 *   GEMINI_MODEL       defaults to gemini-flash-latest
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, createReadStream } from 'fs'
import { resolve, basename } from 'path'
import { timingSafeEqual } from 'crypto'
import ical from 'node-ical'
import { createHousehold } from './household.js'

// Where Jazmyn's window is (keep in sync with src/constants/bounds.ts)
export const WINDOW_ZONE = { south: 42.955, west: -82.432, north: 43.003, east: -82.398 }
const MOC = { lat: 42.9788, lon: -82.4197 }
const NOAA_STATION = '9014090'      // Mouth of the Black River, Port Huron (next to the MOC)
const USGS_SITE = '04159130'        // St. Clair River at Port Huron
const CBP_PORT = '380201'           // Port Huron – Blue Water Bridge

const now = () => Date.now()

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      if (size > limit) { reject(new Error('too large')); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function safeEqual(a, b) {
  if (!a || !b) return false
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

function cookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))
  return m ? decodeURIComponent(m[1]) : null
}

/** Simple time-based cache around an async loader */
function cached(ms, loader) {
  let value = null, at = 0, pending = null
  return async () => {
    if (value && now() - at < ms) return value
    if (pending) return pending
    pending = loader().then(v => { value = v; at = now(); return v }).finally(() => { pending = null })
    try { return await pending } catch (e) { if (value) return value; throw e }
  }
}

async function getJSON(url, opts = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'User-Agent': 'stclair-kiosk/1.0', ...(opts.headers || {}) } })
    if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`)
    return await r.json()
  } finally { clearTimeout(t) }
}

function degToCompass(deg = 0) {
  const d = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return d[Math.round(deg / 22.5) % 16]
}

export function createDashboard({ dataDir, vesselCache, vesselInfo, wxKey }) {
  const KIOSK_TOKEN = process.env.KIOSK_TOKEN || ''
  const ADMIN_TOKEN = process.env.ADMIN_TOKEN || KIOSK_TOKEN
  const GEMINI_KEY = process.env.GEMINI_API_KEY || ''
  const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest'
  const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'   // override only for tests

  const PHOTO_DIR = resolve(dataDir, 'photos')
  const BUILD_DIR = resolve(PHOTO_DIR, 'build')        // Home mode: photos of the house going up
  try { mkdirSync(BUILD_DIR, { recursive: true }) } catch {}
  const albumDir = url => url.searchParams.get('album') === 'build' ? BUILD_DIR : PHOTO_DIR

  const authorized = req => KIOSK_TOKEN && (safeEqual(req.headers['x-kiosk-token'], KIOSK_TOKEN) || safeEqual(cookie(req, 'kiosk'), KIOSK_TOKEN))
  const isAdmin = req => ADMIN_TOKEN && (safeEqual(req.headers['x-admin-token'], ADMIN_TOKEN) || safeEqual(cookie(req, 'kiosk'), ADMIN_TOKEN))
  const household = createHousehold({ dataDir, authorized, isAdmin, send, readBody })

  // ── Ship's log: moving ships that passed the MOC ──────────────────────────
  const PASSES_PATH = resolve(dataDir, 'passes.json')
  let passes = []
  try { passes = JSON.parse(readFileSync(PASSES_PATH, 'utf8')) } catch {}
  let passFlush = null
  function savePasses() {
    if (passFlush) return
    passFlush = setTimeout(() => {
      passFlush = null
      try { writeFileSync(PASSES_PATH, JSON.stringify(passes), 'utf8') } catch (e) { console.error('[Dash] passes save failed', e.message) }
    }, 3000)
  }

  function recordPass(mmsi, { heading = 0, speed = 0 } = {}) {
    if (!(speed >= 1 && speed < 102.2)) return     // 102.3 kn = AIS "not available"
    const t = now()
    // ignore duplicates for the same ship within 2 hours
    if (passes.some(p => p.mmsi === mmsi && t - p.at < 2 * 3600 * 1000)) return
    const info = vesselInfo(mmsi)
    const downbound = heading > 90 && heading < 270
    passes.push({
      mmsi,
      at: t,
      name: info.name || `MMSI ${mmsi}`,
      direction: downbound ? 'downbound' : 'upbound',
      speed: Math.round(speed * 10) / 10,
      photo: info.photo,
      operator: info.operator,
      destination: info.destinations?.length ? info.destinations[info.destinations.length - 1] : undefined,
    })
    const cutoff = t - 14 * 24 * 3600 * 1000
    passes = passes.filter(p => p.at >= cutoff)
    savePasses()
  }

  // ── Coming up: ships headed toward her window, with an ETA ────────────────
  function upcoming() {
    const t = now()
    const out = []
    for (const [mmsi, v] of Object.entries(vesselCache)) {
      if (!v.lastSeen || t - v.lastSeen > 20 * 60 * 1000) continue
      const { lastLat: lat, lastLon: lon, lastSpeed: sog = 0, lastHeading: hdg = 0 } = v
      if (lat == null || lon == null || sog < 3 || sog >= 102.2) continue   // anchored / docked / drifting / speed unknown
      if (lon < -82.75 || lon > -82.2) continue                     // stay on the St. Clair / lower Huron line
      const southbound = hdg > 90 && hdg < 270
      let km
      if (southbound && lat > WINDOW_ZONE.north) km = (lat - WINDOW_ZONE.north) * 111
      else if (!southbound && lat < WINDOW_ZONE.south) km = (WINDOW_ZONE.south - lat) * 111
      else continue
      const minutes = Math.round((km / (sog * 1.852)) * 60)
      if (minutes > 180) continue
      const info = vesselInfo(mmsi)
      out.push({
        mmsi,
        name: info.name || `MMSI ${mmsi}`,
        direction: southbound ? 'downbound' : 'upbound',
        etaMinutes: minutes,
        speed: Math.round(sog * 10) / 10,
        photo: info.photo,
        operator: info.operator,
      })
    }
    return out.sort((a, b) => a.etaMinutes - b.etaMinutes).slice(0, 6)
  }

  // ── Conditions: forecast, sun, river level + flow ─────────────────────────
  const getForecast = cached(30 * 60 * 1000, async () => {
    if (!wxKey) return null
    const [cur, fc] = await Promise.all([
      getJSON(`https://api.openweathermap.org/data/2.5/weather?lat=${MOC.lat}&lon=${MOC.lon}&units=imperial&appid=${wxKey}`),
      getJSON(`https://api.openweathermap.org/data/2.5/forecast?lat=${MOC.lat}&lon=${MOC.lon}&units=imperial&cnt=16&appid=${wxKey}`),
    ])
    return {
      sunrise: cur.sys?.sunrise ? cur.sys.sunrise * 1000 : null,
      sunset: cur.sys?.sunset ? cur.sys.sunset * 1000 : null,
      current: {
        tempF: Math.round(cur.main?.temp), feelsLikeF: Math.round(cur.main?.feels_like),
        windMph: Math.round(cur.wind?.speed), gustMph: cur.wind?.gust ? Math.round(cur.wind.gust) : null,
        windDir: degToCompass(cur.wind?.deg), description: cur.weather?.[0]?.description, icon: cur.weather?.[0]?.icon,
      },
      periods: (fc.list || []).filter((_, i) => i % 2 === 0).slice(0, 4).map(p => ({
        at: p.dt * 1000, tempF: Math.round(p.main.temp), icon: p.weather?.[0]?.icon,
        description: p.weather?.[0]?.description, windMph: Math.round(p.wind?.speed), pop: Math.round((p.pop || 0) * 100),
      })),
    }
  })

  const getRiver = cached(15 * 60 * 1000, async () => {
    const [lvl, flow] = await Promise.allSettled([
      getJSON(`https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?station=${NOAA_STATION}&product=water_level&datum=IGLD&units=english&time_zone=gmt&format=json&range=25&application=stclair_kiosk`),
      getJSON(`https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${USGS_SITE}&parameterCd=00060&siteStatus=all`),
    ])
    const out = {}
    if (lvl.status === 'fulfilled' && lvl.value.data?.length) {
      const d = lvl.value.data.filter(x => x.v !== '')
      const last = d[d.length - 1], first = d[0]
      out.levelFt = Number(last.v)
      out.levelAt = Date.parse(last.t.replace(' ', 'T') + 'Z')
      out.change24hIn = Math.round((Number(last.v) - Number(first.v)) * 12 * 10) / 10
    }
    if (flow.status === 'fulfilled') {
      const v = flow.value.value?.timeSeries?.[0]?.values?.[0]?.value?.slice(-1)?.[0]
      if (v) out.flowCfs = Number(v.value)
    }
    return out
  })

  // ── Blue Water Bridge (into the U.S.) ─────────────────────────────────────
  const getBridge = cached(10 * 60 * 1000, async () => {
    const all = await getJSON('https://bwt.cbp.gov/api/bwtnew')
    const p = all.find(x => x.port_number === CBP_PORT)
    if (!p) return null
    const lane = l => (l && l.operational_status && l.operational_status !== 'N/A')
      ? { status: l.operational_status, minutes: l.delay_minutes === '' ? null : Number(l.delay_minutes), lanes: l.lanes_open === '' ? null : Number(l.lanes_open), updated: l.update_time }
      : null
    return {
      name: `${p.port_name} – ${p.crossing_name}`,
      portStatus: p.port_status,
      cars: lane(p.passenger_vehicle_lanes?.standard_lanes),
      nexus: lane(p.passenger_vehicle_lanes?.NEXUS_SENTRI_lanes),
      trucks: lane(p.commercial_vehicle_lanes?.standard_lanes),
    }
  })

  // ── Calendar (private) ────────────────────────────────────────────────────
  const calCache = new Map()
  function getCalendarRaw(link) {
    if (!calCache.has(link)) {
      calCache.set(link, cached(10 * 60 * 1000, async () => {
        const r = await fetch(link, { headers: { 'User-Agent': 'stclair-kiosk/1.0' } })
        if (!r.ok) throw new Error(`calendar ${r.status}`)
        return ical.sync.parseICS(await r.text())
      }))
    }
    return calCache.get(link)()
  }

  async function calendar(from, to, mode = 'office') {
    const links = household.calendarUrls(mode)
    const results = await Promise.allSettled(links.map(getCalendarRaw))
    if (links.length && results.every(r => r.status === 'rejected')) throw results[0].reason
    const events = results.flatMap(r => r.status === 'fulfilled' ? Object.values(r.value) : [])
    const out = []
    for (const ev of events) {
      if (ev.type !== 'VEVENT' || ev.status === 'CANCELLED') continue
      let instances = []
      try { instances = ical.expandRecurringEvent(ev, { from, to, expandOngoing: true }) } catch { continue }
      for (const i of instances) {
        const allDay = !!i.isFullDay
        out.push({
          title: String(i.summary?.val ?? i.summary ?? 'Busy'),
          allDay,
          start: allDay ? localDateKey(i.start) : new Date(i.start).getTime(),
          end: allDay ? localDateKey(i.end || i.start) : new Date(i.end || i.start).getTime(),
          location: ev.location ? String(ev.location.val ?? ev.location) : undefined,
        })
      }
    }
    out.sort((a, b) => sortKey(a) - sortKey(b))
    return out.slice(0, 25)
  }
  const localDateKey = d => {
    const x = new Date(d)
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  }
  const sortKey = e => e.allDay ? Date.parse(e.start + 'T00:00:00') - 1 : e.start

  // ── Family photos (private) ───────────────────────────────────────────────
  const PHOTO_RE = /^[a-z0-9][a-z0-9._-]{0,80}\.(jpe?g|png|webp)$/i
  function listPhotos(dir = PHOTO_DIR) {
    try {
      const list = readdirSync(dir).filter(f => PHOTO_RE.test(f))
        .map(f => ({ name: f, at: statSync(resolve(dir, f)).mtimeMs }))
      // build photos are named YYYY-MM-DD-… (date taken) → oldest first, as a timeline
      return dir === BUILD_DIR ? list.sort((a, b) => a.name.localeCompare(b.name)) : list.sort((a, b) => b.at - a.at)
    } catch { return [] }
  }

  // ── Ask the Captain (private, Gemini paid tier) ───────────────────────────
  const askLog = []   // timestamps only, for rate limiting — questions and audio are never stored
  async function ask({ audio, mime, text, mode }) {
    const home = mode === 'home'
    const t = now()
    while (askLog.length && t - askLog[0] > 3600 * 1000) askLog.shift()
    if (askLog.length >= 40) throw Object.assign(new Error('Too many questions this hour — try again later.'), { status: 429 })
    askLog.push(t)

    const [cond, river, bridge] = await Promise.allSettled([getForecast(), getRiver(), getBridge()])
    const inRiver = Object.entries(vesselCache)
      .filter(([, v]) => v.lastSeen && t - v.lastSeen < 20 * 60 * 1000 && v.lastLat > 42.85 && v.lastLat < 43.1 && v.lastLon > -82.6 && v.lastLon < -82.3)
      .map(([mmsi, v]) => {
        const i = vesselInfo(mmsi)
        const distKm = Math.hypot((v.lastLat - MOC.lat) * 111, (v.lastLon - MOC.lon) * 81.4)
        return {
          name: i.name || `MMSI ${mmsi}`, operator: i.operator, built: i.yearBuilt, length: i.lengthDetail || (i.length ? `${i.length} m` : undefined),
          capacity: i.capacity, formerNames: i.formerNames, destination: i.destinations?.slice(-1)[0],
          speedKn: v.lastSpeed, heading: v.lastHeading, distanceFromWindowKm: Math.round(distKm * 10) / 10,
          note: i.note ? String(i.note).slice(0, 240) : undefined,
        }
      })
      .sort((a, b) => a.distanceFromWindowKm - b.distanceFromWindowKm).slice(0, 12)

    const context = {
      localTime: new Date().toLocaleString('en-US', { timeZone: 'America/Detroit', dateStyle: 'full', timeStyle: 'short' }),
      shipsOnTheRiverNow: inRiver,
      comingUp: upcoming(),
      passedTheWindowToday: passes.filter(p => t - p.at < 24 * 3600 * 1000).map(p => ({ name: p.name, direction: p.direction, at: new Date(p.at).toLocaleTimeString('en-US', { timeZone: 'America/Detroit', timeStyle: 'short' }) })),
      weather: cond.status === 'fulfilled' ? cond.value : undefined,
      river: river.status === 'fulfilled' ? river.value : undefined,
      blueWaterBridge: bridge.status === 'fulfilled' ? bridge.value : undefined,
      household: home ? household.askContext() : undefined,
    }

    const system = [
      home
        ? 'You are "the Captain", a friendly, knowledgeable voice assistant on a ship-tracking dashboard in her home in Port Huron, Michigan, near the St. Clair River and the Blue Water Bridge. "The window" in the data means the stretch of river by the city offices downtown. You also know her grocery list, to-do list, trash days and move-in date (in "household").'
        : 'You are "the Captain", a friendly, knowledgeable voice assistant on a ship-tracking dashboard in an office window overlooking the St. Clair River at Port Huron, Michigan (the Municipal Office Center, across from Sarnia, just south of the Blue Water Bridge).',
      'Answers are read aloud, so keep them short (1–3 sentences, under 60 words), conversational, with no lists, markdown, emoji or URLs.',
      'For questions about ships, the river, weather or the bridge, use the live data below; say plainly when the data does not cover something. You can also answer general questions.',
      'Distances: speak in miles or feet. Times: Eastern time.',
      'Live data (JSON): ' + JSON.stringify(context),
    ].join('\n')

    const parts = []
    if (audio) parts.push({ inline_data: { mime_type: mime || 'audio/wav', data: audio } })
    parts.push({ text: audio ? 'Answer the spoken question in the audio above.' : String(text || '').slice(0, 500) })

    const r = await fetch(`${GEMINI_BASE}/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        // Never keep this request in the project's AI Studio logs. New projects
        // log generateContent calls by default; a request-level store:false
        // overrides the project setting. Jazmyn's questions stay private —
        // not visible to the key owner, not stored by this server either.
        store: false,
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: {
          temperature: 0.6,
          maxOutputTokens: 2048,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            properties: { heard: { type: 'STRING', description: 'What the person asked, as a short transcript' }, answer: { type: 'STRING' } },
            required: ['heard', 'answer'],
          },
        },
      }),
    })
    if (!r.ok) {
      // Log the status only — never the question, the audio or Gemini's reply
      console.error('[Ask] Gemini error', r.status)
      throw Object.assign(new Error('The Captain could not be reached.'), { status: 502 })
    }
    const j = await r.json()
    const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''
    try { return JSON.parse(txt) } catch { return { heard: '', answer: txt.trim() || 'Sorry, I did not catch that.' } }
  }

  // ── Router ────────────────────────────────────────────────────────────────
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x')
    const path = url.pathname

    try {
      const h = await household.handle(req, res, url, path)
      if (h !== false) return h

      if (req.method === 'GET' && path === '/dash/status') {
        return send(res, 200, {
          unlocked: !!authorized(req),
          defaultMode: household.settings().defaultMode,
          features: {
            calendar: !!KIOSK_TOKEN && household.calendarUrls('office').length > 0,
            homeCalendar: !!KIOSK_TOKEN && household.calendarUrls('home').length > 0,
            photos: !!KIOSK_TOKEN,
            ask: !!GEMINI_KEY && !!KIOSK_TOKEN,
            privateKeySet: !!KIOSK_TOKEN,
          },
        })
      }
      if (req.method === 'GET' && path === '/dash/log') {
        const since = Number(url.searchParams.get('since')) || now() - 24 * 3600 * 1000
        return send(res, 200, passes.filter(p => p.at >= since && p.speed < 102.2).sort((a, b) => b.at - a.at).slice(0, 20))
      }
      if (req.method === 'GET' && path === '/dash/upcoming') return send(res, 200, upcoming())
      if (req.method === 'GET' && path === '/dash/conditions') {
        const [f, r] = await Promise.allSettled([getForecast(), getRiver()])
        return send(res, 200, { weather: f.status === 'fulfilled' ? f.value : null, river: r.status === 'fulfilled' ? r.value : null })
      }
      if (req.method === 'GET' && path === '/dash/bridge') return send(res, 200, await getBridge().catch(() => null))

      // ---- private below ----
      if (path.startsWith('/dash/calendar') || path.startsWith('/dash/photos') || path === '/dash/ask') {
        if (!KIOSK_TOKEN) return send(res, 403, { error: 'Private panels are off (no KIOSK_TOKEN set).' })
        if (!authorized(req)) return send(res, 401, { error: 'This device is not unlocked.' })
      }
      if (req.method === 'GET' && path === '/dash/calendar') {
        const mode = url.searchParams.get('mode') === 'home' ? 'home' : 'office'
        if (!household.calendarUrls(mode).length) return send(res, 404, { error: 'No calendar connected.' })
        const from = new Date(Number(url.searchParams.get('from')) || now())
        const to = new Date(Number(url.searchParams.get('to')) || now() + 3 * 24 * 3600 * 1000)
        return send(res, 200, await calendar(from, to, mode))
      }
      if (req.method === 'GET' && path === '/dash/photos') return send(res, 200, listPhotos(albumDir(url)).map(p => p.name))
      if (req.method === 'GET' && path.startsWith('/dash/photos/')) {
        const name = basename(decodeURIComponent(path.slice('/dash/photos/'.length)))
        const file = resolve(albumDir(url), name)
        if (!PHOTO_RE.test(name) || !existsSync(file)) return send(res, 404, { error: 'not found' })
        res.writeHead(200, { 'Content-Type': name.endsWith('.png') ? 'image/png' : name.endsWith('.webp') ? 'image/webp' : 'image/jpeg', 'Cache-Control': 'private, max-age=86400' })
        return createReadStream(file).pipe(res)
      }
      if (req.method === 'POST' && path === '/dash/ask') {
        if (!GEMINI_KEY) return send(res, 503, { error: 'Ask the Captain is not set up yet.' })
        const body = JSON.parse((await readBody(req, 6 * 1024 * 1024)).toString('utf8') || '{}')
        if (!body.audio && !body.text) return send(res, 400, { error: 'Nothing to answer.' })
        try { return send(res, 200, await ask(body)) }
        catch (e) { return send(res, e.status || 500, { error: e.message }) }
      }

      // ---- photo admin (upload / delete) ----
      if (path === '/admin' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        return res.end(ADMIN_HTML)
      }
      if (path.startsWith('/admin/photos')) {
        if (!ADMIN_TOKEN) return send(res, 403, { error: 'No ADMIN_TOKEN / KIOSK_TOKEN set.' })
        if (!isAdmin(req)) return send(res, 401, { error: 'Wrong key.' })
        const dir = albumDir(url)
        if (req.method === 'GET') return send(res, 200, listPhotos(dir))
        const name = basename(decodeURIComponent(path.slice('/admin/photos/'.length)))
        if (!PHOTO_RE.test(name)) return send(res, 400, { error: 'Bad file name.' })
        const file = resolve(dir, name)
        if (req.method === 'PUT') {
          const buf = await readBody(req, 8 * 1024 * 1024)
          if (listPhotos(dir).length >= 300) return send(res, 400, { error: 'Photo limit reached (300).' })
          writeFileSync(file, buf)
          return send(res, 200, { ok: true })
        }
        if (req.method === 'DELETE') { try { unlinkSync(file) } catch {} ; return send(res, 200, { ok: true }) }
      }
    } catch (e) {
      console.error('[Dash]', path, e.message)
      return send(res, 500, { error: 'Something went wrong.' })
    }
    return false   // not handled
  }

  // expose for the AIS handler
  handle.recordPass = recordPass
  handle.upcoming = upcoming
  return handle
}

const ADMIN_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kiosk admin</title><style>
body{font-family:Georgia,serif;background:#f4ecd2;color:#1a2e3a;max-width:780px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.5rem}h2{font-size:1.1rem;margin:1.8rem 0 .4rem;border-bottom:1px solid #c9a54a;padding-bottom:.2rem}
input,button,select,textarea{font:inherit;padding:.35rem .6rem}textarea{width:100%;min-height:3.2rem;font-size:.8rem;font-family:monospace}
label{display:block;margin:.55rem 0 .15rem;font-weight:700;font-size:.9rem}.row{display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}
#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-top:1rem}
#grid div{position:relative;font-size:.75rem}#grid img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:4px}#grid button{position:absolute;top:4px;right:4px;padding:0 .4rem}
.muted{color:#5a4a2a;font-size:.88rem}.seg button{border:1px solid #8b6914;background:#fff8e6}.seg button.on{background:#1a2e3a;color:#f4ecd2}
.box{background:#fff8e6;border:1px solid #d8c48f;border-radius:6px;padding:.4rem 1rem 1rem}</style></head><body>
<h1>⚓ Kiosk admin</h1>
<p><input id="key" type="password" placeholder="Admin key"> <button id="use">Use key</button> <span id="who" class="muted"></span></p>

<h2>Dashboard mode</h2>
<div class="box">
<p class="muted">Office mode: ship's log, bridge waits, her work calendar. Home mode: trash day, move-in countdown, grocery &amp; to-do list, build photos, household calendar.
Every unlocked device uses this default. One device can be switched by opening the site once with <code>?mode=home</code> or <code>?mode=office</code> (<code>?mode=auto</code> goes back to the default).</p>
<label>Default mode</label><select id="defaultMode"><option value="office">Office</option><option value="home">Home</option></select>

<label>Home location (for the map pin)</label>
<div class="row"><input id="lat" placeholder="Latitude" size="12"> <input id="lon" placeholder="Longitude" size="12"> <input id="label" placeholder="Label" size="10"></div>
<p class="muted">Use the county GIS parcel coordinates — map apps can put new streets in the wrong place. Kept on the server only, shown only on unlocked devices.</p>

<label>Move-in date</label><input id="moveIn" type="date">

<label>Trash pickup day</label>
<div class="row"><select id="trashDay"></select> <span class="muted">Recycling:</span> <select id="recyclingDay"></select>
<select id="every"><option value="1">every week</option><option value="2">every other week</option></select></div>
<div class="row" id="anchorRow"><span class="muted">One recycling date (to know which weeks):</span> <input id="anchor" type="date"></div>
<label class="row" style="font-weight:400"><input id="holiday" type="checkbox" checked> Holiday weeks: pickup is a day late after a weekday holiday</label>
<p class="muted">Check her day with the city / WM once the house has an address in their system.</p>

<label>Office calendar links</label><textarea id="calOffice" placeholder="One Google Calendar &quot;secret address in iCal format&quot; per line"></textarea>
<label>Home calendar links</label><textarea id="calHome" placeholder="One per line"></textarea>
<p class="muted">If the office box is empty, the CALENDAR_ICS_URL variable on Railway is used.</p>
<p><button id="saveSettings">Save settings</button> <span id="smsg" class="muted"></span></p>
</div>

<h2>Photos</h2>
<div class="box">
<div class="row seg"><button data-a="" class="on">Family photos</button><button data-a="build">Build photos</button></div>
<p class="muted" id="ahelp"></p>
<div class="row" id="dateRow"><span class="muted">Taken on (blank = the photo's own date):</span> <input id="taken" type="date"></div>
<p><input id="files" type="file" accept="image/*" multiple> <span id="msg" class="muted"></span></p>
<div id="grid"></div>
</div>

<h2>Grocery &amp; to-do list</h2>
<p class="muted">On her phone: open <code>/list?k=&lt;kiosk key&gt;</code> once, then "Add to Home Screen".</p>
<script>
var $=function(s){return document.querySelector(s)},key=localStorage.getItem('adminKey')||'',album='';
var days=['—','Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
['#trashDay','#recyclingDay'].forEach(function(id){days.forEach(function(d,i){var o=document.createElement('option');o.value=i?i-1:'';o.textContent=d;$(id).append(o)})});
$('#key').value=key;
$('#use').onclick=function(){key=$('#key').value.trim();localStorage.setItem('adminKey',key);loadAll()};
function api(p,o){o=o||{};o.headers=Object.assign({},o.headers||{},{'x-admin-token':key});return fetch(p,o).then(function(r){if(!r.ok)return r.json().catch(function(){return{}}).then(function(j){throw new Error(j.error||r.status)});return r})}
function v(id){return $(id).value}
function showAnchor(){$('#anchorRow').style.display=v('#every')==='2'?'':'none'}$('#every').onchange=showAnchor;
function loadSettings(){return api('/admin/settings').then(function(r){return r.json()}).then(function(s){
$('#defaultMode').value=s.defaultMode;$('#lat').value=s.home.lat==null?'':s.home.lat;$('#lon').value=s.home.lon==null?'':s.home.lon;$('#label').value=s.home.label||'Home';
$('#moveIn').value=s.moveIn||'';$('#trashDay').value=s.trash.trashDay==null?'':s.trash.trashDay;$('#recyclingDay').value=s.trash.recyclingDay==null?'':s.trash.recyclingDay;
$('#every').value=String(s.trash.recyclingEveryWeeks||1);$('#anchor').value=s.trash.recyclingAnchor||'';$('#holiday').checked=s.trash.holidayDelay!==false;
$('#calOffice').value=(s.calendars.office||[]).join('\\n');$('#calHome').value=(s.calendars.home||[]).join('\\n');showAnchor();
document.cookie='kiosk='+encodeURIComponent(key)+';path=/;max-age=31536000;SameSite=Strict;Secure';$('#who').textContent='Key OK'})}
$('#saveSettings').onclick=function(){var body={defaultMode:v('#defaultMode'),home:{lat:v('#lat'),lon:v('#lon'),label:v('#label')},moveIn:v('#moveIn')||null,
trash:{trashDay:v('#trashDay'),recyclingDay:v('#recyclingDay'),recyclingEveryWeeks:Number(v('#every')),recyclingAnchor:v('#anchor')||null,holidayDelay:$('#holiday').checked},
calendars:{office:v('#calOffice').split('\\n'),home:v('#calHome').split('\\n')}};
api('/admin/settings',{method:'PUT',body:JSON.stringify(body)}).then(function(){$('#smsg').textContent='Saved.';return loadSettings()}).catch(function(e){$('#smsg').textContent=e.message})};
function q(){return album?'?album='+album:''}
function setAlbum(a){album=a;document.querySelectorAll('.seg button').forEach(function(b){b.className=b.dataset.a===a?'on':''});
$('#dateRow').style.display=a?'':'none';$('#ahelp').textContent=a?'Photos of the house going up. They show as a timeline in Home mode, oldest first.':'Shown in the photo card on both Office and Home mode.';loadPhotos()}
document.querySelectorAll('.seg button').forEach(function(b){b.onclick=function(){setAlbum(b.dataset.a)}});
function loadPhotos(){if(!key)return Promise.resolve();return api('/admin/photos'+q()).then(function(r){return r.json()}).then(function(list){$('#grid').innerHTML='';list.forEach(function(p){var d=document.createElement('div');
var i=document.createElement('img');i.src='/dash/photos/'+encodeURIComponent(p.name)+q();var b=document.createElement('button');b.textContent='×';
b.onclick=function(){api('/admin/photos/'+encodeURIComponent(p.name)+q(),{method:'DELETE'}).then(loadPhotos)};d.append(i,b);
if(album){var c=document.createElement('div');c.textContent=p.name.slice(0,10);d.append(c)}$('#grid').append(d)});$('#msg').textContent=list.length+' photos'}).catch(function(e){$('#msg').textContent=e.message})}
function ymd(t){var d=new Date(t);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
$('#files').onchange=async function(e){var fs=[].slice.call(e.target.files),n=0;for(var f of fs){$('#msg').textContent='Uploading '+(++n)+'/'+fs.length+'…';
var bmp=await createImageBitmap(f);var s=Math.min(1,1600/Math.max(bmp.width,bmp.height));var c=new OffscreenCanvas(Math.round(bmp.width*s),Math.round(bmp.height*s));
c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);var blob=await c.convertToBlob({type:'image/jpeg',quality:.82});
var base=(Date.now()+'-'+f.name.split('.').slice(0,-1).join('.')).toLowerCase().replace(/[^a-z0-9._-]+/g,'-').slice(0,50);
var name=(album?(v('#taken')||ymd(f.lastModified))+'-':'')+base+'.jpg';
await api('/admin/photos/'+encodeURIComponent(name)+q(),{method:'PUT',body:blob})}e.target.value='';loadPhotos()};
function loadAll(){loadSettings().then(function(){setAlbum(album)}).catch(function(e){$('#who').textContent=e.message})}
setAlbum('');if(key)loadAll();
</script></body></html>`
