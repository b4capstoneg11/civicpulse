// First, and deliberately: it reads the URL before the Supabase client is
// imported and consumes the fragment. See src/lib/recoveryLink.ts.
import './lib/recoveryLink'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
