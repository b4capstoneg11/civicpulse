import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { ROLE_HOME } from '../lib/labels'
import { Alert, Button, Field, Input, Spinner } from '../components/ui'
import type { Role } from '../lib/types'

/** Matches what manage-users enforces, so the rule does not change per route. */
const MIN_LENGTH = 8

type Status = 'checking' | 'ready' | 'invalid'

/**
 * Where an invite or a password-reset link lands.
 *
 * Both flows arrive the same way: Supabase puts tokens in the URL fragment, the
 * client consumes them at import time and establishes a session before React
 * mounts. So the test for "is this link good?" is simply whether a session
 * exists — which is why one page serves both, and why nothing here parses the
 * URL itself.
 *
 * The account has no password until this succeeds, which is the point of the
 * invite model: the admin never chooses or learns it, and an address that was
 * mistyped can never be activated at all.
 */
export function SetPassword() {
  const [status, setStatus] = useState<Status>('checking')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    let cancelled = false

    // Subscribed as well as polled: getSession() waits for the client's initial
    // URL handling, but a session that arrives after this mounts should still
    // flip an "invalid" verdict back to ready rather than stranding the user.
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!cancelled && session) setStatus('ready')
    })

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return
      setStatus(data.session ? 'ready' : 'invalid')
    })

    return () => {
      cancelled = true
      subscription.subscription.unsubscribe()
    }
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (password.length < MIN_LENGTH) {
      setError(`Use at least ${MIN_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError('Those two passwords don’t match.')
      return
    }

    setSubmitting(true)
    const { data, error: updateError } = await supabase.auth.updateUser({ password })

    if (updateError || !data.user) {
      setSubmitting(false)
      setError(updateError?.message ?? 'Could not set the password. Try the link again.')
      return
    }

    // Signed in already, so send them where their role belongs — the same
    // lookup the login page does, for the same reason: the role comes from the
    // database, not from anything the client decided.
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, is_active')
      .eq('id', data.user.id)
      .single()

    setSubmitting(false)

    if (!profile) {
      setError('Your password is set, but this account has no staff profile. Ask an administrator.')
      return
    }
    if (!profile.is_active) {
      setError('Your password is set, but this account is deactivated. Contact your administrator.')
      return
    }

    navigate(ROLE_HOME[profile.role as Role] ?? '/', { replace: true })
  }

  if (status === 'checking') {
    return (
      <div className="mx-auto max-w-sm px-4 py-24">
        <p className="flex items-center gap-2 text-sm text-subtle" role="status">
          <Spinner />
          Checking your link…
        </p>
      </div>
    )
  }

  if (status === 'invalid') {
    return (
      <div className="mx-auto max-w-sm px-4 py-24 text-center">
        <h1 className="mb-2 text-2xl font-semibold text-ink text-balance">This Link Has Expired</h1>
        <p className="mb-6 text-sm text-ink-soft text-pretty">
          Invitation and reset links are single-use and time-limited. Ask an administrator to send a
          new one, or reset your password from the login page.
        </p>
        <Link
          to="/login"
          className="inline-flex rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-brand-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          Go to Login
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <h1 className="mb-1 text-2xl font-semibold text-ink text-balance">Choose a Password</h1>
      <p className="mb-8 text-sm text-ink-soft text-pretty">
        Pick something only you know — nobody else, including administrators, can see it. You&rsquo;ll
        use it with your email address to sign in from now on.
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="New Password" required hint={`At least ${MIN_LENGTH} characters.`}>
          {(props) => (
            <Input
              {...props}
              type="password"
              name="new-password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>

        <Field label="Confirm Password" required>
          {(props) => (
            <Input
              {...props}
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          )}
        </Field>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <Button type="submit" size="lg" loading={submitting} className="w-full">
          {submitting ? 'Saving…' : 'Set Password and Continue'}
        </Button>
      </form>
    </div>
  )
}
