import { PROXY_BASE } from '../services/aisstream'

// ── Private-panel unlock ────────────────────────────────────────────────────
// Open the site once on Jazmyn's tablet as  https://<site>/?k=<KIOSK_TOKEN>
// The key is kept on the device (cookie + localStorage) and removed from the URL.
const KEY_STORE = 'kioskKey'

function readKey(): string {
  try { return localStorage.getItem(KEY_STORE) || '' } catch { return '' }
}

export function captureKeyFromUrl() {
  try {
    const url = new URL(window.location.href)
    const k = url.searchParams.get('k')
    if (!k) return
    try { localStorage.setItem(KEY_STORE, k) } catch { /* private mode */ }
    document.cookie = `kiosk=${encodeURIComponent(k)}; path=/; max-age=31536000; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`
    url.searchParams.delete('k')
    window.history.replaceState(null, '', url.pathname + url.search + url.hash)
  } catch { /* ignore */ }
}

export async function dashGet<T>(path: string): Promise<T> {
  const key = readKey()
  const res = await fetch(`${PROXY_BASE}${path}`, {
    credentials: 'same-origin',
    headers: key ? { 'x-kiosk-token': key } : {},
  })
  if (!res.ok) throw new Error(`${path} ${res.status}`)
  return res.json() as Promise<T>
}

export async function dashPost<T>(path: string, body: unknown): Promise<T> {
  const key = readKey()
  const res = await fetch(`${PROXY_BASE}${path}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(key ? { 'x-kiosk-token': key } : {}) },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((data as { error?: string }).error || `Error ${res.status}`)
  return data as T
}

/** URL for a private family photo (sent with the cookie; header fallback not possible for <img>) */
export function familyPhotoUrl(name: string) {
  return `${PROXY_BASE}/dash/photos/${encodeURIComponent(name)}`
}

// ── Types ───────────────────────────────────────────────────────────────────
export interface DashStatus {
  unlocked: boolean
  features: { calendar: boolean; photos: boolean; ask: boolean; privateKeySet: boolean }
}
export interface Pass {
  mmsi: string; at: number; name: string; direction: 'upbound' | 'downbound'
  speed: number; photo?: string; operator?: string; destination?: string
}
export interface Upcoming {
  mmsi: string; name: string; direction: 'upbound' | 'downbound'
  etaMinutes: number; speed: number; photo?: string; operator?: string
}
export interface Conditions {
  weather: null | {
    sunrise: number | null; sunset: number | null
    current: { tempF: number; feelsLikeF: number; windMph: number; gustMph: number | null; windDir: string; description: string; icon: string }
    periods: { at: number; tempF: number; icon: string; description: string; windMph: number; pop: number }[]
  }
  river: null | { levelFt?: number; levelAt?: number; change24hIn?: number; flowCfs?: number }
}
export interface Lane { status: string; minutes: number | null; lanes: number | null; updated: string }
export interface Bridge { name: string; portStatus: string; cars: Lane | null; nexus: Lane | null; trucks: Lane | null }
export interface CalEvent { title: string; allDay: boolean; start: number | string; end: number | string; location?: string }
