export type IssueType =
  | 'pothole'
  | 'streetlight'
  | 'garbage'
  | 'water_leakage'
  | 'damaged_infrastructure'
  | 'other'

export type Priority = 'low' | 'medium' | 'high'

export type IssueStatus =
  | 'created'
  | 'assigned'
  | 'in_progress'
  | 'resolved'
  | 'closed'
  | 'reopened'

export type ReporterChannel = 'phone' | 'email' | 'anonymous'

export interface Department {
  id: string
  slug: string
  name: string
}

export interface Issue {
  id: string
  ticket_number: string
  reporter_channel: ReporterChannel
  reporter_contact: string | null
  photo_url: string
  comment: string
  landmark: string | null
  latitude: number
  longitude: number
  pincode: string | null
  area: string | null
  city: string | null
  state: string | null
  image_signature: string
  issue_type: IssueType
  department_id: string
  priority: Priority
  ai_summary: string | null
  ai_confidence: number | null
  status: IssueStatus
  assigned_to: string | null
  duplicate_of: string | null
  reopen_count: number
  resolution_photo_url: string | null
  resolution_comment: string | null
  resolved_at: string | null
  closed_at: string | null
  rating: number | null
  rating_comment: string | null
  created_at: string
  updated_at: string
  departments?: Department
  /** Joined from profiles via issues.assigned_to; absent on resident-facing queries. */
  assignee?: { id: string; full_name: string } | null
}

export interface IssueStatusHistoryEntry {
  id: string
  issue_id: string
  status: string
  note: string | null
  actor: string
  created_at: string
}

export type Role = 'super_admin' | 'dept_admin' | 'field_engineer'

export interface Profile {
  id: string
  full_name: string
  role: Role
  department_id: string | null
  is_active: boolean
  phone: string | null
  created_by: string | null
  created_at: string
  departments?: Department
}

/** Weekly recurring shift. weekday: 0 = Monday … 6 = Sunday. Times are IST. */
export interface RosterShift {
  id: string
  engineer_id: string
  weekday: number
  start_time: string
  end_time: string
  created_at: string
}

/** An engineer plus their shifts and current open-ticket count. */
export interface EngineerWorkload {
  profile: Profile
  shifts: RosterShift[]
  openCount: number
}

/** The existing ticket a report was merged into, and why it matched. */
export interface DuplicateMatch {
  ticketNumber: string
  status: IssueStatus
  reportedAt: string
  /** Distance to the original report; null when the match came from the photo alone. */
  distanceMeters: number | null
  matchedOn: 'location' | 'photo'
}

export interface ClassificationResult {
  duplicate: boolean
  duplicateOfTicket?: string
  duplicateOf?: DuplicateMatch
  issue_type?: IssueType
  department_slug?: string
  priority?: Priority
  confidence?: number
  summary?: string
}
