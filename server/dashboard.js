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
 *   CALENDAR_ICS_URL   Google Calendar "secret address in iCal format"
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
  const CAL_URL = process.env.CALENDAR_ICS_URL || ''
  const GEMINI_KEY = process.env.GEMINI_API_KEY || ''
  const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest'
  const GEMINI_BASE = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com'   // override only for tests

  const PHOTO_DIR = resolve(dataDir, 'photos')
  try { mkdirSync(PHOTO_DIR, { recursive: true }) } catch {}

  const authorized = req => KIOSK_TOKEN && (safeEqual(req.headers['x-kiosk-token'], KIOSK_TOKEN) || safeEqual(cookie(req, 'kiosk'), KIOSK_TOKEN))
  const isAdmin = req => ADMIN_TOKEN && (safeEqual(req.headers['x-admin-token'], ADMIN_TOKEN) || safeEqual(cookie(req, 'kiosk'), ADMIN_TOKEN))

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
  const getCalendarRaw = cached(10 * 60 * 1000, async () => {
    const r = await fetch(CAL_URL, { headers: { 'User-Agent': 'stclair-kiosk/1.0' } })
    if (!r.ok) throw new Error(`calendar ${r.status}`)
    return ical.sync.parseICS(await r.text())
  })

  async function calendar(from, to) {
    const data = await getCalendarRaw()
    const out = []
    for (const ev of Object.values(data)) {
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
  function listPhotos() {
    try {
      return readdirSync(PHOTO_DIR).filter(f => PHOTO_RE.test(f))
        .map(f => ({ name: f, at: statSync(resolve(PHOTO_DIR, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
    } catch { return [] }
  }

  // ── Ask the Captain (private, Gemini paid tier) ───────────────────────────
  const askLog = []   // timestamps only, for rate limiting — questions and audio are never stored
  async function ask({ audio, mime, text }) {
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
    }

    const system = [
      'You are "the Captain", a friendly, knowledgeable voice assistant on a ship-tracking dashboard in an office window overlooking the St. Clair River at Port Huron, Michigan (the Municipal Office Center, across from Sarnia, just south of the Blue Water Bridge).',
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
      if (req.method === 'GET' && path === '/dash/status') {
        return send(res, 200, {
          unlocked: !!authorized(req),
          features: {
            calendar: !!CAL_URL && !!KIOSK_TOKEN,
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
        if (!CAL_URL) return send(res, 404, { error: 'No calendar connected.' })
        const from = new Date(Number(url.searchParams.get('from')) || now())
        const to = new Date(Number(url.searchParams.get('to')) || now() + 3 * 24 * 3600 * 1000)
        return send(res, 200, await calendar(from, to))
      }
      if (req.method === 'GET' && path === '/dash/photos') return send(res, 200, listPhotos().map(p => p.name))
      if (req.method === 'GET' && path.startsWith('/dash/photos/')) {
        const name = basename(decodeURIComponent(path.slice('/dash/photos/'.length)))
        const file = resolve(PHOTO_DIR, name)
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
        if (req.method === 'GET') return send(res, 200, listPhotos())
        const name = basename(decodeURIComponent(path.slice('/admin/photos/'.length)))
        if (!PHOTO_RE.test(name)) return send(res, 400, { error: 'Bad file name.' })
        const file = resolve(PHOTO_DIR, name)
        if (req.method === 'PUT') {
          const buf = await readBody(req, 8 * 1024 * 1024)
          if (listPhotos().length >= 300) return send(res, 400, { error: 'Photo limit reached (300).' })
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
<title>Kiosk photos</title><style>
body{font-family:Georgia,serif;background:#f4ecd2;color:#1a2e3a;max-width:760px;margin:2rem auto;padding:0 1rem}
h1{font-size:1.5rem}input,button{font:inherit;padding:.4rem .7rem}#grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;margin-top:1rem}
#grid div{position:relative}#grid img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:4px}#grid button{position:absolute;top:4px;right:4px;padding:0 .4rem}
.muted{color:#5a4a2a;font-size:.9rem}</style></head><body>
<h1>Family photos for the kiosk</h1>
<p class="muted">Photos are resized on this device before upload and stored only on your Railway volume. They show only on unlocked devices.</p>
<p><input id="key" type="password" placeholder="Admin key"> <button id="save">Use key</button></p>
<p><input id="files" type="file" accept="image/*" multiple> <span id="msg" class="muted"></span></p>
<div id="grid"></div>
<script>
const $=s=>document.querySelector(s);let key=localStorage.getItem('adminKey')||'';$('#key').value=key;
$('#save').onclick=()=>{key=$('#key').value.trim();localStorage.setItem('adminKey',key);load()};
async function api(p,o={}){o.headers={...(o.headers||{}),'x-admin-token':key};const r=await fetch(p,o);if(!r.ok)throw new Error((await r.json().catch(()=>({}))).error||r.status);return r}
async function load(){try{const list=await (await api('/admin/photos')).json();$('#grid').innerHTML='';for(const p of list){const d=document.createElement('div');
const i=document.createElement('img');i.src='/dash/photos/'+encodeURIComponent(p.name);const b=document.createElement('button');b.textContent='×';
b.onclick=async()=>{await api('/admin/photos/'+encodeURIComponent(p.name),{method:'DELETE'});load()};d.append(i,b);$('#grid').append(d)}
document.cookie='kiosk='+encodeURIComponent(key)+';path=/;max-age=31536000;SameSite=Strict;Secure';$('#msg').textContent=list.length+' photos'}catch(e){$('#msg').textContent=e.message}}
$('#files').onchange=async e=>{const fs=[...e.target.files];let n=0;for(const f of fs){$('#msg').textContent='Uploading '+(++n)+'/'+fs.length+'…';
const bmp=await createImageBitmap(f);const s=Math.min(1,1600/Math.max(bmp.width,bmp.height));const c=new OffscreenCanvas(Math.round(bmp.width*s),Math.round(bmp.height*s));
c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);const blob=await c.convertToBlob({type:'image/jpeg',quality:.82});
const name=(Date.now()+'-'+f.name.replace(/\\.[^.]+$/,'')).toLowerCase().replace(/[^a-z0-9._-]+/g,'-').slice(0,60)+'.jpg';
await api('/admin/photos/'+encodeURIComponent(name),{method:'PUT',body:blob})}load()};
if(key)load();
</script></body></html>`
