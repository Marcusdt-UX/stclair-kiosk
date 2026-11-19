import type { WeatherData } from '../types'
import { PROXY_BASE } from './aisstream'

function degToCompass(deg: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return dirs[Math.round(deg / 22.5) % 16]
}

// Weather comes through our own proxy (GET /weather), which holds the
// OpenWeather key server-side. The browser never sees the key.
export async function fetchWeather(): Promise<WeatherData> {
  const res = await fetch(`${PROXY_BASE}/weather`)
  if (!res.ok) throw new Error(`Weather proxy ${res.status}`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = await res.json() as any

  return {
    tempF: Math.round(d.main.temp),
    feelsLikeF: Math.round(d.main.feels_like),
    windSpeed: Math.round(d.wind.speed),
    windDeg: d.wind.deg ?? 0,
    windDir: degToCompass(d.wind.deg ?? 0),
    visibility: Math.round((d.visibility ?? 10000) / 1609.34), // m → miles
    description: d.weather?.[0]?.description ?? '',
    iconCode: d.weather?.[0]?.icon ?? '01d',
  }
}
