import { useId } from 'react'
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes } from 'react'

// Shared primitives. Every interactive element gets a visible focus-visible ring
// and touch-action:manipulation here, so individual screens can't forget them.

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-canvas'

const VARIANTS = {
  // A near-white primary is the SaaS-dashboard convention on near-black: it
  // outranks any accent fill without shouting.
  primary: 'bg-ink text-canvas hover:bg-panel active:bg-ink/90 font-medium',
  accent: 'bg-brand text-canvas hover:bg-brand-hi active:bg-brand-dim font-medium',
  success: 'bg-ok text-canvas hover:brightness-110 active:brightness-95 font-medium',
  secondary: 'bg-raised text-ink border border-line hover:bg-hover hover:border-line-strong',
  ghost: 'text-ink-soft hover:bg-raised hover:text-ink',
} as const

const SIZES = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-9 px-3.5 text-sm',
  lg: 'h-11 px-5 text-sm',
} as const

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  children,
  className = '',
  disabled,
  ...rest
}: {
  variant?: keyof typeof VARIANTS
  size?: keyof typeof SIZES
  loading?: boolean
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      // Only `disabled` while the request is in flight — never pre-emptively on invalid input.
      disabled={disabled ?? loading}
      className={`inline-flex shrink-0 items-center justify-center gap-2 rounded-lg transition-all duration-150 [touch-action:manipulation] disabled:cursor-not-allowed disabled:opacity-45 ${VARIANTS[variant]} ${SIZES[size]} ${FOCUS_RING} ${className}`}
      {...rest}
    >
      {loading ? <Spinner /> : null}
      {children}
    </button>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg
      className={`h-3.5 w-3.5 shrink-0 animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z" />
    </svg>
  )
}

/** A panel — the standard content container. */
export function Card({
  children,
  className = '',
  as: Tag = 'section',
}: {
  children: ReactNode
  className?: string
  as?: 'section' | 'div' | 'article'
}) {
  return (
    <Tag className={`rounded-xl border border-line bg-panel ${className}`}>{children}</Tag>
  )
}

/** Wraps a control with a properly associated label + optional hint and error. */
export function Field({
  label,
  hint,
  error,
  required = false,
  children,
}: {
  label: string
  hint?: string
  error?: string | null
  required?: boolean
  children: (props: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode
}) {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ')

  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[13px] font-medium text-ink">
        {label}
        {required ? null : <span className="ml-1.5 font-normal text-subtle">(optional)</span>}
      </label>
      {hint ? (
        <p id={hintId} className="mb-1.5 text-xs text-subtle">
          {hint}
        </p>
      ) : null}
      {children({
        id,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : undefined,
      })}
      {error ? (
        <p id={errorId} className="mt-1.5 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  )
}

const CONTROL =
  'w-full rounded-lg border border-line bg-raised px-3 text-sm text-ink placeholder:text-subtle transition-colors hover:border-line-strong aria-[invalid=true]:border-danger'

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${CONTROL} h-9 ${FOCUS_RING} ${className}`} {...rest} />
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${CONTROL} resize-y py-2 ${FOCUS_RING} ${className}`} {...rest} />
}

/**
 * Native selects need an explicit background and text colour, and the default
 * arrow is a black glyph that disappears on a dark field — hence the inline SVG
 * chevron and appearance-none.
 */
export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`${CONTROL} h-9 cursor-pointer appearance-none bg-[length:14px] bg-[right_0.6rem_center] bg-no-repeat pr-9 ${FOCUS_RING} ${className}`}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%236f6f6f' stroke-width='1.6' stroke-linecap='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E\")",
      }}
      {...rest}
    >
      {children}
    </select>
  )
}

/** Async status message. `aria-live` so screen readers announce it when it appears. */
export function Alert({ tone, children }: { tone: 'error' | 'info' | 'success'; children: ReactNode }) {
  const tones = {
    error: 'border-danger/30 bg-danger-wash text-danger',
    info: 'border-info/30 bg-info-wash text-info',
    success: 'border-ok/30 bg-ok-wash text-ok',
  }
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={`rounded-lg border px-3 py-2 text-[13px] ${tones[tone]}`}
    >
      {children}
    </p>
  )
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-line px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink text-pretty">{title}</p>
      {description ? <p className="mt-1.5 text-[13px] text-subtle text-pretty">{description}</p> : null}
    </div>
  )
}

/** Page heading block, so every screen leads the same way. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <div className="mb-7 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="text-[22px] font-semibold tracking-[-0.01em] text-ink text-balance">{title}</h1>
        {subtitle ? <p className="mt-1 text-[13px] text-ink-soft text-pretty">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}
