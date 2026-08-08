import { Skeleton } from '@/components/ui/skeleton'

/**
 * Loading placeholders shaped like the content they stand in for, so the page
 * does not jump when real data lands.
 *
 * Each one keeps the `role="status"` + visually-hidden "Loading…" that the
 * spinners they replace had. The blocks themselves are aria-hidden: a screen
 * reader should hear one short message, not a list of empty boxes.
 */
function LoadingRegion({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
    </div>
  )
}

/** Six Kanban columns, each with a couple of cards. */
export function BoardSkeleton() {
  return (
    <LoadingRegion label="Loading board…">
      <div className="flex gap-3 overflow-x-auto pb-2">
        {Array.from({ length: 6 }, (_, col) => (
          <div key={col} className="w-72 shrink-0 rounded-xl border border-line bg-panel p-3">
            <div className="mb-3 flex items-center justify-between">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-6" />
            </div>
            <div className="space-y-2">
              {Array.from({ length: col < 3 ? 3 : 1 }, (_, card) => (
                <div key={card} className="space-y-2 rounded-lg border border-line bg-raised p-3">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                  <Skeleton className="h-3 w-28" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </LoadingRegion>
  )
}

/** A stack of full-width rows — the Team list, My Work, the roster. */
export function ListSkeleton({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <LoadingRegion label={label}>
      <div className="space-y-2">
        {Array.from({ length: rows }, (_, i) => (
          <div
            key={i}
            className="flex items-center justify-between gap-4 rounded-xl border border-line bg-panel p-4"
          >
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
            <Skeleton className="h-8 w-24 shrink-0" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  )
}

/** Four stat tiles above two chart panels. */
export function AnalyticsSkeleton() {
  return (
    <LoadingRegion label="Loading analytics…">
      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-line bg-panel p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-16" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 2 }, (_, i) => (
          <div key={i} className="space-y-3 rounded-xl border border-line bg-panel p-5">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-48 w-full" />
          </div>
        ))}
      </div>
    </LoadingRegion>
  )
}
