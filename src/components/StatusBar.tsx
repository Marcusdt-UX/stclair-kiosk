import { useEffect, useState } from 'react'
import { useKioskStore } from '../store/kioskStore'
import './StatusBar.css'

function windDirArrow(deg: number): string {
  // Arrow points the direction wind is blowing TO
  const arrows = ['↓','↙','←','↖','↑','↗','→','↘']
  return arrows[Math.round(deg / 45) % 8]
}

export function StatusBar() {
  const weather = useKioskStore(s => s.weather)
  const [now, setNow] = useState(new Date())

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const timeStr = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  const weatherIcon = weather
    ? `https://openweathermap.org/img/wn/${weather.iconCode}.png`
    : null

  return (
    <div className="status-bar">
      {/* Clock + Date */}
      <div className="status-clock">
        <span className="status-time">{timeStr}</span>
        <span className="status-date">{dateStr}</span>
      </div>

      {/* Weather */}
      {weather && (
        <div className="status-weather">
          {weatherIcon && (
            <img src={weatherIcon} alt={weather.description} className="status-wx-icon" />
          )}
          <span className="status-temp">{weather.tempF}°F</span>
          <span className="status-wx-divider">|</span>
          <span className="status-wx-detail">
            {windDirArrow(weather.windDeg)} {weather.windDir} {weather.windSpeed} mph
          </span>
          <span className="status-wx-divider">|</span>
          <span className="status-wx-detail">Vis {weather.visibility} mi</span>
        </div>
      )}

      {/* Live badge */}
      <div className="status-live">
        <span className="status-live-dot" />
        <span>Live</span>
      </div>
    </div>
  )
}
