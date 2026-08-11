import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { readFunctionError } from '../lib/functionError'
import { suggestEmailDomain } from '../lib/emailSuggest'
import { useAuth } from '../hooks/useAuth'
import { toast } from 'sonner'
import { Alert, Button, EmptyState, Field, Input } from '../components/ui'
import { FieldSelect } from '../components/FieldSelect'
import { ListSkeleton } from '../components/Skeletons'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatDate } from '../lib/format'
import type { Department, Profile, Role } from '../lib/types'

const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  readonly_admin: 'Read-only Admin',
  dept_admin: 'Staff Admin',
  field_engineer: 'Field Engineer',
}

const ROLE_STYLES: Record<Role, string> = {
  super_admin: 'bg-violet-wash text-violet ring-violet/25',
  // Deliberately the muted, unsaturated slot: this role acts on nothing, and
  // the badge should read as quieter than the ones that do.
  readonly_admin: 'bg-raised text-ink-soft ring-line-strong',
  dept_admin: 'bg-info-wash text-info ring-info/25',
  field_engineer: 'bg-brand-wash text-brand ring-brand/40',
}

function RoleBadge({ role }: { role: Role }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${ROLE_STYLES[role]}`}
    >
      {ROLE_LABELS[role]}
    </span>
  )
}

export function AdminUsers() {
  const { profile, hasGlobalScope, departmentId, isReadOnly } = useAuth()

  const [users, setUsers] = useState<Profile[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // A super admin creates staff admins; a staff admin creates field engineers.
  const creatableRole: Role = hasGlobalScope ? 'dept_admin' : 'field_engineer'

  // A read-only admin is global, like a super admin, so it belongs to no
  // department — profiles_department_required enforces that in Postgres.
  const GLOBAL_ROLES: Role[] = ['super_admin', 'readonly_admin']

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  // Held back until the field is left, so a suggestion cannot appear against a
  // half-typed domain — "ravi@gm" is not a mistake yet.
  const [emailBlurred, setEmailBlurred] = useState(false)
  const [phone, setPhone] = useState('')
  const [newRole, setNewRole] = useState<Role>(creatableRole)
  const [newDepartment, setNewDepartment] = useState(departmentId ?? '')
  const [submitting, setSubmitting] = useState(false)
  // Deleting is irreversible, so the row asks first rather than acting on one
  // click next to the button people press routinely.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const emailSuggestion = useMemo(
    () => (emailBlurred ? suggestEmailDomain(email.trim()) : null),
    [email, emailBlurred]
  )

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data: profileRows }, { data: departmentRows }] = await Promise.all([
      supabase
        .from('profiles')
        .select('*, departments(id, slug, name)')
        .order('role')
        .order('full_name'),
      supabase.from('departments').select('*').order('name'),
    ])
    setUsers((profileRows ?? []) as Profile[])
    setDepartments(departmentRows ?? [])
    setLoading(false)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    setNewRole(creatableRole)
    if (!hasGlobalScope && departmentId) setNewDepartment(departmentId)
  }, [creatableRole, hasGlobalScope, departmentId])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    // Departmental roles need a department (profiles_department_required
    // enforces it in Postgres). The picker is no longer a native <select>, so it
    // cannot carry `required` — this keeps the check client-side instead of
    // making the user wait for the edge function to reject it.
    const isGlobalRole = GLOBAL_ROLES.includes(newRole)
    if (!isGlobalRole && !newDepartment) {
      setError('Pick a department for this user.')
      return
    }

    setSubmitting(true)

    // User creation needs the service-role key, so it runs in an edge function
    // that re-derives the caller's role from their JWT.
    const { data, error: fnError } = await supabase.functions.invoke<{ error?: string }>('manage-users', {
      body: {
        action: 'create',
        email: email.trim(),
        full_name: fullName.trim(),
        role: newRole,
        department_id: isGlobalRole ? null : newDepartment || null,
        phone: phone.trim() || null,
      },
    })

    setSubmitting(false)

    const message = await readFunctionError(fnError, data ?? null)
    if (message) {
      setError(message)
      return
    }

    toast.success(`Invite sent to ${email.trim()}. They'll set their own password from the link.`)
    setFullName('')
    setEmail('')
    setEmailBlurred(false)
    setPhone('')
    load()
  }

  async function toggleActive(user: Profile) {
    setError(null)

    const { data, error: fnError } = await supabase.functions.invoke<{ error?: string }>('manage-users', {
      body: { action: 'set_active', user_id: user.id, is_active: !user.is_active },
    })

    const message = await readFunctionError(fnError, data ?? null)
    if (message) {
      setError(message)
      return
    }
    toast.success(`${user.full_name} was ${user.is_active ? 'deactivated' : 'reactivated'}.`)
    load()
  }

  async function deleteUser(user: Profile) {
    setError(null)
    setDeleting(user.id)

    const { data, error: fnError } = await supabase.functions.invoke<{
      error?: string
      released_issues?: number
    }>('manage-users', {
      body: { action: 'delete', user_id: user.id },
    })

    setDeleting(null)
    setConfirmDelete(null)

    const message = await readFunctionError(fnError, data ?? null)
    if (message) {
      setError(message)
      return
    }

    const released = data?.released_issues ?? 0
    toast.success(
      released > 0
        ? `${user.full_name} was deleted. ${released} ticket${released === 1 ? '' : 's'} returned to the queue.`
        : `${user.full_name} was deleted.`
    )
    load()
  }

  /**
   * Mirrors the rules the edge function enforces, so the button is only offered
   * where it will work. The function decides for real — this is about not
   * showing people an action that will fail.
   */
  function canDelete(user: Profile): boolean {
    if (user.id === profile?.id) return false
    if (user.role === 'super_admin') return false
    if (profile?.role === 'super_admin') return true
    return (
      profile?.role === 'dept_admin' &&
      user.role === 'field_engineer' &&
      user.department_id === departmentId
    )
  }

  const visibleUsers = hasGlobalScope
    ? users
    : users.filter((u) => u.department_id === departmentId && u.role === 'field_engineer')

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold text-ink text-balance">
        {hasGlobalScope ? 'User Management' : 'My Team'}
      </h1>
      <p className="mb-8 text-ink-soft text-pretty">
        {hasGlobalScope
          ? 'Create one staff admin per department. Each staff admin then adds their own field engineers.'
          : 'Add the field engineers who will be assigned tickets in your department.'}
      </p>

      {isReadOnly ? (
        <div className="mb-8">
          <Alert tone="info">
            You have read-only access. You can see everything here, but not change it.
          </Alert>
        </div>
      ) : null}

      {isReadOnly ? null : (
      <section className="mb-10 rounded-xl border border-line bg-panel p-5">
        <h2 className="mb-4 text-sm font-semibold text-ink">
          Add {ROLE_LABELS[creatableRole]}
        </h2>

        <form onSubmit={handleCreate} className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Full Name" required>
              {(props) => (
                <Input
                  {...props}
                  name="fullName"
                  autoComplete="name"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Ravi Kumar…"
                />
              )}
            </Field>

            <Field label="Email Address" required>
              {(props) => (
                <>
                  <Input
                    {...props}
                    type="email"
                    name="email"
                    autoComplete="off"
                    spellCheck={false}
                    required
                    value={email}
                    onChange={(e) => {
                      setEmail(e.target.value)
                      setEmailBlurred(false)
                    }}
                    onBlur={() => setEmailBlurred(true)}
                    placeholder="ravi@department.gov…"
                  />
                  {/* A suggestion, never a block — the address stays exactly as
                      typed unless the admin chooses otherwise. */}
                  {emailSuggestion ? (
                    <p className="mt-1.5 text-sm text-ink-soft" role="status">
                      Did you mean{' '}
                      <button
                        type="button"
                        onClick={() => {
                          setEmail(emailSuggestion)
                          setEmailBlurred(false)
                        }}
                        className="rounded font-medium text-brand underline underline-offset-2 hover:text-brand-hi focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                      >
                        {emailSuggestion}
                      </button>
                      ?
                    </p>
                  ) : null}
                </>
              )}
            </Field>

            <Field label="Phone">
              {(props) => (
                <Input
                  {...props}
                  type="tel"
                  name="phone"
                  autoComplete="off"
                  inputMode="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+91 98765 43210"
                />
              )}
            </Field>

            {hasGlobalScope ? (
              <>
                <div>
                  <label htmlFor="new-role" className="mb-1.5 block text-sm font-medium text-ink">
                    Role
                  </label>
                  <FieldSelect
                    id="new-role"
                    value={newRole}
                    onValueChange={(v) => setNewRole(v as Role)}
                    options={[
                      { value: 'dept_admin', label: 'Staff Admin' },
                      { value: 'field_engineer', label: 'Field Engineer' },
                      { value: 'readonly_admin', label: 'Read-only Admin' },
                    ]}
                  />
                </div>

                {GLOBAL_ROLES.includes(newRole) ? (
                  <div className="flex items-end">
                    <p className="text-sm text-subtle text-pretty">
                      Sees every department, so belongs to none. Can view the board, roster, team and
                      analytics, and change nothing.
                    </p>
                  </div>
                ) : (
                  <div>
                    <label htmlFor="new-department" className="mb-1.5 block text-sm font-medium text-ink">
                      Department
                    </label>
                    <FieldSelect
                      id="new-department"
                      value={newDepartment}
                      onValueChange={setNewDepartment}
                      placeholder="Select a department…"
                      options={departments.map((d) => ({ value: d.id, label: d.name }))}
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="sm:col-span-2">
                <p className="text-sm text-subtle">
                  Added to <span className="font-medium text-ink-soft">{profile?.departments?.name}</span> as a
                  field engineer.
                </p>
              </div>
            )}
          </div>

          {/* Successes toast; errors stay inline beside the form that failed. */}
          {error ? <Alert tone="error">{error}</Alert> : null}

          <Button type="submit" loading={submitting}>
            {submitting ? 'Creating…' : `Create ${ROLE_LABELS[newRole]}`}
          </Button>
        </form>
      </section>
      )}

      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink">
          {hasGlobalScope ? 'All Staff' : 'Field Engineers'}
        </h2>

        {loading ? (
          <ListSkeleton label="Loading staff…" rows={4} />
        ) : visibleUsers.length === 0 ? (
          <EmptyState
            title="No staff yet"
            description="Anyone you create above will appear here."
          />
        ) : (
          // shadcn's Table brings its own scroll container; the padding classes
          // keep the row density this page was designed at.
          <div className="rounded-xl border border-line bg-panel">
            <Table>
              <TableHeader className="bg-raised text-xs uppercase tracking-wide text-subtle">
                <TableRow>
                  <TableHead className="px-4 py-2.5">Name</TableHead>
                  <TableHead className="px-4 py-2.5">Role</TableHead>
                  <TableHead className="px-4 py-2.5">Department</TableHead>
                  <TableHead className="px-4 py-2.5">Added</TableHead>
                  <TableHead className="px-4 py-2.5">Status</TableHead>
                  <TableHead className="px-4 py-2.5 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleUsers.map((user) => (
                  <TableRow key={user.id} className={user.is_active ? '' : 'bg-raised text-subtle'}>
                    <TableCell className="px-4 py-3">
                      <span className="font-medium text-ink">{user.full_name}</span>
                      {user.phone ? <p className="text-xs text-subtle">{user.phone}</p> : null}
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      <RoleBadge role={user.role} />
                    </TableCell>
                    <TableCell className="px-4 py-3 text-ink-soft">{user.departments?.name ?? '—'}</TableCell>
                    <TableCell className="px-4 py-3 tabular-nums text-subtle">
                      {formatDate(user.created_at)}
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      {user.is_active ? (
                        <span className="text-ok">Active</span>
                      ) : (
                        <span className="text-subtle">Deactivated</span>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-3 text-right">
                      {user.id === profile?.id ? (
                        <span className="text-xs text-subtle">You</span>
                      ) : isReadOnly ? null : confirmDelete === user.id ? (
                        <div className="flex items-center justify-end gap-2">
                          <span className="text-xs text-danger">Delete permanently?</span>
                          <Button
                            variant="danger"
                            size="sm"
                            loading={deleting === user.id}
                            onClick={() => deleteUser(user)}
                          >
                            Delete
                          </Button>
                          <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(null)}>
                            Cancel
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-2">
                          <Button variant="secondary" size="sm" onClick={() => toggleActive(user)}>
                            {user.is_active ? 'Deactivate' : 'Reactivate'}
                          </Button>
                          {/* Only the two roles that may act on this user get
                              the option at all; the edge function decides for
                              real, this just avoids offering what will fail. */}
                          {canDelete(user) ? (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-danger hover:bg-danger-wash"
                              onClick={() => setConfirmDelete(user.id)}
                            >
                              Delete
                            </Button>
                          ) : null}
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  )
}
