/**
 * Deep link that starts the CivicPulse bot and links it to a ticket.
 *
 * A Telegram bot cannot message someone by username or phone number — only by a
 * chat_id it learns when that person messages the bot first. So a resident
 * cannot be signed up the way an email reporter is, at the moment they file.
 * Instead they carry a single-use token into the chat: Telegram delivers it as
 * "/start <token>" to the webhook, which trades it for a subscription.
 *
 * Two taps on a phone, and nothing typed. It also works for a resident who
 * reported anonymously — Telegram is the one channel that needs nothing
 * identifying from them, since all we ever learn is an opaque chat id.
 *
 * The payload is capped by Telegram at 64 characters from [A-Za-z0-9_-], which
 * is why the token is base64url rather than a plain uuid.
 */
export const TELEGRAM_BOT_USERNAME = 'civicpulse1111_bot'

export function telegramDeepLink(token: string): string {
  return `https://t.me/${TELEGRAM_BOT_USERNAME}?start=${encodeURIComponent(token)}`
}
