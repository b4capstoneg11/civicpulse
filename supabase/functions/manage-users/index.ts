// Supabase Edge Function: manage-users
//
// Creating an auth user requires the service-role key, which must never reach the
// browser -- so provisioning runs here instead of in the client.
//
// Authorisation is re-derived from the caller's JWT on every request. The client
// saying "I'm a super admin" counts for nothing; the profiles row decides.
//
//   super_admin  -> may create dept_admin (any department) and field_engineer
//   dept_admin   -> may create field_engineer in their own department only
//
// Secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (both injected by Supabase)

import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

const JSON_HEADERS = { ...CORS_HEADERS, 'Content-Type': 'application/json' }

type Role = 'super_admin' | 'readonly_admin' | 'dept_admin' | 'field_engineer'

// Global roles hold no department; the profiles_department_required check
// constraint enforces the same thing at the table.
const GLOBAL_ROLES: Role[] = ['super_admin', 'readonly_admin']

interface CreateUserBody {
  action: 'create'
  email: string
  full_name: string
  role: Role
  department_id?: string | null
  phone?: string | null
}

interface SetActiveBody {
  action: 'set_active'
  user_id: string
  is_active: boolean
}

type RequestBody = CreateUserBody | SetActiveBody

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

/**
 * A deliberately loose check that an address could plausibly exist.
 *
 * Checked here rather than relying on the form's type="email": this function is
 * callable directly, so the browser is not the boundary.
 *
 * Loose on purpose. Strict RFC 5322 patterns reject more real addresses than
 * fake ones — plus-addressing, apostrophes and long TLDs all trip them — and a
 * false rejection blocks a legitimate colleague while a false acceptance is
 * caught downstream: the invite has to be received and acted on before the
 * account works at all, so a wrong-but-well-formed address fails visibly rather
 * than producing an account nobody can reach.
 *
 * What it does catch is input that cannot work at all — no @, whitespace, no
 * dotted domain, or lengths beyond what SMTP accepts.
 */
function isPlausibleEmail(value: string): boolean {
  if (value.length > 254 || /\s/.test(value)) return false

  const at = value.lastIndexOf('@')
  if (at < 1 || at === value.length - 1) return false

  const local = value.slice(0, at)
  const domain = value.slice(at + 1)

  if (local.length > 64) return false
  // Split on the last @, so a second one would otherwise hide in the local part
  // and "ravi@@gmail.com" would pass. RFC 5322 does allow @ inside a quoted
  // local part; nobody typing a colleague's address here means that.
  if (local.includes('@')) return false
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return false
  if (domain.startsWith('-') || domain.endsWith('-')) return false
  if (!/^[A-Za-z0-9.-]+$/.test(domain)) return false

  // A dotted TLD of at least two letters. "ravi@localhost" is legal on an
  // intranet and never what anyone means when adding a colleague here.
  return /\.[A-Za-z]{2,}$/.test(domain)
}

/**
 * Describes who already holds an email address, e.g.
 * "Neelay (Field Engineer, Public Works & Infrastructure)".
 * Best-effort: returns null rather than throwing, since this only enriches an
 * error message that is already being returned.
 */
async function describeExistingAccount(
  // deno-lint-ignore no-explicit-any
  admin: any,
  email: string
): Promise<string | null> {
  try {
    const { data } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 })
    const user = data?.users?.find(
      (u: { email?: string }) => u.email?.toLowerCase() === email.toLowerCase()
    )
    if (!user) return null

    const { data: profile } = await admin
      .from('profiles')
      .select('full_name, role, is_active, departments(name)')
      .eq('id', user.id)
      .maybeSingle()

    if (!profile) return 'an account with no staff profile'

    const roleLabels: Record<string, string> = {
      super_admin: 'Super Admin',
      readonly_admin: 'Read-only Admin',
      dept_admin: 'Staff Admin',
      field_engineer: 'Field Engineer',
    }
    const parts = [roleLabels[profile.role] ?? profile.role]
    if (profile.departments?.name) parts.push(profile.departments.name)
    if (!profile.is_active) parts.push('deactivated')

    return `${profile.full_name} (${parts.join(', ')})`
  } catch {
    return null
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS_HEADERS })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

    const authHeader = req.headers.get('Authorization')
    if (!authHeader) return json({ error: 'Missing Authorization header' }, 401)

    // Resolve the caller from their JWT, then read their role from the database.
    const admin = createClient(supabaseUrl, serviceKey)
    const token = authHeader.replace('Bearer ', '')
    const { data: userData, error: userError } = await admin.auth.getUser(token)
    if (userError || !userData.user) return json({ error: 'Invalid or expired session' }, 401)

    const { data: caller } = await admin
      .from('profiles')
      .select('id, role, department_id, is_active')
      .eq('id', userData.user.id)
      .single()

    if (!caller) return json({ error: 'No staff profile for this account' }, 403)
    if (!caller.is_active) return json({ error: 'This account has been deactivated' }, 403)

    const body: RequestBody = await req.json()

    // ---------------------------------------------------------------- set_active
    if (body.action === 'set_active') {
      const { data: target } = await admin
        .from('profiles')
        .select('id, role, department_id')
        .eq('id', body.user_id)
        .single()

      if (!target) return json({ error: 'User not found' }, 404)

      const mayManage =
        caller.role === 'super_admin' ||
        (caller.role === 'dept_admin' &&
          target.role === 'field_engineer' &&
          target.department_id === caller.department_id)

      if (!mayManage) return json({ error: 'Not permitted to manage this user' }, 403)
      if (target.id === caller.id) return json({ error: 'You cannot deactivate yourself' }, 400)

      const { error } = await admin
        .from('profiles')
        .update({ is_active: body.is_active })
        .eq('id', body.user_id)

      if (error) return json({ error: error.message }, 400)
      return json({ ok: true })
    }

    // -------------------------------------------------------------------- create
    if (body.action !== 'create') return json({ error: 'Unknown action' }, 400)

    const { full_name, role, department_id, phone } = body

    // No password: the invited person sets their own. Any password still sent
    // by an older client is ignored rather than rejected, so a stale tab cannot
    // fail a creation for a field that no longer means anything.
    if (!body.email || !full_name || !role) {
      return json({ error: 'email, full_name and role are all required' }, 400)
    }

    // Normalised here rather than trusted from the client. Supabase lower-cases
    // addresses for auth anyway, and the duplicate check below compares
    // case-insensitively -- storing the raw input just leaves the two out of step.
    const email = String(body.email).trim().toLowerCase()

    if (!isPlausibleEmail(email)) {
      return json({ error: `"${body.email}" is not a valid email address.` }, 400)
    }

    // Who may create whom. A readonly_admin falls to the final branch: it can
    // read every page but create nobody, which is the point of the role.
    if (caller.role === 'super_admin') {
      if (role === 'super_admin') {
        return json({ error: 'Additional super admins must be provisioned directly in the database' }, 403)
      }
    } else if (caller.role === 'dept_admin') {
      if (role !== 'field_engineer') {
        return json({ error: 'Department admins may only create field engineers' }, 403)
      }
      if (department_id !== caller.department_id) {
        return json({ error: 'Department admins may only create users in their own department' }, 403)
      }
    } else {
      return json({ error: 'Not permitted to create users' }, 403)
    }

    const isGlobalRole = GLOBAL_ROLES.includes(role)

    if (isGlobalRole && department_id) {
      return json({ error: 'A read-only admin sees every department, so it cannot belong to one' }, 400)
    }
    if (!isGlobalRole && !department_id) {
      return json({ error: 'A department is required for this role' }, 400)
    }

    // One *active* staff admin per department -- checked here so the caller gets
    // a clear message rather than a raw unique-index violation. A deactivated
    // admin does not hold the slot; that is how a department gets a replacement.
    if (role === 'dept_admin') {
      const { data: existing } = await admin
        .from('profiles')
        .select('id, full_name')
        .eq('department_id', department_id)
        .eq('role', 'dept_admin')
        .eq('is_active', true)
        .maybeSingle()

      if (existing) {
        return json(
          {
            error: `That department already has an active staff admin (${existing.full_name}). Deactivate them first, then create the replacement.`,
          },
          409
        )
      }
    }

    // Invited rather than created with a password.
    //
    // The admin never chooses or learns the password: the account has none
    // until the person follows the link and sets one. That also makes a
    // mistyped address fail loudly — nobody can activate it — where before it
    // produced a working account that its supposed owner could never reach,
    // with the address recorded as confirmed because email_confirm said so
    // while nothing had confirmed anything.
    //
    // redirectTo matters: without it the link is built from site_url and lands
    // on the resident report form. Links the app generates say where to go.
    const siteUrl = (Deno.env.get('PUBLIC_SITE_URL') ?? 'https://civicpulse-tan.vercel.app')
      .replace(/\/+$/, '')

    const { data: created, error: createError } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: `${siteUrl}/set-password`,
    })

    if (createError || !created.user) {
      // "already registered" is the most common failure and the least helpful
      // message on its own — say which account holds the address.
      // inviteUserByEmail words this differently from createUser, so match
      // loosely rather than on one provider phrasing.
      if (/already|exists|registered/i.test(createError?.message ?? '')) {
        const owner = await describeExistingAccount(admin, email)
        return json(
          {
            error: owner
              ? `${email} is already in use by ${owner}. Use a different email address, or change that account instead of creating a new one.`
              : `${email} is already registered. Use a different email address.`,
          },
          409
        )
      }
      return json({ error: createError?.message ?? 'Could not create the account' }, 400)
    }

    const { error: profileError } = await admin.from('profiles').insert({
      id: created.user.id,
      full_name,
      role,
      department_id: isGlobalRole ? null : department_id,
      phone: phone ?? null,
      created_by: caller.id,
    })

    // Don't leave an auth user stranded without a profile -- it could log in but
    // would have no role, and the email would be taken for any retry.
    if (profileError) {
      await admin.auth.admin.deleteUser(created.user.id)
      return json({ error: profileError.message }, 400)
    }

    return json({ ok: true, user_id: created.user.id })
  } catch (error) {
    console.error(error)
    return json({ error: (error as Error).message }, 500)
  }
})
