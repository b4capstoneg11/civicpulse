import type { Issue, IssueStatus } from './types'

// Lifecycle states collapse into three reporting buckets. Identity is fixed:
// Open is always orange, Resolved always aqua, Closed always blue — in every
// chart, so a reader who learns the legend once keeps it.
export const BUCKETS = ['open', 'resolved', 'closed'] as const
export type Bucket = (typeof BUCKETS)[number]

export const BUCKET_LABELS: Record<Bucket, string> = {
  open: 'Open',
  resolved: 'Resolved',
  closed: 'Closed',
}

/**
 * On-screen steps, selected for the dark panel (#0a0a0a) rather than flipped
 * from the light set — all-pairs CVD ΔE 9.4, normal-vision 20.9, every colour
 * clearing 3:1 against the surface.
 */
export const BUCKET_COLORS: Record<Bucket, string> = {
  open: '#d95926',
  resolved: '#199e70',
  closed: '#3987e5',
}

/**
 * The PDF is a white document, so the charts are re-inked with the light steps
 * before rasterising. Without this the dark-surface colours would sit on white
 * at the wrong contrast.
 */
export const BUCKET_COLORS_PRINT: Record<Bucket, string> = {
  open: '#eb6834',
  resolved: '#1baf7a',
  closed: '#2a78d6',
}

const STATUS_BUCKET: Record<IssueStatus, Bucket> = {
  created: 'open',
  assigned: 'open',
  in_progress: 'open',
  reopened: 'open',
  resolved: 'resolved',
  closed: 'closed',
}

export function bucketOf(status: IssueStatus): Bucket {
  return STATUS_BUCKET[status] ?? 'open'
}

export interface Counts {
  open: number
  resolved: number
  closed: number
  total: number
}

const emptyCounts = (): Counts => ({ open: 0, resolved: 0, closed: 0, total: 0 })

function add(counts: Counts, bucket: Bucket) {
  counts[bucket] += 1
  counts.total += 1
}

export interface Series {
  key: string
  label: string
  counts: Counts
}

export interface AnalyticsResult {
  totals: Counts
  /** Median is reported rather than mean: one stale ticket skews a mean badly. */
  medianResolutionHours: number | null
  reopenedCount: number
  ratedCount: number
  averageRating: number | null
  byMonth: Series[]
  byDepartment: Series[]
  byIssueType: Series[]
  byPriority: Series[]
  firstTicketAt: string | null
}

const monthKeyFormatter = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit' })
const monthLabelFormatter = new Intl.DateTimeFormat(undefined, { month: 'short', year: '2-digit' })

const ISSUE_TYPE_LABELS: Record<string, string> = {
  pothole: 'Pothole',
  streetlight: 'Streetlight',
  garbage: 'Garbage',
  water_leakage: 'Water Leakage',
  damaged_infrastructure: 'Damaged Infrastructure',
  other: 'Other',
}

/**
 * Builds every month between the first ticket and now, so a month with no
 * activity renders as a genuine gap rather than being silently skipped — a
 * missing column would otherwise read as "no data collected".
 */
function monthSpan(from: Date, to: Date): { key: string; label: string }[] {
  const out: { key: string; label: string }[] = []
  const cursor = new Date(from.getFullYear(), from.getMonth(), 1)
  const end = new Date(to.getFullYear(), to.getMonth(), 1)

  while (cursor <= end && out.length < 36) {
    out.push({
      key: monthKeyFormatter.format(cursor).slice(0, 7),
      label: monthLabelFormatter.format(cursor),
    })
    cursor.setMonth(cursor.getMonth() + 1)
  }
  return out
}

function groupBy(
  issues: Issue[],
  keyOf: (i: Issue) => string | null,
  labelOf: (key: string, i: Issue) => string
): Series[] {
  const map = new Map<string, Series>()
  for (const issue of issues) {
    const key = keyOf(issue)
    if (!key) continue
    if (!map.has(key)) map.set(key, { key, label: labelOf(key, issue), counts: emptyCounts() })
    add(map.get(key)!.counts, bucketOf(issue.status))
  }
  return [...map.values()].sort((a, b) => b.counts.total - a.counts.total)
}

export function buildAnalytics(issues: Issue[]): AnalyticsResult {
  const totals = emptyCounts()
  const resolutionHours: number[] = []
  let reopenedCount = 0
  let ratedCount = 0
  let ratingSum = 0
  let earliest: number | null = null

  for (const issue of issues) {
    add(totals, bucketOf(issue.status))

    const created = new Date(issue.created_at).getTime()
    if (earliest === null || created < earliest) earliest = created

    if (issue.resolved_at) {
      const hours = (new Date(issue.resolved_at).getTime() - created) / 3_600_000
      if (hours >= 0) resolutionHours.push(hours)
    }
    if (issue.reopen_count > 0) reopenedCount += 1
    if (issue.rating != null) {
      ratedCount += 1
      ratingSum += issue.rating
    }
  }

  resolutionHours.sort((a, b) => a - b)
  const medianResolutionHours =
    resolutionHours.length === 0
      ? null
      : resolutionHours.length % 2 === 1
        ? resolutionHours[(resolutionHours.length - 1) / 2]
        : (resolutionHours[resolutionHours.length / 2 - 1] + resolutionHours[resolutionHours.length / 2]) / 2

  // Monthly buckets, pre-seeded across the full span so gaps stay visible.
  const monthIndex = new Map<string, Series>()
  if (earliest !== null) {
    for (const m of monthSpan(new Date(earliest), new Date())) {
      monthIndex.set(m.key, { key: m.key, label: m.label, counts: emptyCounts() })
    }
  }
  for (const issue of issues) {
    const key = monthKeyFormatter.format(new Date(issue.created_at)).slice(0, 7)
    if (!monthIndex.has(key)) {
      monthIndex.set(key, {
        key,
        label: monthLabelFormatter.format(new Date(issue.created_at)),
        counts: emptyCounts(),
      })
    }
    add(monthIndex.get(key)!.counts, bucketOf(issue.status))
  }

  return {
    totals,
    medianResolutionHours,
    reopenedCount,
    ratedCount,
    averageRating: ratedCount === 0 ? null : ratingSum / ratedCount,
    byMonth: [...monthIndex.values()].sort((a, b) => a.key.localeCompare(b.key)),
    byDepartment: groupBy(
      issues,
      (i) => i.department_id,
      (_k, i) => i.departments?.name ?? 'Unknown department'
    ),
    byIssueType: groupBy(issues, (i) => i.issue_type, (k) => ISSUE_TYPE_LABELS[k] ?? k),
    byPriority: groupBy(issues, (i) => i.priority, (k) => k.charAt(0).toUpperCase() + k.slice(1)),
    firstTicketAt: earliest === null ? null : new Date(earliest).toISOString(),
  }
}

/** "3.2 days" / "18 hours" — resolution time reads better in the larger unit. */
export function formatDuration(hours: number | null): string {
  if (hours === null) return '—'
  if (hours < 1) return `${Math.round(hours * 60)} min`
  if (hours < 48) return `${hours.toFixed(1)} hours`
  return `${(hours / 24).toFixed(1)} days`
}

/** Compact display for stat tiles: 1,284 / 12.9K. */
export function formatCount(n: number): string {
  if (n < 10_000) return n.toLocaleString()
  return `${(n / 1000).toFixed(1)}K`
}
