import { Link, NavLink, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { lazy, Suspense } from 'react'
import { ThemeToggle } from './ThemeToggle'
import { AccountAvatar } from './accountChrome'
import { accountTriggerClass, initialsOf } from '../lib/account'

// Radix's menu primitive is sizeable and only signed-in users ever see it, so
// it loads on demand rather than riding along in the resident bundle.
const AccountMenu = lazy(() => import('./AccountMenu'))

const linkBase =
  'rounded-md px-2.5 py-1.5 text-[13px] font-medium transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-canvas'

function navLinkClass({ isActive }: { isActive: boolean }) {
  return `${linkBase} ${isActive ? 'bg-raised text-ink' : 'text-ink-soft hover:bg-raised/60 hover:text-ink'}`
}

export function Navbar() {
  const { session, profile, role, canManageUsers, canManageDepartment, isFieldEngineer, isReadOnly } =
    useAuth()

  // A read-only admin reaches the same pages; the pages themselves are what
  // withhold the controls.
  const seesStaffPages = canManageDepartment || isReadOnly
  const navigate = useNavigate()

  async function handleLogout() {
    await supabase.auth.signOut()
    navigate('/')
  }

  const displayName = profile?.full_name ?? session?.user.email ?? ''
  const initials = initialsOf(displayName)

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
          <span aria-hidden="true" className="grid h-5 w-5 place-items-center rounded-[5px] bg-brand text-[11px] font-bold text-canvas">
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
              {seesStaffPages ? (
                <NavLink to="/board" className={navLinkClass}>
                  Board
                </NavLink>
              ) : null}
              {seesStaffPages ? (
                <NavLink to="/roster" className={navLinkClass}>
                  Roster
                </NavLink>
              ) : null}
              {canManageUsers || isReadOnly ? (
                <NavLink to="/users" className={navLinkClass}>
                  Team
                </NavLink>
              ) : null}
              {seesStaffPages ? (
                <NavLink to="/analytics" className={navLinkClass}>
                  Analytics
                </NavLink>
              ) : null}

              <span aria-hidden="true" className="mx-1.5 hidden h-5 w-px bg-line sm:block" />

              <ThemeToggle />

              {/* Placeholder matches the trigger's box so the header does not
                  shift while the chunk arrives. */}
              <Suspense
                fallback={
                  <span className={`${accountTriggerClass} text-ink-soft`}>
                    <AccountAvatar initials={initials} />
                    <span className="hidden max-w-[10rem] truncate sm:inline">{displayName}</span>
                    <span aria-hidden="true" className="hidden size-3.5 sm:inline" />
                  </span>
                }
              >
                <AccountMenu
                  displayName={displayName}
                  email={session.user.email ?? ''}
                  initials={initials}
                  role={role}
                  onLogout={handleLogout}
                />
              </Suspense>
            </>
          ) : (
            <>
              <NavLink to="/login" className={navLinkClass}>
                Login
              </NavLink>
              <span aria-hidden="true" className="mx-1 hidden h-5 w-px bg-line sm:block" />
              <ThemeToggle />
            </>
          )}
        </div>
      </nav>
    </header>
  )
}
