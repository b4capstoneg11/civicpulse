import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { computeImageHash } from '../lib/imageHash'
import { reverseGeocode } from '../lib/geocode'
import { joinParts } from '../lib/format'
import { Alert, Button, Field, Input, Textarea } from '../components/ui'
import { TicketNumber } from '../components/StatusBadge'
import type { ClassificationResult, ReporterChannel } from '../lib/types'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(',')[1])
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

type Step = 'form' | 'submitting' | 'done' | 'duplicate'

const CHANNEL_LABELS: Record<ReporterChannel, string> = {
  anonymous: 'Stay Anonymous',
  phone: 'Phone',
  email: 'Email',
}

export function ReportIssue() {
  const [photo, setPhoto] = useState<File | null>(null)
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [landmark, setLandmark] = useState('')
  const [reporterChannel, setReporterChannel] = useState<ReporterChannel>('anonymous')
  const [reporterContact, setReporterContact] = useState('')
  const [location, setLocation] = useState<{ lat: number; lon: number } | null>(null)
  const [locating, setLocating] = useState(false)
  const [address, setAddress] = useState<{
    pincode: string | null
    area: string | null
    city: string | null
    state: string | null
  } | null>(null)

  const [step, setStep] = useState<Step>('form')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [resultTicket, setResultTicket] = useState<string | null>(null)

  // Object URLs leak unless revoked, so the preview is tied to the file's lifetime
  // rather than recreated on every render.
  useEffect(() => {
    if (!photo) {
      setPhotoPreview(null)
      return
    }
    const url = URL.createObjectURL(photo)
    setPhotoPreview(url)
    return () => URL.revokeObjectURL(url)
  }, [photo])

  function captureLocation() {
    setLocating(true)
    setError(null)
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude
        const lon = position.coords.longitude
        setLocation({ lat, lon })
        setFieldErrors((prev) => ({ ...prev, location: '' }))
        try {
          setAddress(await reverseGeocode(lat, lon))
        } catch {
          setAddress(null)
        }
        setLocating(false)
      },
      (geoError) => {
        setError(`Could not get your location: ${geoError.message}. Enable location access and try again.`)
        setLocating(false)
      },
      { enableHighAccuracy: true, timeout: 15000 }
    )
  }

  function validate(): Record<string, string> {
    const errors: Record<string, string> = {}
    if (!photo) errors.photo = 'Attach a photo so staff can see the issue.'
    if (!comment.trim()) errors.comment = 'Describe what you’re reporting.'
    if (!location) errors.location = 'Capture your location so we can route this to the right area.'
    if (reporterChannel !== 'anonymous' && !reporterContact.trim()) {
      errors.contact = `Enter your ${reporterChannel}, or choose to stay anonymous.`
    }
    return errors
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    const errors = validate()
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      // Move focus to the first thing that needs fixing.
      const first = document.querySelector<HTMLElement>('[aria-invalid="true"]')
      first?.focus()
      first?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      return
    }

    setStep('submitting')

    try {
      // Hashing and base64 encoding are independent — run them together.
      const [base64, imageSignature] = await Promise.all([
        fileToBase64(photo!),
        computeImageHash(photo!),
      ])

      const { data: classification, error: fnError } =
        await supabase.functions.invoke<ClassificationResult>('analyze-issue', {
          body: {
            photoBase64: base64,
            mediaType: photo!.type || 'image/jpeg',
            comment,
            landmark: landmark || undefined,
            area: address?.area ?? undefined,
            city: address?.city ?? undefined,
            imageSignature,
          },
        })

      if (fnError) throw fnError
      if (!classification) throw new Error('No response from the classification service.')

      if (classification.duplicate && classification.duplicateOfTicket) {
        const { data: original } = await supabase
          .from('issues')
          .select('id')
          .eq('ticket_number', classification.duplicateOfTicket)
          .single()

        if (original) {
          await supabase.from('issue_status_history').insert({
            issue_id: original.id,
            status: 'created',
            note: 'Also reported by another resident (merged as duplicate)',
            actor: 'ai',
          })
        }

        setResultTicket(classification.duplicateOfTicket)
        setStep('duplicate')
        return
      }

      const photoPath = `${crypto.randomUUID()}-${photo!.name}`
      const { error: uploadError } = await supabase.storage.from('issue-photos').upload(photoPath, photo!)
      if (uploadError) throw uploadError
      const { data: photoUrlData } = supabase.storage.from('issue-photos').getPublicUrl(photoPath)

      const { data: department } = await supabase
        .from('departments')
        .select('id')
        .eq('slug', classification.department_slug ?? 'other')
        .single()

      const { data: issue, error: insertError } = await supabase
        .from('issues')
        .insert({
          reporter_channel: reporterChannel,
          reporter_contact: reporterChannel === 'anonymous' ? null : reporterContact,
          photo_url: photoUrlData.publicUrl,
          comment,
          landmark: landmark || null,
          latitude: location!.lat,
          longitude: location!.lon,
          pincode: address?.pincode ?? null,
          area: address?.area ?? null,
          city: address?.city ?? null,
          state: address?.state ?? null,
          image_signature: imageSignature,
          issue_type: classification.issue_type,
          department_id: department?.id,
          priority: classification.priority,
          ai_summary: classification.summary,
          ai_confidence: classification.confidence,
          status: 'assigned',
        })
        .select('id, ticket_number')
        .single()

      if (insertError) throw insertError

      await supabase.from('issue_status_history').insert([
        { issue_id: issue.id, status: 'created', note: 'Report submitted and validated', actor: 'ai' },
        {
          issue_id: issue.id,
          status: 'assigned',
          note: `Routed to ${classification.department_slug} department`,
          actor: 'ai',
        },
      ])

      await supabase.from('notifications').insert({
        issue_id: issue.id,
        channel: 'email',
        recipient: reporterChannel === 'anonymous' ? null : reporterContact,
        message: `Your report ${issue.ticket_number} has been created and assigned.`,
      })

      setResultTicket(issue.ticket_number)
      setStep('done')
    } catch (err) {
      setError((err as Error).message)
      setStep('form')
    }
  }

  if (step === 'done' || step === 'duplicate') {
    const isDuplicate = step === 'duplicate'
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <div
          aria-hidden="true"
          className={`mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-full text-2xl ${
            isDuplicate ? 'bg-info-wash text-info' : 'bg-ok-wash text-ok'
          }`}
        >
          {isDuplicate ? '⇄' : '✓'}
        </div>
        <h1 className="mb-2 text-2xl font-semibold text-ink text-balance">
          {isDuplicate ? 'This Was Already Reported' : 'Thank You for Your Report'}
        </h1>
        <p className="mb-6 text-ink-soft text-pretty">
          {isDuplicate
            ? 'Someone nearby already reported the same issue. Your report is linked to theirs, so you can track it too.'
            : 'Your ticket has been created and routed to the right department.'}
        </p>
        <div className="mb-6 rounded-xl border border-brand/30 bg-brand-wash px-6 py-4">
          <p className="mb-1 text-xs font-medium uppercase tracking-wide text-brand">Ticket Number</p>
          <TicketNumber value={resultTicket ?? ''} className="text-2xl font-bold text-brand-hi" />
        </div>
        <Link
          to={`/track?ticket=${resultTicket}`}
          className="inline-flex rounded-lg bg-brand px-5 py-2.5 text-sm font-medium text-canvas transition-colors hover:bg-brand-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
        >
          Track This Ticket
        </Link>
      </div>
    )
  }

  const submitting = step === 'submitting'

  return (
    <div className="mx-auto max-w-lg px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold text-ink text-balance">Report a Civic Issue</h1>
      <p className="mb-8 text-ink-soft text-pretty">
        Add a photo, a short description, and your location. We’ll triage it and route it to the right
        department automatically.
      </p>

      <form onSubmit={handleSubmit} noValidate className="space-y-6">
        <Field label="Photo" error={fieldErrors.photo} required>
          {(props) => (
            <>
              <input
                {...props}
                type="file"
                accept="image/*"
                capture="environment"
                name="photo"
                onChange={(e) => {
                  setPhoto(e.target.files?.[0] ?? null)
                  setFieldErrors((prev) => ({ ...prev, photo: '' }))
                }}
                className="block w-full cursor-pointer rounded-lg border border-line bg-panel p-2 text-sm text-ink-soft file:mr-3 file:rounded-md file:border-0 file:bg-brand-wash file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-brand hover:file:bg-brand-wash focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
              />
              {photoPreview ? (
                <img
                  src={photoPreview}
                  alt="Preview of the issue you’re reporting"
                  width={640}
                  height={256}
                  className="mt-3 h-48 w-full rounded-lg border border-line object-cover"
                />
              ) : null}
            </>
          )}
        </Field>

        <Field
          label="What’s the Issue?"
          error={fieldErrors.comment}
          required
          hint="A sentence or two is plenty."
        >
          {(props) => (
            <Textarea
              {...props}
              name="description"
              value={comment}
              onChange={(e) => {
                setComment(e.target.value)
                setFieldErrors((prev) => ({ ...prev, comment: '' }))
              }}
              rows={3}
              maxLength={1000}
              placeholder="Large pothole blocking the left lane near the bus stop…"
            />
          )}
        </Field>

        <Field label="Nearby Landmark" hint="Helps crews find the exact spot.">
          {(props) => (
            <Input
              {...props}
              type="text"
              name="landmark"
              autoComplete="off"
              value={landmark}
              onChange={(e) => setLandmark(e.target.value)}
              placeholder="Opposite Sector 12 market…"
            />
          )}
        </Field>

        {/* A fieldset/legend, not Field: a <label for> pointing at a button replaces
            the button's visible text as its accessible name, so screen readers would
            announce "Location" instead of "Capture My Location". */}
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium text-ink">Location</legend>
          {/* Accent, not primary: Submit Report is this screen's one primary action. */}
          <Button
            type="button"
            variant={location ? 'secondary' : 'accent'}
            onClick={captureLocation}
            loading={locating}
            aria-invalid={fieldErrors.location ? true : undefined}
            aria-describedby={fieldErrors.location ? 'location-error' : undefined}
          >
            {locating ? 'Getting Location…' : location ? 'Location Captured ✓' : 'Capture My Location'}
          </Button>
          {address ? (
            <p className="mt-2 text-sm text-ink-soft">
              {joinParts([address.area, address.city, address.state, address.pincode])}
            </p>
          ) : null}
          {fieldErrors.location ? (
            <p id="location-error" className="mt-1.5 text-sm text-danger">
              {fieldErrors.location}
            </p>
          ) : null}
        </fieldset>

        <fieldset>
          <legend className="mb-2 text-sm font-medium text-ink">How Should We Reach You?</legend>
          <div className="mb-3 flex flex-wrap gap-2">
            {(['anonymous', 'phone', 'email'] as ReporterChannel[]).map((channel) => (
              <label
                key={channel}
                className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors [touch-action:manipulation] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand has-[:focus-visible]:ring-offset-2 ${
                  reporterChannel === channel
                    ? 'border-brand bg-brand-wash text-brand-hi'
                    : 'border-line bg-panel text-ink-soft hover:border-line-strong'
                }`}
              >
                <input
                  type="radio"
                  name="reporterChannel"
                  value={channel}
                  checked={reporterChannel === channel}
                  onChange={() => {
                    setReporterChannel(channel)
                    setFieldErrors((prev) => ({ ...prev, contact: '' }))
                  }}
                  className="accent-brand focus-visible:outline-none"
                />
                {CHANNEL_LABELS[channel]}
              </label>
            ))}
          </div>

          {reporterChannel === 'anonymous' ? null : (
            <Field
              label={reporterChannel === 'email' ? 'Email Address' : 'Phone Number'}
              error={fieldErrors.contact}
              required
            >
              {(props) => (
                <Input
                  {...props}
                  type={reporterChannel === 'email' ? 'email' : 'tel'}
                  name={reporterChannel === 'email' ? 'email' : 'tel'}
                  autoComplete={reporterChannel === 'email' ? 'email' : 'tel'}
                  inputMode={reporterChannel === 'email' ? 'email' : 'tel'}
                  spellCheck={false}
                  value={reporterContact}
                  onChange={(e) => {
                    setReporterContact(e.target.value)
                    setFieldErrors((prev) => ({ ...prev, contact: '' }))
                  }}
                  placeholder={reporterChannel === 'email' ? 'you@example.com' : '+91 98765 43210'}
                />
              )}
            </Field>
          )}
        </fieldset>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <Button type="submit" size="lg" loading={submitting} className="w-full">
          {submitting ? 'Analyzing Report…' : 'Submit Report'}
        </Button>
      </form>
    </div>
  )
}
