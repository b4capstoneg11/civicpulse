import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { Alert, Button } from '../components/ui'

type Step = 'confirm' | 'working' | 'done' | 'error'

/**
 * Opting out of updates for one ticket.
 *
 * Deliberately a button rather than something that fires on page load: mail
 * clients and corporate security scanners follow links in email before anyone
 * reads them, and a link that unsubscribes on GET would opt residents out
 * without them ever clicking. One extra click is worth not doing that.
 *
 * The token is the whole credential. It is unguessable, scoped to a single
 * subscription, and grants nothing else — so no ticket details are shown before
 * it is redeemed, because the page cannot read them without doing so.
 */
export function Unsubscribe() {
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') ?? ''

  const [step, setStep] = useState<Step>('confirm')
  const [ticket, setTicket] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleUnsubscribe() {
    setStep('working')
    setError(null)

    const { data, error: rpcError } = await supabase.rpc('unsubscribe_from_ticket', {
      p_token: token,
    })

    if (rpcError) {
      setError(rpcError.message)
      setStep('error')
      return
    }

    setTicket(typeof data === 'string' ? data : null)
    setStep('done')
  }

  if (!token) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="mb-2 text-2xl font-semibold text-ink text-balance">Link Incomplete</h1>
        <p className="text-ink-soft text-pretty">
          This unsubscribe link is missing its token. Use the link from the bottom of one of our
          emails.
        </p>
      </div>
    )
  }

  if (step === 'done') {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <div
          aria-hidden="true"
          className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full bg-ok-wash text-2xl text-ok"
        >
          ✓
        </div>
        <h1 className="mb-2 text-2xl font-semibold text-ink text-balance">You&rsquo;re Unsubscribed</h1>
        <p className="mb-6 text-ink-soft text-pretty">
          {ticket
            ? `We won't email you about ${ticket} again. `
            : 'We won’t email you about that ticket again. '}
          You can still check its progress any time without an account.
        </p>
        <Link
          to={ticket ? `/track?ticket=${ticket}` : '/track'}
          className="inline-flex rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-brand-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          Track This Ticket
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md px-4 py-24 text-center">
      <h1 className="mb-2 text-2xl font-semibold text-ink text-balance">Stop These Emails?</h1>
      <p className="mb-6 text-ink-soft text-pretty">
        You&rsquo;ll stop getting status updates for this ticket. It stays open and crews keep working
        on it either way — you just won&rsquo;t hear from us about it.
      </p>

      {step === 'error' && error ? (
        <div className="mb-6 text-left">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      <Button
        type="button"
        onClick={handleUnsubscribe}
        loading={step === 'working'}
        disabled={step === 'working'}
      >
        {step === 'error' ? 'Try Again' : 'Yes, Stop Emailing Me'}
      </Button>
    </div>
  )
}
