import { create } from 'zustand'
import type { Vessel, WeatherData } from '../types'

interface KioskState {
  vessels: Record<string, Vessel>
  activePopup: Vessel | null
  popupQueue: Vessel[]
  weather: WeatherData | null
  lastActivityAt: number

  updateVessel: (partial: Partial<Vessel> & { mmsi: string }) => void
  triggerPopup: (vessel: Vessel) => void
  dismissPopup: () => void
  setWeather: (w: WeatherData) => void
}

export const useKioskStore = create<KioskState>((set, get) => ({
  vessels: {},
  activePopup: null,
  popupQueue: [],
  weather: null,
  lastActivityAt: Date.now(),

  updateVessel(partial) {
    set(state => {
      const existing = state.vessels[partial.mmsi] ?? {}
      return {
        vessels: {
          ...state.vessels,
          [partial.mmsi]: { ...existing, ...partial } as Vessel,
        },
        lastActivityAt: Date.now(),
      }
    })
  },

  triggerPopup(vessel) {
    set(state => {
      if (!state.activePopup) {
        // Get the latest full vessel data from the store
        const full = state.vessels[vessel.mmsi] ?? vessel
        return { activePopup: full }
      }
      // Already showing — queue it (avoid duplicates)
      const alreadyQueued = state.popupQueue.some(v => v.mmsi === vessel.mmsi)
      if (alreadyQueued) return {}
      return { popupQueue: [...state.popupQueue, vessel] }
    })
  },

  dismissPopup() {
    set(state => {
      const [next, ...rest] = state.popupQueue
      if (next) {
        const full = state.vessels[next.mmsi] ?? next
        return { activePopup: full, popupQueue: rest }
      }
      return { activePopup: null, popupQueue: [] }
    })

    // If there's a queued vessel, show it after a brief pause
    const { popupQueue } = get()
    if (popupQueue.length > 0) {
      setTimeout(() => {
        const { popupQueue: q, vessels } = get()
        if (q.length === 0) return
        const [next, ...rest] = q
        set({ activePopup: vessels[next.mmsi] ?? next, popupQueue: rest })
      }, 800)
    }
  },

  setWeather(w) {
    set({ weather: w })
  },
}))
