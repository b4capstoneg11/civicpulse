import { Link, NavLink, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { ROLE_LABELS } from '../lib/labels'
import { Button } from './ui'

const linkBase =
  'rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2'

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `${linkBase} ${isActive ? 'bg-teal-50 text-teal-800' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`
}

export function Navbar() {
  const { session, profile, role, canManageUsers, canManageDepartment, isFieldEngineer } = useAuth()
  const navigate = useNavigate()

  async function handleLogout() {
    await supabase.auth.signOut()
    navigate('/')
  }

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/90 backdrop-blur-sm">
      <nav
        aria-label="Main"
        className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6"
      >
        <Link
          to="/"
          className={`${linkBase} -ml-2.5 text-lg font-semibold text-teal-700 hover:bg-teal-50`}
        >
          <span translate="no">CivicPulse</span>
        </Link>

        <div className="flex flex-wrap items-center gap-1">
          {/* Reporting and tracking are resident journeys. Staff have the board
              and their own queue instead, so these are hidden once signed in —
              the routes stay reachable by URL for shared ticket links. */}
          {session ? null : (
            <>
              <NavLink to="/" end className={navLinkClass}>
                Report an Issue
              </NavLink>
              <NavLink to="/track" className={navLinkClass}>
                Track a Ticket
              </NavLink>
            </>
          )}

          {session ? (
            <>
              {isFieldEngineer ? (
                <NavLink to="/my-work" className={navLinkClass}>
                  My Work
                </NavLink>
              ) : null}
              {canManageDepartment ? (
                <NavLink to="/board" className={navLinkClass}>
                  Board
                </NavLink>
              ) : null}
              {canManageDepartment ? (
                <NavLink to="/roster" className={navLinkClass}>
                  Roster
                </NavLink>
              ) : null}
              {canManageUsers ? (
                <NavLink to="/users" className={navLinkClass}>
                  Team
                </NavLink>
              ) : null}
              {canManageDepartment ? (
                <NavLink to="/analytics" className={navLinkClass}>
                  Analytics
                </NavLink>
              ) : null}

              <span className="ml-1 hidden max-w-[14rem] flex-col items-end truncate text-right sm:flex">
                <span className="truncate text-sm text-slate-600">
                  {profile?.full_name ?? session.user.email}
                </span>
                {role ? <span className="text-xs text-slate-400">{ROLE_LABELS[role]}</span> : null}
              </span>

              <Button variant="ghost" size="sm" onClick={handleLogout}>
                Log Out
              </Button>
            </>
          ) : (
            <NavLink to="/login" className={navLinkClass}>
              Login
            </NavLink>
          )}
        </div>
      </nav>
    </header>
  )
}
