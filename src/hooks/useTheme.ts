import { createContext, useContext } from 'react'

/** What the user chose. `system` follows the OS and keeps following it. */
export type ThemePreference = 'light' | 'dark' | 'system'

/** What is actually on screen once `system` has been resolved. */
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'civicpulse-theme'

export interface ThemeValue {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (next: ThemePreference) => void
}

export const ThemeContext = createContext<ThemeValue | null>(null)

/**
 * Charts read this to pick their palette: series colours are written as inline
 * SVG attributes (so the PDF export can serialise them), which means they cannot
 * come from a CSS variable and have to be chosen in JS.
 */
export function useTheme(): ThemeValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error('useTheme must be used inside a ThemeProvider')
  return context
}
