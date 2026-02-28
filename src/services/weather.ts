import type { WeatherData } from '../types'
import { PORT_HURON_LAT, PORT_HURON_LON } from '../constants/bounds'

function degToCompass(deg: number): string {
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return dirs[Math.round(deg / 22.5) % 16]
}

export async function fetchWeather(apiKey: string): Promise<WeatherData> {
  const url =
    `https://api.openweathermap.org/data/2.5/weather` +
    `?lat=${PORT_HURON_LAT}&lon=${PORT_HURON_LON}` +
    `&units=imperial&appid=${apiKey}`

  const res = await fetch(url)
  if (!res.ok) throw new Error(`Weather API ${res.status}`)
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
