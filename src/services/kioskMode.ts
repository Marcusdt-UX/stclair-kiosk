import { useEffect } from 'react'

// Kiosk helpers for running on an old phone or tablet:
//  • Screen Wake Lock — keeps the display from sleeping (re-acquired when the
//    tab becomes visible again, since browsers release it when hidden).
//    Needs HTTPS (Railway is) and a reasonably recent browser; silently skipped otherwise.
//  • Fullscreen on first tap — browsers only allow fullscreen from a user gesture.
//    Skipped when already running as an installed home-screen app.

type WakeLockSentinelLike = { release: () => Promise<void>; addEventListener?: (t: string, cb: () => void) => void }

export function useKioskMode() {
  useEffect(() => {
    let lock: WakeLockSentinelLike | null = null
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nav = navigator as any

    async function acquire() {
      try {
        if (!nav.wakeLock || document.visibilityState !== 'visible') return
        lock = await nav.wakeLock.request('screen')
        lock?.addEventListener?.('release', () => { lock = null })
      } catch {
        // Not supported / not allowed — fine
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !lock) acquire()
    }

    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      window.matchMedia?.('(display-mode: fullscreen)').matches ||
      nav.standalone === true

    const onFirstTap = () => {
      // Some browsers only grant the wake lock after a gesture
      if (!lock) acquire()
      const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void }
      if (!standalone && !document.fullscreenElement) {
        try {
          if (el.requestFullscreen) el.requestFullscreen().catch(() => {})
          else el.webkitRequestFullscreen?.()
        } catch { /* ignore */ }
      }
      window.removeEventListener('pointerdown', onFirstTap)
    }

    acquire()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pointerdown', onFirstTap)

    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pointerdown', onFirstTap)
      lock?.release().catch(() => {})
    }
  }, [])
}
