import { useId } from 'react'
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes, SelectHTMLAttributes } from 'react'

// Shared primitives. Every interactive element gets a visible focus-visible ring and
// touch-action:manipulation here, so individual screens can't forget them.

const FOCUS_RING =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white'

const VARIANTS = {
  primary: 'bg-teal-600 text-white hover:bg-teal-700 active:bg-teal-800 shadow-sm',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 shadow-sm',
  secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 hover:border-slate-400',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
} as const

const SIZES = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-5 py-2.5 text-base',
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
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors duration-150 [touch-action:manipulation] disabled:cursor-not-allowed disabled:opacity-60 ${VARIANTS[variant]} ${SIZES[size]} ${FOCUS_RING} ${className}`}
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
      className={`h-4 w-4 shrink-0 animate-spin ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-90"
        fill="currentColor"
        d="M4 12a8 8 0 0 1 8-8v4a4 4 0 0 0-4 4H4z"
      />
    </svg>
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
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-800">
        {label}
        {required ? null : <span className="ml-1.5 font-normal text-slate-400">(optional)</span>}
      </label>
      {hint ? (
        <p id={hintId} className="mb-1.5 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
      {children({
        id,
        'aria-describedby': describedBy || undefined,
        'aria-invalid': error ? true : undefined,
      })}
      {error ? (
        <p id={errorId} className="mt-1.5 text-sm text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  )
}

const CONTROL =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition-colors hover:border-slate-400 aria-[invalid=true]:border-red-400'

export function Input({ className = '', ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${CONTROL} ${FOCUS_RING} ${className}`} {...rest} />
}

export function Textarea({ className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${CONTROL} resize-y ${FOCUS_RING} ${className}`} {...rest} />
}

// Native selects need explicit background/color or they inherit the OS dark theme
// and render dark-on-dark.
export function Select({ className = '', children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`${CONTROL} [color-scheme:light] ${FOCUS_RING} ${className}`} {...rest}>
      {children}
    </select>
  )
}

/** Async status message. `aria-live` so screen readers announce it when it appears. */
export function Alert({ tone, children }: { tone: 'error' | 'info' | 'success'; children: ReactNode }) {
  const tones = {
    error: 'border-red-200 bg-red-50 text-red-800',
    info: 'border-sky-200 bg-sky-50 text-sky-800',
    success: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  }
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live="polite"
      className={`rounded-lg border px-3 py-2 text-sm ${tones[tone]}`}
    >
      {children}
    </p>
  )
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="rounded-xl border border-dashed border-slate-300 px-6 py-10 text-center">
      <p className="text-sm font-medium text-slate-700 text-pretty">{title}</p>
      {description ? <p className="mt-1 text-sm text-slate-500 text-pretty">{description}</p> : null}
    </div>
  )
}
