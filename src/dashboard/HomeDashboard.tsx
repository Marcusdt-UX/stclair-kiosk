import { useEffect, useState, type ReactNode } from 'react'
import {
  dashGet, dashPost, familyPhotoUrl,
  type Bridge, type CalEvent, type Conditions, type DashStatus, type HomeInfo, type ListItem, type Pass, type Upcoming,
} from './api'
import { usePoll, Thumb, Dir, WxIcon, shipName, keyToDate, daysBetween, dayWord, fmtTime, startOfToday } from './Sidebar'
import './HomeDashboard.css'

// Home mode as a household dashboard: clock, weather, the house, lists,
// calendar, photos — and the river as one tile (tap it for the full map).

const DAY = 86_400_000
const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function useNow(ms = 15_000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

function Tile({ title, children, className = '', onClick, right }: { title?: string; children: ReactNode; className?: string; onClick?: () => void; right?: ReactNode }) {
  return (
    <section className={`hd-tile ${className}`} onClick={onClick}>
      {title && <h2 className="hd-title"><span>{title}</span>{right}</h2>}
      {children}
    </section>
  )
}

// ── Header: clock, date, weather ────────────────────────────────────────────
function Header({ c }: { c: Conditions | null }) {
  const now = useNow()
  const h = now.getHours()
  const hello = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '')
  const ampm = h < 12 ? 'AM' : 'PM'
  const w = c?.weather
  const sun = w && (() => {
    const t = Date.now()
    if (w.sunrise && t < w.sunrise) return `Sunrise ${fmtTime(w.sunrise)}`
    if (w.sunset && t < w.sunset) return `Sunset ${fmtTime(w.sunset)}`
    return null
  })()
  return (
    <header className="hd-header">
      <div className="hd-clock">
        <div className="hd-time">{time}<span>{ampm}</span></div>
        <div className="hd-date">{hello} · {now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</div>
      </div>
      {w && (
        <div className="hd-weather">
          <div className="hd-wx-now">
            <WxIcon code={w.current.icon} className="hd-wx-big" />
            <div>
              <div className="hd-temp">{w.current.tempF}°</div>
              <div className="hd-wx-desc">{w.current.description}</div>
              <div className="hd-wx-sub">Feels {w.current.feelsLikeF}° · wind {w.current.windDir} {w.current.windMph} mph{sun ? ` · ${sun}` : ''}</div>
            </div>
          </div>
          <div className="hd-fc">
            {w.periods.map(p => (
              <div key={p.at}>
                <span>{new Date(p.at).toLocaleTimeString([], { hour: 'numeric' })}</span>
                <WxIcon code={p.icon} />
                <strong>{p.tempF}°</strong>
                {p.pop >= 20 && <em>{p.pop}%</em>}
              </div>
            ))}
          </div>
        </div>
      )}
    </header>
  )
}

// ── The house: move-in countdown, trash night ───────────────────────────────
function HouseTile({ home }: { home: HomeInfo | null }) {
  const byDate = new Map<string, { names: string[]; shifted: boolean }>()
  for (const [name, p] of [['Trash', home?.trash], ['Recycling', home?.recycling]] as const) {
    if (!p) continue
    const g = byDate.get(p.date) || { names: [], shifted: false }
    g.names.push(g.names.length ? name.toLowerCase() : name)
    g.shifted ||= p.shifted
    byDate.set(p.date, g)
  }
  const pickups = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
  const md = home?.moveInDays
  return (
    <Tile title="The house" className="hd-house">
      {!home ? <p className="hd-empty">Checking…</p> : (
        <>
          {home.moveIn && md != null && md >= 0 && (
            <div className="hd-movein">
              <span className="hd-big">{md === 0 ? '🏡' : md}</span>
              <span>{md === 0 ? 'Move-in day!' : `${md === 1 ? 'day' : 'days'} until move-in`}<small>{keyToDate(home.moveIn).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</small></span>
            </div>
          )}
          {pickups.map(([date, g]) => {
            const n = daysBetween(home.today, date)
            const what = g.names.join(' & ')
            return (
              <div key={date} className={`hd-pickup${n === 1 ? ' is-tonight' : n === 0 ? ' is-today' : ''}`}>
                <span className="hd-pickup-icon">🗑</span>
                <span>
                  {n === 1 ? <strong>{what} out tonight</strong> : n === 0 ? <strong>{what} pickup today</strong> : <>{what} <b>{dayWord(date, home.today)}</b></>}
                  {g.shifted && <small>Holiday week — a day late</small>}
                </span>
              </div>
            )
          })}
          {!home.trashSet && !home.moveIn && <p className="hd-empty">Add the move-in date and trash day at /admin.</p>}
        </>
      )}
    </Tile>
  )
}

// ── Lists: groceries + to-do (tap to check off) ─────────────────────────────
function ListsTile() {
  const [items, setItems] = useState<ListItem[] | null>(null)
  useEffect(() => {
    let alive = true
    const run = () => dashGet<ListItem[]>('/dash/list').then(d => { if (alive) setItems(d) }).catch(() => {})
    run()
    const t = setInterval(run, 20_000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  const toggle = (i: ListItem) => dashPost<ListItem[]>(`/dash/list/${i.id}`, { done: !i.done }).then(setItems).catch(() => {})
  const open = (k: ListItem['kind']) => (items || []).filter(i => i.kind === k && !i.done).sort((a, b) => a.at - b.at)
  const groceries = open('grocery'), todos = open('todo')
  return (
    <Tile title="Lists" className="hd-lists">
      <div className="hd-lists-body">
        <div>
          <h3>Groceries {groceries.length > 0 && <span>{groceries.length}</span>}</h3>
          {!items ? <p className="hd-empty">Opening…</p> : groceries.length === 0 ? <p className="hd-empty">All stocked up.</p> : (
            <div className="hd-chips">
              {groceries.slice(0, 18).map(i => <button key={i.id} onClick={() => toggle(i)}>{i.text}</button>)}
              {groceries.length > 18 && <span className="hd-more">+{groceries.length - 18} more</span>}
            </div>
          )}
        </div>
        <div>
          <h3>To-do {todos.length > 0 && <span>{todos.length}</span>}</h3>
          {!items ? null : todos.length === 0 ? <p className="hd-empty">Nothing on the list.</p> : (
            <ul className="hd-todo">
              {todos.slice(0, 8).map(i => <li key={i.id} onClick={() => toggle(i)}><span className="hd-box" />{i.text}</li>)}
              {todos.length > 8 && <li className="hd-more">+{todos.length - 8} more</li>}
            </ul>
          )}
        </div>
      </div>
      <p className="hd-foot">Tap to check off · add from your phone at {location.host}/list</p>
    </Tile>
  )
}

// ── Calendar: the next week ─────────────────────────────────────────────────
function CalendarTile({ status }: { status: DashStatus | null }) {
  const has = !!status?.unlocked && !!status.features.homeCalendar
  const ev = usePoll(
    () => {
      if (!has) return Promise.resolve(null)
      const from = startOfToday()
      return dashGet<CalEvent[]>(`/dash/calendar?from=${from}&to=${from + 7 * DAY}&mode=home`)
    },
    10 * 60_000, [has],
  )
  const today = dayKey(new Date())
  const groups = new Map<string, CalEvent[]>()
  for (const e of ev || []) {
    if (!e.allDay && Number(e.end) < Date.now()) continue
    const k = e.allDay ? String(e.start) : dayKey(new Date(Number(e.start)))
    const key = k < today ? today : k
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(e)
  }
  const days = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(0, 5)
  const label = (k: string) => { const n = daysBetween(today, k); return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : keyToDate(k).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' }) }
  return (
    <Tile title="This week" className="hd-cal">
      {!has ? <p className="hd-empty">Connect a calendar at /admin (Home calendar links).</p>
        : !ev ? <p className="hd-empty">Checking the calendar…</p>
        : days.length === 0 ? <p className="hd-empty">A clear week — nothing scheduled.</p>
        : days.map(([k, list]) => (
          <div key={k} className="hd-day">
            <h3>{label(k)}</h3>
            {list.slice(0, 4).map((e, i) => (
              <div key={i} className="hd-event">
                <span>{e.allDay ? 'All day' : fmtTime(Number(e.start))}</span>
                <strong>{e.title}</strong>
              </div>
            ))}
          </div>
        ))}
    </Tile>
  )
}

// ── Photos: family + the house going up ─────────────────────────────────────
function PhotoTile({ status, moveIn }: { status: DashStatus | null; moveIn: string | null }) {
  const unlocked = !!status?.unlocked
  const family = usePoll(() => (unlocked ? dashGet<string[]>('/dash/photos') : Promise.resolve([] as string[])), 30 * 60_000, [unlocked])
  const build = usePoll(() => (unlocked ? dashGet<string[]>('/dash/photos?album=build') : Promise.resolve([] as string[])), 30 * 60_000, [unlocked])
  const all = [...(build || []).map(n => ({ n, build: true })), ...(family || []).map(n => ({ n, build: false }))]
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI(x => x + 1), 30_000)
    return () => clearInterval(t)
  }, [])
  if (!all.length) {
    return (
      <Tile className="hd-photo is-empty">
        <div className="hd-photo-empty"><span>⚓</span><p>Family photos and pictures of the house going up will show here.</p><small>Add them at /admin</small></div>
      </Tile>
    )
  }
  // alternate family / build so neither takes over
  const p = all[(i * 7) % all.length]
  const taken = p.build && /^\d{4}-\d{2}-\d{2}/.test(p.n) ? keyToDate(p.n.slice(0, 10)) : null
  return (
    <Tile className="hd-photo" onClick={() => setI(x => x + 1)}>
      <img key={p.n} src={familyPhotoUrl(p.n, p.build ? 'build' : undefined)} alt="" />
      {p.build && (
        <div className="hd-photo-cap">
          <strong>The house</strong>{taken && <> · {taken.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })}</>}
          {moveIn && <span>Move-in {keyToDate(moveIn).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>}
        </div>
      )}
    </Tile>
  )
}

// ── The river: one tile, tap for the full map ───────────────────────────────
function laneText(l: Bridge['cars']) {
  if (!l) return null
  if (/closed/i.test(l.status)) return 'closed'
  if (l.minutes == null) return null
  return l.minutes === 0 ? 'no wait' : `${l.minutes} min`
}

function RiverTile({ onOpen }: { onOpen: () => void }) {
  const up = usePoll(() => dashGet<Upcoming[]>('/dash/upcoming'), 60_000)
  const log = usePoll(() => dashGet<Pass[]>(`/dash/log?since=${startOfToday()}`), 120_000)
  const bridge = usePoll(() => dashGet<Bridge | null>('/dash/bridge'), 10 * 60_000)
  const next = up?.[0]
  const last = log?.[0]
  const cars = laneText(bridge?.cars ?? null)
  return (
    <Tile title="On the river" className="hd-river" onClick={onOpen} right={<span className="hd-open">Map ›</span>}>
      {next ? (
        <div className="hd-ship">
          <Thumb src={next.photo} />
          <div>
            <strong><Dir d={next.direction} /> {shipName(next.name, next.mmsi)}</strong>
            <span>{next.etaMinutes < 2 ? 'Passing the city offices now' : `Downtown in ${next.etaMinutes} min`}{next.operator ? ` · ${next.operator}` : ''}</span>
          </div>
        </div>
      ) : last ? (
        <div className="hd-ship">
          <Thumb src={last.photo} />
          <div>
            <strong><Dir d={last.direction} /> {shipName(last.name, last.mmsi)}</strong>
            <span>Went by at {fmtTime(last.at)}</span>
          </div>
        </div>
      ) : <p className="hd-empty">Quiet on the river right now.</p>}
      <p className="hd-foot">
        {log ? `${log.length} ship${log.length === 1 ? '' : 's'} today` : ''}
        {cars ? ` · Blue Water Bridge into the U.S.: ${cars}` : ''}
      </p>
    </Tile>
  )
}

export function HomeDashboard({ status, home, onOpenMap, askOn = false }: { status: DashStatus | null; home: HomeInfo | null; onOpenMap: () => void; askOn?: boolean }) {
  const cond = usePoll(() => dashGet<Conditions>('/dash/conditions'), 10 * 60_000)
  return (
    <div className={`home-dash${askOn ? ' has-ask' : ''}`}>
      <Header c={cond} />
      <div className="hd-grid">
        <HouseTile home={home} />
        <ListsTile />
        <PhotoTile status={status} moveIn={home?.moveIn ?? null} />
        <CalendarTile status={status} />
        <RiverTile onOpen={onOpenMap} />
      </div>
    </div>
  )
}
