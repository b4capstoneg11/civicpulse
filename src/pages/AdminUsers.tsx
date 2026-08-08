import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { readFunctionError } from '../lib/functionError'
import { useAuth } from '../hooks/useAuth'
import { Alert, Button, EmptyState, Field, Input, Select, Spinner } from '../components/ui'
import { formatDate } from '../lib/format'
import type { Department, Profile, Role } from '../lib/types'

const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  dept_admin: 'Staff Admin',
  field_engineer: 'Field Engineer',
}

const ROLE_STYLES: Record<Role, string> = {
  super_admin: 'bg-violet-wash text-violet ring-violet/25',
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
  const { profile, isSuperAdmin, departmentId } = useAuth()

  const [users, setUsers] = useState<Profile[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  // A super admin creates staff admins; a staff admin creates field engineers.
  const creatableRole: Role = isSuperAdmin ? 'dept_admin' : 'field_engineer'

  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [newRole, setNewRole] = useState<Role>(creatableRole)
  const [newDepartment, setNewDepartment] = useState(departmentId ?? '')
  const [submitting, setSubmitting] = useState(false)

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
    if (!isSuperAdmin && departmentId) setNewDepartment(departmentId)
  }, [creatableRole, isSuperAdmin, departmentId])

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    setSubmitting(true)

    // User creation needs the service-role key, so it runs in an edge function
    // that re-derives the caller's role from their JWT.
    const { data, error: fnError } = await supabase.functions.invoke<{ error?: string }>('manage-users', {
      body: {
        action: 'create',
        email: email.trim(),
        password,
        full_name: fullName.trim(),
        role: newRole,
        department_id: newDepartment || null,
        phone: phone.trim() || null,
      },
    })

    setSubmitting(false)

    const message = await readFunctionError(fnError, data ?? null)
    if (message) {
      setError(message)
      return
    }

    setNotice(`${fullName.trim()} can now sign in with ${email.trim()}.`)
    setFullName('')
    setEmail('')
    setPassword('')
    setPhone('')
    load()
  }

  async function toggleActive(user: Profile) {
    setError(null)
    setNotice(null)

    const { data, error: fnError } = await supabase.functions.invoke<{ error?: string }>('manage-users', {
      body: { action: 'set_active', user_id: user.id, is_active: !user.is_active },
    })

    const message = await readFunctionError(fnError, data ?? null)
    if (message) {
      setError(message)
      return
    }
    setNotice(`${user.full_name} was ${user.is_active ? 'deactivated' : 'reactivated'}.`)
    load()
  }

  const visibleUsers = isSuperAdmin
    ? users
    : users.filter((u) => u.department_id === departmentId && u.role === 'field_engineer')

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold text-ink text-balance">
        {isSuperAdmin ? 'User Management' : 'My Team'}
      </h1>
      <p className="mb-8 text-ink-soft text-pretty">
        {isSuperAdmin
          ? 'Create one staff admin per department. Each staff admin then adds their own field engineers.'
          : 'Add the field engineers who will be assigned tickets in your department.'}
      </p>

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
                <Input
                  {...props}
                  type="email"
                  name="email"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="ravi@department.gov…"
                />
              )}
            </Field>

            <Field label="Temporary Password" required hint="At least 8 characters. Share it securely.">
              {(props) => (
                <Input
                  {...props}
                  type="text"
                  name="newPassword"
                  autoComplete="off"
                  spellCheck={false}
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
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

            {isSuperAdmin ? (
              <>
                <div>
                  <label htmlFor="new-role" className="mb-1.5 block text-sm font-medium text-ink">
                    Role
                  </label>
                  <Select id="new-role" value={newRole} onChange={(e) => setNewRole(e.target.value as Role)}>
                    <option value="dept_admin">Staff Admin</option>
                    <option value="field_engineer">Field Engineer</option>
                  </Select>
                </div>

                <div>
                  <label htmlFor="new-department" className="mb-1.5 block text-sm font-medium text-ink">
                    Department
                  </label>
                  <Select
                    id="new-department"
                    required
                    value={newDepartment}
                    onChange={(e) => setNewDepartment(e.target.value)}
                  >
                    <option value="">Select a department…</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </Select>
                </div>
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

          {error ? <Alert tone="error">{error}</Alert> : null}
          {notice ? <Alert tone="success">{notice}</Alert> : null}

          <Button type="submit" loading={submitting}>
            {submitting ? 'Creating…' : `Create ${ROLE_LABELS[newRole]}`}
          </Button>
        </form>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold text-ink">
          {isSuperAdmin ? 'All Staff' : 'Field Engineers'}
        </h2>

        {loading ? (
          <p className="flex items-center gap-2 text-sm text-subtle" role="status">
            <Spinner />
            Loading…
          </p>
        ) : visibleUsers.length === 0 ? (
          <EmptyState
            title="No staff yet"
            description="Anyone you create above will appear here."
          />
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-panel">
            <table className="w-full text-sm">
              <thead className="border-b border-line bg-raised text-left text-xs uppercase tracking-wide text-subtle">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Name</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Role</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Department</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Added</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2.5 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {visibleUsers.map((user) => (
                  <tr key={user.id} className={user.is_active ? '' : 'bg-raised text-subtle'}>
                    <td className="px-4 py-3">
                      <span className="font-medium text-ink">{user.full_name}</span>
                      {user.phone ? <p className="text-xs text-subtle">{user.phone}</p> : null}
                    </td>
                    <td className="px-4 py-3">
                      <RoleBadge role={user.role} />
                    </td>
                    <td className="px-4 py-3 text-ink-soft">{user.departments?.name ?? '—'}</td>
                    <td className="px-4 py-3 tabular-nums text-subtle">{formatDate(user.created_at)}</td>
                    <td className="px-4 py-3">
                      {user.is_active ? (
                        <span className="text-ok">Active</span>
                      ) : (
                        <span className="text-subtle">Deactivated</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {user.id === profile?.id ? (
                        <span className="text-xs text-subtle">You</span>
                      ) : (
                        <Button variant="secondary" size="sm" onClick={() => toggleActive(user)}>
                          {user.is_active ? 'Deactivate' : 'Reactivate'}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
