import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { captureKeyFromUrl } from './dashboard/api'

// Unlock private panels on this device if opened with ?k=<key>
captureKeyFromUrl()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
