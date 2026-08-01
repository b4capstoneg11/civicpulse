import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { StatusBadge, PriorityBadge, TicketNumber } from '../components/StatusBadge'
import { RatingWidget } from '../components/RatingWidget'
import { Alert, Button, Field, Input, Spinner } from '../components/ui'
import { formatDateTime, joinParts } from '../lib/format'
import type { Issue, IssueStatusHistoryEntry } from '../lib/types'

export function TrackIssue() {
  const [searchParams, setSearchParams] = useSearchParams()
  const urlTicket = searchParams.get('ticket') ?? ''

  const [ticketInput, setTicketInput] = useState(urlTicket)
  const [issue, setIssue] = useState<Issue | null>(null)
  const [history, setHistory] = useState<IssueStatusHistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ratingSubmitted, setRatingSubmitted] = useState(false)

  // Tracks which ticket has been fetched, so the effect below doesn't refetch
  // the same one on unrelated re-renders.
  const fetchedRef = useRef<string | null>(null)

  async function search(ticket: string) {
    const normalized = ticket.trim().toUpperCase()
    if (!normalized) return

    fetchedRef.current = normalized
    setLoading(true)
    setError(null)
    setIssue(null)
    setRatingSubmitted(false)

    const { data: issueData, error: issueError } = await supabase
      .from('issues')
      .select('*, departments(id, slug, name)')
      .eq('ticket_number', normalized)
      .single()

    if (issueError || !issueData) {
      setError(`No ticket found matching ${normalized}. Check the number and try again.`)
      setLoading(false)
      return
    }

    setIssue(issueData as Issue)

    const { data: historyData } = await supabase
      .from('issue_status_history')
      .select('*')
      .eq('issue_id', issueData.id)
      .order('created_at', { ascending: true })

    setHistory(historyData ?? [])
    setLoading(false)
  }

  // The ticket in the URL is the source of truth, so deep links and the back
  // button both work.
  useEffect(() => {
    if (urlTicket && fetchedRef.current !== urlTicket.toUpperCase()) {
      setTicketInput(urlTicket)
      search(urlTicket)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlTicket])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const normalized = ticketInput.trim().toUpperCase()
    if (!normalized) return
    setSearchParams({ ticket: normalized })
    search(normalized)
  }

  const canRate = issue !== null && ['resolved', 'closed'].includes(issue.status) && issue.rating == null

  return (
    <div className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold text-slate-900 text-balance">Track Your Report</h1>
      <p className="mb-8 text-slate-600 text-pretty">
        Enter the ticket number from your report to see its current status.
      </p>

      <form onSubmit={handleSubmit} className="mb-8">
        <Field label="Ticket Number" required>
          {(props) => (
            <div className="flex gap-2">
              <Input
                {...props}
                type="text"
                name="ticket"
                autoComplete="off"
                spellCheck={false}
                value={ticketInput}
                onChange={(e) => setTicketInput(e.target.value)}
                placeholder="CP-000123…"
                className="flex-1 uppercase"
              />
              <Button type="submit" loading={loading} className="shrink-0">
                Track
              </Button>
            </div>
          )}
        </Field>
      </form>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-slate-500" role="status">
          <Spinner />
          Loading…
        </p>
      ) : null}

      {error ? <Alert tone="error">{error}</Alert> : null}

      {issue ? (
        <div className="space-y-6">
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <TicketNumber value={issue.ticket_number} className="text-lg font-bold text-teal-700" />
              <div className="flex flex-wrap gap-2">
                <PriorityBadge priority={issue.priority} />
                <StatusBadge status={issue.status} />
              </div>
            </div>
            <p className="mb-1.5 text-sm text-slate-700 break-words">{issue.comment}</p>
            <p className="text-xs text-slate-500 break-words">
              {joinParts([issue.departments?.name, issue.area, issue.city])}
            </p>
            <img
              src={issue.photo_url}
              alt={`Issue you reported: ${issue.comment}`}
              width={640}
              height={256}
              loading="lazy"
              className="mt-4 h-48 w-full rounded-lg border border-slate-200 bg-slate-100 object-cover"
            />
          </section>

          <section>
            <h2 className="mb-3 text-sm font-semibold text-slate-800">Status Timeline</h2>
            {history.length === 0 ? (
              <p className="text-sm text-slate-400">No updates recorded yet.</p>
            ) : (
              <ol className="space-y-4 border-l-2 border-slate-200 pl-4">
                {history.map((entry) => (
                  <li key={entry.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={entry.status as Issue['status']} />
                      <time dateTime={entry.created_at} className="text-xs tabular-nums text-slate-400">
                        {formatDateTime(entry.created_at)}
                      </time>
                    </div>
                    {entry.note ? (
                      <p className="mt-1 text-sm text-slate-600 break-words">{entry.note}</p>
                    ) : null}
                  </li>
                ))}
              </ol>
            )}
          </section>

          {(issue.status === 'resolved' || issue.status === 'closed') && issue.resolution_photo_url ? (
            <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
              <h2 className="mb-3 text-sm font-semibold text-emerald-900">Resolution</h2>
              <img
                src={issue.resolution_photo_url}
                alt="Photo showing the completed work"
                width={640}
                height={224}
                loading="lazy"
                className="mb-3 h-44 w-full rounded-lg border border-emerald-200 bg-emerald-100 object-cover"
              />
              {issue.resolution_comment ? (
                <p className="text-sm text-emerald-900 break-words">{issue.resolution_comment}</p>
              ) : null}
            </section>
          ) : null}

          {canRate && !ratingSubmitted ? (
            <RatingWidget
              ticketNumber={issue.ticket_number}
              onSubmitted={() => {
                setRatingSubmitted(true)
                search(issue.ticket_number)
              }}
            />
          ) : null}

          {issue.rating != null ? (
            <Alert tone="success">
              You rated this resolution {issue.rating} out of 5. Thank you for the feedback.
            </Alert>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
