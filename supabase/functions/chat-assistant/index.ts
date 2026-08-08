// Supabase Edge Function: chat-assistant
//
// A retrieval-grounded assistant over ticket data. The model never sees the
// database and never chooses what it is allowed to read: it composes tool calls,
// this function executes them, and **the role scope is applied server-side after
// the caller's role is re-derived from their JWT**. A model instructed to "show
// all departments" still gets only the caller's department.
//
// Grounding is structured retrieval rather than embeddings. Ticket data is
// tabular — counts, statuses, dates, assignees — so a parameterised query
// answers "how many are open in Roads" exactly, where vector similarity would
// only approximate it.
//
// Secrets: OPENAI_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY

import OpenAI from 'npm:openai@4.77.0'
import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}
const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' }

const MODEL = 'gpt-4o'
const MAX_TOOL_ROUNDS = 4
const MAX_ROWS = 60

// Columns sent to the model. reporter_contact and the exact coordinates are
// deliberately excluded — resident PII has no business in a model context, and
// nothing the assistant answers needs it.
const TICKET_COLUMNS =
  'ticket_number, status, priority, issue_type, comment, ai_summary, area, city, landmark, created_at, resolved_at, closed_at, rating, reopen_count, departments(name), assignee:profiles!issues_assigned_to_fkey(full_name)'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })

/**
 * Accepts a date filter only if it is a real past date. A model asked "how many
 * are open right now" will otherwise reach for `created_after: <today>`, which
 * silently excludes every older ticket and makes a populated database look empty.
 */
function safeDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const t = Date.parse(value)
  if (Number.isNaN(t)) return null
  if (t > Date.now()) return null // a future lower bound can only match nothing
  return new Date(t).toISOString()
}

interface Caller {
  id: string
  role: 'super_admin' | 'dept_admin' | 'field_engineer'
  department_id: string | null
  full_name: string
  departmentName: string | null
}

/**
 * The single choke point for authorisation. Every retrieval passes through here,
 * so no tool can widen its own scope.
 */
// deno-lint-ignore no-explicit-any
function scoped(query: any, caller: Caller) {
  if (caller.role === 'super_admin') return query
  if (caller.role === 'dept_admin') return query.eq('department_id', caller.department_id)
  return query.eq('assigned_to', caller.id) // field_engineer
}

const OPEN_STATUSES = ['created', 'assigned', 'in_progress', 'reopened']

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_tickets',
      description:
        'Find tickets matching filters. Use for "show me…", "which tickets…", "list…". Returns individual tickets.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'array',
            items: { type: 'string', enum: ['created', 'assigned', 'in_progress', 'resolved', 'closed', 'reopened'] },
            description: 'Filter by lifecycle status. Omit for any.',
          },
          only_open: { type: 'boolean', description: 'Shorthand for created/assigned/in_progress/reopened.' },
          priority: { type: 'array', items: { type: 'string', enum: ['low', 'medium', 'high'] } },
          issue_type: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['pothole', 'streetlight', 'garbage', 'water_leakage', 'damaged_infrastructure', 'other'],
            },
          },
          department_name: { type: 'string', description: 'Partial department name, e.g. "roads".' },
          area: { type: 'string', description: 'Partial area or locality name.' },
          created_after: { type: 'string', description: 'ISO date, inclusive.' },
          created_before: { type: 'string', description: 'ISO date, inclusive.' },
          unassigned_only: { type: 'boolean' },
          limit: { type: 'number', description: 'Default 20, max 60.' },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'ticket_counts',
      description:
        'Aggregated counts grouped by a dimension. Use for "how many…", "breakdown of…", trends and comparisons — it is exact, unlike listing and counting. ' +
        'EVERY group in the result already contains total, open, resolved and closed counts, so to answer "how many are OPEN" just call this with the grouping you want and read the "open" field. ' +
        'Do NOT use the date filters to express open-ness or recency — they filter on when a ticket was CREATED, and passing a recent date will wrongly exclude older tickets that are still open. Omit both dates unless the user explicitly asked about a time window.',
      parameters: {
        type: 'object',
        properties: {
          group_by: {
            type: 'string',
            enum: ['status', 'department', 'priority', 'issue_type', 'month', 'assignee'],
          },
          created_after: {
            type: 'string',
            description: 'ISO date. Only when the user asked for a time window. Never use this to mean "currently open".',
          },
          created_before: { type: 'string', description: 'ISO date. Only for an explicit time window.' },
        },
        required: ['group_by'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_ticket',
      description: 'Full detail and audit history for one ticket, by its number (e.g. CP-000002).',
      parameters: {
        type: 'object',
        properties: { ticket_number: { type: 'string' } },
        required: ['ticket_number'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'team_workload',
      description:
        'Field engineers in scope with their open ticket counts and rostered days. Use for "who is busiest", "who is on shift", capacity questions. Not available to field engineers.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
]

// deno-lint-ignore no-explicit-any
async function runTool(name: string, args: any, admin: any, caller: Caller): Promise<unknown> {
  if (name === 'search_tickets') {
    let q = scoped(admin.from('issues').select(TICKET_COLUMNS), caller)

    const statuses: string[] | undefined = args.only_open ? OPEN_STATUSES : args.status
    if (statuses?.length) q = q.in('status', statuses)
    if (args.priority?.length) q = q.in('priority', args.priority)
    if (args.issue_type?.length) q = q.in('issue_type', args.issue_type)
    if (args.area) q = q.ilike('area', `%${args.area}%`)
    const sAfter = safeDate(args.created_after)
    const sBefore = safeDate(args.created_before)
    if (sAfter) q = q.gte('created_at', sAfter)
    if (sBefore) q = q.lte('created_at', sBefore)
    if (args.unassigned_only) q = q.is('assigned_to', null)

    if (args.department_name) {
      const { data: depts } = await admin
        .from('departments')
        .select('id')
        .ilike('name', `%${args.department_name}%`)
      const ids = (depts ?? []).map((d: { id: string }) => d.id)
      // An unmatched department name must narrow to nothing, never widen.
      q = q.in('department_id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
    }

    const limit = Math.min(Math.max(1, Number(args.limit) || 20), MAX_ROWS)
    const { data, error } = await q.order('created_at', { ascending: false }).limit(limit)
    if (error) return { error: error.message }
    return { count: data?.length ?? 0, tickets: data ?? [] }
  }

  if (name === 'ticket_counts') {
    let q = scoped(
      admin.from('issues').select('status, priority, issue_type, created_at, department_id, assigned_to, departments(name), assignee:profiles!issues_assigned_to_fkey(full_name)'),
      caller
    )
    const after = safeDate(args.created_after)
    const before = safeDate(args.created_before)
    if (after) q = q.gte('created_at', after)
    if (before) q = q.lte('created_at', before)

    const { data, error } = await q.limit(5000)
    if (error) return { error: error.message }

    // Tell the model *why* it got nothing, so it retries without the window
    // instead of reporting that no such data exists.
    if ((data?.length ?? 0) === 0 && (after || before)) {
      const { count } = await scoped(
        admin.from('issues').select('id', { count: 'exact', head: true }),
        caller
      )
      return {
        group_by: args.group_by,
        total_tickets: 0,
        groups: {},
        note:
          (count ?? 0) > 0
            ? `No tickets fall in that date window, but ${count} ticket(s) exist in scope. Call this tool again without created_after/created_before.`
            : 'There are no tickets in scope at all.',
      }
    }

    const keyOf = (r: Record<string, unknown>): string => {
      switch (args.group_by) {
        case 'status': return String(r.status)
        case 'priority': return String(r.priority)
        case 'issue_type': return String(r.issue_type)
        case 'department': return (r.departments as { name?: string } | null)?.name ?? 'Unknown'
        case 'assignee': return (r.assignee as { full_name?: string } | null)?.full_name ?? 'Unassigned'
        case 'month': return String(r.created_at).slice(0, 7)
        default: return 'all'
      }
    }

    const buckets: Record<string, { total: number; open: number; resolved: number; closed: number }> = {}
    for (const row of data ?? []) {
      const k = keyOf(row)
      buckets[k] ??= { total: 0, open: 0, resolved: 0, closed: 0 }
      buckets[k].total += 1
      if (OPEN_STATUSES.includes(String(row.status))) buckets[k].open += 1
      else if (row.status === 'resolved') buckets[k].resolved += 1
      else buckets[k].closed += 1
    }
    return { group_by: args.group_by, total_tickets: data?.length ?? 0, groups: buckets }
  }

  if (name === 'get_ticket') {
    const { data: ticket } = await scoped(
      admin.from('issues').select(`id, ${TICKET_COLUMNS}`).eq('ticket_number', String(args.ticket_number).toUpperCase()),
      caller
    ).maybeSingle()

    if (!ticket) {
      return { found: false, note: 'No such ticket, or it is outside what you are permitted to see.' }
    }
    const { data: history } = await admin
      .from('issue_status_history')
      .select('status, note, actor, created_at')
      .eq('issue_id', ticket.id)
      .order('created_at', { ascending: true })

    delete (ticket as Record<string, unknown>).id
    return { found: true, ticket, history: history ?? [] }
  }

  if (name === 'team_workload') {
    if (caller.role === 'field_engineer') {
      return { error: 'Field engineers cannot see team workload.' }
    }
    let pq = admin.from('profiles').select('id, full_name, department_id, is_active, departments(name)').eq('role', 'field_engineer').eq('is_active', true)
    if (caller.role === 'dept_admin') pq = pq.eq('department_id', caller.department_id)

    const { data: people } = await pq
    if (!people?.length) return { engineers: [] }

    const ids = people.map((p: { id: string }) => p.id)
    const [{ data: openRows }, { data: shifts }] = await Promise.all([
      admin.from('issues').select('assigned_to').in('assigned_to', ids).in('status', OPEN_STATUSES),
      admin.from('roster_shifts').select('engineer_id, weekday, start_time, end_time').in('engineer_id', ids),
    ])

    const load: Record<string, number> = {}
    for (const r of openRows ?? []) load[r.assigned_to] = (load[r.assigned_to] ?? 0) + 1

    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
    return {
      engineers: people.map((p: { id: string; full_name: string; departments?: { name?: string } }) => ({
        name: p.full_name,
        department: p.departments?.name ?? null,
        open_tickets: load[p.id] ?? 0,
        rostered_days: (shifts ?? [])
          .filter((s: { engineer_id: string }) => s.engineer_id === p.id)
          .map((s: { weekday: number; start_time: string; end_time: string }) =>
            `${days[s.weekday]} ${s.start_time.slice(0, 5)}-${s.end_time.slice(0, 5)}`
          ),
      })),
    }
  }

  return { error: `Unknown tool ${name}` }
}

function systemPrompt(caller: Caller): string {
  const scope =
    caller.role === 'super_admin'
      ? 'You can see tickets across every department.'
      : caller.role === 'dept_admin'
        ? `You can see only tickets belonging to ${caller.departmentName ?? 'their department'}. You cannot see other departments at all.`
        : 'You can see only the tickets assigned to this engineer. You cannot see anyone else’s tickets.'

  return [
    'You are the CivicPulse assistant, helping council staff understand their civic-issue ticket data.',
    `The user is ${caller.full_name}, whose role is ${caller.role.replace('_', ' ')}. ${scope}`,
    '',
    'Rules you must follow:',
    '1. Answer ONLY from data returned by the tools. Never invent a ticket number, count, name or date.',
    '2. If the tools return nothing relevant, say plainly that you have no data for it. Do not guess.',
    '3. Prefer ticket_counts for "how many" questions; it is exact. Do not list tickets and count them yourself.',
    '4. Cite ticket numbers (CP-000123) when referring to specific tickets so the user can open them.',
    '5. The data you receive is already limited to what this user may see. Never claim data is missing because of permissions unless a tool says so.',
    '6. Be concise. Lead with the answer. Use short markdown lists or a compact table when comparing.',
    '7. You are read-only. If asked to change, assign or close anything, explain where in the app to do it.',
    '',
    `Today is ${new Date().toISOString().slice(0, 10)}. Statuses: created, assigned, in_progress count as OPEN; reopened is also open; then resolved, then closed.`,
  ].join('\n')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS })

  try {
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Sign in to use the assistant.' }, 401)

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: userData, error: userError } = await admin.auth.getUser(authHeader.replace('Bearer ', ''))
    if (userError || !userData.user) return json({ error: 'Your session has expired. Sign in again.' }, 401)

    const { data: profile } = await admin
      .from('profiles')
      .select('id, role, department_id, full_name, is_active, departments(name)')
      .eq('id', userData.user.id)
      .single()

    if (!profile) return json({ error: 'No staff profile for this account.' }, 403)
    if (!profile.is_active) return json({ error: 'This account has been deactivated.' }, 403)

    const caller: Caller = {
      id: profile.id,
      role: profile.role,
      department_id: profile.department_id,
      full_name: profile.full_name,
      departmentName: profile.departments?.name ?? null,
    }

    const body = await req.json()
    const incoming: { role: string; content: string }[] = Array.isArray(body.messages) ? body.messages : []
    if (incoming.length === 0) return json({ error: 'No message provided.' }, 400)

    // Keep the last few turns only: enough for follow-ups, bounded for cost.
    const history = incoming
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-8)
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content).slice(0, 4000) }))

    const openai = new OpenAI({ apiKey: Deno.env.get('OPENAI_API_KEY') })
    // deno-lint-ignore no-explicit-any
    const messages: any[] = [{ role: 'system', content: systemPrompt(caller) }, ...history]
    const toolsUsed: string[] = []

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const completion = await openai.chat.completions.create({
        model: MODEL,
        messages,
        tools: TOOLS,
        temperature: 0.2,
        max_tokens: 900,
      })

      const choice = completion.choices[0]
      const message = choice?.message
      if (!message) return json({ error: 'The assistant did not respond. Try again.' }, 502)

      if (message.tool_calls?.length) {
        messages.push(message)
        for (const call of message.tool_calls) {
          let args: Record<string, unknown> = {}
          try {
            args = JSON.parse(call.function.arguments || '{}')
          } catch {
            args = {}
          }
          toolsUsed.push(call.function.name)
          const result = await runTool(call.function.name, args, admin, caller)
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(result).slice(0, 24000),
          })
        }
        continue
      }

      return json({
        reply: message.content ?? 'I could not find an answer to that.',
        toolsUsed: [...new Set(toolsUsed)],
      })
    }

    return json(
      {
        reply:
          'That question needed more lookups than I can do in one go. Try narrowing it — a single department, a shorter period, or one ticket.',
        toolsUsed: [...new Set(toolsUsed)],
      },
      200
    )
  } catch (error) {
    console.error(error)
    return json({ error: (error as Error).message }, 500)
  }
})
