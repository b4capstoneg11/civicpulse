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

const HAMMING_DUPLICATE_THRESHOLD = 10
const DUPLICATE_LOOKBACK_DAYS = 30

interface RequestBody {
  photoBase64: string
  mediaType: string
  comment: string
  landmark?: string
  area?: string
  city?: string
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
  if (hexA.length !== hexB.length) return Number.MAX_SAFE_INTEGER
  let distance = 0
  for (let i = 0; i < hexA.length; i++) {
    const xor = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16)
    distance += xor.toString(2).split('1').length - 1
  }
  return distance
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
    const { photoBase64, mediaType, comment, landmark, area, city, imageSignature } = body

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

    // Dedup: look at open issues in the same area within the lookback window,
    // compare perceptual-hash distance.
    const since = new Date(Date.now() - DUPLICATE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString()
    let dupQuery = supabaseAdmin
      .from('issues')
      .select('ticket_number, image_signature')
      .in('status', ['created', 'assigned', 'in_progress'])
      .eq('issue_type', classification.issue_type)
      .gte('created_at', since)
      .limit(50)

    if (area) dupQuery = dupQuery.eq('area', area)

    const { data: candidates } = await dupQuery

    let duplicateOfTicket: string | undefined
    for (const candidate of candidates ?? []) {
      if (hammingDistance(imageSignature, candidate.image_signature) <= HAMMING_DUPLICATE_THRESHOLD) {
        duplicateOfTicket = candidate.ticket_number
        break
      }
    }

    if (duplicateOfTicket) {
      return new Response(
        JSON.stringify({ duplicate: true, duplicateOfTicket }),
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
