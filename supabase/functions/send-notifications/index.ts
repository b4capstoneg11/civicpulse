// Supabase Edge Function: send-notifications
//
// Drains the `notifications` queue and delivers the email. Invoked once a
// minute by pg_cron via pg_net (migration 0009), and safe to invoke by hand.
//
// Nothing decides *whether* to notify here -- Postgres already did that. A
// trigger on `issues` queues an event for every subscriber (migration 0007),
// which is what finally covers the status-change paths the frontend never knew
// about. This function only renders and sends.
//
// The claim is a single SQL statement (`claim_notifications`) rather than a
// select-then-update: two overlapping runs must not grab the same row and email
// a resident twice. Rows are marked 'sending' at claim time and reported back
// individually, so one bad address cannot take the batch down with it.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected by Supabase),
//          GMAIL_USER, GMAIL_APP_PASSWORD, PUBLIC_SITE_URL

import { createClient } from 'npm:@supabase/supabase-js@2'
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'

const BATCH_SIZE = 20
const DEFAULT_SITE_URL = 'https://civicpulse-tan.vercel.app'

const STATUS_LABELS: Record<string, string> = {
  created: 'Created',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
  reopened: 'Reopened',
}

interface NotificationRow {
  id: string
  recipient: string
  event: string
  payload: Record<string, string | null>
}

/**
 * What a rendered message looks like, independent of how it is delivered.
 *
 * Gmail SMTP was chosen because it reaches arbitrary recipients with no domain
 * to verify. If the edge runtime turns out to block raw SMTP, or Gmail's daily
 * cap becomes the binding constraint, swapping in an HTTPS provider means
 * replacing `createSender` and nothing else.
 */
interface Email {
  to: string
  subject: string
  html: string
  text: string
}

interface Sender {
  send(email: Email): Promise<void>
  close(): Promise<void>
}

/** Resident-supplied text lands inside an HTML email, so it has to be escaped. */
function esc(value: string | null | undefined): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function statusLabel(status: string | null): string {
  return STATUS_LABELS[status ?? ''] ?? (status ?? 'Updated')
}

function createGmailSender(): Sender {
  const client = new SMTPClient({
    connection: {
      hostname: 'smtp.gmail.com',
      port: 465,
      tls: true,
      auth: {
        username: Deno.env.get('GMAIL_USER')!,
        password: Deno.env.get('GMAIL_APP_PASSWORD')!,
      },
    },
  })

  return {
    async send(email) {
      await client.send({
        from: `CivicPulse <${Deno.env.get('GMAIL_USER')!}>`,
        to: email.to,
        subject: email.subject,
        content: email.text,
        html: email.html,
      })
    },
    async close() {
      await client.close()
    },
  }
}

function render(row: NotificationRow, siteUrl: string): Email {
  const p = row.payload ?? {}
  const ticket = String(p.ticket_number ?? '')
  const trackUrl = `${siteUrl}/track?ticket=${encodeURIComponent(ticket)}`
  const unsubscribeUrl = `${siteUrl}/unsubscribe?token=${encodeURIComponent(String(p.unsubscribe_token ?? ''))}`
  const where = [p.area, p.city].filter(Boolean).join(', ')

  let subject: string
  let headline: string
  let body: string

  switch (row.event) {
    case 'ticket_created':
      subject = `${ticket} — we've got your report`
      headline = 'Your report has been logged'
      body = `Thanks for reporting this. It has been routed to ${esc(p.department ?? 'the right department')} and we'll email you as the status changes.`
      break

    case 'ticket_followed':
      subject = `${ticket} — someone already reported this`
      headline = "You're following an existing ticket"
      body = `Someone had already reported this issue at the same location, so your report was merged into ticket ${esc(ticket)} rather than creating a duplicate. You'll get the same updates as the original reporter.`
      break

    case 'status_changed':
    default:
      subject = `${ticket} — now ${statusLabel(p.status).toLowerCase()}`
      headline = `Status changed to ${statusLabel(p.status)}`
      body = p.previous_status
        ? `This ticket moved from ${statusLabel(p.previous_status).toLowerCase()} to ${statusLabel(p.status).toLowerCase()}.`
        : `This ticket is now ${statusLabel(p.status).toLowerCase()}.`
      break
  }

  const resolution =
    p.status === 'resolved' && p.resolution_comment
      ? `<p style="margin:0 0 16px;padding:12px;background:#f0fdf4;border-left:3px solid #16a34a;">
           <strong>What was done:</strong><br>${esc(p.resolution_comment)}
         </p>`
      : ''

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2328;">
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e4e7eb;border-radius:12px;padding:24px;">
    <p style="margin:0 0 4px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#6b7280;">CivicPulse</p>
    <h1 style="margin:0 0 12px;font-size:20px;">${esc(headline)}</h1>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${body}</p>
    ${resolution}
    <table style="width:100%;border-collapse:collapse;font-size:14px;margin:0 0 20px;">
      <tr><td style="padding:6px 0;color:#6b7280;">Ticket</td><td style="padding:6px 0;font-weight:600;">${esc(ticket)}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Status</td><td style="padding:6px 0;">${esc(statusLabel(p.status))}</td></tr>
      <tr><td style="padding:6px 0;color:#6b7280;">Department</td><td style="padding:6px 0;">${esc(p.department)}</td></tr>
      ${where ? `<tr><td style="padding:6px 0;color:#6b7280;">Location</td><td style="padding:6px 0;">${esc(where)}</td></tr>` : ''}
      <tr><td style="padding:6px 0;color:#6b7280;">Reported</td><td style="padding:6px 0;">${esc(p.comment)}</td></tr>
    </table>
    <a href="${trackUrl}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:500;">Track this ticket</a>
    <p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e4e7eb;font-size:12px;color:#6b7280;">
      You're getting this because you gave your email when reporting a civic issue.
      <a href="${unsubscribeUrl}" style="color:#6b7280;">Stop emails about this ticket</a>.
    </p>
  </div>
</body></html>`

  const text = [
    headline,
    '',
    body.replace(/<[^>]+>/g, ''),
    '',
    `Ticket:     ${ticket}`,
    `Status:     ${statusLabel(p.status)}`,
    `Department: ${p.department ?? '-'}`,
    where ? `Location:   ${where}` : '',
    `Reported:   ${p.comment ?? '-'}`,
    p.status === 'resolved' && p.resolution_comment ? `\nWhat was done: ${p.resolution_comment}` : '',
    '',
    `Track it: ${trackUrl}`,
    '',
    `Stop emails about this ticket: ${unsubscribeUrl}`,
  ]
    .filter((line) => line !== '')
    .join('\n')

  return { to: row.recipient, subject, html, text }
}

Deno.serve(async (req) => {
  // Only the scheduler may drain the queue. Supabase's gateway checks that the
  // JWT is *valid*, which an anon key also is -- so the service-role key is
  // compared explicitly here rather than trusting the gateway alone.
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  if (req.headers.get('Authorization') !== `Bearer ${serviceKey}`) {
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey)
  const siteUrl = (Deno.env.get('PUBLIC_SITE_URL') ?? DEFAULT_SITE_URL).replace(/\/+$/, '')

  const { data: claimed, error: claimError } = await supabase.rpc('claim_notifications', {
    p_limit: BATCH_SIZE,
  })

  if (claimError) {
    return new Response(JSON.stringify({ error: claimError.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const rows = (claimed ?? []) as NotificationRow[]
  if (rows.length === 0) {
    return new Response(JSON.stringify({ claimed: 0, sent: 0, failed: 0 }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let sender: Sender
  try {
    sender = createGmailSender()
  } catch (err) {
    // The transport itself is unusable (missing credentials, say). Hand every
    // claimed row back rather than stranding the batch in 'sending'.
    const reason = `sender unavailable: ${(err as Error).message}`
    for (const row of rows) {
      await supabase.rpc('mark_notification_failed', { p_id: row.id, p_error: reason })
    }
    return new Response(JSON.stringify({ claimed: rows.length, sent: 0, failed: rows.length }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let sent = 0
  let failed = 0

  // Sequential on purpose: Gmail throttles aggressively on parallel sends, and
  // one connection reused across the batch is what it expects to see.
  for (const row of rows) {
    try {
      await sender.send(render(row, siteUrl))
      await supabase.rpc('mark_notification_sent', { p_id: row.id })
      sent++
    } catch (err) {
      // Back to 'queued' for another attempt, or 'failed' once attempts run out
      // -- mark_notification_failed decides which.
      await supabase.rpc('mark_notification_failed', {
        p_id: row.id,
        p_error: (err as Error).message,
      })
      failed++
    }
  }

  try {
    await sender.close()
  } catch {
    // A failed close says nothing about whether the mail went out.
  }

  return new Response(JSON.stringify({ claimed: rows.length, sent, failed }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
