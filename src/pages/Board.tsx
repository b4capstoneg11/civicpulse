import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { DragDropContext, type DropResult } from '@hello-pangea/dnd'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { KanbanColumn } from '../components/KanbanColumn'
import { IssueDetailModal } from '../components/IssueDetailModal'
import { Alert, EmptyState, Select, Spinner } from '../components/ui'
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
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null)
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

  const handleSelect = useCallback((issue: Issue) => setSelectedIssue(issue), [])

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), [])

  async function handleDragEnd(result: DropResult) {
    const { source, destination, draggableId } = result
    if (!destination || destination.droppableId === source.droppableId) return

    const newStatus = destination.droppableId as IssueStatus
    const issue = issues.find((i) => i.id === draggableId)
    if (!issue) return

    if (newStatus === 'resolved') {
      // Resolution needs a proof photo + comment, so collect it in the modal instead.
      setSelectedIssue(issue)
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
          <h1 className="text-xl font-semibold text-slate-900">Issue Board</h1>
          <p className="text-xs text-slate-500">
            {isSuperAdmin ? 'All departments' : (profile?.departments?.name ?? 'Your department')}
          </p>
        </div>

        {isSuperAdmin ? (
          <div>
            <label htmlFor="filter-department" className="mb-1 block text-xs font-medium text-slate-600">
              Department
            </label>
            <Select
              id="filter-department"
              value={filterDepartment}
              onChange={(e) => setFilter('department', e.target.value)}
              className="w-48"
            >
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        <div>
          <label htmlFor="filter-assignee" className="mb-1 block text-xs font-medium text-slate-600">
            Assigned To
          </label>
          <Select
            id="filter-assignee"
            value={filterAssignee}
            onChange={(e) => setFilter('assignee', e.target.value)}
            className="w-44"
          >
            <option value="">Anyone</option>
            <option value="unassigned">Unassigned</option>
            {engineers.map((e) => (
              <option key={e.id} value={e.id}>
                {e.full_name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <label htmlFor="filter-priority" className="mb-1 block text-xs font-medium text-slate-600">
            Priority
          </label>
          <Select
            id="filter-priority"
            value={filterPriority}
            onChange={(e) => setFilter('priority', e.target.value)}
            className="w-36"
          >
            <option value="">All priorities</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </Select>
        </div>

        <div>
          <label htmlFor="filter-area" className="mb-1 block text-xs font-medium text-slate-600">
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
            className="w-44 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 transition-colors hover:border-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2"
          />
        </div>

        {hasFilters ? (
          <button
            type="button"
            onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}
            className="rounded-lg px-2.5 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
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
        <p className="flex items-center gap-2 text-sm text-slate-500" role="status">
          <Spinner />
          Loading board…
        </p>
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
          onClose={() => setSelectedIssue(null)}
          onUpdated={refresh}
        />
      ) : null}
    </div>
  )
}
