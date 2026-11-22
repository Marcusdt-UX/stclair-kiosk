import { useEffect, useState, type ReactNode } from 'react'
import { dashGet, dashPost, familyPhotoUrl, type Bridge, type CalEvent, type Conditions, type DashStatus, type HomeInfo, type ListItem, type Meetings, type Mode, type Pass, type Upcoming } from './api'
import { getSilhouette } from '../services/photoResolver'
import './Sidebar.css'

// ── helpers ─────────────────────────────────────────────────────────────────
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []): T | null {
  const [data, setData] = useState<T | null>(null)
  useEffect(() => {
    let alive = true
    const run = () => load().then(d => { if (alive) setData(d) }).catch(() => { /* keep last good */ })
    run()
    const t = setInterval(run, ms)
    return () => { alive = false; clearInterval(t) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return data
}

const WX: Record<string, string> = { '01d': '☀️', '01n': '🌙', '02d': '🌤️', '02n': '☁️', '03': '☁️', '04': '☁️', '09': '🌧️', '10d': '🌦️', '10n': '🌧️', '11': '⛈️', '13': '❄️', '50': '🌫️' }
/** Weather glyph for an OpenWeather icon code */
export function WxIcon({ code, className = '' }: { code?: string; className?: string }) {
  const g = code ? (WX[code] || WX[code.slice(0, 2)] || '🌡️') : ''
  return <span className={`wx-icon ${className}`} aria-hidden>{g}</span>
}

export const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
export const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }

export function Thumb({ src }: { src?: string }) {
  const [s, setS] = useState(src || getSilhouette(70))
  useEffect(() => setS(src || getSilhouette(70)), [src])
  return <img className={`sb-thumb${s.startsWith('/silhouettes/') ? ' is-sil' : ''}`} src={s} alt="" onError={() => setS(getSilhouette(70))} />
}

export function Dir({ d }: { d: 'upbound' | 'downbound' }) {
  return <span className={`sb-dir sb-dir-${d}`} title={d === 'downbound' ? 'Downbound — toward Lake St. Clair' : 'Upbound — toward Lake Huron'}>{d === 'downbound' ? '▼' : '▲'}</span>
}

function Panel({ title, children, className = '' }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`sb-panel ${className}`}>
      <h2 className="sb-title">{title}</h2>
      {children}
    </section>
  )
}

// ── Coming up the river ─────────────────────────────────────────────────────
function ComingUp({ max = 3 }: { max?: number }) {
  const list = usePoll(() => dashGet<Upcoming[]>('/dash/upcoming'), 60_000)
  return (
    <Panel title="Coming up the river">
      {!list ? <p className="sb-empty">Checking the channel…</p>
        : list.length === 0 ? <p className="sb-empty">Nothing headed this way right now.</p>
        : (
          <ul className="sb-list">
            {list.slice(0, max).map(v => (
              <li key={v.mmsi} className="sb-row">
                <Thumb src={v.photo} />
                <div className="sb-row-main">
                  <div className="sb-name"><Dir d={v.direction} /> {v.name}</div>
                  <div className="sb-sub">{v.operator || `${v.speed} kn`}</div>
                </div>
                <div className="sb-eta">{v.etaMinutes < 2 ? 'now' : `${v.etaMinutes} min`}</div>
              </li>
            ))}
          </ul>
        )}
    </Panel>
  )
}

// ── Ship's log (passed the MOC today) ───────────────────────────────────────
function ShipsLog() {
  const list = usePoll(() => dashGet<Pass[]>(`/dash/log?since=${startOfToday()}`), 60_000)
  return (
    <Panel title={`Ship's log — today${list && list.length ? ` · ${list.length}` : ''}`}>
      {!list ? <p className="sb-empty">Opening the log…</p>
        : list.length === 0 ? <p className="sb-empty">No ships past the window yet today.</p>
        : (
          <ul className="sb-list sb-log">
            {list.slice(0, 4).map(p => (
              <li key={`${p.mmsi}-${p.at}`} className="sb-logrow">
                <span className="sb-logtime">{fmtTime(p.at)}</span>
                <Dir d={p.direction} />
                <span className="sb-logname">{p.name}</span>
              </li>
            ))}
          </ul>
        )}
    </Panel>
  )
}

function LogCard() {
  const list = usePoll(() => dashGet<Pass[]>(`/dash/log?since=${startOfToday()}`), 60_000)
  return (
    <div className="sb-card">
      <h2 className="sb-title">{`Ship's log — today${list && list.length ? ` · ${list.length}` : ''}`}</h2>
      {!list ? <p className="sb-empty">Opening the log…</p>
        : list.length === 0 ? <p className="sb-empty">No ships past the city offices yet today.</p>
        : (
          <ul className="sb-list sb-log">
            {list.slice(0, 9).map(p => (
              <li key={`${p.mmsi}-${p.at}`} className="sb-logrow">
                <span className="sb-logtime">{fmtTime(p.at)}</span>
                <Dir d={p.direction} />
                <span className="sb-logname">{p.name}</span>
              </li>
            ))}
          </ul>
        )}
    </div>
  )
}

// ── Home mode: today at the house ───────────────────────────────────────────
export const keyToDate = (k: string) => new Date(`${k}T00:00:00`)
export function daysBetween(a: string, b: string) { return Math.round((keyToDate(b).getTime() - keyToDate(a).getTime()) / 86_400_000) }
export function dayWord(k: string, today: string) {
  const n = daysBetween(today, k)
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  return keyToDate(k).toLocaleDateString([], n < 7 ? { weekday: 'long' } : { weekday: 'short', month: 'short', day: 'numeric' })
}

function HomeToday({ home }: { home: HomeInfo | null }) {
  if (!home) return <Panel title="At home"><p className="sb-empty">Checking the house…</p></Panel>
  // group trash + recycling that share a day
  const byDate = new Map<string, { names: string[]; shifted: boolean }>()
  for (const [name, p] of [['Trash', home.trash], ['Recycling', home.recycling]] as const) {
    if (!p) continue
    const g = byDate.get(p.date) || { names: [], shifted: false }
    g.names.push(g.names.length ? name.toLowerCase() : name)
    g.shifted ||= p.shifted
    byDate.set(p.date, g)
  }
  const pickups = [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
  const md = home.moveInDays
  return (
    <Panel title="At home" className="sb-home">
      {home.moveIn && md != null && md >= 0 && (
        <div className="sb-movein">
          {md === 0 ? <span className="sb-big">Move-in day!</span> : <span className="sb-big">{md}</span>}
          {md > 0 && <span>{md === 1 ? 'day' : 'days'} to move-in<small>{keyToDate(home.moveIn).toLocaleDateString([], { weekday: 'short', month: 'long', day: 'numeric' })}</small></span>}
        </div>
      )}
      {pickups.map(([date, g]) => {
        const n = daysBetween(home.today, date)
        const what = g.names.join(' & ')
        return (
          <div key={date} className={`sb-pickup${n === 1 ? ' is-tonight' : n === 0 ? ' is-today' : ''}`}>
            <span className="sb-pickup-icon">🗑</span>
            <span>
              {n === 1 ? <strong>{what} out tonight</strong> : n === 0 ? <strong>{what} pickup today</strong> : <>{what} · {dayWord(date, home.today)}</>}
              {g.shifted && <small> · holiday week, a day late</small>}
            </span>
          </div>
        )
      })}
      {!home.trashSet && !home.moveIn && <p className="sb-empty">Add the move-in date and trash day at /admin.</p>}
    </Panel>
  )
}

// ── Home mode: grocery + to-do list (tap to check off; add from her phone at /list)
function ListCard() {
  const [items, setItems] = useState<ListItem[] | null>(null)
  useEffect(() => {
    let alive = true
    const run = () => dashGet<ListItem[]>('/dash/list').then(d => { if (alive) setItems(d) }).catch(() => {})
    run()
    const t = setInterval(run, 30_000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  const toggle = (i: ListItem) => dashPost<ListItem[]>(`/dash/list/${i.id}`, { done: !i.done }).then(setItems).catch(() => {})
  const open = (k: ListItem['kind']) => (items || []).filter(i => i.kind === k && !i.done).sort((a, b) => a.at - b.at)
  const groceries = open('grocery'), todos = open('todo')
  return (
    <Panel title={`Ship's stores${groceries.length ? ` · ${groceries.length}` : ''}`} className="sb-stores">
      {!items ? <p className="sb-empty">Opening the list…</p>
        : !groceries.length && !todos.length ? <p className="sb-empty">All stocked up. Add things from your phone.</p>
        : (
          <>
            {groceries.length > 0 && (
              <div className="sb-chips">
                {groceries.slice(0, 10).map(i => <button key={i.id} className="sb-chip" onClick={() => toggle(i)}>{i.text}</button>)}
                {groceries.length > 10 && <span className="sb-chip is-more">+{groceries.length - 10}</span>}
              </div>
            )}
            {todos.length > 0 && (
              <ul className="sb-list sb-todo">
                {todos.slice(0, 3).map(i => <li key={i.id} onClick={() => toggle(i)}><span className="sb-box" />{i.text}</li>)}
                {todos.length > 3 && <li className="sb-sub">+{todos.length - 3} more to-dos</li>}
              </ul>
            )}
          </>
        )}
      <p className="sb-foot">Tap to check off · add from your phone at {location.host}/list</p>
    </Panel>
  )
}

function BuildCard({ names, seed, moveIn }: { names: string[]; seed: number; moveIn: string | null }) {
  // walk the timeline, oldest → newest, one photo each time the card comes around
  const i = seed % names.length
  const name = names[i]
  const taken = /^\d{4}-\d{2}-\d{2}/.test(name) ? keyToDate(name.slice(0, 10)) : null
  return (
    <div className="sb-card sb-photo sb-build">
      <img src={familyPhotoUrl(name, 'build')} alt="" />
      <div className="sb-build-cap">
        <strong>The house</strong>{taken && <> · {taken.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</>}
        <span>{i + 1} of {names.length}{moveIn ? ` · move-in ${keyToDate(moveIn).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}</span>
      </div>
    </div>
  )
}

// ── Office mode: city board meetings (public city calendar) ────────────────
function MeetingsCard({ m }: { m: Meetings | null }) {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const list = (m?.meetings || []).filter(x => x.start > Date.now() - 2 * 3600_000).slice(0, 6)
  const cutoff = (m?.meetings || []).find(x => x.appsDue && x.appsDue >= todayKey)
  const when = (ms: number) => {
    const d = new Date(ms)
    const day = d.toDateString() === today.toDateString() ? 'Today' : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    return `${day} · ${d.toLocaleTimeString([], { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined })}`
  }
  const short = (k: string) => new Date(`${k}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })
  return (
    <div className="sb-card">
      <h2 className="sb-title">Board meetings</h2>
      {!m ? <p className="sb-empty">Checking the city calendar…</p>
        : list.length === 0 ? <p className="sb-empty">Nothing on the city calendar soon.</p>
        : (
          <ul className="sb-list sb-cal sb-meet">
            {list.map(x => (
              <li key={`${x.board}-${x.start}`} className={x.cancelled ? 'is-cancelled' : ''}>
                <span className="sb-cal-when">{when(x.start)}{x.cancelled && <em> · cancelled</em>}</span>
                <span className="sb-cal-what">{x.title}</span>
              </li>
            ))}
          </ul>
        )}
      {cutoff && (
        <p className="sb-meet-cutoff">
          <span>Next filing cutoff</span>
          {cutoff.appsDue === todayKey ? 'Today' : short(cutoff.appsDue!)} → {cutoff.name}, {short(cutoff.date)}
        </p>
      )}
      <p className="sb-foot">{m?.source === 'schedule' ? 'Regular schedule (city calendar unavailable)' : 'City of Port Huron calendar'}</p>
    </div>
  )
}

// ── Rotating instrument cards ───────────────────────────────────────────────
function ConditionsCard({ c }: { c: Conditions | null }) {
  const w = c?.weather
  const r = c?.river
  return (
    <div className="sb-card">
      <h2 className="sb-title">Conditions on the river</h2>
      {w ? (
        <>
          <div className="sb-wx-now">
            <WxIcon code={w.current.icon} className="sb-wx-big" />
            <div>
              <div className="sb-big">{w.current.tempF}°F</div>
              <div className="sb-sub">{w.current.description} · wind {w.current.windDir} {w.current.windMph}{w.current.gustMph ? `–${w.current.gustMph}` : ''} mph</div>
            </div>
          </div>
          <div className="sb-forecast">
            {w.periods.map(p => (
              <div key={p.at} className="sb-fc">
                <div className="sb-fc-time">{new Date(p.at).toLocaleTimeString([], { hour: 'numeric' })}</div>
                <WxIcon code={p.icon} />
                <div className="sb-fc-temp">{p.tempF}°</div>
                {p.pop >= 20 && <div className="sb-fc-pop">{p.pop}%</div>}
              </div>
            ))}
          </div>
          <div className="sb-pairs">
            {w.sunrise && <div><span>Sunrise</span>{fmtTime(w.sunrise)}</div>}
            {w.sunset && <div><span>Sunset</span>{fmtTime(w.sunset)}</div>}
            {r?.levelFt != null && <div><span>River level</span>{r.levelFt.toFixed(2)} ft{r.change24hIn != null && ` (${r.change24hIn > 0 ? '+' : ''}${r.change24hIn}″ 24h)`}</div>}
            {r?.flowCfs != null && <div><span>Flow</span>{Math.round(r.flowCfs / 1000)}k ft³/s</div>}
          </div>
        </>
      ) : <p className="sb-empty">Reading the instruments…</p>}
    </div>
  )
}

function laneText(l: Bridge['cars']) {
  if (!l) return '—'
  if (l.status === 'Lanes Closed' || l.status === 'lanes closed') return 'Closed'
  if (l.minutes == null) return l.status
  return l.minutes === 0 ? 'No delay' : `${l.minutes} min`
}

function BridgeCard({ b }: { b: Bridge | null }) {
  return (
    <div className="sb-card sb-card-center">
      <h2 className="sb-title">Blue Water Bridge · into the U.S.</h2>
      {b ? (
        <>
          <div className="sb-bridge">
            <div><span>Cars</span><strong>{laneText(b.cars)}</strong></div>
            <div><span>NEXUS</span><strong>{laneText(b.nexus)}</strong></div>
            <div><span>Trucks</span><strong>{laneText(b.trucks)}</strong></div>
          </div>
          <p className="sb-foot">CBP · {b.cars?.updated || b.portStatus}</p>
        </>
      ) : <p className="sb-empty">Wait times unavailable.</p>}
    </div>
  )
}

function WatchCard({ ev, title = 'Watch schedule' }: { ev: CalEvent[] | null; title?: string }) {
  const todayKey = new Date(startOfToday()).toDateString()
  const label = (e: CalEvent) => {
    const d = e.allDay ? new Date(String(e.start) + 'T00:00:00') : new Date(Number(e.start))
    const day = d.toDateString() === todayKey ? 'Today' : 'Tomorrow'
    return `${day}${e.allDay ? '' : ' · ' + fmtTime(Number(e.start))}`
  }
  return (
    <div className="sb-card">
      <h2 className="sb-title">{title}</h2>
      {!ev ? <p className="sb-empty">Checking the calendar…</p>
        : ev.length === 0 ? <p className="sb-empty">Clear sailing — nothing scheduled.</p>
        : (
          <ul className="sb-list sb-cal">
            {ev.filter(e => e.allDay || Number(e.end) > Date.now()).slice(0, 8).map((e, i) => (
              <li key={i}><span className="sb-cal-when">{label(e)}</span><span className="sb-cal-what">{e.title}</span></li>
            ))}
          </ul>
        )}
    </div>
  )
}

function PhotoCard({ names, seed }: { names: string[]; seed: number }) {
  // a different photo each time the card comes around
  const name = names[(seed * 7 + 3) % names.length]
  return (
    <div className="sb-card sb-photo">
      <img src={familyPhotoUrl(name)} alt="" />
    </div>
  )
}

function Rotator({ status, mode = 'office', home = null }: { status: DashStatus | null; mode?: Mode; home?: HomeInfo | null }) {
  const unlocked = !!status?.unlocked
  const isHome = mode === 'home'
  const hasCal = isHome ? !!status?.features.homeCalendar : !!status?.features.calendar
  const cond = usePoll(() => dashGet<Conditions>('/dash/conditions'), 10 * 60_000)
  const bridge = usePoll(() => dashGet<Bridge | null>('/dash/bridge'), 10 * 60_000)
  const meet = usePoll(() => (mode === 'office' ? dashGet<Meetings>('/dash/meetings') : Promise.resolve(null)), 30 * 60_000, [mode])
  const cal = usePoll(
    () => {
      if (!unlocked || !hasCal) return Promise.resolve(null)
      const from = startOfToday()
      return dashGet<CalEvent[]>(`/dash/calendar?from=${from}&to=${from + 2 * 24 * 3600 * 1000}&mode=${mode}`)
    },
    10 * 60_000, [unlocked, hasCal, mode],
  )
  const build = usePoll(
    () => (isHome && unlocked ? dashGet<string[]>('/dash/photos?album=build') : Promise.resolve([] as string[])),
    30 * 60_000, [isHome, unlocked],
  )
  const photos = usePoll(
    () => (status?.unlocked && status.features.photos ? dashGet<string[]>('/dash/photos') : Promise.resolve([] as string[])),
    30 * 60_000, [status?.unlocked],
  )
  const [idx, setIdx] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setIdx(i => i + 1), 20_000)
    return () => clearInterval(t)
  }, [])

  const cards: { key: string; el: ReactNode }[] = [{ key: 'cond', el: <ConditionsCard c={cond} /> }]
  if (isHome) cards.push({ key: 'log', el: <LogCard /> })
  else cards.push({ key: 'bridge', el: <BridgeCard b={bridge} /> }, { key: 'meet', el: <MeetingsCard m={meet} /> })
  if (unlocked && hasCal) cards.push({ key: 'watch', el: <WatchCard ev={cal} title={isHome ? 'On the calendar' : 'Watch schedule'} /> })
  if (build && build.length) cards.push({ key: 'build', el: null })
  if (photos && photos.length) cards.push({ key: 'photo', el: <PhotoCard names={photos} seed={idx} /> })
  if (isHome) cards.push({ key: 'bridge', el: <BridgeCard b={bridge} /> })
  // the build timeline moves one photo forward each time its card comes around
  const bi = cards.findIndex(c => c.key === 'build')
  if (bi >= 0 && build) cards[bi].el = <BuildCard names={build} seed={Math.floor(idx / cards.length)} moveIn={home?.moveIn ?? null} />
  const current = cards[idx % cards.length]

  return (
    <section className="sb-panel sb-rotator" onClick={() => setIdx(i => i + 1)}>
      <div key={`${current.key}-${idx}`} className="sb-fade">{current.el}</div>
      <div className="sb-dots">{cards.map((c, i) => <span key={c.key} className={i === idx % cards.length ? 'on' : ''} />)}</div>
    </section>
  )
}

// ── Sidebar ─────────────────────────────────────────────────────────────────
export function Sidebar({ status, mode = 'office', home = null }: { status: DashStatus | null; mode?: Mode; home?: HomeInfo | null }) {
  if (mode === 'home' && status?.unlocked) {
    return (
      <aside className="sidebar is-home">
        <HomeToday home={home} />
        <ComingUp max={2} />
        <ListCard />
        <Rotator status={status} mode="home" home={home} />
      </aside>
    )
  }
  return (
    <aside className="sidebar">
      <ComingUp />
      <ShipsLog />
      <Rotator status={status} />
    </aside>
  )
}
