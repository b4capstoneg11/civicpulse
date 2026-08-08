import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { ROLE_HOME } from '../lib/labels'
import { Alert, Button, Field, Input } from '../components/ui'
import type { Role } from '../lib/types'

export function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const navigate = useNavigate()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)

    const { data, error: signInError } = await supabase.auth.signInWithPassword({ email, password })

    if (signInError) {
      setSubmitting(false)
      setError(`${signInError.message}. Check your email and password, then try again.`)
      return
    }

    // The role is read from the database, not chosen at sign-in — whoever you
    // are is whatever your profiles row says. Read it directly here rather than
    // waiting for the auth context to catch up with the brand-new session.
    const { data: profile } = await supabase
      .from('profiles')
      .select('role, is_active')
      .eq('id', data.user.id)
      .single()

    setSubmitting(false)

    if (!profile) {
      setError('This account has no staff profile attached. Ask an administrator to provision it.')
      return
    }
    if (!profile.is_active) {
      setError('This account has been deactivated. Contact your department administrator.')
      return
    }

    navigate(ROLE_HOME[profile.role as Role] ?? '/', { replace: true })
  }

  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <h1 className="mb-1 text-2xl font-semibold text-ink text-balance">Login</h1>
      <p className="mb-8 text-sm text-ink-soft text-pretty">
        Sign in and we’ll take you to the right place — your role is read from your account, so there’s
        nothing to choose here. Accounts are provisioned by an administrator.
      </p>

      <form onSubmit={handleSubmit} className="space-y-5">
        <Field label="Email Address" required>
          {(props) => (
            <Input
              {...props}
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@department.gov…"
            />
          )}
        </Field>

        <Field label="Password" required>
          {(props) => (
            <Input
              {...props}
              type="password"
              name="password"
              autoComplete="current-password"
              spellCheck={false}
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <Button type="submit" size="lg" loading={submitting} className="w-full">
          {submitting ? 'Signing In…' : 'Sign In'}
        </Button>
      </form>
    </div>
  )
}
