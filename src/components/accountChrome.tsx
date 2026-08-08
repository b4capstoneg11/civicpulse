/**
 * The avatar shared between the Navbar's Suspense placeholder and the lazily
 * loaded account menu. Imports nothing from Radix, so pulling it into the
 * eager Navbar costs nothing. Its non-component siblings live in lib/account.
 */
export function AccountAvatar({ initials }: { initials: string }) {
  return (
    <span
      aria-hidden="true"
      className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-raised text-[11px] font-semibold text-ink"
    >
      {initials}
    </span>
  )
}
