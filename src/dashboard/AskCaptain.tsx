import { useEffect, useRef, useState } from 'react'
import { dashPost, type Mode } from './api'
import { blobToWavBase64 } from './wav'
import './AskCaptain.css'

// Tap-to-talk. The microphone is only open while "Listening…" is showing,
// and is released right after. Audio goes to our server, which asks Gemini
// (paid tier, store:false) and keeps nothing. The answer is spoken by the
// tablet's own voice, so the reply never leaves the device as audio.

type Phase = 'idle' | 'listening' | 'thinking' | 'answer' | 'error'
const MAX_SECONDS = 12

export function AskCaptain({ mode = 'office' }: { mode?: Mode }) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [heard, setHeard] = useState('')
  const [answer, setAnswer] = useState('')
  const [secs, setSecs] = useState(0)
  const recRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunks = useRef<Blob[]>([])
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = [] }
  const releaseMic = () => { streamRef.current?.getTracks().forEach(t => t.stop()); streamRef.current = null }

  useEffect(() => () => { clearTimers(); releaseMic(); window.speechSynthesis?.cancel() }, [])

  function fail(msg: string) {
    releaseMic()
    setAnswer(msg)
    setPhase('error')
    timers.current.push(setTimeout(() => setPhase('idle'), 8000))
  }

  async function start() {
    window.speechSynthesis?.cancel()
    clearTimers()
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return fail('Voice questions aren’t supported on this device.')
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      streamRef.current = stream
      const rec = new MediaRecorder(stream)
      chunks.current = []
      rec.ondataavailable = e => { if (e.data.size) chunks.current.push(e.data) }
      rec.onstop = () => { releaseMic(); send(new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' })) }
      recRef.current = rec
      rec.start()
      setHeard(''); setAnswer(''); setSecs(0); setPhase('listening')
      for (let s = 1; s <= MAX_SECONDS; s++) timers.current.push(setTimeout(() => setSecs(s), s * 1000))
      timers.current.push(setTimeout(stop, MAX_SECONDS * 1000))
    } catch {
      fail('I need permission to use the microphone.')
    }
  }

  function stop() {
    clearTimers()
    if (recRef.current?.state === 'recording') recRef.current.stop()
  }

  async function send(blob: Blob) {
    setPhase('thinking')
    try {
      const audio = await blobToWavBase64(blob)
      const res = await dashPost<{ heard: string; answer: string }>('/dash/ask', { audio, mime: 'audio/wav', mode })
      setHeard(res.heard || '')
      setAnswer(res.answer || 'Sorry, I didn’t catch that.')
      setPhase('answer')
      speak(res.answer)
      timers.current.push(setTimeout(() => setPhase('idle'), 30_000))
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Something went wrong.')
    }
  }

  function speak(text: string) {
    const synth = window.speechSynthesis
    if (!synth || !text) return
    const u = new SpeechSynthesisUtterance(text)
    const voices = synth.getVoices().filter(v => v.lang?.startsWith('en'))
    u.voice = voices.find(v => /natural|neural|enhanced|premium/i.test(v.name)) || voices.find(v => v.lang === 'en-US') || voices[0] || null
    u.rate = 1
    synth.speak(u)
  }

  function dismiss() { clearTimers(); window.speechSynthesis?.cancel(); setPhase('idle') }

  return (
    <>
      <button
        className={`ask-btn${phase === 'listening' ? ' is-listening' : ''}`}
        onClick={phase === 'listening' ? stop : phase === 'thinking' ? undefined : start}
        aria-label="Ask the Captain"
      >
        <span className="ask-btn-icon">{phase === 'listening' ? '■' : '🎙'}</span>
        <span className="ask-btn-label">{phase === 'listening' ? 'Done' : 'Ask the Captain'}</span>
      </button>

      {phase !== 'idle' && (
        <div className="ask-card" onClick={phase === 'answer' || phase === 'error' ? dismiss : undefined}>
          {phase === 'listening' && (
            <>
              <div className="ask-wave"><span /><span /><span /><span /><span /></div>
              <p className="ask-status">{mode === 'home' ? 'Listening… ask about a ship, the weather, your list — anything.' : 'Listening… ask about a ship, the river, the weather — anything.'}</p>
              <p className="ask-hint">Tap “Done” when you’re finished · {MAX_SECONDS - secs}s</p>
            </>
          )}
          {phase === 'thinking' && <p className="ask-status">The Captain is thinking…</p>}
          {phase === 'answer' && (
            <>
              {heard && <p className="ask-heard">“{heard}”</p>}
              <p className="ask-answer">{answer}</p>
              <p className="ask-hint">Tap to close · answers can be wrong</p>
            </>
          )}
          {phase === 'error' && <p className="ask-status">{answer}</p>}
        </div>
      )}
    </>
  )
}
