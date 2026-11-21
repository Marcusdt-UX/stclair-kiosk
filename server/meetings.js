/**
 * City board meetings for the Office-mode "Board meetings" card.
 *
 * Source: the City of Port Huron's public website calendar (Revize). The page
 * loads its events from calendar_data_handler.php as JSON. Recurring meetings
 * come with an RRULE (local "floating" times) plus EXDATEs, and a cancelled
 * meeting shows up as its own event titled "… - Cancelled".
 * If the city site can't be reached, the regular schedule from the Planning
 * Department page is used instead (first Mon/Tue/Wed of the month).
 */

const FEED = process.env.MEETINGS_FEED_URL || 'https://www.porthuron.org/_assets_/plugins/revizeCalendar/calendar_data_handler.php?webspace=porthuronminw&relative_revize_url=//cms9.revize.com&protocol=https:'
const DAY = 24 * 3600 * 1000

// Boards the Planning Department staffs (+ City Council, where its items end up)
export const BOARDS = [
  { key: 'pc', name: 'Planning Commission', re: /planning commission/i, apps: true, rule: { nth: 1, wd: 2, h: 18 } },
  { key: 'hdc', name: 'Historic District Commission', re: /historic district/i, apps: true, rule: { nth: 1, wd: 2, h: 16 } },
  { key: 'zba', name: 'Zoning Board of Appeals', re: /zoning board/i, apps: true, rule: { nth: 1, wd: 1, h: 18 } },
  { key: 'cboa', name: 'Construction Board of Appeals', re: /construction board/i, apps: true, rule: { nth: 1, wd: 3, h: 17 } },
  { key: 'cc', name: 'City Council', re: /city council/i, apps: false, rule: null },
]
const APPS_DAYS = 30           // "Applications generally must be received at least 30 days before the meeting"

const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 }

/** "20250203T180000" → local Date (the city's times are local wall-clock) */
function parseStamp(s) {
  const m = String(s).match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/)
  if (!m) return null
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))
}
/** "2026-11-23T18:00:00" → local Date */
function parseIsoLocal(s) {
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/)
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : null
}

/** nth (1..5, or -1 = last) weekday of a month, at the given time */
function nthWeekday(y, mo, wd, nth, h, mi) {
  if (nth > 0) {
    const d = new Date(y, mo, 1, h, mi)
    d.setDate(1 + ((wd - d.getDay() + 7) % 7) + (nth - 1) * 7)
    return d.getMonth() === mo ? d : null
  }
  const d = new Date(y, mo + 1, 0, h, mi)
  d.setDate(d.getDate() - ((d.getDay() - wd + 7) % 7))
  return d
}

/** Expand a Revize/iCal RRULE block into local Dates within [from, to] */
export function expandRule(block, from, to) {
  const lines = String(block).split(/\r?\n/)
  let start = null, rule = null
  const ex = new Set(), extra = []
  for (const l of lines) {
    const [k, v] = [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1)]
    if (k === 'DTSTART') start = parseStamp(v)
    else if (k === 'RRULE') rule = Object.fromEntries(v.split(';').map(p => p.split('=')))
    else if (k === 'EXDATE') v.split(',').forEach(x => { const d = parseStamp(x); if (d) ex.add(d.getTime()) })
    else if (k === 'RDATE') v.split(',').forEach(x => { const d = parseStamp(x); if (d) extra.push(d) })
  }
  if (!start) return []
  const out = new Set(extra.map(d => d.getTime()))
  if (rule) {
    const freq = rule.FREQ, interval = Math.max(1, +(rule.INTERVAL || 1))
    const until = rule.UNTIL ? parseStamp(rule.UNTIL) : null
    const count = rule.COUNT ? +rule.COUNT : Infinity
    const byday = (rule.BYDAY || '').split(',').filter(Boolean).map(x => { const m = x.match(/^([+-]?\d+)?(\w\w)$/); return m ? { n: m[1] ? +m[1] : null, wd: WD[m[2]] } : null }).filter(Boolean)
    const pos = rule.BYSETPOS ? +rule.BYSETPOS : null
    const months = rule.BYMONTH ? rule.BYMONTH.split(',').map(x => +x - 1) : null
    const h = start.getHours(), mi = start.getMinutes()
    let n = 0
    const push = d => {
      if (!d || d < start) return true
      if (until && d > until) return false
      if (++n > count) return false
      out.add(d.getTime())
      return d <= to
    }
    const limit = new Date(to.getTime() + 40 * DAY)
    if (freq === 'MONTHLY' || freq === 'YEARLY') {
      const step = freq === 'MONTHLY' ? interval : 12 * interval
      for (let y = start.getFullYear(), mo = start.getMonth(); new Date(y, mo, 1) <= limit; mo += freq === 'YEARLY' && months ? 1 : step) {
        if (mo > 11) { y += Math.floor(mo / 12); mo %= 12 }
        if (freq === 'YEARLY' && months) { if (!months.includes(mo) || (y - start.getFullYear()) % interval) continue }
        else if (months && !months.includes(mo)) continue
        let d
        if (byday.length) {
          const b = byday[0]
          d = nthWeekday(y, mo, b.wd, b.n ?? pos ?? 1, h, mi)
        } else d = new Date(y, mo, start.getDate(), h, mi)
        if (!push(d)) break
      }
    } else if (freq === 'WEEKLY') {
      const days = byday.length ? byday.map(b => b.wd) : [start.getDay()]
      const wk0 = new Date(start); wk0.setDate(wk0.getDate() - wk0.getDay())
      outer: for (let w = 0; new Date(wk0.getTime() + w * 7 * DAY) <= limit; w += interval) {
        for (const wd of [...days].sort()) {
          const d = new Date(wk0); d.setDate(d.getDate() + w * 7 + wd); d.setHours(h, mi, 0, 0)
          if (!push(d)) break outer
        }
      }
    } else if (freq === 'DAILY') {
      for (let i = 0; ; i += interval) {
        const d = new Date(start); d.setDate(d.getDate() + i)
        if (d > limit || !push(d)) break
      }
    }
  } else out.add(start.getTime())
  return [...out].filter(t => !ex.has(t)).map(t => new Date(t)).filter(d => d >= from && d <= to)
}

const isCancelled = t => /cancel+ed/i.test(t)
const cleanTitle = t => String(t).replace(/\s*-?\s*cancel+ed\s*-?\s*/i, ' ').replace(/^port huron\s+/i, '').replace(/\s+meeting$/i, '').replace(/\s+/g, ' ').trim()
const dateKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Turn the city's raw feed into upcoming board meetings */
export function boardMeetings(events, now = new Date(), days = 75) {
  const from = new Date(now.getTime() - 3 * 3600 * 1000), to = new Date(now.getTime() + days * DAY)
  const map = new Map()
  for (const e of events || []) {
    if (e.primary_calendar_name && e.primary_calendar_name !== 'Meetings') continue
    const board = BOARDS.find(b => b.re.test(e.title || ''))
    if (!board) continue
    const dates = e.rrule ? expandRule(e.rrule, from, to) : [parseIsoLocal(e.start)].filter(d => d && d >= from && d <= to)
    for (const d of dates) {
      const k = `${board.key}|${d.getTime()}`
      const prev = map.get(k)
      const cancelled = isCancelled(e.title) || !!prev?.cancelled
      const title = cleanTitle(e.title)
      map.set(k, { board: board.key, name: board.name, title: title.length > board.name.length + 2 ? title : board.name, start: d.getTime(), date: dateKey(d), cancelled })
    }
  }
  return finish([...map.values()])
}

/** Regular schedule, for when the city calendar can't be reached */
export function ruleMeetings(now = new Date(), days = 75) {
  const to = new Date(now.getTime() + days * DAY), list = []
  for (let i = 0; i < 4; i++) {
    const y = now.getFullYear(), mo = now.getMonth() + i
    for (const b of BOARDS) {
      if (!b.rule) continue
      const d = nthWeekday(y + Math.floor(mo / 12), mo % 12, b.rule.wd, b.rule.nth, b.rule.h, 0)
      if (d && d >= new Date(now.getTime() - 3 * 3600 * 1000) && d <= to) list.push({ board: b.key, name: b.name, title: b.name, start: d.getTime(), date: dateKey(d), cancelled: false })
    }
  }
  return finish(list)
}

function finish(list) {
  return list
    .sort((a, b) => a.start - b.start)
    .map(m => {
      const b = BOARDS.find(x => x.key === m.board)
      if (b?.apps && !m.cancelled && m.title === b.name) m.appsDue = dateKey(new Date(m.start - APPS_DAYS * DAY))
      return m
    })
}

export function createMeetings() {
  let raw = null, at = 0, pending = null, failedAt = 0
  async function load() {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 20000)
    try {
      const r = await fetch(FEED, { signal: ctrl.signal, headers: { 'User-Agent': 'stclair-kiosk/1.0', Accept: 'application/json' } })
      if (!r.ok) throw new Error(`city calendar ${r.status}`)
      const j = await r.json()
      if (!Array.isArray(j)) throw new Error('city calendar: unexpected format')
      raw = j.filter(e => e.primary_calendar_name === 'Meetings')
      at = Date.now()
    } finally { clearTimeout(t) }
  }
  async function get() {
    const stale = !raw || Date.now() - at > 3 * 3600 * 1000
    if (stale && !pending && Date.now() - failedAt > 10 * 60 * 1000) {
      pending = load().catch(e => { failedAt = Date.now(); console.error('[Meetings]', e.message) }).finally(() => { pending = null })
    }
    if (!raw && pending) await pending
    const now = new Date()
    return raw
      ? { source: 'city', updated: at, meetings: boardMeetings(raw, now) }
      : { source: 'schedule', updated: null, meetings: ruleMeetings(now) }
  }
  return { get }
}
