import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import {
  THEME_STORAGE_KEY,
  ThemeContext,
  type ResolvedTheme,
  type ThemePreference,
  type ThemeValue,
} from '../hooks/useTheme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

function readStored(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    // Private mode or blocked storage — fall back to following the OS.
  }
  return 'system'
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStored)
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme)

  // `system` keeps following the OS after the fact, so switching appearance at
  // the OS level updates a tab that is already open.
  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY)
    const onChange = (e: MediaQueryListEvent) => setSystem(e.matches ? 'dark' : 'light')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const resolved: ResolvedTheme = preference === 'system' ? system : preference

  // The inline script in index.html already stamped the first paint; this keeps
  // the attribute in step with later changes.
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', resolved)
    // shadcn/ui's dark variant matches a `.dark` ancestor, so both markers are
    // kept in step: data-theme drives our selectors, .dark drives theirs.
    root.classList.toggle('dark', resolved === 'dark')
    root.style.colorScheme = resolved

    const meta = document.querySelector('meta[name="theme-color"]:not([media])')
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#000000' : '#ffffff')
  }, [resolved])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    try {
      // 'system' is stored as a removal, so a fresh device follows its own OS.
      if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
      else localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Non-persistent is still usable for this session.
    }
  }, [])

  const value = useMemo<ThemeValue>(
    () => ({ preference, resolved, setPreference }),
    [preference, resolved, setPreference]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
