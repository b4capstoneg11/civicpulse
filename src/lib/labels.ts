import type { IssueStatus, Priority, Role } from './types'

export const ROLE_LABELS: Record<Role, string> = {
  super_admin: 'Super Admin',
  readonly_admin: 'Read-only Admin',
  dept_admin: 'Staff Admin',
  field_engineer: 'Field Engineer',
}

/**
 * Where each role lands after signing in. The role comes from the `profiles`
 * row, never from anything the user typed — this is the single place that
 * mapping lives, so the redirect and the nav can't drift apart.
 */
export const ROLE_HOME: Record<Role, string> = {
  super_admin: '/board',
  readonly_admin: '/board',
  dept_admin: '/board',
  field_engineer: '/my-work',
}

// Kept out of the component files so Fast Refresh keeps working — a module that
// exports both components and constants loses its refresh boundary.

export const STATUS_LABELS: Record<IssueStatus, string> = {
  created: 'Created',
  assigned: 'Assigned',
  in_progress: 'In Progress',
  resolved: 'Resolved',
  closed: 'Closed',
  reopened: 'Reopened',
}

export const PRIORITY_LABELS: Record<Priority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
}
