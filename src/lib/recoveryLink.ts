/**
 * Reads what a password-recovery link left in the URL, before anything clears it.
 *
 * Must be evaluated before the Supabase client, which is why main.tsx imports
 * it first and why this module deliberately depends on nothing: the client
 * consumes the URL fragment during construction — at import time, before React
 * mounts — and clears it. Anything waiting for a component to mount is racing
 * that, and the PASSWORD_RECOVERY event can fire before a listener exists.
 *
 * Needed because a recovery link carries no destination of its own. Supabase
 * builds it from site_url, so it lands on "/" — the resident report form — and
 * the person never reaches the page that lets them set a password. Links the
 * app generates can pass redirectTo and avoid this; one sent from the Supabase
 * dashboard cannot, and this covers that case.
 */
function params(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams()
  // Supabase uses the fragment for tokens and the query string for some errors,
  // so both are worth reading.
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : ''
  return new URLSearchParams(`${hash}&${window.location.search.replace(/^\?/, '')}`)
}

const initial = params()

/** A usable recovery link: Supabase will have established a session from it. */
export const arrivedFromRecoveryLink = initial.get('type') === 'recovery'

/**
 * Why a link failed, when it did. A spent or expired link redirects here with
 * the reason in the URL and no session — without this it lands silently on the
 * report form, which reads as "nothing happened" rather than "try again".
 *
 * Single use is the common case: clicking the same link twice always fails the
 * second time, however soon after.
 */
export const recoveryLinkError: string | null =
  initial.get('error_description')?.replace(/\+/g, ' ') ??
  initial.get('error_code') ??
  initial.get('error') ??
  null
