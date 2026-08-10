// Supabase Edge Function: send-notifications
//
// Drains the `notifications` queue and delivers each row over its own channel --
// email by SMTP, Telegram by HTTPS. Invoked once a minute by pg_cron via pg_net
// (migration 0009), and safe to invoke by hand.
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
//          GMAIL_USER, GMAIL_APP_PASSWORD, TELEGRAM_BOT_TOKEN, PUBLIC_SITE_URL

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
  /** 'email' | 'telegram' — decides which sender handles the row. */
  channel: string
  subscriber_id: string | null
  event: string
  payload: Record<string, string | null>
}

interface Email {
  to: string
  subject: string
  html: string
  text: string
}

/**
 * A delivery channel. Each one renders its own format: an email needs a subject
 * and an HTML body, a Telegram message needs neither, and pretending they share
 * a shape only forces one of them to carry fields it ignores.
 */
interface Sender {
  send(row: NotificationRow, siteUrl: string): Promise<void>
  close(): Promise<void>
}

/**
 * Thrown when the recipient has put the channel beyond reach for good — a
 * blocked bot, most obviously. Retrying that four more times is pointless, so
 * it short-circuits to unsubscribing instead of going back on the queue.
 */
class RecipientGoneError extends Error {}

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

/**
 * Gmail SMTP reaches arbitrary recipients with no domain to verify, which is
 * what made it the practical choice. If its daily cap ever becomes the binding
 * constraint, swapping in an HTTPS provider means replacing this factory alone.
 */
function createGmailSender(): Sender {
  const user = Deno.env.get('GMAIL_USER')
  const password = Deno.env.get('GMAIL_APP_PASSWORD')
  if (!user || !password) throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not configured')

  const client = new SMTPClient({
    connection: {
      hostname: 'smtp.gmail.com',
      port: 465,
      tls: true,
      auth: { username: user, password },
    },
  })

  return {
    async send(row, siteUrl) {
      const email = renderEmail(row, siteUrl)
      await client.send({
        from: `CivicPulse <${user}>`,
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

/**
 * Telegram is a single HTTPS call, so there is no connection to keep or close.
 * The recipient is a chat_id the bot learned when the resident tapped the deep
 * link — the bot cannot message anyone who has not started it first.
 */
function createTelegramSender(): Sender {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not configured')

  return {
    async send(row, siteUrl) {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: row.recipient,
          text: renderTelegram(row, siteUrl),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      })

      if (response.ok) return

      const body = await response.text()
      // 403 is Telegram's answer for "blocked by the user" and for a chat that
      // no longer exists. Neither improves by trying again.
      if (response.status === 403) throw new RecipientGoneError(body)
      throw new Error(`telegram ${response.status}: ${body}`)
    },
    async close() {},
  }
}

function renderTelegram(row: NotificationRow, siteUrl: string): string {
  const p = row.payload ?? {}
  const ticket = String(p.ticket_number ?? '')
  const trackUrl = `${siteUrl}/track?ticket=${encodeURIComponent(ticket)}`
  const where = [p.area, p.city].filter(Boolean).join(', ')

  let headline: string
  switch (row.event) {
    case 'ticket_created':
      headline = `<b>${esc(ticket)}</b> — we've got your report`
      break
    case 'ticket_followed':
      headline = `<b>${esc(ticket)}</b> — someone already reported this, so you're following their ticket`
      break
    default:
      headline = p.previous_status
        ? `<b>${esc(ticket)}</b> — ${esc(statusLabel(p.previous_status))} → <b>${esc(statusLabel(p.status))}</b>`
        : `<b>${esc(ticket)}</b> — now <b>${esc(statusLabel(p.status))}</b>`
  }

  const lines = [
    headline,
    '',
    `${esc(p.comment)}`,
    where ? `📍 ${esc(where)}` : '',
    p.department ? `🏢 ${esc(p.department)}` : '',
  ]

  if (p.status === 'resolved' && p.resolution_comment) {
    lines.push('', `✅ <b>What was done:</b> ${esc(p.resolution_comment)}`)
  }

  lines.push('', `<a href="${trackUrl}">Track this ticket</a>`, '', '<i>Send /stop to end these updates.</i>')
  return lines.filter((line, i) => line !== '' || lines[i - 1] !== '').join('\n')
}

function renderEmail(row: NotificationRow, siteUrl: string): Email {
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

/**
 * The `role` claim of the bearer token, or null if there isn't one.
 *
 * Reads the payload without verifying the signature, which is safe *here* and
 * only here: this function is deployed with JWT verification on, so Supabase's
 * gateway has already rejected anything not signed by the project. What the
 * gateway does not do is care *which* role signed it -- an anon key is equally
 * valid to it -- so that is what this adds.
 */
function callerRole(req: Request): string | null {
  const auth = req.headers.get('Authorization') ?? ''
  if (!auth.startsWith('Bearer ')) return null

  const segment = auth.slice(7).split('.')[1]
  if (!segment) return null

  try {
    const padded = segment.replaceAll('-', '+').replaceAll('_', '/')
    const json = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
    return JSON.parse(json).role ?? null
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  // Only the scheduler may drain the queue.
  //
  // Checked by role rather than by comparing against SUPABASE_SERVICE_ROLE_KEY:
  // a project can have more than one valid service_role JWT (a legacy key and a
  // re-issued one), and byte-equality against whichever happens to be injected
  // here rejects the others. Verified in production -- the cron job presented a
  // perfectly good service_role key for this project and got a 403.
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const authorized =
    req.headers.get('Authorization') === `Bearer ${serviceKey}` ||
    callerRole(req) === 'service_role'

  if (!authorized) {
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

  // Built on demand and cached for the batch, rather than up front.
  //
  // A single sender constructed before the loop meant one channel's missing
  // credential failed every row claimed alongside it — a Telegram token problem
  // would have taken the emails down with it. Now a channel that cannot be
  // built fails only its own rows, and a batch with no Telegram in it never
  // touches the Telegram configuration at all.
  const senders = new Map<string, Sender>()
  const factories: Record<string, () => Sender> = {
    email: createGmailSender,
    telegram: createTelegramSender,
  }

  function senderFor(channel: string): Sender {
    const existing = senders.get(channel)
    if (existing) return existing

    const factory = factories[channel]
    if (!factory) throw new Error(`no sender for channel '${channel}'`)

    const created = factory()
    senders.set(channel, created)
    return created
  }

  let sent = 0
  let failed = 0
  let dropped = 0

  // Sequential on purpose: Gmail throttles aggressively on parallel sends, and
  // one connection reused across the batch is what it expects to see.
  for (const row of rows) {
    try {
      await senderFor(row.channel).send(row, siteUrl)
      await supabase.rpc('mark_notification_sent', { p_id: row.id })
      sent++
    } catch (err) {
      if (err instanceof RecipientGoneError) {
        // The resident blocked the bot. Unsubscribing is the honest reading of
        // that, and it stops four more attempts at a door that is shut.
        if (row.subscriber_id) {
          await supabase
            .from('issue_subscribers')
            .update({ unsubscribed_at: new Date().toISOString() })
            .eq('id', row.subscriber_id)
        }
        await supabase
          .from('notifications')
          .update({ status: 'skipped', last_error: `recipient unreachable: ${err.message}` })
          .eq('id', row.id)
        dropped++
        continue
      }

      // Back to 'queued' for another attempt, or 'failed' once attempts run out
      // -- mark_notification_failed decides which.
      await supabase.rpc('mark_notification_failed', {
        p_id: row.id,
        p_error: (err as Error).message,
      })
      failed++
    }
  }

  for (const sender of senders.values()) {
    try {
      await sender.close()
    } catch {
      // A failed close says nothing about whether the message went out.
    }
  }

  return new Response(JSON.stringify({ claimed: rows.length, sent, failed, dropped }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
