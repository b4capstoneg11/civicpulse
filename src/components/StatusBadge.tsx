import { PRIORITY_LABELS, STATUS_LABELS } from '../lib/labels'
import type { IssueStatus, Priority } from '../lib/types'

const STATUS_STYLES: Record<IssueStatus, string> = {
  created: 'bg-slate-100 text-slate-700 ring-slate-200',
  assigned: 'bg-blue-50 text-blue-700 ring-blue-200',
  in_progress: 'bg-amber-50 text-amber-800 ring-amber-200',
  resolved: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  closed: 'bg-slate-100 text-slate-500 ring-slate-200',
  reopened: 'bg-rose-50 text-rose-700 ring-rose-200',
}

export function StatusBadge({ status }: { status: IssueStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  )
}

const PRIORITY_STYLES: Record<Priority, string> = {
  low: 'bg-slate-100 text-slate-600 ring-slate-200',
  medium: 'bg-orange-50 text-orange-700 ring-orange-200',
  high: 'bg-red-50 text-red-700 ring-red-200',
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${PRIORITY_STYLES[priority]}`}
    >
      {/* Colour alone can't carry priority for colour-blind users, so the label spells it out. */}
      <span aria-hidden="true" className="text-[8px] leading-none">
        ●
      </span>
      {PRIORITY_LABELS[priority]} Priority
    </span>
  )
}

/** Ticket IDs are identifiers: never translated, and monospaced so digits line up. */
export function TicketNumber({
  value,
  className = '',
  id,
}: {
  value: string
  className?: string
  id?: string
}) {
  return (
    <span id={id} translate="no" className={`font-mono tabular-nums tracking-tight ${className}`}>
      {value}
    </span>
  )
}
