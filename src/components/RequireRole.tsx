import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { Spinner } from './ui'
import type { Role } from '../lib/types'

const focusRing =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2'

function Gate({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="mb-2 text-xl font-semibold text-slate-900 text-balance">{title}</h1>
      <p className="mb-6 text-slate-600 text-pretty">{body}</p>
      {action}
    </div>
  )
}

/**
 * Route guard. This is a usability layer, not the security boundary — RLS in
 * Postgres is what actually stops a user reading or writing another
 * department's data.
 */
export function RequireRole({ allow, children }: { allow: Role[]; children: ReactNode }) {
  const { loading, session, profile, role } = useAuth()

  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-24 text-sm text-slate-500" role="status">
        <Spinner />
        Loading…
      </div>
    )
  }

  if (!session) {
    return (
      <Gate
        title="Sign In Required"
        body="This area is only available to council staff."
        action={
          <Link
            to="/login"
            className={`inline-flex rounded-lg bg-teal-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-teal-700 ${focusRing}`}
          >
            Go to Login
          </Link>
        }
      />
    )
  }

  if (!profile) {
    return (
      <Gate
        title="No Staff Profile"
        body="This account is signed in but has no staff profile attached. An administrator needs to provision it."
      />
    )
  }

  if (!profile.is_active) {
    return (
      <Gate
        title="Account Deactivated"
        body="This account has been deactivated. Contact your department administrator to restore access."
      />
    )
  }

  if (!role || !allow.includes(role)) {
    return (
      <Gate
        title="Not Available to You"
        body="Your role doesn’t have access to this page."
        action={
          <Link
            to="/"
            className={`inline-flex rounded-lg bg-teal-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-teal-700 ${focusRing}`}
          >
            Back to Home
          </Link>
        }
      />
    )
  }

  return <>{children}</>
}
