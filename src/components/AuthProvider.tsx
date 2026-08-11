import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
import { arrivedFromRecoveryLink, recoveryLinkError } from '../lib/recoveryLink'
import { AuthContext, type AuthValue } from '../hooks/useAuth'
import type { Profile } from '../lib/types'

const PROFILE_COLUMNS =
  'id, full_name, role, department_id, is_active, phone, created_by, created_at, departments(id, slug, name)'

/**
 * Holds the session and staff profile once for the whole app. Without this,
 * every screen calling useAuth would open its own auth listener and refetch
 * the profile.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate()
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [profileLoading, setProfileLoading] = useState(false)

  useEffect(() => {
    // Two triggers for the same thing, because either alone can miss it. The
    // event is the clean signal but may fire before this subscribes; the flag
    // is captured at page load and cannot be missed, but says nothing about
    // links that arrive later in the session.
    // A failed link is routed there too, so the reason can be shown instead of
    // leaving someone on the report form wondering whether anything happened.
    if (arrivedFromRecoveryLink || recoveryLinkError) {
      navigate('/set-password', { replace: true })
    }

    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setSessionLoading(false)
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((event, newSession) => {
      setSession(newSession)

      // A recovery link carries no destination of its own: Supabase builds it
      // from site_url, so it lands on "/" — the resident report form — with the
      // tokens in the fragment, and the person never reaches the page that lets
      // them set a password. Catching the event here works however the link was
      // produced, including one sent from the Supabase dashboard, where no
      // redirect can be specified at all.
      if (event === 'PASSWORD_RECOVERY') {
        navigate('/set-password', { replace: true })
      }
    })

    return () => subscription.subscription.unsubscribe()
  }, [navigate])

  useEffect(() => {
    if (!session) {
      setProfile(null)
      setProfileLoading(false)
      return
    }

    let cancelled = false
    setProfileLoading(true)

    supabase
      .from('profiles')
      .select(PROFILE_COLUMNS)
      .eq('id', session.user.id)
      .single()
      .then(({ data }) => {
        if (cancelled) return
        setProfile((data as Profile | null) ?? null)
        setProfileLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [session])

  const value = useMemo<AuthValue>(() => {
    const role = profile?.role ?? null
    // A deactivated account keeps its JWT until expiry, so capability checks
    // must look at is_active rather than the session alone.
    const active = profile?.is_active !== false
    const isSuperAdmin = active && role === 'super_admin'
    const isDeptAdmin = active && role === 'dept_admin'
    const isReadOnly = active && role === 'readonly_admin'

    return {
      session,
      profile,
      loading: sessionLoading || profileLoading,
      role,
      isSuperAdmin,
      isReadOnly,
      // Scope, deliberately separate from capability: a read-only admin sees
      // every department but may change nothing, so the two questions the UI
      // used to answer with `isSuperAdmin` alone have to be asked apart.
      hasGlobalScope: isSuperAdmin || isReadOnly,
      canManageDepartment: isSuperAdmin || isDeptAdmin,
      canManageUsers: isSuperAdmin || isDeptAdmin,
      isFieldEngineer: active && role === 'field_engineer',
      departmentId: profile?.department_id ?? null,
    }
  }, [session, profile, sessionLoading, profileLoading])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
