// Supabase Edge Function: analyze-issue
//
// Given a resident's photo + comment + location, this function:
//   1. Calls OpenAI (vision + text) to classify the issue type, route it to a
//      department, and score its priority.
//   2. Checks open issues in the same area for a visual/type match and
//      reports a duplicate instead of letting the caller create a new ticket.
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

// Duplicate detection. GPS is the primary signal, not the photo.
//
// A perceptual hash only recognises the *same image file* resubmitted — it does
// not recognise the same object photographed twice. Measured against this
// database: two reports of one pothole taken 5 m and minutes apart differ by 29
// of 64 hash bits, and two unrelated images average 32. There is no threshold
// that separates those. Coordinates do separate them, so proximity decides, and
// the hash is kept only for the case it is actually good at.
const SAME_ISSUE_METERS = 120
const HAMMING_DUPLICATE_THRESHOLD = 10
const DUPLICATE_LOOKBACK_DAYS = 30
const OPEN_STATUSES = ['created', 'assigned', 'in_progress']

interface RequestBody {
  photoBase64: string
  mediaType: string
  comment: string
  landmark?: string
  area?: string
  city?: string
  latitude?: number
  longitude?: number
  imageSignature: string
}

interface Classification {
  issue_type: (typeof ISSUE_TYPES)[number]
  department_slug: (typeof DEPARTMENT_SLUGS)[number]
  priority: (typeof PRIORITIES)[number]
  confidence: number
  summary: string
}

// Structured Outputs in strict mode require every property to be listed in
// `required` and `additionalProperties: false` — optional fields aren't allowed.
const CLASSIFICATION_SCHEMA = {
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
  },
  required: ['issue_type', 'department_slug', 'priority', 'confidence', 'summary'],
  additionalProperties: false,
} as const

function hammingDistance(hexA: string, hexB: string): number {
  if (!hexA || !hexB || hexA.length !== hexB.length) return Number.MAX_SAFE_INTEGER
  let distance = 0
  for (let i = 0; i < hexA.length; i++) {
    const xor = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16)
    distance += xor.toString(2).split('1').length - 1
  }
  return distance
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

// Why dedup keys on the department and not on `issue_type`:
//
// `issue_type` is not stable. One burnt transformer, the same photo and the
// same comment, classified six times, came back `streetlight` once, `other`
// three times and `damaged_infrastructure` twice — a real object that does not
// fit the six-value enum cleanly. `department_slug` was `electrical` all six
// times. Keying on the type therefore keys on a coin flip: CP-000018 is stored
// as `streetlight`, so a re-report landing on `other` could never match its own
// ticket, and one landing on `damaged_infrastructure` matched the footpath
// ticket 2 m away instead.
//
// The department is both stable and the thing that actually matters — two
// reports the same crew would act on at the same spot are one job. It also
// makes a cross-department merge impossible, so the footpath (public_works),
// the pothole (roads) and the transformer (electrical) sharing one Dhakuria
// junction stay three tickets.

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS })
  }

  try {
    const body: RequestBody = await req.json()
    const { photoBase64, mediaType, comment, landmark, area, city, latitude, longitude, imageSignature } =
      body

    if (!photoBase64 || !comment || !imageSignature) {
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

    const prompt = [
      `Resident comment: "${comment}"`,
      landmark ? `Nearby landmark: ${landmark}` : null,
      area ? `Area: ${area}` : null,
      city ? `City: ${city}` : null,
      '',
      'Classify this civic issue report. Base the classification jointly on the image and the text.',
    ]
      .filter(Boolean)
      .join('\n')

    const response = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 1024,
      // Classification is a lookup, not a piece of writing — sampling variety is
      // pure downside here. At the default temperature one transformer photo
      // came back `streetlight`, `other` and `damaged_infrastructure` across six
      // identical requests, which is also why dedup no longer keys on the type.
      // This does not make the API deterministic, only much steadier.
      temperature: 0,
      // Strict JSON Schema is what guarantees a parseable response here. Don't
      // swap this for asking the model to emit JSON in prose.
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'classify_civic_issue',
          strict: true,
          schema: CLASSIFICATION_SCHEMA,
        },
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            {
              type: 'image_url',
              // OpenAI takes the image as a data URI rather than a separate base64 block.
              image_url: { url: `data:${mediaType};base64,${photoBase64}` },
            },
          ],
        },
      ],
    })

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

    // Dedup runs against open tickets routed to the same department in the last
    // DUPLICATE_LOOKBACK_DAYS. Two independent signals, either of which is
    // enough:
    //   1. one within SAME_ISSUE_METERS, which is the "same issue, same place"
    //      case residents actually hit;
    //   2. a near-identical photo anywhere, which catches a resubmission of one
    //      image (a double-tap, a retry, a forward).
    const since = new Date(Date.now() - DUPLICATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
    const COLUMNS =
      'ticket_number, status, issue_type, image_signature, latitude, longitude, created_at, departments!inner(slug)'

    const hasCoords = typeof latitude === 'number' && typeof longitude === 'number'

    // Square bounding box first so Postgres can range-scan; the round radius is
    // applied to the survivors below. cos() is clamped so a report near the
    // poles cannot widen the box to the whole globe.
    const latDelta = SAME_ISSUE_METERS / 111_320
    const lonDelta =
      SAME_ISSUE_METERS / (111_320 * Math.max(Math.cos((latitude ?? 0) * (Math.PI / 180)), 0.01))

    const nearbyQuery = hasCoords
      ? supabaseAdmin
          .from('issues')
          .select(COLUMNS)
          .in('status', OPEN_STATUSES)
          .gte('created_at', since)
          .eq('departments.slug', classification.department_slug)
          .gte('latitude', latitude! - latDelta)
          .lte('latitude', latitude! + latDelta)
          .gte('longitude', longitude! - lonDelta)
          .lte('longitude', longitude! + lonDelta)
          .order('created_at', { ascending: true })
          .limit(100)
      : null

    const samePhotoQuery = supabaseAdmin
      .from('issues')
      .select(COLUMNS)
      .in('status', OPEN_STATUSES)
      .gte('created_at', since)
      .eq('departments.slug', classification.department_slug)
      .order('created_at', { ascending: true })
      .limit(200)

    const [nearbyResult, samePhotoResult] = await Promise.all([nearbyQuery, samePhotoQuery])

    // Fail open: a dedup lookup that errors must not block a resident's report.
    // Log it rather than swallowing it — this check going quietly dead is
    // exactly the failure that is invisible from the outside.
    if (nearbyResult?.error) console.error('dedup nearby query failed', nearbyResult.error)
    if (samePhotoResult.error) console.error('dedup photo query failed', samePhotoResult.error)
    if (!hasCoords) console.warn('dedup: request carried no coordinates, location check skipped')

    let match:
      | { ticket: string; status: string; reportedAt: string; meters: number | null; on: 'location' | 'photo' }
      | undefined

    // Nearest wins, not oldest. A department can have several tickets open on
    // one street, and the resident is standing at exactly one of them — the
    // ticket 0 m away is the one they are re-reporting. Ties break to the older
    // ticket, which is the original and carries the fuller history.
    const nearby = (nearbyResult?.data ?? [])
      .map((candidate) => ({
        candidate,
        meters: metersBetween(latitude!, longitude!, candidate.latitude, candidate.longitude),
      }))
      // The bounding box is square; this is where the round radius is applied.
      .filter(({ meters }) => meters <= SAME_ISSUE_METERS)
      .sort((a, b) => a.meters - b.meters || a.candidate.created_at.localeCompare(b.candidate.created_at))

    if (nearby.length > 0) {
      const { candidate, meters } = nearby[0]
      match = {
        ticket: candidate.ticket_number,
        status: candidate.status,
        reportedAt: candidate.created_at,
        meters: Math.round(meters),
        on: 'location',
      }
    }

    if (!match) {
      for (const candidate of samePhotoResult.data ?? []) {
        if (hammingDistance(imageSignature, candidate.image_signature) > HAMMING_DUPLICATE_THRESHOLD) {
          continue
        }
        // No distance: this match did not use one, and the two reports can be
        // kilometres apart, which would read as nonsense next to "same location".
        match = {
          ticket: candidate.ticket_number,
          status: candidate.status,
          reportedAt: candidate.created_at,
          meters: null,
          on: 'photo',
        }
        break
      }
    }

    if (match) {
      return new Response(
        JSON.stringify({
          duplicate: true,
          // Kept alongside the richer object so a client deployed before this
          // function still resolves the ticket it needs.
          duplicateOfTicket: match.ticket,
          duplicateOf: {
            ticketNumber: match.ticket,
            status: match.status,
            reportedAt: match.reportedAt,
            distanceMeters: match.meters,
            matchedOn: match.on,
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
