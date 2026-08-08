import { useTheme, type ThemePreference } from '../hooks/useTheme'

// A three-way segmented control rather than a two-state flip: a blind toggle
// makes "follow my OS" unreachable once it has been touched.
const OPTIONS: { key: ThemePreference; label: string; icon: string }[] = [
  { key: 'light', label: 'Light', icon: '☀' },
  { key: 'dark', label: 'Dark', icon: '☾' },
  { key: 'system', label: 'System', icon: '◐' },
]

export function ThemeToggle() {
  const { preference, resolved, setPreference } = useTheme()

  return (
    <div
      role="radiogroup"
      aria-label="Colour theme"
      className="flex items-center gap-0.5 rounded-lg border border-line bg-raised p-0.5"
    >
      {OPTIONS.map((o) => {
        const active = preference === o.key
        const label = o.key === 'system' ? `System (${resolved})` : o.label
        return (
          // Deliberately a native `title` rather than the Radix Tooltip used on
          // staff pages: this control is in the header every resident loads, and
          // measuring showed Radix's tooltip adds 26 kB gzipped to that path.
          // The aria-label is what carries the meaning; `title` is the hover hint.
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={
              o.key === 'system' ? `System theme (currently ${resolved})` : `${o.label} theme`
            }
            title={label}
            onClick={() => setPreference(o.key)}
            className={`grid h-6 w-6 place-items-center rounded-md text-[12px] leading-none transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 focus-visible:ring-offset-canvas ${
              active
                ? 'bg-panel text-ink shadow-sm'
                : 'text-subtle hover:text-ink-soft'
            }`}
          >
            <span aria-hidden="true">{o.icon}</span>
          </button>
        )
      })}
    </div>
  )
}
