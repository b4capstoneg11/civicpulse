import type { FunctionsError } from '@supabase/supabase-js'

/**
 * supabase-js reports any non-2xx from an Edge Function as the opaque
 * "Edge Function returned a non-2xx status code" and leaves `data` null — the
 * JSON body carrying the real reason is stashed on `error.context`, which is the
 * raw Response. Without unwrapping it the user is told nothing useful.
 */
export async function readFunctionError(
  error: FunctionsError | null,
  data: { error?: string } | null
): Promise<string | null> {
  if (data?.error) return data.error
  if (!error) return null

  const context = (error as { context?: unknown }).context
  if (context instanceof Response) {
    try {
      // The body can only be read once, so work on a clone.
      const body = await context.clone().json()
      if (body && typeof body.error === 'string') return body.error
    } catch {
      // Not JSON — fall through to the generic message.
    }
  }

  return error.message
}
