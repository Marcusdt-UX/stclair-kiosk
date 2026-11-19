import { useEffect, useState, type ReactNode } from 'react'
import { dashGet, familyPhotoUrl, type Bridge, type CalEvent, type Conditions, type DashStatus, type Pass, type Upcoming } from './api'
import { getSilhouette } from '../services/photoResolver'
import './Sidebar.css'

// ── helpers ─────────────────────────────────────────────────────────────────
function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []): T | null {
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

const fmtTime = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }

function Thumb({ src }: { src?: string }) {
  const [s, setS] = useState(src || getSilhouette(70))
  useEffect(() => setS(src || getSilhouette(70)), [src])
  return <img className={`sb-thumb${s.startsWith('/silhouettes/') ? ' is-sil' : ''}`} src={s} alt="" onError={() => setS(getSilhouette(70))} />
}

function Dir({ d }: { d: 'upbound' | 'downbound' }) {
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
function ComingUp() {
  const list = usePoll(() => dashGet<Upcoming[]>('/dash/upcoming'), 60_000)
  return (
    <Panel title="Coming up the river">
      {!list ? <p className="sb-empty">Checking the channel…</p>
        : list.length === 0 ? <p className="sb-empty">Nothing headed this way right now.</p>
        : (
          <ul className="sb-list">
            {list.slice(0, 3).map(v => (
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
            <img src={`https://openweathermap.org/img/wn/${w.current.icon}@2x.png`} alt="" onError={e => { e.currentTarget.style.display = 'none' }} />
            <div>
              <div className="sb-big">{w.current.tempF}°F</div>
              <div className="sb-sub">{w.current.description} · wind {w.current.windDir} {w.current.windMph}{w.current.gustMph ? `–${w.current.gustMph}` : ''} mph</div>
            </div>
          </div>
          <div className="sb-forecast">
            {w.periods.map(p => (
              <div key={p.at} className="sb-fc">
                <div className="sb-fc-time">{new Date(p.at).toLocaleTimeString([], { hour: 'numeric' })}</div>
                <img src={`https://openweathermap.org/img/wn/${p.icon}.png`} alt="" onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
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

function WatchCard({ ev }: { ev: CalEvent[] | null }) {
  const todayKey = new Date(startOfToday()).toDateString()
  const label = (e: CalEvent) => {
    const d = e.allDay ? new Date(String(e.start) + 'T00:00:00') : new Date(Number(e.start))
    const day = d.toDateString() === todayKey ? 'Today' : 'Tomorrow'
    return `${day}${e.allDay ? '' : ' · ' + fmtTime(Number(e.start))}`
  }
  return (
    <div className="sb-card">
      <h2 className="sb-title">Watch schedule</h2>
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

function Rotator({ status }: { status: DashStatus | null }) {
  const unlocked = !!status?.unlocked
  const cond = usePoll(() => dashGet<Conditions>('/dash/conditions'), 10 * 60_000)
  const bridge = usePoll(() => dashGet<Bridge | null>('/dash/bridge'), 10 * 60_000)
  const cal = usePoll(
    () => {
      if (!unlocked || !status?.features.calendar) return Promise.resolve(null)
      const from = startOfToday()
      return dashGet<CalEvent[]>(`/dash/calendar?from=${from}&to=${from + 2 * 24 * 3600 * 1000}`)
    },
    10 * 60_000, [unlocked, status?.features.calendar],
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

  const cards: { key: string; el: ReactNode }[] = [
    { key: 'cond', el: <ConditionsCard c={cond} /> },
    { key: 'bridge', el: <BridgeCard b={bridge} /> },
  ]
  if (unlocked && status?.features.calendar) cards.push({ key: 'watch', el: <WatchCard ev={cal} /> })
  if (photos && photos.length) cards.push({ key: 'photo', el: <PhotoCard names={photos} seed={idx} /> })
  const current = cards[idx % cards.length]

  return (
    <section className="sb-panel sb-rotator" onClick={() => setIdx(i => i + 1)}>
      <div key={`${current.key}-${idx}`} className="sb-fade">{current.el}</div>
      <div className="sb-dots">{cards.map((c, i) => <span key={c.key} className={i === idx % cards.length ? 'on' : ''} />)}</div>
    </section>
  )
}

// ── Sidebar ─────────────────────────────────────────────────────────────────
export function Sidebar({ status }: { status: DashStatus | null }) {
  return (
    <aside className="sidebar">
      <ComingUp />
      <ShipsLog />
      <Rotator status={status} />
    </aside>
  )
}
