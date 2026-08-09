import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { readFunctionError } from '../lib/functionError'
import { useAuth } from '../hooks/useAuth'
import { ROLE_LABELS } from '../lib/labels'
import { Alert, Spinner } from './ui'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'

interface Turn {
  role: 'user' | 'assistant'
  content: string
}

// What each role's assistant can actually reach — shown in the header so the
// difference between the three is stated, not just implied.
const SCOPE_NOTE: Record<string, string> = {
  super_admin: 'all departments',
  readonly_admin: 'all departments, read-only',
  dept_admin: 'your department only',
  field_engineer: 'your assigned tickets only',
}

const SUGGESTIONS: Record<string, string[]> = {
  readonly_admin: [
    'How many tickets are open, broken down by department?',
    'Which department has the biggest backlog right now?',
    'Show me high-priority tickets that are still unassigned',
    'How has ticket volume changed month by month?',
  ],
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
                      className={`font-mono text-brand underline decoration-brand/50 underline-offset-2 hover:decoration-brand ${bold ? 'font-semibold' : ''}`}
                    >
                      {piece}
                    </Link>
                  )
                }
                return bold ? (
                  <strong key={key} className="font-semibold text-ink">
                    {piece}
                  </strong>
                ) : (
                  <span key={key}>{piece}</span>
                )
              })
          })

        return bullet ? (
          <p key={li} className="flex gap-2 py-0.5">
            <span aria-hidden="true" className="text-subtle">
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

  const inputRef = useRef<HTMLTextAreaElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

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

  // Escape, the focus trap, focus restoration and scroll locking are all Radix's
  // job now — this used to be ~30 lines of hand-rolled key handling.

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
    // Controlled (open/onOpenChange) so the conversation state lives here beside
    // `turns` — but the launcher is still a real SheetTrigger, which is what lets
    // Radix return focus to it when the drawer closes.
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="Open the CivicPulse assistant"
          className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-brand px-4 py-3 text-sm font-medium text-canvas shadow-lg transition-colors [touch-action:manipulation] hover:bg-brand-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          <span aria-hidden="true">✦</span>
          Ask CivicPulse
        </button>
      </SheetTrigger>

      <SheetContent
        side="right"
        aria-modal="true"
        // Wider than the shadcn default (sm:max-w-sm); a conversation needs room.
        className="w-full gap-0 p-0 sm:max-w-md"
        // Radix would otherwise focus the close button; the input is what the
        // user wants, and it was the focus target before this migration too.
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          inputRef.current?.focus()
        }}
      >
          <SheetHeader className="gap-0.5 border-b border-line px-5 py-4 pr-12">
            <SheetTitle className="text-sm font-semibold text-ink">Ask CivicPulse</SheetTitle>
            {/* Naming the scope makes it obvious the assistant answers from a
                different slice of data for each role. */}
            <SheetDescription className="truncate text-xs text-subtle">
              {ROLE_LABELS[role]} · {SCOPE_NOTE[role]}
              {role === 'dept_admin' && profile?.departments?.name
                ? ` (${profile.departments.name})`
                : ''}
            </SheetDescription>
          </SheetHeader>

          <div
              ref={logRef}
              className="flex-1 overflow-y-auto overscroll-contain px-5 py-4"
              role="log"
              aria-live="polite"
              aria-label="Conversation"
            >
              {turns.length === 0 ? (
                <div>
                  <p className="mb-3 text-sm text-ink-soft text-pretty">
                    I can answer questions about the tickets you have access to — counts, backlogs, a specific
                    ticket’s history. I only read data; I can’t change anything.
                  </p>
                  <ul className="space-y-2">
                    {(SUGGESTIONS[role] ?? []).map((s) => (
                      <li key={s}>
                        <button
                          type="button"
                          onClick={() => send(s)}
                          className="w-full rounded-lg border border-line px-3 py-2 text-left text-sm text-ink-soft transition-colors hover:border-brand/50 hover:bg-brand-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
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
                          <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-brand px-3.5 py-2 text-sm text-canvas break-words">
                            {t.content}
                          </p>
                        </div>
                      ) : (
                        <div className="max-w-[95%] text-sm text-ink-soft">
                          <RichText text={t.content} />
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}

              {busy ? (
                <p className="mt-4 flex items-center gap-2 text-sm text-subtle">
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
              className="border-t border-line px-5 py-3"
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
                  className="min-w-0 flex-1 resize-none rounded-lg border border-line px-3 py-2 text-sm text-ink placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-1"
                />
                <button
                  type="submit"
                  disabled={busy || draft.trim() === ''}
                  className="shrink-0 rounded-lg bg-brand px-3.5 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-brand-hi disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
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
                  className="mt-2 text-xs text-subtle underline decoration-line-strong underline-offset-2 hover:text-ink-soft"
                >
                  Start a new conversation
                </button>
              ) : null}
            </form>
      </SheetContent>
    </Sheet>
  )
}
