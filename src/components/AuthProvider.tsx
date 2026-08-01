import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabaseClient'
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
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [sessionLoading, setSessionLoading] = useState(true)
  const [profileLoading, setProfileLoading] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setSessionLoading(false)
    })

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })

    return () => subscription.subscription.unsubscribe()
  }, [])

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

    return {
      session,
      profile,
      loading: sessionLoading || profileLoading,
      role,
      isSuperAdmin,
      canManageDepartment: isSuperAdmin || isDeptAdmin,
      canManageUsers: isSuperAdmin || isDeptAdmin,
      isFieldEngineer: active && role === 'field_engineer',
      departmentId: profile?.department_id ?? null,
    }
  }, [session, profile, sessionLoading, profileLoading])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
