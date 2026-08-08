import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { Alert, Button, EmptyState } from '../components/ui'
import { FieldSelect } from '../components/FieldSelect'
import { ListSkeleton } from '../components/Skeletons'
// Provided here rather than at the app root: this is the only page using
// tooltips, and it is lazy-loaded, so residents never download Radix's tooltip.
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { WEEKDAYS, istNow, isOnShiftNow } from '../lib/roster'
import type { Department, EngineerWorkload, Profile, RosterShift } from '../lib/types'

const DEFAULT_START = '08:00'
const DEFAULT_END = '18:00'

const OPEN_STATUSES = ['created', 'assigned', 'in_progress']

export function AdminRoster() {
  const { isSuperAdmin, departmentId } = useAuth()

  const [departments, setDepartments] = useState<Department[]>([])
  // A super admin has no department of their own, so they pick one to edit.
  const [selectedDepartment, setSelectedDepartment] = useState(departmentId ?? '')
  const [engineers, setEngineers] = useState<EngineerWorkload[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingCell, setSavingCell] = useState<string | null>(null)

  // Explicit "add shift" form, for setting hours other than the 08:00-18:00 default.
  const [formEngineer, setFormEngineer] = useState('')
  const [formDays, setFormDays] = useState<number[]>([])
  const [formStart, setFormStart] = useState(DEFAULT_START)
  const [formEnd, setFormEnd] = useState(DEFAULT_END)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    if (!isSuperAdmin) return
    supabase
      .from('departments')
      .select('*')
      .order('name')
      .then(({ data }) => setDepartments(data ?? []))
  }, [isSuperAdmin])

  const load = useCallback(async () => {
    if (!selectedDepartment) {
      setEngineers([])
      setLoading(false)
      return
    }

    setLoading(true)

    const { data: profileRows } = await supabase
      .from('profiles')
      .select('*')
      .eq('department_id', selectedDepartment)
      .eq('role', 'field_engineer')
      .order('full_name')

    const people = (profileRows ?? []) as Profile[]
    if (people.length === 0) {
      setEngineers([])
      setLoading(false)
      return
    }

    const ids = people.map((p) => p.id)

    // Shifts and open-ticket counts are independent — fetch them together.
    const [{ data: shiftRows }, { data: openIssues }] = await Promise.all([
      supabase.from('roster_shifts').select('*').in('engineer_id', ids),
      supabase.from('issues').select('assigned_to').in('assigned_to', ids).in('status', OPEN_STATUSES),
    ])

    const loadByEngineer = new Map<string, number>()
    for (const row of openIssues ?? []) {
      const key = (row as { assigned_to: string }).assigned_to
      loadByEngineer.set(key, (loadByEngineer.get(key) ?? 0) + 1)
    }

    setEngineers(
      people.map((p) => ({
        profile: p,
        shifts: ((shiftRows ?? []) as RosterShift[]).filter((s) => s.engineer_id === p.id),
        openCount: loadByEngineer.get(p.id) ?? 0,
      }))
    )
    setLoading(false)
  }, [selectedDepartment])

  useEffect(() => {
    load()
  }, [load])

  async function toggleShift(engineer: EngineerWorkload, weekday: number) {
    const cellKey = `${engineer.profile.id}-${weekday}`
    const existing = engineer.shifts.find((s) => s.weekday === weekday)

    setSavingCell(cellKey)
    setError(null)

    // Flip the cell immediately. The round trip to Supabase takes a couple of
    // seconds, and without this the cell looks unresponsive and invites a second
    // click that would undo the first.
    setEngineers((prev) =>
      prev.map((e) => {
        if (e.profile.id !== engineer.profile.id) return e
        return {
          ...e,
          shifts: existing
            ? e.shifts.filter((s) => s.id !== existing.id)
            : [
                ...e.shifts,
                {
                  id: `pending-${cellKey}`,
                  engineer_id: e.profile.id,
                  weekday,
                  start_time: DEFAULT_START,
                  end_time: DEFAULT_END,
                  created_at: new Date().toISOString(),
                },
              ],
        }
      })
    )

    const { error: writeError } = existing
      ? await supabase.from('roster_shifts').delete().eq('id', existing.id)
      : await supabase.from('roster_shifts').insert({
          engineer_id: engineer.profile.id,
          weekday,
          start_time: DEFAULT_START,
          end_time: DEFAULT_END,
        })

    setSavingCell(null)

    if (writeError) {
      setError(writeError.message)
    }
    // Reload either way: on success to pick up the real row id, on failure to
    // discard the optimistic change.
    load()
  }

  async function addShift(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!formEngineer) {
      setError('Choose an engineer.')
      return
    }
    if (formStart >= formEnd) {
      setError('A shift must end after it starts.')
      return
    }

    const target = engineers.find((x) => x.profile.id === formEngineer)
    const clash = target?.shifts.find((s) => formDays.includes(s.weekday))
    if (clash) {
      setError(
        `${target?.profile.full_name} already has a ${WEEKDAYS[clash.weekday]} shift. Remove it first, or adjust its hours below.`
      )
      return
    }
    if (formDays.length === 0) {
      setError('Pick at least one day.')
      return
    }

    setAdding(true)
    const { error: writeError } = await supabase.from('roster_shifts').insert(
      formDays.map((weekday) => ({
        engineer_id: formEngineer,
        weekday,
        start_time: formStart,
        end_time: formEnd,
      }))
    )
    setAdding(false)

    if (writeError) {
      setError(writeError.message)
      return
    }
    setFormDays([])
    load()
  }

  async function updateTimes(shift: RosterShift, startTime: string, endTime: string) {
    if (startTime >= endTime) {
      setError('A shift must end after it starts.')
      return
    }
    setError(null)

    const { error: writeError } = await supabase
      .from('roster_shifts')
      .update({ start_time: startTime, end_time: endTime })
      .eq('id', shift.id)

    if (writeError) {
      setError(writeError.message)
      return
    }
    load()
  }

  const { weekday: todayIst } = istNow()

  return (
    <TooltipProvider delayDuration={300}>
    <div className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold text-ink text-balance">Work Roster</h1>
      <p className="mb-8 text-ink-soft text-pretty">
        Shifts repeat weekly and are in IST. When a report arrives, it goes to whoever is on shift at that
        moment with the fewest open tickets. Reports arriving outside these hours are queued and assigned
        when the next shift opens.
      </p>

      {isSuperAdmin ? (
        <div className="mb-6 max-w-xs">
          <label htmlFor="roster-department" className="mb-1.5 block text-sm font-medium text-ink">
            Department
          </label>
          <FieldSelect
            id="roster-department"
            value={selectedDepartment}
            onValueChange={setSelectedDepartment}
            placeholder="Select a department…"
            options={departments.map((d) => ({ value: d.id, label: d.name }))}
          />
        </div>
      ) : null}

      {error ? (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      {loading ? (
        <ListSkeleton label="Loading roster…" rows={3} />
      ) : !selectedDepartment ? (
        <EmptyState title="Pick a department" description="Choose a department to edit its roster." />
      ) : engineers.length === 0 ? (
        <EmptyState
          title="No field engineers in this department"
          description="Add engineers under My Team before building a roster."
        />
      ) : (
        <>
          <section className="mb-8 rounded-xl border border-line bg-panel p-5">
            <h2 className="mb-1 text-sm font-semibold text-ink">Add a Shift</h2>
            <p className="mb-4 text-sm text-subtle text-pretty">
              Pick an engineer and the days they work. Use the grid below for quick {DEFAULT_START}–
              {DEFAULT_END} toggles.
            </p>

            <form onSubmit={addShift} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-3">
                <div>
                  <label htmlFor="shift-engineer" className="mb-1.5 block text-sm font-medium text-ink">
                    Engineer
                  </label>
                  <FieldSelect
                    id="shift-engineer"
                    value={formEngineer}
                    onValueChange={setFormEngineer}
                    placeholder="Select an engineer…"
                    options={engineers
                      .filter((e) => e.profile.is_active)
                      .map((e) => ({ value: e.profile.id, label: e.profile.full_name }))}
                  />
                </div>

                <div>
                  <label htmlFor="shift-start" className="mb-1.5 block text-sm font-medium text-ink">
                    Starts
                  </label>
                  <input
                    id="shift-start"
                    type="time"
                    value={formStart}
                    onChange={(e) => setFormStart(e.target.value)}
                    className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink [color-scheme:light] transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                  />
                </div>

                <div>
                  <label htmlFor="shift-end" className="mb-1.5 block text-sm font-medium text-ink">
                    Ends
                  </label>
                  <input
                    id="shift-end"
                    type="time"
                    value={formEnd}
                    onChange={(e) => setFormEnd(e.target.value)}
                    className="w-full rounded-lg border border-line bg-panel px-3 py-2 text-sm text-ink [color-scheme:light] transition-colors hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2"
                  />
                </div>
              </div>

              <fieldset>
                <legend className="mb-2 text-sm font-medium text-ink">Days</legend>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map((day, weekday) => (
                    <label
                      key={day}
                      className={`cursor-pointer rounded-lg border px-3 py-1.5 text-sm transition-colors [touch-action:manipulation] has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand has-[:focus-visible]:ring-offset-2 ${
                        formDays.includes(weekday)
                          ? 'border-brand bg-brand-wash text-brand-hi'
                          : 'border-line bg-panel text-ink-soft hover:border-line-strong'
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={formDays.includes(weekday)}
                        onChange={() =>
                          setFormDays((prev) =>
                            prev.includes(weekday) ? prev.filter((d) => d !== weekday) : [...prev, weekday]
                          )
                        }
                      />
                      {day}
                    </label>
                  ))}
                </div>
              </fieldset>

              <Button type="submit" loading={adding}>
                {adding ? 'Adding…' : 'Add Shift'}
              </Button>
            </form>
          </section>

          <div className="overflow-x-auto rounded-xl border border-line bg-panel">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Weekly shift roster. Select a day to toggle whether that engineer works it.
              </caption>
              <thead className="border-b border-line bg-raised text-xs uppercase tracking-wide text-subtle">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-left font-medium">Engineer</th>
                  <th scope="col" className="px-3 py-2.5 text-center font-medium">Open</th>
                  {WEEKDAYS.map((day, index) => (
                    <th
                      key={day}
                      scope="col"
                      className={`px-3 py-2.5 text-center font-medium ${index === todayIst ? 'text-brand' : ''}`}
                    >
                      {day}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {engineers.map((engineer) => (
                  <tr key={engineer.profile.id} className={engineer.profile.is_active ? '' : 'opacity-50'}>
                    <td className="px-4 py-3">
                      <span className="font-medium text-ink">{engineer.profile.full_name}</span>
                      {isOnShiftNow(engineer.shifts) && engineer.profile.is_active ? (
                        <span className="ml-2 inline-flex items-center rounded-full bg-ok-wash px-2 py-0.5 text-xs font-medium text-ok ring-1 ring-inset ring-ok/25">
                          On shift
                        </span>
                      ) : null}
                      {engineer.profile.is_active ? null : (
                        <span className="ml-2 text-xs text-subtle">Deactivated</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center tabular-nums text-ink-soft">
                      {engineer.openCount}
                    </td>
                    {WEEKDAYS.map((day, weekday) => {
                      const shift = engineer.shifts.find((s) => s.weekday === weekday)
                      const cellKey = `${engineer.profile.id}-${weekday}`
                      return (
                        <td key={day} className="px-2 py-2 text-center">
                          {/* A ✓ says there is a shift but not when it runs.
                              The tooltip carries the hours, and the aria-label
                              states them too so the information is not
                              hover-only. */}
                          <Tooltip>
                            <TooltipTrigger
                              type="button"
                              onClick={() => toggleShift(engineer, weekday)}
                              disabled={savingCell === cellKey}
                              aria-pressed={Boolean(shift)}
                              aria-label={
                                shift
                                  ? `${engineer.profile.full_name}, ${day}, ${shift.start_time}–${shift.end_time}. Click to clear.`
                                  : `${engineer.profile.full_name}, ${day}, not rostered. Click to add ${DEFAULT_START}–${DEFAULT_END}.`
                              }
                              className={`h-8 w-full min-w-14 rounded-md border text-xs font-medium transition-colors [touch-action:manipulation] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:opacity-50 ${
                                shift
                                  ? 'border-brand bg-brand text-canvas hover:bg-brand-hi'
                                  : 'border-line bg-panel text-subtle hover:border-line-strong'
                              }`}
                            >
                              {shift ? '✓' : '—'}
                            </TooltipTrigger>
                            <TooltipContent>
                              {shift
                                ? `${shift.start_time}–${shift.end_time} · click to clear`
                                : `Not rostered · click to add ${DEFAULT_START}–${DEFAULT_END}`}
                            </TooltipContent>
                          </Tooltip>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <section className="mt-8">
            <h2 className="mb-3 text-sm font-semibold text-ink">Shift Hours</h2>
            <p className="mb-4 text-sm text-subtle text-pretty">
              Every shift defaults to {DEFAULT_START}–{DEFAULT_END} IST. Adjust an individual day here.
            </p>

            <div className="space-y-2">
              {engineers.flatMap((engineer) =>
                engineer.shifts
                  .slice()
                  .sort((a, b) => a.weekday - b.weekday)
                  .map((shift) => (
                    <div
                      key={shift.id}
                      className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-panel px-4 py-2.5"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">
                        {engineer.profile.full_name}
                        <span className="ml-2 text-subtle">{WEEKDAYS[shift.weekday]}</span>
                      </span>
                      <label className="flex items-center gap-2 text-xs text-subtle">
                        Start
                        <input
                          type="time"
                          defaultValue={shift.start_time.slice(0, 5)}
                          onBlur={(e) => updateTimes(shift, e.target.value, shift.end_time.slice(0, 5))}
                          className="rounded-md border border-line px-2 py-1 text-sm text-ink [color-scheme:light] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        />
                      </label>
                      <label className="flex items-center gap-2 text-xs text-subtle">
                        End
                        <input
                          type="time"
                          defaultValue={shift.end_time.slice(0, 5)}
                          onBlur={(e) => updateTimes(shift, shift.start_time.slice(0, 5), e.target.value)}
                          className="rounded-md border border-line px-2 py-1 text-sm text-ink [color-scheme:light] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand"
                        />
                      </label>
                    </div>
                  ))
              )}
            </div>
          </section>
        </>
      )}
    </div>
    </TooltipProvider>
  )
}
