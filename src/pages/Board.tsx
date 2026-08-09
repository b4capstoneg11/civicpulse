import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DragDropContext, type DropResult } from '@hello-pangea/dnd'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { KanbanColumn } from '../components/KanbanColumn'
import { IssueDetailModal } from '../components/IssueDetailModal'
import { Alert, EmptyState } from '../components/ui'
import { FieldSelect } from '../components/FieldSelect'
import { BoardSkeleton } from '../components/Skeletons'
import type { Department, Issue, IssueStatus, Profile } from '../lib/types'

const COLUMNS: IssueStatus[] = ['created', 'assigned', 'in_progress', 'resolved', 'reopened', 'closed']

const EMPTY_BY_STATUS: Record<IssueStatus, Issue[]> = {
  created: [],
  assigned: [],
  in_progress: [],
  resolved: [],
  closed: [],
  reopened: [],
}

export function Board() {
  const { session, profile, isSuperAdmin, departmentId } = useAuth()
  const [searchParams, setSearchParams] = useSearchParams()

  const [issues, setIssues] = useState<Issue[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [engineers, setEngineers] = useState<Profile[]>([])
  // Only a snapshot of the clicked card. What the modal actually renders is
  // re-read from `issues` below — see `selectedIssue`.
  const [selectedSnapshot, setSelectedSnapshot] = useState<Issue | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters live in the URL so a filtered board can be bookmarked and shared.
  // A dept_admin is pinned to their own department — RLS would hide other
  // departments' tickets anyway, but pinning keeps the UI honest about it.
  const filterDepartment = isSuperAdmin ? (searchParams.get('department') ?? '') : (departmentId ?? '')
  const filterPriority = searchParams.get('priority') ?? ''
  const filterArea = searchParams.get('area') ?? ''
  const filterAssignee = searchParams.get('assignee') ?? ''

  // Realtime bumps this instead of calling the loader directly — that avoids the
  // subscription capturing a stale loader closure with the original filter values.
  const [refreshToken, setRefreshToken] = useState(0)

  const actorLabel = profile?.full_name ?? session?.user.email ?? 'staff'

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(searchParams)
    if (value) {
      next.set(key, value)
    } else {
      next.delete(key)
    }
    setSearchParams(next, { replace: true })
  }

  useEffect(() => {
    supabase
      .from('departments')
      .select('*')
      .order('name')
      .then(({ data }) => setDepartments(data ?? []))
  }, [])

  // Engineer list drives the "assigned to" filter.
  useEffect(() => {
    if (!session) return

    let query = supabase.from('profiles').select('*').eq('role', 'field_engineer').order('full_name')
    if (filterDepartment) query = query.eq('department_id', filterDepartment)

    query.then(({ data }) => setEngineers((data ?? []) as Profile[]))
  }, [session, filterDepartment])

  useEffect(() => {
    if (!session) return

    let cancelled = false
    setLoading(true)

    async function load() {
      let query = supabase
        .from('issues')
        .select('*, departments(id, slug, name), assignee:profiles!issues_assigned_to_fkey(id, full_name)')
        .order('created_at', { ascending: false })

      if (filterDepartment) query = query.eq('department_id', filterDepartment)
      if (filterPriority) query = query.eq('priority', filterPriority)
      if (filterArea) query = query.ilike('area', `%${filterArea}%`)
      if (filterAssignee === 'unassigned') query = query.is('assigned_to', null)
      else if (filterAssignee) query = query.eq('assigned_to', filterAssignee)

      const { data, error: queryError } = await query
      // A newer run may have started while this one was in flight.
      if (cancelled) return

      if (queryError) {
        setError(queryError.message)
      } else {
        setError(null)
        setIssues((data ?? []) as Issue[])
      }
      setLoading(false)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [session, filterDepartment, filterPriority, filterArea, filterAssignee, refreshToken])

  useEffect(() => {
    if (!session) return

    const channel = supabase
      .channel('issues-board')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'issues' }, () =>
        setRefreshToken((n) => n + 1)
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [session])

  const issuesByStatus = useMemo(() => {
    const map: Record<IssueStatus, Issue[]> = {
      created: [],
      assigned: [],
      in_progress: [],
      resolved: [],
      closed: [],
      reopened: [],
    }
    for (const issue of issues) {
      map[issue.status]?.push(issue)
    }
    return map
  }, [issues])

  // Re-reading the row by id is what keeps the modal honest: it renders what the
  // board last loaded, not what was clicked. Holding the clicked object directly
  // meant a status change updated the database and the board while the open
  // modal still showed the old value — and the modal's "already in that status"
  // guard, comparing against that stale value, then silently swallowed the next
  // change. Realtime edits by other staff now reach the open modal too.
  //
  // Falls back to the snapshot when the row is missing from `issues`: reassigning
  // while an assignee filter is set drops the ticket off the board, and the modal
  // should stay put rather than vanish mid-interaction.
  const selectedIssue = selectedSnapshot
    ? (issues.find((i) => i.id === selectedSnapshot.id) ?? selectedSnapshot)
    : null

  const handleSelect = useCallback((issue: Issue) => setSelectedSnapshot(issue), [])

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), [])

  async function handleDragEnd(result: DropResult) {
    const { source, destination, draggableId } = result
    if (!destination || destination.droppableId === source.droppableId) return

    const newStatus = destination.droppableId as IssueStatus
    const issue = issues.find((i) => i.id === draggableId)
    if (!issue) return

    if (newStatus === 'resolved') {
      // Resolution needs a proof photo + comment, so collect it in the modal instead.
      setSelectedSnapshot(issue)
      return
    }

    const previousStatus = issue.status
    setIssues((prev) => prev.map((i) => (i.id === draggableId ? { ...i, status: newStatus } : i)))

    const { error: updateError } = await supabase
      .from('issues')
      .update({ status: newStatus })
      .eq('id', draggableId)

    if (updateError) {
      // Roll the card back rather than leaving the UI lying about the server state.
      setIssues((prev) => prev.map((i) => (i.id === draggableId ? { ...i, status: previousStatus } : i)))
      setError(`Could not move ${issue.ticket_number}: ${updateError.message}`)
      return
    }

    await supabase.from('issue_status_history').insert({
      issue_id: draggableId,
      status: newStatus,
      note: `Moved to ${newStatus.replace('_', ' ')} by ${actorLabel}`,
      actor: `staff:${actorLabel}`,
    })
  }

  // Auth loading and the signed-out state are handled by RequireRole on the route.
  const hasFilters = Boolean(
    (isSuperAdmin && filterDepartment) || filterPriority || filterArea || filterAssignee
  )

  return (
    <div className="px-4 py-6 sm:px-6">
      <div className="mb-5 flex flex-wrap items-end gap-3">
        <div className="mr-2">
          <h1 className="text-xl font-semibold text-ink">Issue Board</h1>
          <p className="text-xs text-subtle">
            {isSuperAdmin ? 'All departments' : (profile?.departments?.name ?? 'Your department')}
          </p>
        </div>

        {isSuperAdmin ? (
          <div>
            <label htmlFor="filter-department" className="mb-1 block text-xs font-medium text-ink-soft">
              Department
            </label>
            <FieldSelect
              id="filter-department"
              value={filterDepartment}
              onValueChange={(v) => setFilter('department', v)}
              className="w-48"
              options={[
                { value: '', label: 'All departments' },
                ...departments.map((d) => ({ value: d.id, label: d.name })),
              ]}
            />
          </div>
        ) : null}

        <div>
          <label htmlFor="filter-assignee" className="mb-1 block text-xs font-medium text-ink-soft">
            Assigned To
          </label>
          <FieldSelect
            id="filter-assignee"
            value={filterAssignee}
            onValueChange={(v) => setFilter('assignee', v)}
            className="w-44"
            options={[
              { value: '', label: 'Anyone' },
              { value: 'unassigned', label: 'Unassigned' },
              ...engineers.map((e) => ({ value: e.id, label: e.full_name })),
            ]}
          />
        </div>

        <div>
          <label htmlFor="filter-priority" className="mb-1 block text-xs font-medium text-ink-soft">
            Priority
          </label>
          <FieldSelect
            id="filter-priority"
            value={filterPriority}
            onValueChange={(v) => setFilter('priority', v)}
            className="w-36"
            options={[
              { value: '', label: 'All priorities' },
              { value: 'high', label: 'High' },
              { value: 'medium', label: 'Medium' },
              { value: 'low', label: 'Low' },
            ]}
          />
        </div>

        <div>
          <label htmlFor="filter-area" className="mb-1 block text-xs font-medium text-ink-soft">
            Area
          </label>
          <input
            id="filter-area"
            type="search"
            name="area"
            autoComplete="off"
            value={filterArea}
            onChange={(e) => setFilter('area', e.target.value)}
            placeholder="Sector 12…"
            className="w-44 rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink placeholder:text-subtle transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
          />
        </div>

        {hasFilters ? (
          <button
            type="button"
            onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}
            className="rounded-lg px-2.5 py-2 text-sm font-medium text-ink-soft transition-colors hover:bg-raised hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
          >
            Clear Filters
          </button>
        ) : null}
      </div>

      {error ? (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      {loading ? (
        <BoardSkeleton />
      ) : issues.length === 0 ? (
        <EmptyState
          title={hasFilters ? 'No tickets match these filters' : 'No tickets yet'}
          description={
            hasFilters
              ? 'Try clearing a filter to widen the search.'
              : 'Reports submitted by residents will appear here automatically.'
          }
        />
      ) : (
        <DragDropContext onDragEnd={handleDragEnd}>
          <div className="flex gap-4 overflow-x-auto pb-4">
            {COLUMNS.map((status) => (
              <KanbanColumn
                key={status}
                status={status}
                issues={issuesByStatus[status] ?? EMPTY_BY_STATUS[status]}
                onSelect={handleSelect}
              />
            ))}
          </div>
        </DragDropContext>
      )}

      {selectedIssue ? (
        <IssueDetailModal
          issue={selectedIssue}
          actorLabel={actorLabel}
          onClose={() => setSelectedSnapshot(null)}
          onUpdated={refresh}
        />
      ) : null}
    </div>
  )
}
