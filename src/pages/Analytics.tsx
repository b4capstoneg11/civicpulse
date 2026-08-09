import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../hooks/useAuth'
import { Alert, Button, EmptyState } from '../components/ui'
import { FieldSelect } from '../components/FieldSelect'
import { AnalyticsSkeleton } from '../components/Skeletons'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BreakdownBars, ChartLegend, MonthlyColumns, SeriesTable } from '../components/Charts'
import { buildAnalytics, formatCount, formatDuration, type AnalyticsResult } from '../lib/analytics'
import { buildAnalyticsPdf } from '../lib/reportPdf'
import type { Department, Issue } from '../lib/types'

const RANGES = [
  { key: '3', label: 'Last 3 months' },
  { key: '6', label: 'Last 6 months' },
  { key: '12', label: 'Last 12 months' },
  { key: 'all', label: 'All time' },
] as const

function StatTile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-panel px-4 py-3">
      <p className="text-xs font-medium uppercase tracking-wide text-subtle">{label}</p>
      {/* Proportional figures deliberately: tabular-nums makes display sizes look loose. */}
      <p className="mt-1 text-2xl font-semibold text-ink">{value}</p>
      {hint ? <p className="mt-0.5 text-xs text-subtle">{hint}</p> : null}
    </div>
  )
}

function ChartCard({
  id,
  title,
  subtitle,
  children,
  table,
}: {
  id: string
  title: string
  subtitle: string
  children: React.ReactNode
  table: React.ReactNode
}) {
  return (
    <section className="rounded-xl border border-line bg-panel p-5">
      <Tabs defaultValue="chart">
        <div className="mb-1 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-ink">{title}</h2>
            <p className="text-xs text-subtle">{subtitle}</p>
          </div>
          <TabsList aria-label={`${title} view`}>
            <TabsTrigger value="chart">Chart</TabsTrigger>
            <TabsTrigger value="table">Table</TabsTrigger>
          </TabsList>
        </div>

        <ChartLegend />

        {/* forceMount matters: the PDF export looks the figure up by DOM id, so
            the chart has to stay mounted while the table tab is showing. Radix
            marks it hidden instead of unmounting, which is what the previous
            hand-rolled toggle did — and the export already falls back to the
            SVG's viewBox when a hidden node measures zero. */}
        <TabsContent value="chart" forceMount>
          <div id={id}>{children}</div>
        </TabsContent>
        <TabsContent value="table" className="mt-2">
          {table}
        </TabsContent>
      </Tabs>
    </section>
  )
}

export function Analytics() {
  const { profile, hasGlobalScope, departmentId } = useAuth()

  const [issues, setIssues] = useState<Issue[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const [range, setRange] = useState<string>('12')
  // Super admins may narrow to one department; a staff admin is pinned to theirs.
  const [deptFilter, setDeptFilter] = useState('')

  const scopedDepartment = hasGlobalScope ? deptFilter : (departmentId ?? '')

  // A non-super-admin with no department must never fall through to an unscoped
  // query. The check constraint makes this impossible in the database, but an
  // empty filter would silently widen scope to every department, so it is
  // treated as a hard stop rather than trusted.
  const scopeBroken = !hasGlobalScope && !departmentId

  useEffect(() => {
    if (!hasGlobalScope) return
    supabase
      .from('departments')
      .select('*')
      .order('name')
      .then(({ data }) => setDepartments(data ?? []))
  }, [hasGlobalScope])

  useEffect(() => {
    if (scopeBroken) {
      setIssues([])
      setLoading(false)
      setError('Your account has no department assigned, so no analytics can be shown. Contact a super admin.')
      return
    }

    let cancelled = false
    setLoading(true)

    async function load() {
      let query = supabase
        .from('issues')
        .select('*, departments(id, slug, name)')
        .order('created_at', { ascending: true })

      // A staff admin's analytics never leave their own department.
      if (scopedDepartment) query = query.eq('department_id', scopedDepartment)

      if (range !== 'all') {
        const since = new Date()
        since.setMonth(since.getMonth() - Number(range))
        query = query.gte('created_at', since.toISOString())
      }

      const { data, error: queryError } = await query
      if (cancelled) return

      if (queryError) setError(queryError.message)
      else {
        setError(null)
        setIssues((data ?? []) as Issue[])
      }
      setLoading(false)
    }

    load()
    return () => {
      cancelled = true
    }
  }, [scopedDepartment, range, scopeBroken])

  const result: AnalyticsResult = useMemo(() => buildAnalytics(issues), [issues])

  const scopeLabel = hasGlobalScope
    ? deptFilter
      ? `${departments.find((d) => d.id === deptFilter)?.name ?? 'Department'} · ${RANGES.find((r) => r.key === range)?.label}`
      : `All departments · ${RANGES.find((r) => r.key === range)?.label}`
    : `${profile?.departments?.name ?? 'Your department'} · ${RANGES.find((r) => r.key === range)?.label}`

  // The by-department chart is meaningless for a single department — a one-bar
  // chart is an anti-pattern, so it only appears when more than one is in scope.
  const showDepartmentChart = result.byDepartment.length > 1

  const handleExport = useCallback(async () => {
    setExporting(true)
    setError(null)
    try {
      const charts = [{ id: 'chart-monthly', caption: 'Tickets per Month' }]
      if (showDepartmentChart) charts.push({ id: 'chart-department', caption: 'By Department' })
      charts.push({ id: 'chart-type', caption: 'By Issue Type' })

      const pdf = await buildAnalyticsPdf(result, {
        scopeLabel,
        generatedBy: profile?.full_name ?? 'staff',
        charts,
        tables: [
          { caption: 'Monthly Detail', firstColumn: 'Month', data: result.byMonth },
          ...(showDepartmentChart
            ? [{ caption: 'Department Detail', firstColumn: 'Department', data: result.byDepartment }]
            : []),
          { caption: 'Issue Type Detail', firstColumn: 'Issue type', data: result.byIssueType },
          { caption: 'Priority Detail', firstColumn: 'Priority', data: result.byPriority },
        ],
      })

      const stamp = new Date().toISOString().slice(0, 10)
      pdf.save(`civicpulse-analytics-${stamp}.pdf`)
    } catch (err) {
      setError(`Could not build the PDF: ${(err as Error).message}`)
    } finally {
      setExporting(false)
    }
  }, [result, scopeLabel, profile?.full_name, showDepartmentChart])

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink text-balance">Analytics</h1>
          <p className="text-sm text-ink-soft">{scopeLabel}</p>
        </div>
        <Button onClick={handleExport} loading={exporting} disabled={loading || issues.length === 0}>
          {exporting ? 'Building PDF…' : 'Download PDF Report'}
        </Button>
      </div>

      {/* One filter row above everything it scopes — never per-chart filters. */}
      <div className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="range" className="mb-1 block text-xs font-medium text-ink-soft">
            Period
          </label>
          <FieldSelect
            id="range"
            value={range}
            onValueChange={setRange}
            className="w-44"
            options={RANGES.map((r) => ({ value: r.key, label: r.label }))}
          />
        </div>

        {hasGlobalScope ? (
          <div>
            <label htmlFor="dept" className="mb-1 block text-xs font-medium text-ink-soft">
              Department
            </label>
            <FieldSelect
              id="dept"
              value={deptFilter}
              onValueChange={setDeptFilter}
              className="w-56"
              options={[
                { value: '', label: 'All departments' },
                ...departments.map((d) => ({ value: d.id, label: d.name })),
              ]}
            />
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="mb-4">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      {loading ? (
        <AnalyticsSkeleton />
      ) : issues.length === 0 ? (
        <EmptyState
          title="No tickets in this period"
          description="Widen the period, or wait for reports to come in."
        />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile label="Total tickets" value={formatCount(result.totals.total)} />
            <StatTile
              label="Open"
              value={formatCount(result.totals.open)}
              hint={`${Math.round((result.totals.open / result.totals.total) * 100)}% of total`}
            />
            <StatTile
              label="Resolved"
              value={formatCount(result.totals.resolved)}
              hint={`${result.reopenedCount} reopened at least once`}
            />
            <StatTile
              label="Median resolution"
              value={formatDuration(result.medianResolutionHours)}
              hint={
                result.averageRating === null
                  ? 'No ratings yet'
                  : `Avg rating ${result.averageRating.toFixed(1)}/5`
              }
            />
          </div>

          <ChartCard
            id="chart-monthly"
            title="Tickets per Month"
            subtitle="Created each month, split by current state"
            table={<SeriesTable data={result.byMonth} firstColumn="Month" />}
          >
            <MonthlyColumns data={result.byMonth} />
          </ChartCard>

          {showDepartmentChart ? (
            <ChartCard
              id="chart-department"
              title="By Department"
              subtitle="Where the workload sits across departments"
              table={<SeriesTable data={result.byDepartment} firstColumn="Department" />}
            >
              <BreakdownBars data={result.byDepartment} />
            </ChartCard>
          ) : null}

          <ChartCard
            id="chart-type"
            title="By Issue Type"
            subtitle="What residents are reporting most"
            table={<SeriesTable data={result.byIssueType} firstColumn="Issue type" />}
          >
            <BreakdownBars data={result.byIssueType} />
          </ChartCard>

          <ChartCard
            id="chart-priority"
            title="By Priority"
            subtitle="How the AI triage graded the backlog"
            table={<SeriesTable data={result.byPriority} firstColumn="Priority" />}
          >
            <BreakdownBars data={result.byPriority} />
          </ChartCard>
        </div>
      )}
    </div>
  )
}
