import { memo } from 'react'
import { Draggable } from '@hello-pangea/dnd'
import { PriorityBadge, TicketNumber } from './StatusBadge'
import { formatRelative } from '../lib/format'
import type { Issue } from '../lib/types'

function IssueCardImpl({
  issue,
  index,
  onSelect,
  dragDisabled = false,
}: {
  issue: Issue
  index: number
  // Takes the issue rather than a pre-bound closure, so the prop stays
  // referentially stable across renders and `memo` can actually bail out.
  onSelect: (issue: Issue) => void
  /** Read-only viewers still open a ticket; they just cannot move it. */
  dragDisabled?: boolean
}) {
  const onClick = () => onSelect(issue)

  return (
    <Draggable draggableId={issue.id} index={index} isDragDisabled={dragDisabled}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          role="button"
          aria-label={`Open ticket ${issue.ticket_number}`}
          onClick={onClick}
          // Space is reserved by the drag library for lifting the card, so Enter opens it.
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onClick()
            }
          }}
          className={`mb-2 cursor-pointer select-none rounded-lg border bg-panel p-3 shadow-sm transition-shadow [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1 ${
            snapshot.isDragging
              ? 'border-brand shadow-lg ring-2 ring-brand'
              : 'border-line hover:border-brand/50 hover:shadow'
          }`}
        >
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <TicketNumber value={issue.ticket_number} className="text-xs font-semibold text-brand" />
            <PriorityBadge priority={issue.priority} />
          </div>
          <p className="mb-1.5 line-clamp-2 text-sm text-ink-soft break-words">{issue.comment}</p>
          <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-subtle">
            {/* min-w-0 lets the truncate actually kick in inside a flex row. */}
            <span className="min-w-0 truncate">
              {issue.departments?.name ?? issue.issue_type} · {issue.area ?? 'Unknown area'}
            </span>
            <time dateTime={issue.created_at} className="shrink-0 tabular-nums">
              {formatRelative(issue.created_at)}
            </time>
          </div>

          {issue.assignee ? (
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-raised px-2 py-0.5 text-xs text-ink-soft">
              <span aria-hidden="true" className="text-[8px] leading-none text-brand">
                ●
              </span>
              <span className="truncate">{issue.assignee.full_name}</span>
            </span>
          ) : (
            <span className="inline-flex items-center rounded-full bg-warn-wash px-2 py-0.5 text-xs text-warn ring-1 ring-inset ring-warn/25">
              Unassigned
            </span>
          )}
        </div>
      )}
    </Draggable>
  )
}

// The board refetches on every realtime event, so without memo each change
// re-renders every card on the board.
export const IssueCard = memo(IssueCardImpl)
