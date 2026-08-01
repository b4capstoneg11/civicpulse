import { createContext, useContext } from 'react'
import type { Session } from '@supabase/supabase-js'
import type { Profile, Role } from '../lib/types'

// Context and hook live apart from the provider component: a module that exports
// both components and plain functions loses its Fast Refresh boundary.

export interface AuthValue {
  session: Session | null
  profile: Profile | null
  /** True until both the session *and* the profile have settled. */
  loading: boolean
  role: Role | null
  isSuperAdmin: boolean
  /** A super admin has every department admin capability, everywhere. */
  canManageDepartment: boolean
  canManageUsers: boolean
  isFieldEngineer: boolean
  departmentId: string | null
}

export const AuthContext = createContext<AuthValue | null>(null)

export function useAuth(): AuthValue {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used inside an AuthProvider')
  return context
}
