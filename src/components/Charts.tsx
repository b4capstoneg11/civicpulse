import { useId, useState } from 'react'
import { BUCKETS, BUCKET_COLORS, BUCKET_LABELS, type Bucket, type Series } from '../lib/analytics'

// Chart chrome, stepped for the dark panel. Presentation attributes are inline
// rather than CSS classes so the SVG can be serialised straight into the PDF
// export without losing its styling — a class-styled SVG rasterises unpainted.
const INK_MUTED = '#6f6f6f'
const INK_SECONDARY = '#a1a1a1'
const GRID = '#1f1f1f'
const AXIS = '#2f2f2f'
const GAP = 2 // gap between touching marks — the surface does the separating
const MAX_BAR = 24 // never fill the band; the leftover is air

function niceCeil(v: number): number {
  if (v <= 5) return Math.max(1, v)
  const mag = 10 ** Math.floor(Math.log10(v))
  return Math.ceil(v / (mag / 2)) * (mag / 2)
}

export function ChartLegend() {
  return (
    <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1.5" aria-label="Ticket state legend">
      {BUCKETS.map((b) => (
        <li key={b} className="flex items-center gap-1.5 text-[11px] text-ink-soft">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ background: BUCKET_COLORS[b] }}
          />
          {BUCKET_LABELS[b]}
        </li>
      ))}
    </ul>
  )
}

interface Hover {
  x: number
  y: number
  title: string
  rows: { label: string; value: number; color: string }[]
}

function Tooltip({ hover, width }: { hover: Hover; width: number }) {
  // Flip to the left of the cursor near the right edge so it never leaves the card.
  const flip = hover.x > width * 0.6
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 min-w-36 rounded-lg border border-line-strong bg-raised px-3 py-2 text-xs shadow-2xl shadow-black/60"
      style={{
        left: flip ? undefined : hover.x + 12,
        right: flip ? width - hover.x + 12 : undefined,
        top: Math.max(0, hover.y - 12),
      }}
    >
      <p className="mb-1 font-medium text-ink">{hover.title}</p>
      {hover.rows.map((r) => (
        <p key={r.label} className="flex items-center justify-between gap-3 text-ink-soft">
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: r.color }}
            />
            {r.label}
          </span>
          <span className="tabular-nums font-medium text-ink">{r.value}</span>
        </p>
      ))}
    </div>
  )
}

const hoverRows = (s: Series) =>
  BUCKETS.filter((b) => s.counts[b] > 0).map((b) => ({
    label: BUCKET_LABELS[b],
    value: s.counts[b],
    color: BUCKET_COLORS[b],
  }))

/** Stacked columns over time. Total is labelled on the cap; parts live in the tooltip. */
export function MonthlyColumns({ data, height = 240 }: { data: Series[]; height?: number }) {
  const [hover, setHover] = useState<Hover | null>(null)
  const titleId = useId()

  if (data.length === 0) return <p className="py-8 text-center text-sm text-muted">No tickets yet.</p>

  const padL = 34
  const padR = 8
  const padT = 18
  const axisBand = 26 // reserved so x labels are never clipped by a fixed height
  const width = Math.max(320, data.length * 58 + padL + padR)
  const plotH = height - padT - axisBand
  const max = niceCeil(Math.max(1, ...data.map((d) => d.counts.total)))
  const band = (width - padL - padR) / data.length
  const barW = Math.min(MAX_BAR, band * 0.55)
  const ticks = [0, max / 2, max]

  return (
    <div className="relative overflow-x-auto">
      <svg
        width={width}
        height={height}
        role="img"
        aria-labelledby={titleId}
        style={{ display: 'block', minWidth: '100%' }}
      >
        <title id={titleId}>Tickets created per month, split by state</title>

        {ticks.map((t) => {
          const y = padT + plotH - (t / max) * plotH
          return (
            <g key={t}>
              <line x1={padL} y1={y} x2={width - padR} y2={y} stroke={GRID} strokeWidth="1" />
              <text
                x={padL - 8}
                y={y + 3.5}
                textAnchor="end"
                fontSize="10"
                fill={INK_MUTED}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {Math.round(t)}
              </text>
            </g>
          )
        })}
        <line x1={padL} y1={padT + plotH} x2={width - padR} y2={padT + plotH} stroke={AXIS} strokeWidth="1" />

        {data.map((d, i) => {
          const cx = padL + band * i + band / 2
          const x = cx - barW / 2
          let cursorY = padT + plotH
          const isTop = (b: Bucket) => BUCKETS.filter((k) => d.counts[k] > 0).at(-1) === b

          return (
            <g
              key={d.key}
              onMouseEnter={(e) =>
                setHover({
                  x: cx,
                  y: e.nativeEvent.offsetY,
                  title: d.label,
                  rows: [{ label: 'Total', value: d.counts.total, color: INK_SECONDARY }, ...hoverRows(d)],
                })
              }
              onMouseLeave={() => setHover(null)}
            >
              {/* Full-height hit area — larger than the mark, per the interaction spec. */}
              <rect x={padL + band * i} y={padT} width={band} height={plotH} fill="transparent" />

              {BUCKETS.map((b) => {
                const v = d.counts[b]
                if (v === 0) return null
                const h = (v / max) * plotH
                cursorY -= h
                const top = isTop(b)
                return (
                  <rect
                    key={b}
                    x={x}
                    y={cursorY}
                    width={barW}
                    height={Math.max(1, h - GAP)}
                    rx={top ? 4 : 0}
                    fill={BUCKET_COLORS[b]}
                  />
                )
              })}

              {d.counts.total > 0 ? (
                <text
                  x={cx}
                  y={padT + plotH - (d.counts.total / max) * plotH - 6}
                  textAnchor="middle"
                  fontSize="10"
                  fontWeight="600"
                  fill={INK_SECONDARY}
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {d.counts.total}
                </text>
              ) : null}

              <text x={cx} y={height - 8} textAnchor="middle" fontSize="10" fill={INK_MUTED}>
                {d.label}
              </text>
            </g>
          )
        })}
      </svg>
      {hover ? <Tooltip hover={hover} width={width} /> : null}
    </div>
  )
}

/** Stacked horizontal bars for a nominal breakdown (department, type, priority). */
export function BreakdownBars({ data, maxRows = 8 }: { data: Series[]; maxRows?: number }) {
  const [hover, setHover] = useState<Hover | null>(null)
  const titleId = useId()

  if (data.length === 0) return <p className="py-8 text-center text-sm text-muted">No tickets yet.</p>

  const rows = data.slice(0, maxRows)
  const labelW = 148
  const valueW = 40
  const rowH = 30
  const width = 620
  const height = rows.length * rowH + 6
  const max = niceCeil(Math.max(1, ...rows.map((r) => r.counts.total)))
  const trackW = width - labelW - valueW

  return (
    <div className="relative overflow-x-auto">
      <svg width={width} height={height} role="img" aria-labelledby={titleId} style={{ display: 'block' }}>
        <title id={titleId}>Ticket counts by category, split by state</title>

        {rows.map((r, i) => {
          const y = i * rowH + 4
          const barH = Math.min(MAX_BAR - 6, rowH - 14)
          let cursorX = labelW
          const visible = BUCKETS.filter((b) => r.counts[b] > 0)

          return (
            <g
              key={r.key}
              onMouseEnter={(e) =>
                setHover({
                  x: e.nativeEvent.offsetX,
                  y,
                  title: r.label,
                  rows: [{ label: 'Total', value: r.counts.total, color: INK_SECONDARY }, ...hoverRows(r)],
                })
              }
              onMouseLeave={() => setHover(null)}
            >
              <rect x={0} y={y} width={width} height={rowH} fill="transparent" />

              <text x={labelW - 10} y={y + barH / 2 + 4} textAnchor="end" fontSize="11" fill={INK_SECONDARY}>
                {r.label.length > 22 ? `${r.label.slice(0, 21)}…` : r.label}
              </text>

              {visible.map((b, bi) => {
                const w = (r.counts[b] / max) * trackW
                const isLast = bi === visible.length - 1
                const seg = (
                  <rect
                    key={b}
                    x={cursorX}
                    y={y}
                    width={Math.max(1, w - (isLast ? 0 : GAP))}
                    height={barH}
                    rx={isLast ? 4 : 0}
                    fill={BUCKET_COLORS[b]}
                  />
                )
                cursorX += w
                return seg
              })}

              <text
                x={labelW + (r.counts.total / max) * trackW + 8}
                y={y + barH / 2 + 4}
                fontSize="11"
                fontWeight="600"
                fill={INK_SECONDARY}
                style={{ fontVariantNumeric: 'tabular-nums' }}
              >
                {r.counts.total}
              </text>
            </g>
          )
        })}
      </svg>
      {hover ? <Tooltip hover={hover} width={width} /> : null}
    </div>
  )
}

/** The WCAG-clean twin of every chart — no value is reachable only by hover. */
export function SeriesTable({ data, firstColumn }: { data: Series[]; firstColumn: string }) {
  if (data.length === 0) return null
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="w-full text-[13px]">
        <thead className="border-b border-line bg-raised text-[11px] uppercase tracking-wider text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 text-left font-medium">{firstColumn}</th>
            {BUCKETS.map((b) => (
              <th key={b} scope="col" className="px-3 py-2 text-right font-medium">{BUCKET_LABELS[b]}</th>
            ))}
            <th scope="col" className="px-3 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {data.map((r) => (
            <tr key={r.key} className="transition-colors hover:bg-raised/50">
              <th scope="row" className="px-3 py-2 text-left font-normal text-ink-soft">{r.label}</th>
              {BUCKETS.map((b) => (
                <td key={b} className="px-3 py-2 text-right tabular-nums text-ink-soft">{r.counts[b]}</td>
              ))}
              <td className="px-3 py-2 text-right font-medium tabular-nums text-ink">{r.counts.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
