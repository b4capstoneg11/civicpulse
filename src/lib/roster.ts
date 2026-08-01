import type { RosterShift } from './types'

/** 0 = Monday … 6 = Sunday, matching roster_shifts.weekday. */
export const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

/**
 * Current IST weekday index and wall-clock time. Shifts are stored as IST
 * wall-clock, and the assignment function in Postgres compares against
 * `now() at time zone 'Asia/Kolkata'` — this mirrors that on the client so the
 * interface and the database agree about who is on shift.
 */
export function istNow(): { weekday: number; time: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date())

  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]))
  return {
    weekday: WEEKDAYS.indexOf(lookup.weekday ?? ''),
    time: `${lookup.hour}:${lookup.minute}`,
  }
}

export function isOnShiftNow(shifts: RosterShift[]): boolean {
  const { weekday, time } = istNow()
  return shifts.some(
    (s) => s.weekday === weekday && s.start_time.slice(0, 5) <= time && time < s.end_time.slice(0, 5)
  )
}

/** "Mon, Tue, Wed" — the days someone is rostered, for at-a-glance availability. */
export function shiftSummary(shifts: RosterShift[]): string {
  if (shifts.length === 0) return 'no roster'
  return shifts
    .slice()
    .sort((a, b) => a.weekday - b.weekday)
    .map((s) => WEEKDAYS[s.weekday])
    .join(', ')
}
