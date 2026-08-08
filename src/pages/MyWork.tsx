import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { StatusBadge, PriorityBadge, TicketNumber } from '../components/StatusBadge'
import { IssueDetailModal } from '../components/IssueDetailModal'
import { Alert, Button, EmptyState, Spinner } from '../components/ui'
import { formatRelative, joinParts } from '../lib/format'
import type { Issue, IssueStatus } from '../lib/types'

const OPEN_STATUSES: IssueStatus[] = ['created', 'assigned', 'in_progress', 'reopened']
const DONE_STATUSES: IssueStatus[] = ['resolved', 'closed']

// Defined at module scope, not inside MyWork — a component declared inside another
// is a fresh type on every render, so React unmounts and remounts the whole subtree.
function TicketRow({
  issue,
  onOpen,
  onStart,
}: {
  issue: Issue
  onOpen: (issue: Issue) => void
  onStart: (issue: Issue) => void
}) {
  return (
    <li className="rounded-xl border border-line bg-panel p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <TicketNumber value={issue.ticket_number} className="text-sm font-semibold text-accent" />
        <div className="flex flex-wrap gap-2">
          <PriorityBadge priority={issue.priority} />
          <StatusBadge status={issue.status} />
        </div>
      </div>

      <p className="mb-1.5 text-sm text-ink-soft break-words">{issue.comment}</p>
      <p className="mb-3 text-xs text-muted break-words">
        {joinParts([issue.landmark, issue.area, issue.city])} ·{' '}
        <time dateTime={issue.created_at}>{formatRelative(issue.created_at)}</time>
      </p>

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={() => onOpen(issue)}>
          View Details
        </Button>
        {issue.status === 'assigned' || issue.status === 'reopened' ? (
          <Button size="sm" onClick={() => onStart(issue)}>
            Start Work
          </Button>
        ) : null}
        {issue.status === 'in_progress' ? (
          <Button variant="success" size="sm" onClick={() => onOpen(issue)}>
            Submit Resolution
          </Button>
        ) : null}
      </div>
    </li>
  )
}

export function MyWork() {
  const { session, profile } = useAuth()
  const [issues, setIssues] = useState<Issue[]>([])
  const [selectedIssue, setSelectedIssue] = useState<Issue | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)

  const userId = session?.user.id

  useEffect(() => {
    if (!userId) return

    let cancelled = false
    setLoading(true)

    supabase
      .from('issues')
      .select('*, departments(id, slug, name)')
      .eq('assigned_to', userId)
      .order('created_at', { ascending: false })
      .then(({ data, error: queryError }) => {
        if (cancelled) return
        if (queryError) setError(queryError.message)
        else setIssues((data ?? []) as Issue[])
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [userId, refreshToken])

  // Tickets can be auto-assigned while the engineer is looking at this page.
  useEffect(() => {
    if (!userId) return

    const channel = supabase
      .channel('my-work')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'issues' }, () =>
        setRefreshToken((n) => n + 1)
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [userId])

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), [])

  const { open, done } = useMemo(
    () => ({
      open: issues.filter((i) => OPEN_STATUSES.includes(i.status)),
      done: issues.filter((i) => DONE_STATUSES.includes(i.status)),
    }),
    [issues]
  )

  const startWork = useCallback(
    (issue: Issue) => advance(issue, 'in_progress'),
    // `advance` is stable enough for this page — it only closes over `profile`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile?.full_name]
  )

  async function advance(issue: Issue, next: IssueStatus) {
    setError(null)

    const { error: updateError } = await supabase
      .from('issues')
      .update({ status: next })
      .eq('id', issue.id)

    if (updateError) {
      setError(updateError.message)
      return
    }

    await supabase.from('issue_status_history').insert({
      issue_id: issue.id,
      status: next,
      note: `Moved to ${next.replace('_', ' ')} by ${profile?.full_name ?? 'engineer'}`,
      actor: `staff:${profile?.full_name ?? 'engineer'}`,
    })

    refresh()
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold text-ink text-balance">My Work</h1>
      <p className="mb-8 text-ink-soft text-pretty">
        Tickets assigned to you in {profile?.departments?.name ?? 'your department'}. New ones arrive
        automatically while you are on shift.
      </p>

      {error ? (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <Spinner />
          Loading your tickets…
        </p>
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-sm font-semibold text-ink">
              Open <span className="ml-1 tabular-nums text-muted">({open.length})</span>
            </h2>
            {open.length === 0 ? (
              <EmptyState
                title="Nothing open right now"
                description="New tickets are assigned to you automatically during your shift."
              />
            ) : (
              <ul className="space-y-3">
                {open.map((issue) => (
                  <TicketRow key={issue.id} issue={issue} onOpen={setSelectedIssue} onStart={startWork} />
                ))}
              </ul>
            )}
          </section>

          {done.length > 0 ? (
            <section>
              <h2 className="mb-3 text-sm font-semibold text-ink">
                Completed <span className="ml-1 tabular-nums text-muted">({done.length})</span>
              </h2>
              <ul className="space-y-3">
                {done.map((issue) => (
                  <TicketRow key={issue.id} issue={issue} onOpen={setSelectedIssue} onStart={startWork} />
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      )}

      {selectedIssue ? (
        <IssueDetailModal
          issue={selectedIssue}
          actorLabel={profile?.full_name ?? 'engineer'}
          onClose={() => setSelectedIssue(null)}
          onUpdated={refresh}
        />
      ) : null}
    </div>
  )
}
