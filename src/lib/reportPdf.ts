import { jsPDF } from 'jspdf'
import {
  BUCKETS,
  BUCKET_COLORS_DARK,
  BUCKET_COLORS_PRINT,
  BUCKET_LABELS,
  CHART_CHROME,
  formatDuration,
  type AnalyticsResult,
  type Series,
} from './analytics'

/**
 * Rasterises a live <svg> at 2x for embedding. The charts carry inline
 * presentation attributes rather than CSS classes precisely so this works —
 * a serialised SVG has no access to the page stylesheet, and anything styled
 * by class would come out unpainted.
 */
async function svgToPng(svg: SVGSVGElement, scale = 2): Promise<{ data: string; w: number; h: number }> {
  const rect = svg.getBoundingClientRect()
  const w = Math.ceil(rect.width || svg.viewBox.baseVal.width || 600)
  const h = Math.ceil(rect.height || svg.viewBox.baseVal.height || 300)

  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(w))
  clone.setAttribute('height', String(h))

  // The PDF is always a white document, whichever theme the app is showing, so
  // the clone is re-inked from the dark steps to the light ones. Keyed on the
  // dark hexes, this is a no-op when the user is already in light mode — nothing
  // matches — so one map serves both themes.
  const recolour: Record<string, string> = {
    [BUCKET_COLORS_DARK.open.toLowerCase()]: BUCKET_COLORS_PRINT.open,
    [BUCKET_COLORS_DARK.resolved.toLowerCase()]: BUCKET_COLORS_PRINT.resolved,
    [BUCKET_COLORS_DARK.closed.toLowerCase()]: BUCKET_COLORS_PRINT.closed,
    [CHART_CHROME.dark.muted]: CHART_CHROME.light.muted,
    [CHART_CHROME.dark.secondary]: CHART_CHROME.light.secondary,
    [CHART_CHROME.dark.grid]: CHART_CHROME.light.grid,
    [CHART_CHROME.dark.axis]: CHART_CHROME.light.axis,
  }
  for (const el of clone.querySelectorAll<SVGElement>('[fill], [stroke]')) {
    for (const attr of ['fill', 'stroke'] as const) {
      const v = el.getAttribute(attr)?.toLowerCase()
      if (v && recolour[v]) el.setAttribute(attr, recolour[v])
    }
  }

  const source = new XMLSerializer().serializeToString(clone)
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`

  const img = new Image()
  img.width = w
  img.height = h
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('Could not rasterise the chart'))
    img.src = url
  })

  const canvas = document.createElement('canvas')
  canvas.width = w * scale
  canvas.height = h * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is unavailable in this browser')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, w, h)

  return { data: canvas.toDataURL('image/png'), w, h }
}

const TEAL: [number, number, number] = [15, 118, 110]
const INK: [number, number, number] = [15, 23, 42]
const MUTED: [number, number, number] = [100, 116, 139]
const RULE: [number, number, number] = [203, 213, 225]

export interface ReportMeta {
  scopeLabel: string
  generatedBy: string
  /** DOM ids of the chart figures to embed, with their captions. */
  charts: { id: string; caption: string }[]
  tables: { caption: string; firstColumn: string; data: Series[] }[]
}

export async function buildAnalyticsPdf(result: AnalyticsResult, meta: ReportMeta): Promise<jsPDF> {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4' })
  const pageW = pdf.internal.pageSize.getWidth()
  const pageH = pdf.internal.pageSize.getHeight()
  const margin = 42
  const contentW = pageW - margin * 2
  let y = margin

  const ensureRoom = (needed: number) => {
    if (y + needed <= pageH - margin) return
    pdf.addPage()
    y = margin
  }

  // ── header ───────────────────────────────────────────────────────────────
  pdf.setFont('helvetica', 'bold').setFontSize(20).setTextColor(...TEAL)
  pdf.text('CivicPulse', margin, y)
  y += 20
  pdf.setFont('helvetica', 'normal').setFontSize(12).setTextColor(...INK)
  pdf.text('Ticket Analytics Report', margin, y)
  y += 14
  pdf.setFontSize(9).setTextColor(...MUTED)
  pdf.text(meta.scopeLabel, margin, y)
  y += 11
  pdf.text(
    `Generated ${new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeStyle: 'short' }).format(new Date())} by ${meta.generatedBy}`,
    margin,
    y
  )
  y += 8
  pdf.setDrawColor(...RULE).setLineWidth(0.7)
  pdf.line(margin, y, pageW - margin, y)
  y += 22

  // ── KPI row ──────────────────────────────────────────────────────────────
  const kpis: [string, string][] = [
    ['Total tickets', String(result.totals.total)],
    ['Open', String(result.totals.open)],
    ['Resolved', String(result.totals.resolved)],
    ['Closed', String(result.totals.closed)],
    ['Median resolution', formatDuration(result.medianResolutionHours)],
    ['Reopened', String(result.reopenedCount)],
  ]
  const colW = contentW / 3
  kpis.forEach(([label, value], i) => {
    const col = i % 3
    const row = Math.floor(i / 3)
    const x = margin + col * colW
    const ty = y + row * 42
    pdf.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED)
    pdf.text(label.toUpperCase(), x, ty)
    pdf.setFont('helvetica', 'bold').setFontSize(16).setTextColor(...INK)
    pdf.text(value, x, ty + 17)
  })
  y += Math.ceil(kpis.length / 3) * 42 + 8

  if (result.averageRating !== null) {
    pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...MUTED)
    pdf.text(
      `Average resident rating ${result.averageRating.toFixed(1)} of 5, across ${result.ratedCount} rated ticket(s).`,
      margin,
      y
    )
    y += 16
  }

  // ── charts ───────────────────────────────────────────────────────────────
  for (const chart of meta.charts) {
    const svg = document.getElementById(chart.id)?.querySelector('svg')
    if (!(svg instanceof SVGSVGElement)) continue

    let png: { data: string; w: number; h: number }
    try {
      png = await svgToPng(svg)
    } catch {
      continue // a chart that will not rasterise is skipped; its table still carries the data
    }

    const drawW = Math.min(contentW, png.w)
    const drawH = (png.h / png.w) * drawW
    ensureRoom(drawH + 30)

    pdf.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...INK)
    pdf.text(chart.caption, margin, y)
    y += 12
    // jsPDF embeds bitmaps uncompressed by default, which turned a four-chart
    // report into several megabytes. FAST (Flate) suits flat chart art.
    pdf.addImage(png.data, 'PNG', margin, y, drawW, drawH, undefined, 'FAST')
    y += drawH + 8

    // Legend, so the PDF is readable without the app beside it.
    pdf.setFontSize(8)
    let lx = margin
    for (const b of BUCKETS) {
      // Print steps, to match the re-inked chart above.
      const [r, g, bl] = hexToRgb(BUCKET_COLORS_PRINT[b])
      pdf.setFillColor(r, g, bl)
      pdf.circle(lx + 3, y - 3, 3, 'F')
      pdf.setTextColor(...MUTED)
      pdf.text(BUCKET_LABELS[b], lx + 10, y)
      lx += pdf.getTextWidth(BUCKET_LABELS[b]) + 26
    }
    y += 20
  }

  // ── tables ───────────────────────────────────────────────────────────────
  for (const t of meta.tables) {
    if (t.data.length === 0) continue
    ensureRoom(60)
    pdf.setFont('helvetica', 'bold').setFontSize(11).setTextColor(...INK)
    pdf.text(t.caption, margin, y)
    y += 14

    const cols = [t.firstColumn, ...BUCKETS.map((b) => BUCKET_LABELS[b]), 'Total']
    const firstW = contentW * 0.4
    const numW = (contentW - firstW) / (cols.length - 1)

    pdf.setFont('helvetica', 'bold').setFontSize(8).setTextColor(...MUTED)
    cols.forEach((c, i) => {
      const x = i === 0 ? margin : margin + firstW + numW * (i - 1)
      pdf.text(c.toUpperCase(), i === 0 ? x : x + numW - 4, y, { align: i === 0 ? 'left' : 'right' })
    })
    y += 4
    pdf.setDrawColor(...RULE).setLineWidth(0.5)
    pdf.line(margin, y, pageW - margin, y)
    y += 11

    pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...INK)
    for (const row of t.data) {
      ensureRoom(16)
      const values = [row.label, ...BUCKETS.map((b) => String(row.counts[b])), String(row.counts.total)]
      values.forEach((v, i) => {
        const x = i === 0 ? margin : margin + firstW + numW * (i - 1)
        const text = i === 0 && v.length > 34 ? `${v.slice(0, 33)}…` : v
        pdf.text(text, i === 0 ? x : x + numW - 4, y, { align: i === 0 ? 'left' : 'right' })
      })
      y += 14
    }
    y += 12
  }

  // ── footer on every page ─────────────────────────────────────────────────
  const pages = pdf.getNumberOfPages()
  for (let i = 1; i <= pages; i++) {
    pdf.setPage(i)
    pdf.setFont('helvetica', 'normal').setFontSize(8).setTextColor(...MUTED)
    pdf.text('CivicPulse analytics', margin, pageH - 22)
    pdf.text(`Page ${i} of ${pages}`, pageW - margin, pageH - 22, { align: 'right' })
  }

  return pdf
}

function hexToRgb(hex: string): [number, number, number] {
  const v = hex.replace('#', '')
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)]
}
