// Supabase Edge Function: telegram-webhook
//
// Receives updates from Telegram and turns /start into a subscription.
//
// A bot cannot message someone by username or phone number, only by a chat_id
// it learns when that person messages the bot. So the resident taps a deep link
// carrying a single-use token, Telegram delivers "/start <token>" here, and this
// trades the token for a row in issue_subscribers. Everything after that is the
// same queue the email channel uses.
//
// Deployed with --no-verify-jwt: Telegram will not present a Supabase JWT, so
// the platform's usual gate cannot apply. Authentication is the secret token
// agreed with Telegram at setWebhook time and sent back on every request in
// X-Telegram-Bot-Api-Secret-Token. That header is the only thing standing
// between this endpoint and the open internet, so it is checked first and
// compared in full.
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (injected by Supabase),
//          TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_SITE_URL

import { createClient } from 'npm:@supabase/supabase-js@2'

const DEFAULT_SITE_URL = 'https://civicpulse-tan.vercel.app'

interface TelegramUpdate {
  message?: {
    chat?: { id?: number }
    text?: string
  }
}

/**
 * Telegram retries any update it does not see acknowledged, so every reply is
 * 200 regardless of what happened inside. Returning an error status would earn
 * the same update again a moment later, and again after that. Failures are
 * logged rather than signalled.
 */
const ok = () => new Response(JSON.stringify({ ok: true }), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

async function reply(chatId: number, text: string): Promise<void> {
  const token = Deno.env.get('TELEGRAM_BOT_TOKEN')!
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  })
  if (!response.ok) {
    console.error(`sendMessage failed: ${response.status} ${await response.text()}`)
  }
}

Deno.serve(async (req) => {
  const expected = Deno.env.get('TELEGRAM_WEBHOOK_SECRET')
  if (!expected || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== expected) {
    // Not Telegram. Say as little as possible about why.
    return new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  let update: TelegramUpdate
  try {
    update = await req.json()
  } catch {
    return ok()
  }

  const chatId = update.message?.chat?.id
  const text = (update.message?.text ?? '').trim()
  if (!chatId || !text) return ok()

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  )
  const siteUrl = (Deno.env.get('PUBLIC_SITE_URL') ?? DEFAULT_SITE_URL).replace(/\/+$/, '')

  // ---------------------------------------------------------------- /start
  if (text.startsWith('/start')) {
    const token = text.slice('/start'.length).trim()

    if (!token) {
      await reply(
        chatId,
        'Hello from <b>CivicPulse</b>.\n\nTo follow a ticket, report an issue at ' +
          `${siteUrl} and tap <b>Get updates on Telegram</b> on the confirmation screen.`
      )
      return ok()
    }

    const { data: ticket, error } = await supabase.rpc('telegram_subscribe', {
      p_token: token,
      p_chat_id: String(chatId),
    })

    if (error) {
      console.error(`telegram_subscribe failed: ${error.message}`)
      await reply(chatId, 'Something went wrong linking that ticket. Please try the link again.')
      return ok()
    }

    if (!ticket) {
      // Unknown, expired, or already spent by a different chat. All three are
      // the same thing from the resident's side: this link will not work.
      await reply(
        chatId,
        'That link has expired or has already been used.\n\nOpen your ticket at ' +
          `${siteUrl}/track and tap <b>Get updates on Telegram</b> again for a fresh link.`
      )
      return ok()
    }

    await reply(
      chatId,
      `You're now following <b>${ticket}</b>.\n\n` +
        "I'll message you here whenever its status changes. " +
        `Track it any time at ${siteUrl}/track?ticket=${ticket}\n\n` +
        'Send /stop to stop these updates.'
    )
    return ok()
  }

  // ----------------------------------------------------------------- /stop
  if (text.startsWith('/stop')) {
    const { data: stopped, error } = await supabase.rpc('telegram_unsubscribe_all', {
      p_chat_id: String(chatId),
    })

    if (error) {
      console.error(`telegram_unsubscribe_all failed: ${error.message}`)
      await reply(chatId, 'Something went wrong. Please try /stop again.')
      return ok()
    }

    const tickets = (stopped ?? []) as string[]
    await reply(
      chatId,
      tickets.length === 0
        ? "You weren't following any tickets, so there's nothing to stop."
        : `Stopped updates for <b>${tickets.join('</b>, <b>')}</b>.\n\n` +
            'The work carries on either way — you can still track progress at ' +
            `${siteUrl}/track`
    )
    return ok()
  }

  // -------------------------------------------------------------- anything else
  await reply(
    chatId,
    'I only understand /start and /stop.\n\n' +
      `To follow a ticket, report an issue at ${siteUrl} and tap ` +
      '<b>Get updates on Telegram</b> on the confirmation screen.'
  )
  return ok()
})
