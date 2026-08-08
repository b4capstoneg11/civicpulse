/**
 * Helpers shared between the Navbar's Suspense placeholder and the lazily
 * loaded account menu.
 *
 * These live outside the component files on purpose. If the Navbar imported
 * them from AccountMenu, that static import would drag Radix's menu primitive
 * back into the eager bundle and undo the code split.
 */
export const accountTriggerClass =
  'flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-canvas'

/** First letters of the first two words, so "Asha Rao" reads as AR. */
export function initialsOf(name: string) {
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
  return letters.toUpperCase() || '?'
}
