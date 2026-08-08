import { Link, NavLink, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { ROLE_LABELS } from '../lib/labels'
import { Button } from './ui'

const linkBase =
  'rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas'

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `${linkBase} ${isActive ? 'bg-raised text-ink' : 'text-ink-soft hover:bg-raised/60 hover:text-ink'}`
}

export function Navbar() {
  const { session, profile, role, canManageUsers, canManageDepartment, isFieldEngineer } = useAuth()
  const navigate = useNavigate()

  async function handleLogout() {
    await supabase.auth.signOut()
    navigate('/')
  }

  return (
    // A translucent hairline bar over near-black; the blur keeps content legible
    // as it scrolls beneath.
    <header className="sticky top-0 z-40 border-b border-line bg-canvas/80 backdrop-blur-xl">
      <nav
        aria-label="Main"
        className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2.5 sm:px-6"
      >
        <Link
          to="/"
          className={`${linkBase} -ml-2.5 flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em] text-ink hover:bg-raised/60`}
        >
          <span aria-hidden="true" className="grid h-5 w-5 place-items-center rounded-[5px] bg-accent text-[11px] font-bold text-canvas">
            C
          </span>
          <span translate="no">CivicPulse</span>
        </Link>

        <div className="flex flex-wrap items-center gap-1">
          {/* Reporting and tracking are resident journeys — hidden once staff sign
              in. The routes stay reachable so shared ticket links still work. */}
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

              <span aria-hidden="true" className="mx-1.5 hidden h-5 w-px bg-line sm:block" />

              <span className="hidden max-w-[13rem] flex-col items-end truncate text-right sm:flex">
                <span className="truncate text-[13px] font-medium text-ink">
                  {profile?.full_name ?? session.user.email}
                </span>
                {role ? <span className="text-[11px] text-muted">{ROLE_LABELS[role]}</span> : null}
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
