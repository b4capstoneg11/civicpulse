// Intl formatters are expensive to construct, so build them once at module level
// rather than per render. Locale follows the browser instead of being hardcoded.

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const dateFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function formatDateTime(iso: string): string {
  return dateTimeFormatter.format(new Date(iso))
}

export function formatDate(iso: string): string {
  return dateFormatter.format(new Date(iso))
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** "3 hours ago" / "yesterday" — falls back to an absolute date past a week. */
export function formatRelative(iso: string): string {
  const elapsed = Date.now() - new Date(iso).getTime()

  if (elapsed < HOUR) return relativeFormatter.format(-Math.round(elapsed / MINUTE), 'minute')
  if (elapsed < DAY) return relativeFormatter.format(-Math.round(elapsed / HOUR), 'hour')
  if (elapsed < 7 * DAY) return relativeFormatter.format(-Math.round(elapsed / DAY), 'day')
  return dateFormatter.format(new Date(iso))
}

/** Joins location parts, dropping the empty ones, with an em-dash-free separator. */
export function joinParts(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(', ')
}
