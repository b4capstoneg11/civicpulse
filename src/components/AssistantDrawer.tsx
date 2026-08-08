import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { readFunctionError } from '../lib/functionError'
import { useAuth } from '../hooks/useAuth'
import { ROLE_LABELS } from '../lib/labels'
import { Alert, Spinner } from './ui'

interface Turn {
  role: 'user' | 'assistant'
  content: string
}

// What each role's assistant can actually reach — shown in the header so the
// difference between the three is stated, not just implied.
const SCOPE_NOTE: Record<string, string> = {
  super_admin: 'all departments',
  dept_admin: 'your department only',
  field_engineer: 'your assigned tickets only',
}

const SUGGESTIONS: Record<string, string[]> = {
  super_admin: [
    'How many tickets are open, broken down by department?',
    'Which department has the biggest backlog right now?',
    'Show me high-priority tickets that are still unassigned',
    'How has ticket volume changed month by month?',
  ],
  dept_admin: [
    'How many tickets are open in my department?',
    'Who on my team has the most open work?',
    'Show me high-priority tickets still unassigned',
    'What issue type do we get most often?',
  ],
  field_engineer: [
    'What am I working on?',
    'Which of my tickets is highest priority?',
    'Do I have anything that has been reopened?',
    'What did I resolve most recently?',
  ],
}

/**
 * Renders the model's light markdown as React elements — never innerHTML, so a
 * reply can't inject markup. Handles bold, bullets, and turns ticket numbers
 * into links so an answer is one click from the ticket itself.
 */
function RichText({ text }: { text: string }) {
  const lines = text.split('\n')
  return (
    <>
      {lines.map((line, li) => {
        const bullet = /^\s*[-*]\s+/.test(line)
        const body = bullet ? line.replace(/^\s*[-*]\s+/, '') : line
        if (body.trim() === '') return <div key={li} className="h-2" />

        // Bold is tokenised first, then ticket numbers *inside* each chunk — the
        // model usually emits **CP-000002**, and a single flat split would turn
        // that into bold text with the link swallowed.
        const rendered = body
          .split(/(\*\*[^*]+\*\*)/g)
          .filter(Boolean)
          .flatMap((chunk, ci) => {
            const bold = /^\*\*[^*]+\*\*$/.test(chunk)
            const inner = bold ? chunk.slice(2, -2) : chunk

            return inner
              .split(/(CP-\d{6})/g)
              .filter(Boolean)
              .map((piece, pi) => {
                const key = `${ci}-${pi}`
                if (/^CP-\d{6}$/.test(piece)) {
                  return (
                    <Link
                      key={key}
                      to={`/track?ticket=${piece}`}
                      className={`font-mono text-teal-700 underline decoration-teal-300 underline-offset-2 hover:decoration-teal-600 ${bold ? 'font-semibold' : ''}`}
                    >
                      {piece}
                    </Link>
                  )
                }
                return bold ? (
                  <strong key={key} className="font-semibold text-slate-900">
                    {piece}
                  </strong>
                ) : (
                  <span key={key}>{piece}</span>
                )
              })
          })

        return bullet ? (
          <p key={li} className="flex gap-2 py-0.5">
            <span aria-hidden="true" className="text-slate-400">
              •
            </span>
            <span>{rendered}</span>
          </p>
        ) : (
          <p key={li} className="py-0.5">
            {rendered}
          </p>
        )
      })}
    </>
  )
}

export function AssistantDrawer() {
  const { session, role, profile } = useAuth()

  const [open, setOpen] = useState(false)
  const [turns, setTurns] = useState<Turn[]>([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const panelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  // This drawer is mounted outside the routes so a conversation survives
  // navigation — which also means it survives a logout. Without this reset the
  // next person to sign in would inherit the previous user's conversation, and
  // a staff admin could read a super admin's cross-department answers.
  const userId = session?.user.id ?? null
  const previousUserId = useRef<string | null>(userId)

  useEffect(() => {
    if (previousUserId.current !== userId) {
      previousUserId.current = userId
      setTurns([])
      setDraft('')
      setError(null)
      setBusy(false)
      setOpen(false)
    }
  }, [userId])

  // Focus moves in on open and back to the launcher on close; Tab stays inside.
  useEffect(() => {
    if (!open) return
    const previouslyFocused = document.activeElement as HTMLElement | null
    inputRef.current?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setOpen(false)
        return
      }
      if (e.key !== 'Tab' || !panelRef.current) return
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
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

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previouslyFocused?.focus()
    }
  }, [open])

  // Keep the newest turn in view as the conversation grows.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns, busy])

  async function send(question: string) {
    const text = question.trim()
    if (!text || busy) return

    const next: Turn[] = [...turns, { role: 'user', content: text }]
    setTurns(next)
    setDraft('')
    setBusy(true)
    setError(null)

    const { data, error: fnError } = await supabase.functions.invoke<{ reply?: string; error?: string }>(
      'chat-assistant',
      { body: { messages: next } }
    )

    const message = await readFunctionError(fnError, data ?? null)
    if (message) {
      setError(message)
      setBusy(false)
      return
    }

    setTurns([...next, { role: 'assistant', content: data?.reply ?? 'I could not answer that.' }])
    setBusy(false)
  }

  // Staff only — residents have no ticket data of their own to reason over.
  if (!session || !role) return null

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        aria-label="Open the CivicPulse assistant"
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-teal-600 px-4 py-3 text-sm font-medium text-white shadow-lg transition-colors [touch-action:manipulation] hover:bg-teal-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2"
      >
        <span aria-hidden="true">✦</span>
        Ask CivicPulse
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          <div
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            onClick={() => setOpen(false)}
            aria-hidden="true"
          />

          <div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="relative flex h-full w-full max-w-md flex-col overflow-hidden bg-white shadow-2xl"
          >
            <header className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div className="min-w-0">
                <h2 id={titleId} className="text-sm font-semibold text-slate-900">
                  Ask CivicPulse
                </h2>
                {/* Naming the scope makes it obvious the assistant answers from a
                    different slice of data for each role. */}
                <p className="truncate text-xs text-slate-500">
                  {ROLE_LABELS[role]} · {SCOPE_NOTE[role]}
                  {role === 'dept_admin' && profile?.departments?.name
                    ? ` (${profile.departments.name})`
                    : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close the assistant"
                className="-mr-2 -mt-1 rounded-md p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
              >
                <span aria-hidden="true" className="block text-lg leading-none">
                  ✕
                </span>
              </button>
            </header>

            <div
              ref={logRef}
              className="flex-1 overflow-y-auto overscroll-contain px-5 py-4"
              role="log"
              aria-live="polite"
              aria-label="Conversation"
            >
              {turns.length === 0 ? (
                <div>
                  <p className="mb-3 text-sm text-slate-600 text-pretty">
                    I can answer questions about the tickets you have access to — counts, backlogs, a specific
                    ticket’s history. I only read data; I can’t change anything.
                  </p>
                  <ul className="space-y-2">
                    {(SUGGESTIONS[role] ?? []).map((s) => (
                      <li key={s}>
                        <button
                          type="button"
                          onClick={() => send(s)}
                          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-slate-700 transition-colors hover:border-teal-300 hover:bg-teal-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500"
                        >
                          {s}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <ul className="space-y-4">
                  {turns.map((t, i) => (
                    <li key={i}>
                      {t.role === 'user' ? (
                        <div className="flex justify-end">
                          <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-teal-600 px-3.5 py-2 text-sm text-white break-words">
                            {t.content}
                          </p>
                        </div>
                      ) : (
                        <div className="max-w-[95%] text-sm text-slate-700">
                          <RichText text={t.content} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {busy ? (
                <p className="mt-4 flex items-center gap-2 text-sm text-slate-500">
                  <Spinner />
                  Looking through your tickets…
                </p>
              ) : null}

              {error ? (
                <div className="mt-4">
                  <Alert tone="error">{error}</Alert>
                </div>
              ) : null}
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault()
                send(draft)
              }}
              className="border-t border-slate-200 px-5 py-3"
            >
              <label htmlFor="assistant-input" className="sr-only">
                Ask a question about your tickets
              </label>
              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  id="assistant-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter sends; Shift+Enter starts a new line.
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      send(draft)
                    }
                  }}
                  rows={2}
                  maxLength={800}
                  placeholder="Ask about your tickets…"
                  className="min-w-0 flex-1 resize-none rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-1"
                />
                <button
                  type="submit"
                  disabled={busy || draft.trim() === ''}
                  className="shrink-0 rounded-lg bg-teal-600 px-3.5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-500 focus-visible:ring-offset-2"
                >
                  Send
                </button>
              </div>
              {turns.length > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setTurns([])
                    setError(null)
                  }}
                  className="mt-2 text-xs text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-700"
                >
                  Start a new conversation
                </button>
              ) : null}
            </form>
          </div>
        </div>
      ) : null}
    </>
  )
}
