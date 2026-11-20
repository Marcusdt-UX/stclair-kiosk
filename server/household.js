/**
 * Household panels for the kiosk's Home mode (all private — kiosk key needed).
 *
 *   settings.json  on the volume: default mode, home location, move-in date,
 *                  trash/recycling days, calendar links. Edited at /admin.
 *                  Nothing personal (address, coordinates, calendar links)
 *                  lives in this repo — the repo is public.
 *   lists.json     grocery + to-do list, editable on the tablet and at /list
 *                  on her phone.
 *
 * Trash: Port Huron's rule is that a weekday holiday pushes that day's
 * pickup and every later pickup that week back one day (Friday → Saturday).
 */

import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { randomBytes } from 'crypto'

const DAY = 24 * 3600 * 1000

export const DEFAULT_SETTINGS = {
  defaultMode: 'office',                 // 'office' | 'home'
  home: { lat: null, lon: null, label: 'Home' },
  moveIn: null,                          // 'YYYY-MM-DD'
  trash: {
    trashDay: null,                      // 0 = Sunday … 6 = Saturday
    recyclingDay: null,
    recyclingEveryWeeks: 1,              // 1 = weekly, 2 = every other week
    recyclingAnchor: null,               // 'YYYY-MM-DD' of any recycling pickup (for every-other-week)
    holidayDelay: true,
  },
  calendars: { office: [], home: [] },   // Google "secret address in iCal format" links
}

// ── local-date helpers (process.env.TZ is America/Detroit) ──────────────────
export const dateKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const parseKey = k => { const [y, m, d] = String(k).split('-').map(Number); return new Date(y, m - 1, d) }
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x }
const startOfDay = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }
const mondayOf = d => addDays(startOfDay(d), -((d.getDay() + 6) % 7))
const nthWeekday = (y, m, wd, n) => { const d = new Date(y, m, 1); d.setDate(1 + ((wd - d.getDay() + 7) % 7) + (n - 1) * 7); return d }
const lastWeekday = (y, m, wd) => { const d = new Date(y, m + 1, 0); d.setDate(d.getDate() - ((d.getDay() - wd + 7) % 7)); return d }

/** Observed holidays that delay pickup (WM / City of Port Huron list) */
export function holidays(year) {
  return [
    new Date(year, 0, 1),            // New Year's Day
    lastWeekday(year, 4, 1),         // Memorial Day
    new Date(year, 6, 4),            // Independence Day
    nthWeekday(year, 8, 1, 1),       // Labor Day
    nthWeekday(year, 10, 4, 4),      // Thanksgiving
    new Date(year, 11, 25),          // Christmas
  ].map(dateKey)
}

/** Next pickup on or after `from` for a weekly (or every-N-weeks) service day */
export function nextPickup(from, weekday, { everyWeeks = 1, anchor = null, holidayDelay = true } = {}) {
  if (weekday == null || weekday === '') return null
  const wd = Number(weekday)
  const today = startOfDay(from)
  const anchorMon = anchor ? mondayOf(parseKey(anchor)) : null
  for (let w = -1; w < 6; w++) {
    const mon = addDays(mondayOf(today), w * 7)
    if (everyWeeks > 1 && anchorMon) {
      const weeks = Math.round((mon - anchorMon) / (7 * DAY))
      if (((weeks % everyWeeks) + everyWeeks) % everyWeeks !== 0) continue
    }
    let day = addDays(mon, (wd + 6) % 7)
    let shifted = false
    if (holidayDelay) {
      const hs = new Set([...holidays(mon.getFullYear()), ...holidays(mon.getFullYear() + 1)])
      for (let i = 0; i < 5; i++) {                       // Mon–Fri holidays only
        const h = addDays(mon, i)
        if (hs.has(dateKey(h)) && h <= day) { shifted = true; break }
      }
      if (shifted) day = addDays(day, 1)
    }
    if (day >= today) return { date: dateKey(day), shifted }
  }
  return null
}

export function createHousehold({ dataDir, authorized, isAdmin, send, readBody }) {
  const SETTINGS_PATH = resolve(dataDir, 'settings.json')
  const LIST_PATH = resolve(dataDir, 'lists.json')

  let settings = structuredClone(DEFAULT_SETTINGS)
  try { settings = merge(settings, JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'))) } catch {}
  let items = []
  try { items = JSON.parse(readFileSync(LIST_PATH, 'utf8')) } catch {}

  function merge(base, over) {
    const out = { ...base }
    for (const [k, v] of Object.entries(over || {})) {
      out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) ? merge(base[k], v) : v
    }
    return out
  }

  function cleanSettings(s) {
    const num = (v, lo, hi) => (v === '' || v == null || isNaN(Number(v)) || Number(v) < lo || Number(v) > hi) ? null : Number(v)
    const date = v => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null
    const urls = a => (Array.isArray(a) ? a : String(a || '').split(/\s+/))
      .map(u => String(u).trim()).filter(u => /^(https|webcal):\/\//i.test(u)).map(u => u.replace(/^webcal:/i, 'https:')).slice(0, 5)
    return {
      defaultMode: s.defaultMode === 'home' ? 'home' : 'office',
      home: { lat: num(s.home?.lat, -90, 90), lon: num(s.home?.lon, -180, 180), label: String(s.home?.label || 'Home').slice(0, 30) },
      moveIn: date(s.moveIn),
      trash: {
        trashDay: num(s.trash?.trashDay, 0, 6),
        recyclingDay: num(s.trash?.recyclingDay, 0, 6),
        recyclingEveryWeeks: s.trash?.recyclingEveryWeeks == 2 ? 2 : 1,
        recyclingAnchor: date(s.trash?.recyclingAnchor),
        holidayDelay: s.trash?.holidayDelay !== false,
      },
      calendars: { office: urls(s.calendars?.office), home: urls(s.calendars?.home) },
    }
  }

  function saveSettings() { writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8') }
  function saveList() { try { writeFileSync(LIST_PATH, JSON.stringify(items), 'utf8') } catch (e) { console.error('[Home] list save failed', e.message) } }

  /** Calendar links for a mode; the office falls back to the CALENDAR_ICS_URL env var */
  function calendarUrls(mode) {
    const list = settings.calendars?.[mode === 'home' ? 'home' : 'office'] || []
    if (list.length) return list
    return mode === 'home' ? [] : (process.env.CALENDAR_ICS_URL ? [process.env.CALENDAR_ICS_URL] : [])
  }

  function homeInfo() {
    const t = settings.trash
    const today = startOfDay(new Date())
    const trash = nextPickup(today, t.trashDay, { holidayDelay: t.holidayDelay })
    const recycling = nextPickup(today, t.recyclingDay, { everyWeeks: t.recyclingEveryWeeks, anchor: t.recyclingAnchor, holidayDelay: t.holidayDelay })
    const moveInDays = settings.moveIn ? Math.round((parseKey(settings.moveIn) - today) / DAY) : null
    return {
      defaultMode: settings.defaultMode,
      home: settings.home.lat != null && settings.home.lon != null ? settings.home : null,
      today: dateKey(today),
      moveIn: settings.moveIn,
      moveInDays,
      trash,
      recycling,
      trashSet: t.trashDay != null || t.recyclingDay != null,
    }
  }

  // Short household summary for Ask the Captain in Home mode
  function askContext() {
    const h = homeInfo()
    return {
      moveInDate: h.moveIn || undefined,
      daysUntilMoveIn: h.moveInDays ?? undefined,
      nextTrashPickup: h.trash || undefined,
      nextRecyclingPickup: h.recycling || undefined,
      groceryList: items.filter(i => i.kind === 'grocery' && !i.done).map(i => i.text),
      toDoList: items.filter(i => i.kind === 'todo' && !i.done).map(i => i.text),
    }
  }

  async function handle(req, res, url, path) {
    // Phone page for the list — HTML is public; the data behind it is not
    if (req.method === 'GET' && (path === '/list' || path === '/list/')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      return res.end(LIST_HTML)
    }

    if (path === '/dash/home' || path.startsWith('/dash/list')) {
      if (!process.env.KIOSK_TOKEN) return send(res, 403, { error: 'Private panels are off (no KIOSK_TOKEN set).' })
      if (!authorized(req)) return send(res, 401, { error: 'This device is not unlocked.' })

      if (req.method === 'GET' && path === '/dash/home') return send(res, 200, homeInfo())

      if (req.method === 'GET' && path === '/dash/list') return send(res, 200, items)
      if (req.method === 'POST' && path === '/dash/list') {
        const b = JSON.parse((await readBody(req, 16 * 1024)).toString('utf8') || '{}')
        const text = String(b.text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
        if (!text) return send(res, 400, { error: 'Nothing to add.' })
        if (items.length >= 200) return send(res, 400, { error: 'The list is full — clear some checked items.' })
        const kind = b.kind === 'todo' ? 'todo' : 'grocery'
        if (!items.some(i => i.kind === kind && !i.done && i.text.toLowerCase() === text.toLowerCase())) {
          items.push({ id: randomBytes(6).toString('hex'), kind, text, done: false, at: Date.now() })
          saveList()
        }
        return send(res, 200, items)
      }
      if (req.method === 'POST' && path === '/dash/list/clear') {
        const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}')
        items = items.filter(i => !(i.done && (!b.kind || i.kind === b.kind)))
        saveList()
        return send(res, 200, items)
      }
      const m = path.match(/^\/dash\/list\/([a-f0-9]{12})$/)
      if (m) {
        const it = items.find(i => i.id === m[1])
        if (!it) return send(res, 404, { error: 'Already gone.' })
        if (req.method === 'POST') {
          const b = JSON.parse((await readBody(req, 4096)).toString('utf8') || '{}')
          if (typeof b.done === 'boolean') { it.done = b.done; it.doneAt = b.done ? Date.now() : undefined }
          saveList()
          return send(res, 200, items)
        }
        if (req.method === 'DELETE') { items = items.filter(i => i !== it); saveList(); return send(res, 200, items) }
      }
      return send(res, 405, { error: 'Not allowed.' })
    }

    if (path === '/admin/settings') {
      if (!isAdmin(req)) return send(res, 401, { error: 'Wrong key.' })
      if (req.method === 'GET') return send(res, 200, settings)
      if (req.method === 'PUT') {
        settings = cleanSettings(JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'))
        saveSettings()
        return send(res, 200, settings)
      }
    }
    return false
  }

  return { handle, calendarUrls, homeInfo, askContext, settings: () => settings }
}

// ── Phone list page (/list) ─────────────────────────────────────────────────
const LIST_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0d1a22">
<meta name="apple-mobile-web-app-capable" content="yes"><title>Ship's stores</title><style>
*{box-sizing:border-box}body{margin:0;font-family:Georgia,'Palatino Linotype',serif;background:#0d1a22;color:#e8dfc0;padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
header{padding:1rem 1rem .4rem}h1{margin:0;font-size:1.25rem;color:#f1e8c8}.sub{font-size:.8rem;color:#9ab0b8;font-style:italic}
.tabs{display:flex;gap:.4rem;padding:.4rem 1rem}.tabs button{flex:1;font:inherit;padding:.55rem;border-radius:6px;border:1px solid rgba(139,105,20,.6);background:transparent;color:#c9a54a;letter-spacing:.08em;text-transform:uppercase;font-size:.75rem}
.tabs button.on{background:#c9a54a;color:#0d1a22;font-weight:700}
form{display:flex;gap:.4rem;padding:.5rem 1rem}input{flex:1;font:inherit;font-size:1rem;padding:.65rem .7rem;border-radius:6px;border:1px solid rgba(139,105,20,.6);background:#13242e;color:#f1e8c8}
form button{font:inherit;padding:0 1rem;border-radius:6px;border:0;background:#c9a54a;color:#0d1a22;font-weight:700}
ul{list-style:none;margin:0;padding:0 1rem}li{display:flex;align-items:center;gap:.7rem;padding:.7rem .1rem;border-top:1px solid rgba(139,105,20,.2);font-size:1.05rem}
li .box{width:1.4rem;height:1.4rem;border:2px solid #c9a54a;border-radius:4px;flex-shrink:0;display:grid;place-items:center;color:#0d1a22;font-size:.9rem}
li.done .box{background:#c9a54a}li.done .t{text-decoration:line-through;color:#7d9099}li .t{flex:1}li .x{background:none;border:0;color:#7d9099;font-size:1.3rem;padding:0 .3rem}
.foot{padding:1rem;display:flex;justify-content:space-between;align-items:center}.foot button{font:inherit;font-size:.8rem;background:none;border:1px solid rgba(139,105,20,.5);color:#c9a54a;border-radius:6px;padding:.4rem .7rem}
.msg{padding:1.5rem 1rem;color:#9ab0b8;font-style:italic}</style></head><body>
<header><h1>⚓ Ship's stores</h1><div class="sub">Shows on the dashboard. Add to your home screen for one tap.</div></header>
<div class="tabs"><button data-k="grocery" class="on">Groceries</button><button data-k="todo">To-do</button></div>
<form id="f"><input id="t" autocomplete="off" placeholder="Add an item…" maxlength="120"><button>Add</button></form>
<ul id="l"></ul><div class="foot"><span class="sub" id="n"></span><button id="c">Clear checked</button></div>
<script>
(function(){var u=new URL(location.href),k=u.searchParams.get('k');if(k){try{localStorage.setItem('kioskKey',k)}catch(e){}
document.cookie='kiosk='+encodeURIComponent(k)+';path=/;max-age=31536000;SameSite=Strict'+(location.protocol==='https:'?';Secure':'');history.replaceState(null,'',u.pathname)}})();
var key='';try{key=localStorage.getItem('kioskKey')||''}catch(e){}
var kind='grocery',items=[],$=function(s){return document.querySelector(s)};
function api(p,o){o=o||{};o.headers=Object.assign({'Content-Type':'application/json'},key?{'x-kiosk-token':key}:{});o.credentials='same-origin';
return fetch(p,o).then(function(r){return r.json().then(function(j){if(!r.ok)throw new Error(j.error||r.status);return j})})}
function draw(){var l=$('#l');l.innerHTML='';var mine=items.filter(function(i){return i.kind===kind}).sort(function(a,b){return (a.done-b.done)||(a.at-b.at)});
if(!mine.length){l.innerHTML='<li class="msg">Nothing here yet.</li>'}
mine.forEach(function(i){var li=document.createElement('li');if(i.done)li.className='done';li.innerHTML='<span class="box">'+(i.done?'✓':'')+'</span><span class="t"></span><button class="x" aria-label="Remove">×</button>';
li.querySelector('.t').textContent=i.text;li.onclick=function(e){if(e.target.className==='x'){api('/dash/list/'+i.id,{method:'DELETE'}).then(set).catch(err);return}
api('/dash/list/'+i.id,{method:'POST',body:JSON.stringify({done:!i.done})}).then(set).catch(err)};l.appendChild(li)});
$('#n').textContent=mine.filter(function(i){return !i.done}).length+' to get'}
function set(j){items=j;draw()}function err(e){$('#l').innerHTML='<li class="msg">'+(String(e.message).indexOf('401')>-1||/unlocked/.test(e.message)?'This phone isn\\u2019t unlocked yet — open the link with the key once.':e.message)+'</li>'}
function load(){api('/dash/list').then(set).catch(err)}
document.querySelectorAll('.tabs button').forEach(function(b){b.onclick=function(){kind=b.dataset.k;document.querySelectorAll('.tabs button').forEach(function(x){x.className=x===b?'on':''});
$('#t').placeholder=kind==='todo'?'Add a to-do…':'Add an item…';draw()}});
$('#f').onsubmit=function(e){e.preventDefault();var t=$('#t').value.trim();if(!t)return;$('#t').value='';api('/dash/list',{method:'POST',body:JSON.stringify({text:t,kind:kind})}).then(set).catch(err)};
$('#c').onclick=function(){api('/dash/list/clear',{method:'POST',body:JSON.stringify({kind:kind})}).then(set).catch(err)};
load();setInterval(function(){if(!document.hidden)load()},15000);document.addEventListener('visibilitychange',function(){if(!document.hidden)load()});
</script></body></html>`
