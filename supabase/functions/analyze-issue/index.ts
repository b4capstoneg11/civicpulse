// Supabase Edge Function: analyze-issue
//
// Given a resident's photo + comment + location, this function:
//   1. Looks up the open tickets already recorded near that location.
//   2. Calls OpenAI (vision + text) once to classify the issue type, route it to
//      a department, score its priority, and say whether the report describes
//      the same physical problem as one of those nearby tickets.
//
// Secrets required (set via `supabase secrets set`):
//   OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import OpenAI from 'npm:openai@4.77.0'
import { createClient } from 'npm:@supabase/supabase-js@2'

const DEPARTMENT_SLUGS = ['roads', 'electrical', 'sanitation', 'water', 'public_works', 'other'] as const
const ISSUE_TYPES = ['pothole', 'streetlight', 'garbage', 'water_leakage', 'damaged_infrastructure', 'other'] as const
const PRIORITIES = ['low', 'medium', 'high'] as const

const MODEL = 'gpt-4o'

// The browser sends a preflight OPTIONS before the real POST (the request carries
// Authorization + Content-Type). Without these headers on *every* response the
// preflight fails and supabase-js surfaces a bare "Failed to send a request to
// the Edge Function", with no status to inspect.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' }

// Duplicate detection, in two parts that do different jobs.
//
// Location is a hard gate: only open tickets within SAME_ISSUE_METERS are even
// considered, so a report from Delhi can never merge into a Kolkata ticket.
//
// Which of those tickets — if any — is the *same issue* is then decided by the
// model, comparing this photo and description against each candidate's photo
// and description. Every bucket tried before this failed, because no bucket
// expresses "the same physical problem":
//   - `issue_type` is unstable. One transformer photo classified six times came
//     back `streetlight` once, `other` three times, `damaged_infrastructure`
//     twice, so a re-report could not reliably find its own ticket.
//   - the department is stable but far too coarse. Every roads report within
//     120 m collapses into one ticket, and a broken road is not a pothole.
//   - a perceptual hash of the photo recognises the same image *file*, not the
//     same object: two photos of one pothole 5 m apart differ by 29 of 64 bits
//     against 32 for unrelated images.
// Sameness is a judgement about content, so it is made by looking at content.
const SAME_ISSUE_METERS = 120
const DUPLICATE_LOOKBACK_DAYS = 30
const OPEN_STATUSES = ['created', 'assigned', 'in_progress']

// How many nearby tickets go in front of the model. Each carries a photo, so
// this bounds cost and latency; the busiest junction in the data has three.
const MAX_CANDIDATES = 6

// The schema needs a value meaning "none of them", and it has to be a string so
// it can sit in the same enum as the ticket numbers. Ticket numbers are CP-\d+,
// so this cannot collide with one.
const NO_DUPLICATE = 'none'

interface RequestBody {
  photoBase64: string
  mediaType: string
  comment: string
  landmark?: string
  area?: string
  city?: string
  latitude?: number
  longitude?: number
}

interface Classification {
  issue_type: (typeof ISSUE_TYPES)[number]
  department_slug: (typeof DEPARTMENT_SLUGS)[number]
  priority: (typeof PRIORITIES)[number]
  confidence: number
  summary: string
  duplicate_of_ticket: string
}

interface Candidate {
  ticket_number: string
  status: string
  created_at: string
  comment: string
  ai_summary: string | null
  photo_url: string
  departments: { name: string } | null
  meters: number
}

// Built per request rather than as a constant: the candidate ticket numbers go
// into the enum, so the model cannot name a ticket that is not on the list, and
// cannot invent one. Structured Outputs in strict mode require every property
// in `required` and `additionalProperties: false` — no optional fields.
function classificationSchema(candidateTickets: string[]) {
  return {
    type: 'object',
    properties: {
      issue_type: { type: 'string', enum: ISSUE_TYPES as unknown as string[] },
      department_slug: { type: 'string', enum: DEPARTMENT_SLUGS as unknown as string[] },
      priority: {
        type: 'string',
        enum: PRIORITIES as unknown as string[],
        description: 'high = safety hazard or blocks access; medium = clear nuisance; low = cosmetic/minor',
      },
      confidence: { type: 'number', description: '0 to 1 confidence in this classification' },
      summary: { type: 'string', description: 'One sentence human-readable summary of the issue' },
      duplicate_of_ticket: {
        type: 'string',
        enum: [...candidateTickets, NO_DUPLICATE],
        description: `The nearby ticket reporting this same physical problem, or "${NO_DUPLICATE}" if none of them does`,
      },
    },
    required: [
      'issue_type',
      'department_slug',
      'priority',
      'confidence',
      'summary',
      'duplicate_of_ticket',
    ],
    additionalProperties: false,
  }
}

/** Great-circle distance in metres. */
function metersBetween(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLon = toRad(bLon - aLon)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS })
  }

  try {
    const body: RequestBody = await req.json()
    const { photoBase64, mediaType, comment, landmark, area, city, latitude, longitude } = body

    if (!photoBase64 || !comment) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400,
        headers: JSON_HEADERS,
      })
    }

    const openai = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY') })
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Candidates are found by location alone, which needs no classification, so
    // this happens before the model call and its answer can be folded into it.
    const hasCoords = typeof latitude === 'number' && typeof longitude === 'number'
    let candidates: Candidate[] = []

    if (hasCoords) {
      const since = new Date(Date.now() - DUPLICATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
      // Square bounding box first so Postgres can range-scan; the round radius
      // is applied below. cos() is clamped so a report near the poles cannot
      // widen the box to the whole globe.
      const latDelta = SAME_ISSUE_METERS / 111_320
      const lonDelta =
        SAME_ISSUE_METERS / (111_320 * Math.max(Math.cos(latitude! * (Math.PI / 180)), 0.01))

      const { data, error } = await supabaseAdmin
        .from('issues')
        .select(
          'ticket_number, status, created_at, latitude, longitude, comment, ai_summary, photo_url, departments(name)'
        )
        .in('status', OPEN_STATUSES)
        .gte('created_at', since)
        .gte('latitude', latitude! - latDelta)
        .lte('latitude', latitude! + latDelta)
        .gte('longitude', longitude! - lonDelta)
        .lte('longitude', longitude! + lonDelta)
        .limit(100)

      // Fail open: a dedup lookup that errors must not block a resident's
      // report. Log it rather than swallowing it — this check going quietly
      // dead is exactly the failure that is invisible from the outside.
      if (error) console.error('dedup candidate query failed', error)

      candidates = (data ?? [])
        .map((row) => ({
          ...row,
          meters: metersBetween(latitude!, longitude!, row.latitude, row.longitude),
        }))
        // The bounding box is square; this is where the round radius applies.
        .filter((row) => row.meters <= SAME_ISSUE_METERS)
        // Nearest first, so if the list is truncated it keeps the likeliest.
        .sort((a, b) => a.meters - b.meters || a.created_at.localeCompare(b.created_at))
        .slice(0, MAX_CANDIDATES) as Candidate[]
    } else {
      // No coordinates means no way to establish "same place", and location is a
      // required condition, so the report can only be new.
      console.warn('dedup: request carried no coordinates, skipped')
    }

    const prompt = [
      `Resident comment: "${comment}"`,
      landmark ? `Nearby landmark: ${landmark}` : null,
      area ? `Area: ${area}` : null,
      city ? `City: ${city}` : null,
      '',
      'Classify this civic issue report. Base the classification jointly on the image and the text.',
      '',
      candidates.length
        ? [
            `These open tickets were already reported within ${SAME_ISSUE_METERS} m of this one, each followed by its own photo.`,
            'Decide whether this new report describes the SAME physical problem as one of them: the same object, the same defect, in the same place.',
            'Being close by is not enough on its own. A pothole, a broken footpath and a failed transformer can share one street corner; they are three different problems needing three different crews, and merging them would leave real work undone.',
            `Set duplicate_of_ticket to the number of that ticket, or to "${NO_DUPLICATE}" if this report is a problem none of them covers.`,
          ].join('\n')
        : `No open tickets were found near this location, so set duplicate_of_ticket to "${NO_DUPLICATE}".`,
    ]
      .filter(Boolean)
      .join('\n')

    // The report's own photo at full detail; the candidates at low detail, which
    // is plenty to tell a transformer from a pothole and keeps six extra images
    // affordable.
    function buildContent(withCandidatePhotos: boolean) {
      const content: unknown[] = [
        { type: 'text', text: prompt },
        // OpenAI takes the image as a data URI rather than a separate base64 block.
        { type: 'image_url', image_url: { url: `data:${mediaType};base64,${photoBase64}` } },
      ]
      for (const c of candidates) {
        const reported = c.created_at.slice(0, 10)
        content.push({
          type: 'text',
          text:
            `Ticket ${c.ticket_number} — ${Math.round(c.meters)} m away, reported ${reported}` +
            `${c.departments?.name ? `, handled by ${c.departments.name}` : ''}: "${c.comment}"` +
            `${c.ai_summary ? ` (summary: ${c.ai_summary})` : ''}`,
        })
        if (withCandidatePhotos) {
          content.push({ type: 'image_url', image_url: { url: c.photo_url, detail: 'low' } })
        }
      }
      return content
    }

    async function classify(withCandidatePhotos: boolean) {
      return await openai.chat.completions.create({
        model: MODEL,
        max_tokens: 1024,
        // Classification is a lookup, not a piece of writing — sampling variety
        // is pure downside. At the default temperature one transformer photo
        // came back three different types across six identical requests.
        temperature: 0,
        // Strict JSON Schema is what guarantees a parseable response here. Don't
        // swap this for asking the model to emit JSON in prose.
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'classify_civic_issue',
            strict: true,
            schema: classificationSchema(candidates.map((c) => c.ticket_number)),
          },
        },
        messages: [{ role: 'user', content: buildContent(withCandidatePhotos) as never }],
      })
    }

    let response
    try {
      response = await classify(true)
    } catch (imageError) {
      // A candidate's photo can be unreachable — a storage object removed out
      // from under a live ticket — and OpenAI fails the whole call when it
      // cannot fetch one. A resident's report must not die for that, so retry
      // on the descriptions alone.
      if (!candidates.length) throw imageError
      console.error('classification with candidate photos failed, retrying text-only', imageError)
      response = await classify(false)
    }

    const message = response.choices[0]?.message

    if (message?.refusal) {
      return new Response(
        JSON.stringify({ error: `Model refused to classify: ${message.refusal}` }),
        { status: 502, headers: JSON_HEADERS }
      )
    }

    if (!message?.content) {
      return new Response(
        JSON.stringify({ error: 'Model did not return a classification' }),
        { status: 502, headers: JSON_HEADERS }
      )
    }

    const classification = JSON.parse(message.content) as Classification

    const duplicate =
      classification.duplicate_of_ticket && classification.duplicate_of_ticket !== NO_DUPLICATE
        ? candidates.find((c) => c.ticket_number === classification.duplicate_of_ticket)
        : undefined

    if (duplicate) {
      return new Response(
        JSON.stringify({
          duplicate: true,
          // Kept alongside the richer object so a client deployed before this
          // function still resolves the ticket it needs.
          duplicateOfTicket: duplicate.ticket_number,
          duplicateOf: {
            ticketNumber: duplicate.ticket_number,
            status: duplicate.status,
            reportedAt: duplicate.created_at,
            distanceMeters: Math.round(duplicate.meters),
          },
        }),
        { headers: JSON_HEADERS }
      )
    }

    return new Response(
      JSON.stringify({
        duplicate: false,
        issue_type: classification.issue_type,
        department_slug: classification.department_slug,
        priority: classification.priority,
        confidence: classification.confidence,
        summary: classification.summary,
      }),
      { headers: JSON_HEADERS }
    )
  } catch (error) {
    console.error(error)
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500,
      headers: JSON_HEADERS,
    })
  }
})
