import { memo } from 'react'
import { Droppable } from '@hello-pangea/dnd'
import { IssueCard } from './IssueCard'
import { STATUS_LABELS } from '../lib/labels'
import type { Issue, IssueStatus } from '../lib/types'

function KanbanColumnImpl({
  status,
  issues,
  onSelect,
}: {
  status: IssueStatus
  issues: Issue[]
  onSelect: (issue: Issue) => void
}) {
  return (
    <section
      aria-label={`${STATUS_LABELS[status]} (${issues.length})`}
      className="flex w-72 shrink-0 flex-col rounded-xl bg-raised p-3"
    >
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h2 className="text-sm font-semibold text-ink-soft">{STATUS_LABELS[status]}</h2>
        <span className="rounded-full bg-raised px-2 py-0.5 text-xs font-medium tabular-nums text-ink-soft">
          {issues.length}
        </span>
      </div>

      <Droppable droppableId={status}>
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={`min-h-24 flex-1 rounded-lg transition-colors ${
              snapshot.isDraggingOver ? 'bg-accent-wash ring-2 ring-inset ring-accent/40' : ''
            }`}
          >
            {issues.length === 0 && !snapshot.isDraggingOver ? (
              <p className="px-2 py-6 text-center text-xs text-muted">No tickets</p>
            ) : null}
            {issues.map((issue, index) => (
              <IssueCard key={issue.id} issue={issue} index={index} onSelect={onSelect} />
            ))}
            {provided.placeholder}
          </div>
        )}
      </Droppable>
    </section>
  )
}

export const KanbanColumn = memo(KanbanColumnImpl)
