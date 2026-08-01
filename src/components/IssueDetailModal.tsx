import { useEffect, useId, useRef, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { StatusBadge, PriorityBadge, TicketNumber } from './StatusBadge'
import { Alert, Button, Field, Select, Textarea } from './ui'
import { formatDateTime, joinParts } from '../lib/format'
import { STATUS_LABELS } from '../lib/labels'
import { isOnShiftNow, shiftSummary } from '../lib/roster'
import type { Issue, IssueStatus, IssueStatusHistoryEntry, Profile, RosterShift } from '../lib/types'

const RESOLVABLE_STATUSES = ['assigned', 'in_progress', 'reopened']
const OPEN_STATUSES = ['created', 'assigned', 'in_progress', 'reopened']

interface AssignCandidate {
  profile: Profile
  shifts: RosterShift[]
  onShift: boolean
  openCount: number
}

/** "on shift now · 2 open" — availability at a glance, per the roster. */
function availabilityLabel(c: AssignCandidate): string {
  const load = `${c.openCount} open`
  if (c.profile.role === 'dept_admin') return load
  if (c.onShift) return `on shift now · ${load}`
  return `off shift (${shiftSummary(c.shifts)}) · ${load}`
}

// `resolved` is deliberately absent: resolution requires a proof photo and
// comment, so it is only reachable through the form below — the same reason the
// board intercepts a drag onto the Resolved column.
const ADMIN_STATUSES: IssueStatus[] = ['created', 'assigned', 'in_progress', 'reopened', 'closed']
const ENGINEER_STATUSES: IssueStatus[] = ['assigned', 'in_progress']

export function IssueDetailModal({
  issue,
  actorLabel,
  onClose,
  onUpdated,
}: {
  issue: Issue
  actorLabel: string
  onClose: () => void
  onUpdated: () => void
}) {
  const { canManageDepartment, isFieldEngineer, session } = useAuth()

  const [history, setHistory] = useState<IssueStatusHistoryEntry[]>([])
  const [candidates, setCandidates] = useState<AssignCandidate[]>([])
  // Distinguishes "still loading" from "genuinely nobody" — otherwise the empty
  // state flashes a warning about there being no staff while the query is in flight.
  const [candidatesLoading, setCandidatesLoading] = useState(true)
  const [resolutionPhoto, setResolutionPhoto] = useState<File | null>(null)
  const [resolutionComment, setResolutionComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [savingChange, setSavingChange] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const dialogRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()

  useEffect(() => {
    supabase
      .from('issue_status_history')
      .select('*')
      .eq('issue_id', issue.id)
      .order('created_at', { ascending: true })
      .then(({ data }) => setHistory(data ?? []))
  }, [issue.id])

  // Reassignment targets: every active staff member in this ticket's department —
  // field engineers and staff admins alike. Deactivated accounts never appear.
  // Roster and current load come along so the chooser can see availability.
  useEffect(() => {
    if (!canManageDepartment) return

    let cancelled = false

    async function loadCandidates() {
      const { data: staff } = await supabase
        .from('profiles')
        .select('*')
        .in('role', ['field_engineer', 'dept_admin'])
        .eq('department_id', issue.department_id)
        .eq('is_active', true)
        .order('full_name')

      const people = (staff ?? []) as Profile[]
      if (cancelled || people.length === 0) {
        if (!cancelled) {
          setCandidates([])
          setCandidatesLoading(false)
        }
        return
      }

      const ids = people.map((p) => p.id)
      const [{ data: shiftRows }, { data: openRows }] = await Promise.all([
        supabase.from('roster_shifts').select('*').in('engineer_id', ids),
        supabase.from('issues').select('assigned_to').in('assigned_to', ids).in('status', OPEN_STATUSES),
      ])
      if (cancelled) return

      const loadByPerson = new Map<string, number>()
      for (const row of openRows ?? []) {
        const key = (row as { assigned_to: string }).assigned_to
        loadByPerson.set(key, (loadByPerson.get(key) ?? 0) + 1)
      }

      setCandidates(
        people.map((profile) => {
          const shifts = ((shiftRows ?? []) as RosterShift[]).filter((s) => s.engineer_id === profile.id)
          return {
            profile,
            shifts,
            onShift: isOnShiftNow(shifts),
            openCount: loadByPerson.get(profile.id) ?? 0,
          }
        })
      )
      setCandidatesLoading(false)
    }

    setCandidatesLoading(true)
    loadCandidates()
    return () => {
      cancelled = true
    }
  }, [canManageDepartment, issue.department_id])

  // Focus moves into the dialog on open and returns to the trigger on close;
  // Tab is kept inside while it's open.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    closeButtonRef.current?.focus()

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose()
        return
      }
      if (e.key !== 'Tab' || !dialogRef.current) return

      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    // Stop the page behind the dialog from scrolling.
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    return () => {
      document.removeEventListener('keydown', handleKeyDown)
      document.body.style.overflow = previousOverflow
      previouslyFocused?.focus()
    }
  }, [onClose])

  async function changeStatus(next: IssueStatus) {
    if (next === issue.status) return
    setSavingChange(true)
    setError(null)
    setNotice(null)

    // return=representation so a row count of zero — an RLS block, which
    // PostgREST reports as a success — is caught rather than assumed to work.
    const { data, error: updateError } = await supabase
      .from('issues')
      .update({ status: next })
      .eq('id', issue.id)
      .select('id')

    if (updateError || !data || data.length === 0) {
      setSavingChange(false)
      setError(updateError?.message ?? 'You do not have permission to change this ticket.')
      return
    }

    await supabase.from('issue_status_history').insert({
      issue_id: issue.id,
      status: next,
      note: `Status changed to ${STATUS_LABELS[next].toLowerCase()} by ${actorLabel}`,
      actor: `staff:${actorLabel}`,
    })

    setSavingChange(false)
    setNotice(`Status changed to ${STATUS_LABELS[next]}.`)
    onUpdated()
  }

  async function reassign(engineerId: string) {
    setSavingChange(true)
    setError(null)
    setNotice(null)

    const { data, error: updateError } = await supabase
      .from('issues')
      .update({ assigned_to: engineerId || null })
      .eq('id', issue.id)
      .select('id')

    if (updateError || !data || data.length === 0) {
      setSavingChange(false)
      setError(updateError?.message ?? 'You do not have permission to reassign this ticket.')
      return
    }

    const name = candidates.find((c) => c.profile.id === engineerId)?.profile.full_name
    await supabase.from('issue_status_history').insert({
      issue_id: issue.id,
      status: issue.status,
      note: engineerId
        ? `Reassigned to ${name ?? 'engineer'} by ${actorLabel}`
        : `Unassigned by ${actorLabel}. Returned to the queue.`,
      actor: `staff:${actorLabel}`,
    })

    setSavingChange(false)
    setNotice(engineerId ? `Reassigned to ${name}.` : 'Returned to the queue.')
    onUpdated()
  }

  async function handleResolve() {
    if (!resolutionPhoto || !resolutionComment.trim()) {
      setError('A proof photo and a comment are both required before resolving.')
      return
    }
    setSubmitting(true)
    setError(null)

    const path = `resolution-${crypto.randomUUID()}-${resolutionPhoto.name}`
    const { error: uploadError } = await supabase.storage.from('issue-photos').upload(path, resolutionPhoto)
    if (uploadError) {
      setError(uploadError.message)
      setSubmitting(false)
      return
    }
    const { data: urlData } = supabase.storage.from('issue-photos').getPublicUrl(path)

    const { error: updateError } = await supabase
      .from('issues')
      .update({
        status: 'resolved',
        resolution_photo_url: urlData.publicUrl,
        resolution_comment: resolutionComment,
        resolved_at: new Date().toISOString(),
      })
      .eq('id', issue.id)

    if (updateError) {
      setError(updateError.message)
      setSubmitting(false)
      return
    }

    await supabase.from('issue_status_history').insert({
      issue_id: issue.id,
      status: 'resolved',
      note: `Marked resolved by ${actorLabel}`,
      actor: `staff:${actorLabel}`,
    })

    await supabase.from('notifications').insert({
      issue_id: issue.id,
      channel: 'email',
      recipient: issue.reporter_contact,
      message: `Your report ${issue.ticket_number} has been resolved. Please confirm.`,
    })

    setSubmitting(false)
    onUpdated()
    onClose()
  }

  // Grouped so the chooser sees who can actually act right now, per the roster.
  const onShiftEngineers = candidates.filter((c) => c.profile.role === 'field_engineer' && c.onShift)
  const offShiftEngineers = candidates.filter((c) => c.profile.role === 'field_engineer' && !c.onShift)
  const admins = candidates.filter((c) => c.profile.role === 'dept_admin')

  const assignedToMe = issue.assigned_to === session?.user.id
  // An engineer may only act on their own ticket; an admin on any in scope.
  const canChangeStatus = canManageDepartment || (isFieldEngineer && assignedToMe)
  const statusOptions = canManageDepartment ? ADMIN_STATUSES : ENGINEER_STATUSES
  const canResolve = RESOLVABLE_STATUSES.includes(issue.status) && (canManageDepartment || assignedToMe)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto overscroll-contain rounded-xl bg-white p-6 shadow-2xl"
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <TicketNumber id={titleId} value={issue.ticket_number} className="text-lg font-bold text-teal-700" />
            <div className="mt-2 flex flex-wrap gap-2">
              <StatusBadge status={issue.status} />
              <PriorityBadge priority={issue.priority} />
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label="Close Ticket Details"
            className="-mr-2 -mt-1 shrink-0 rounded-md p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
          >
            <span aria-hidden="true" className="block text-lg leading-none">
              ✕
            </span>
          </button>
        </div>

        <img
          src={issue.photo_url}
          alt={`Reported issue: ${issue.comment}`}
          width={640}
          height={256}
          loading="lazy"
          className="mb-3 h-48 w-full rounded-lg border border-slate-200 bg-slate-100 object-cover"
        />

        <p className="mb-1.5 text-sm text-slate-700 break-words">{issue.comment}</p>
        {issue.ai_summary ? (
          <p className="mb-2 text-xs italic text-slate-500 break-words">AI summary: {issue.ai_summary}</p>
        ) : null}
        <p className="mb-5 text-xs text-slate-500 break-words">
          {joinParts([issue.departments?.name, issue.landmark, issue.area, issue.city])}
        </p>

        <section className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-slate-800">Audit Trail</h3>
          {history.length === 0 ? (
            <p className="text-sm text-slate-400">No history recorded yet.</p>
          ) : (
            <ol className="space-y-3 border-l-2 border-slate-200 pl-4 text-sm">
              {history.map((entry) => (
                <li key={entry.id}>
                  <time dateTime={entry.created_at} className="text-xs tabular-nums text-slate-400">
                    {formatDateTime(entry.created_at)}
                  </time>
                  <p className="text-slate-600 break-words">{entry.note ?? entry.status}</p>
                </li>
              ))}
            </ol>
          )}
        </section>

        {canChangeStatus ? (
          <section className="mb-4 rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-800">Manage Ticket</h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="change-status" className="mb-1.5 block text-sm font-medium text-slate-800">
                  Status
                </label>
                <Select
                  id="change-status"
                  value={issue.status}
                  disabled={savingChange}
                  onChange={(e) => changeStatus(e.target.value as IssueStatus)}
                >
                  {/* Keep the current status selectable even when it is not an
                      option the caller may set, so the control reflects reality. */}
                  {!statusOptions.includes(issue.status) ? (
                    <option value={issue.status}>{STATUS_LABELS[issue.status]}</option>
                  ) : null}
                  {statusOptions.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              </div>

              {canManageDepartment ? (
                <div>
                  <label htmlFor="change-assignee" className="mb-1.5 block text-sm font-medium text-slate-800">
                    Assigned To
                  </label>
                  <Select
                    id="change-assignee"
                    value={issue.assigned_to ?? ''}
                    disabled={savingChange}
                    onChange={(e) => reassign(e.target.value)}
                  >
                    <option value="">Unassigned — return to queue</option>

                    {/* On-shift engineers first: they are the ones who can act now. */}
                    {onShiftEngineers.length > 0 ? (
                      <optgroup label="Field Engineers — on shift now">
                        {onShiftEngineers.map((c) => (
                          <option key={c.profile.id} value={c.profile.id}>
                            {c.profile.full_name} — {availabilityLabel(c)}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}

                    {offShiftEngineers.length > 0 ? (
                      <optgroup label="Field Engineers — off shift">
                        {offShiftEngineers.map((c) => (
                          <option key={c.profile.id} value={c.profile.id}>
                            {c.profile.full_name} — {availabilityLabel(c)}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}

                    {admins.length > 0 ? (
                      <optgroup label="Staff Admins">
                        {admins.map((c) => (
                          <option key={c.profile.id} value={c.profile.id}>
                            {c.profile.full_name} — {availabilityLabel(c)}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </Select>
                  {candidatesLoading ? (
                    <p className="mt-1.5 text-xs text-slate-500">Loading available staff…</p>
                  ) : candidates.length === 0 ? (
                    <p className="mt-1.5 text-xs text-amber-700">
                      No active staff in this department. Add someone under Team before reassigning.
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <p className="mt-2 text-xs text-slate-500 text-pretty">
              {canManageDepartment
                ? 'Only active engineers in this department can be assigned. Marking a ticket resolved requires proof below.'
                : 'Marking this ticket resolved requires a proof photo and description below.'}
            </p>

            {notice ? (
              <div className="mt-3">
                <Alert tone="success">{notice}</Alert>
              </div>
            ) : null}
            {error && !canResolve ? (
              <div className="mt-3">
                <Alert tone="error">{error}</Alert>
              </div>
            ) : null}
          </section>
        ) : null}

        {canResolve ? (
          <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <h3 className="mb-3 text-sm font-semibold text-slate-800">Mark as Resolved</h3>
            <div className="space-y-3">
              <Field label="Proof Photo" required hint="Show the completed work.">
                {(props) => (
                  <input
                    {...props}
                    type="file"
                    accept="image/*"
                    name="resolutionPhoto"
                    onChange={(e) => setResolutionPhoto(e.target.files?.[0] ?? null)}
                    className="block w-full cursor-pointer rounded-lg border border-slate-300 bg-white p-2 text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-teal-50 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-teal-700 hover:file:bg-teal-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2"
                  />
                )}
              </Field>

              <Field label="What Was Done?" required>
                {(props) => (
                  <Textarea
                    {...props}
                    name="resolutionComment"
                    value={resolutionComment}
                    onChange={(e) => setResolutionComment(e.target.value)}
                    placeholder="Pothole filled and resurfaced…"
                    rows={2}
                  />
                )}
              </Field>

              {error ? <Alert tone="error">{error}</Alert> : null}

              <Button variant="success" onClick={handleResolve} loading={submitting}>
                {submitting ? 'Submitting…' : 'Submit Resolution'}
              </Button>
            </div>
          </section>
        ) : null}
      </div>
    </div>
  )
}
