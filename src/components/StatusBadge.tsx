import { PRIORITY_LABELS, STATUS_LABELS } from '../lib/labels'
import type { IssueStatus, Priority } from '../lib/types'

// Tinted wash + 1px ring rather than a solid fill: on near-black a saturated
// block shouts, while a wash reads as state without competing with the data.
const STATUS_STYLES: Record<IssueStatus, string> = {
  created: 'bg-raised text-ink-soft ring-line-strong',
  assigned: 'bg-info-wash text-info ring-info/25',
  in_progress: 'bg-warn-wash text-warn ring-warn/25',
  resolved: 'bg-ok-wash text-ok ring-ok/25',
  closed: 'bg-raised text-muted ring-line',
  reopened: 'bg-danger-wash text-danger ring-danger/25',
}

export function StatusBadge({ status }: { status: IssueStatus }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${STATUS_STYLES[status]}`}
    >
      {STATUS_LABELS[status]}
    </span>
  )
}

const PRIORITY_STYLES: Record<Priority, string> = {
  low: 'bg-raised text-muted ring-line',
  medium: 'bg-warn-wash text-warn ring-warn/25',
  high: 'bg-danger-wash text-danger ring-danger/25',
}

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${PRIORITY_STYLES[priority]}`}
    >
      {/* Colour alone can't carry priority for colour-blind users, so the label spells it out. */}
      <span aria-hidden="true" className="text-[7px] leading-none">
        ●
      </span>
      {PRIORITY_LABELS[priority]}
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
