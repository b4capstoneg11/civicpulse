import { ChevronDownIcon, LogOutIcon } from 'lucide-react'
import { ROLE_LABELS } from '../lib/labels'
import type { Role } from '../lib/types'
import { AccountAvatar } from './accountChrome'
import { accountTriggerClass } from '../lib/account'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * The signed-in account menu. Split into its own module so Radix's menu
 * primitive is not in the bundle every resident downloads — the Navbar is
 * eager, but this renders only once someone has logged in. The shared trigger
 * chrome lives in ./accountChrome so the Navbar's Suspense placeholder can
 * match this box without importing Radix.
 */
export default function AccountMenu({
  displayName,
  email,
  initials,
  role,
  onLogout,
}: {
  displayName: string
  email: string
  initials: string
  role: Role | null
  onLogout: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={`${accountTriggerClass} text-ink-soft hover:bg-raised/60 hover:text-ink data-[state=open]:bg-raised data-[state=open]:text-ink`}
        aria-label={`Account menu for ${displayName}`}
      >
        <AccountAvatar initials={initials} />
        <span className="hidden max-w-[10rem] truncate sm:inline">{displayName}</span>
        <ChevronDownIcon aria-hidden="true" className="hidden size-3.5 opacity-60 sm:inline" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-60">
        {/* The label carries the identity the trigger truncates: the email is
            what you actually sign in with. */}
        <DropdownMenuLabel className="font-normal">
          <span className="block truncate text-[13px] font-medium text-ink">{displayName}</span>
          <span className="block truncate text-[11px] text-subtle">{email}</span>
          {role ? <span className="mt-1 block text-[11px] text-subtle">{ROLE_LABELS[role]}</span> : null}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout}>
          <LogOutIcon aria-hidden="true" />
          Log Out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
