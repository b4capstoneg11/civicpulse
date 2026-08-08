import { useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { Alert, Button, Field, Textarea } from './ui'

const RATINGS = [1, 2, 3, 4, 5]

export function RatingWidget({
  ticketNumber,
  onSubmitted,
}: {
  ticketNumber: string
  onSubmitted: () => void
}) {
  const [rating, setRating] = useState(0)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (rating === 0) {
      setError('Select a rating from 1 to 5 before submitting.')
      return
    }
    setSubmitting(true)
    setError(null)

    const { error: rpcError } = await supabase.rpc('rate_issue', {
      p_ticket_number: ticketNumber,
      p_rating: rating,
      p_rating_comment: comment || null,
    })
    setSubmitting(false)

    if (rpcError) {
      setError(rpcError.message)
      return
    }
    onSubmitted()
  }

  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <h2 className="mb-3 text-sm font-semibold text-ink">Was This Resolution Satisfactory?</h2>

      {/* Real radios rather than buttons, so arrow keys and screen readers work for free. */}
      <fieldset className="mb-4">
        <legend className="sr-only">Rating out of 5</legend>
        <div className="flex gap-2">
          {RATINGS.map((n) => (
            <label
              key={n}
              className={`flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border text-sm font-semibold transition-colors [touch-action:manipulation] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand has-[:focus-visible]:ring-offset-2 ${
                rating >= n
                  ? 'border-warn bg-warn text-canvas'
                  : 'border-line bg-panel text-subtle hover:border-line-strong'
              }`}
            >
              <input
                type="radio"
                name="rating"
                value={n}
                checked={rating === n}
                onChange={() => {
                  setRating(n)
                  setError(null)
                }}
                aria-label={`${n} out of 5`}
                className="sr-only"
              />
              {n}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mb-3">
        <Field label="Anything Else to Add?">
          {(props) => (
            <Textarea
              {...props}
              name="ratingComment"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="The road is smooth again…"
              rows={2}
              maxLength={500}
            />
          )}
        </Field>
      </div>

      {error ? (
        <div className="mb-3">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      <Button onClick={submit} loading={submitting}>
        {submitting ? 'Submitting…' : 'Submit Rating'}
      </Button>

      <p className="mt-3 text-xs text-subtle text-pretty">
        A rating of 1 or 2 automatically reopens this ticket and routes it back for review.
      </p>
    </section>
  )
}
