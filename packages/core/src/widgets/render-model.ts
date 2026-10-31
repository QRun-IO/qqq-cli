/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The neutral render model: a widget payload (any `WidgetData` shape, chosen by `type`) becomes a
 * list of blocks that the CLI prints and the TUI draws. New widget types are handled here once.
 */

import { formatTable, type Row } from '../render/output.js'

export type RenderBlock =
  | { kind: 'heading'; text: string; sub?: string }
  | { kind: 'text'; text: string }
  | { kind: 'stat'; label?: string; value: string; context?: string; delta?: { amount: number; label?: string; good?: boolean } }
  | { kind: 'table'; columns: string[]; headers: string[]; rows: Row[] }
  | { kind: 'series'; labels: string[]; datasets: Array<{ label: string; data: number[] }>; chart: 'line' | 'bar' | 'pie' | 'stackedBar' | 'horizontalBar' | 'chart' }
  | { kind: 'pairs'; pairs: Array<{ label: string; value: string }> }
  | { kind: 'steps'; steps: Array<{ label: string; state: 'done' | 'active' | 'todo' }> }
  | { kind: 'alert'; level: 'info' | 'warning' | 'error' | 'success'; text: string }
  | { kind: 'link'; label: string; href: string }
  | { kind: 'rule' }
  | { kind: 'children'; blocks: RenderBlock[][] }
  | { kind: 'raw'; type: string; data: unknown }

type J = Record<string, unknown>

/** Strips tags and collapses whitespace; keeps link text. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n').replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l, i, all) => l || (i > 0 && all[i - 1])).join('\n').trim()
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** Turns one widget payload into render blocks. */
export function widgetToBlocks(data: unknown): RenderBlock[] {
  const w = (data ?? {}) as J
  const blocks: RenderBlock[] = []
  const title = (w.title ?? w.label) as string | undefined
  if (title) blocks.push({ kind: 'heading', text: htmlToText(String(title)), sub: w.sublabel ? htmlToText(String(w.sublabel)) : w.description ? htmlToText(String(w.description)) : undefined })
  if (w.hasPermission === false) {
    blocks.push({ kind: 'alert', level: 'warning', text: 'You do not have permission to view this data.' })
    return blocks
  }
  const type = String(w.type ?? w.blockTypeName ?? '')
  switch (type) {
    case 'statistics':
      blocks.push({ kind: 'stat', value: str(w.count), context: w.countContext ? String(w.countContext) : undefined, delta: w.percentageAmount !== undefined && w.percentageAmount !== null ? { amount: Number(w.percentageAmount), label: w.percentageLabel ? String(w.percentageLabel) : undefined, good: typeof w.increaseIsGood === 'boolean' ? (Number(w.percentageAmount) >= 0) === w.increaseIsGood : undefined } : undefined })
      break
    case 'multiStatistics':
      for (const group of ((w.statisticsGroupData ?? w.groups ?? []) as J[])) {
        if (group.header ?? group.label) blocks.push({ kind: 'text', text: String(group.header ?? group.label) })
        for (const s of ((group.statisticsList ?? group.statistics ?? []) as J[])) blocks.push({ kind: 'stat', label: str(s.label), value: str(s.count ?? s.value), context: s.context ? String(s.context) : undefined })
      }
      break
    case 'table':
    case 'multiTable': {
      const tables = type === 'multiTable' ? ((w.tableDataList ?? w.tables ?? []) as J[]) : [w]
      for (const t of tables) {
        const columns = ((t.columns ?? []) as J[]).filter((c) => c.type !== 'hidden')
        const rows = ((t.rows ?? []) as J[]).map((r) => Object.fromEntries(columns.map((c) => [String(c.accessor), c.type === 'html' ? htmlToText(str(r[String(c.accessor)])) : str(r[String(c.accessor)])])))
        if (t.label && t !== w) blocks.push({ kind: 'text', text: String(t.label) })
        blocks.push({ kind: 'table', columns: columns.map((c) => String(c.accessor)), headers: columns.map((c) => String(c.header ?? c.accessor)), rows })
      }
      break
    }
    case 'chart': case 'barChart': case 'horizontalBarChart': case 'stackedBarChart': case 'lineChart': case 'smallLineChart': case 'pieChart': {
      const cd = (w.chartData ?? {}) as J
      const datasets = ((cd.datasets ?? (cd.dataset ? [cd.dataset] : [])) as J[]).map((d) => ({ label: str(d.label), data: ((d.data ?? []) as unknown[]).map(Number) }))
      const chart = type === 'pieChart' ? 'pie' : type === 'stackedBarChart' ? 'stackedBar' : type === 'horizontalBarChart' ? 'horizontalBar' : type === 'barChart' ? 'bar' : type === 'chart' ? 'chart' : 'line'
      const sub = w.chartSubheaderData as J | undefined
      if (sub && sub.mainNumber !== undefined) blocks.push({ kind: 'stat', value: str(sub.mainNumber), delta: sub.vsPreviousPercent !== undefined ? { amount: Number(sub.vsPreviousPercent), label: sub.vsDescription ? String(sub.vsDescription) : undefined, good: typeof sub.isGoodVsPrevious === 'boolean' ? sub.isGoodVsPrevious : undefined } : undefined })
      blocks.push({ kind: 'series', labels: ((cd.labels ?? []) as unknown[]).map(str), datasets, chart })
      break
    }
    case 'html':
      blocks.push({ kind: 'text', text: typeof w.text === 'string' ? w.text : htmlToText(str(w.html)) })
      break
    case 'alert': {
      const level = String(w.alertType ?? 'INFO').toLowerCase()
      const items = Array.isArray(w.bulletList) ? (w.bulletList as unknown[]).map((b) => `• ${htmlToText(str(b))}`).join('\n') : ''
      blocks.push({ kind: 'alert', level: level === 'warning' || level === 'error' || level === 'success' ? level : 'info', text: [typeof w.text === 'string' ? w.text : htmlToText(str(w.html)), items].filter(Boolean).join('\n') })
      break
    }
    case 'divider':
      blocks.push({ kind: 'rule' })
      break
    case 'fieldValueList': {
      const record = (w.record ?? {}) as J
      const fields = (w.fields ?? []) as J[]
      const values = (record.displayValues ?? record.values ?? {}) as J
      const pairs = fields.length ? fields.map((f) => ({ label: str(f.label ?? f.name), value: str(values[String(f.name)]) })) : Object.entries(values).map(([k, v]) => ({ label: k, value: str(v) }))
      blocks.push({ kind: 'pairs', pairs })
      break
    }
    case 'stepper': {
      const active = Number(w.activeStep ?? 0)
      blocks.push({ kind: 'steps', steps: ((w.steps ?? []) as J[]).map((s, i) => ({ label: str(s.label), state: i < active ? 'done' : i === active ? 'active' : 'todo' })) })
      break
    }
    case 'quickSightChart':
      blocks.push({ kind: 'link', label: 'QuickSight dashboard (web only)', href: str(w.url ?? w.embedUrl) })
      break
    case 'location':
    case 'usaMap':
      blocks.push({ kind: 'text', text: [w.address, w.latitude !== undefined ? `${str(w.latitude)}, ${str(w.longitude)}` : '', Array.isArray(w.markers) ? `${(w.markers as unknown[]).length} markers` : ''].filter(Boolean).map(str).join('\n') || `(${type}: web only)` })
      break
    case 'childRecordList': {
      const meta = (w.childTableMetaData ?? {}) as J
      const fields = (meta.fields ?? {}) as Record<string, J>
      const records = (((w.queryOutput ?? {}) as J).records ?? []) as J[]
      const names = Object.keys(fields).filter((n) => !fields[n]!.isHidden).slice(0, 8)
      blocks.push({ kind: 'table', columns: names, headers: names.map((n) => str(fields[n]!.label ?? n)), rows: records.map((r) => Object.fromEntries(names.map((n) => [n, str(((r.displayValues ?? {}) as J)[n] ?? ((r.values ?? {}) as J)[n])]))) })
      if (w.totalRows !== undefined) blocks.push({ kind: 'text', text: `${str(w.totalRows)} ${str(meta.label ?? 'records')}` })
      break
    }
    case 'block':
    case 'composite':
    case 'parentWidget': {
      const children = ((w.blocks ?? w.childWidgets ?? w.children ?? []) as unknown[])
      if (children.length) blocks.push({ kind: 'children', blocks: children.map((child) => blockToBlocks(child as J)) })
      else if (Array.isArray(w.childWidgetNameList)) blocks.push({ kind: 'text', text: `children: ${(w.childWidgetNameList as string[]).join(', ')}` })
      break
    }
    default:
      blocks.push({ kind: 'raw', type: type || 'unknown', data })
  }
  if (typeof w.footerText === 'string' && w.footerText) blocks.push({ kind: 'text', text: w.footerText })
  else if (typeof w.footerHTML === 'string' && w.footerHTML) blocks.push({ kind: 'text', text: htmlToText(w.footerHTML) })
  return blocks
}

/** A block inside a composite widget (`blockTypeName`: BIG_NUMBER, TEXT, TABLE_SUB_ROW_DETAIL_ROW, …). */
function blockToBlocks(b: J): RenderBlock[] {
  const kind = String(b.blockTypeName ?? b.type ?? '')
  const v = (b.values ?? {}) as J
  switch (kind) {
    case 'BIG_NUMBER':
      return [{ kind: 'stat', label: v.heading ? str(v.heading) : undefined, value: str(v.number), context: v.context ? str(v.context) : undefined }]
    case 'NUMBER_ICON_BADGE':
      return [{ kind: 'stat', label: v.label ? str(v.label) : undefined, value: str(v.number) }]
    case 'UP_OR_DOWN_NUMBER': {
      const up = v.isUp === true || v.isUp === 'true'
      const good = typeof v.isGood === 'boolean' ? v.isGood : typeof v.isUpGood === 'boolean' ? v.isUpGood === up : undefined
      return [{ kind: 'stat', label: v.heading ? str(v.heading) : undefined, value: `${up ? '▲' : '▼'} ${str(v.number)}`, context: [v.context ? str(v.context) : '', good === true ? '(good)' : good === false ? '(bad)' : ''].filter(Boolean).join(' ') || undefined }]
    }
    case 'TEXT':
      return [{ kind: 'text', text: str(v.text) }]
    case 'PROGRESS_BAR':
      return [{ kind: 'stat', label: v.heading ? str(v.heading) : undefined, value: `${str(v.percent)}%` }]
    case 'DIVIDER':
      return [{ kind: 'rule' }]
    case 'COMPOSITE':
      return widgetToBlocks({ ...b, type: 'composite' })
    case 'TABLE_SUB_ROW_DETAIL_ROW':
      return [{ kind: 'pairs', pairs: [{ label: str(v.label), value: str(v.value) }] }]
    default:
      return [{ kind: 'raw', type: kind || 'block', data: b }]
  }
}

/** Renders blocks as plain text for a terminal (the CLI; the TUI draws them itself). */
export function blocksToText(blocks: RenderBlock[], options: { width?: number; ascii?: boolean } = {}): string {
  const width = options.width ?? 100
  const bar = options.ascii ? '#' : '█'
  const out: string[] = []
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading': out.push(b.sub ? `${b.text} — ${b.sub}` : b.text); break
      case 'text': out.push(b.text); break
      case 'stat': {
        const delta = b.delta ? ` (${b.delta.amount >= 0 ? '+' : ''}${b.delta.amount}%${b.delta.label ? ` ${b.delta.label}` : ''}${b.delta.good === true ? ' ▲' : b.delta.good === false ? ' ▼' : ''})` : ''
        out.push(`${b.label ? `${b.label}: ` : ''}${b.value}${b.context ? ` ${b.context}` : ''}${delta}`)
        break
      }
      case 'table': out.push(formatTable(b.rows, b.columns, b.headers)); break
      case 'series': {
        const rows = b.labels.map((label, i) => Object.fromEntries([['label', label], ...b.datasets.map((d) => [d.label || 'value', d.data[i] ?? ''])]))
        const columns = ['label', ...b.datasets.map((d) => d.label || 'value')]
        if (b.datasets.length === 1 && b.datasets[0]!.data.length) {
          const max = Math.max(...b.datasets[0]!.data.map((n) => Math.abs(n)), 1)
          const labelWidth = Math.min(24, Math.max(...b.labels.map((l) => l.length), 1))
          const barWidth = Math.max(8, Math.min(40, width - labelWidth - 14))
          b.labels.forEach((label, i) => {
            const n = b.datasets[0]!.data[i] ?? 0
            out.push(`${label.slice(0, labelWidth).padEnd(labelWidth)}  ${bar.repeat(Math.round((Math.abs(n) / max) * barWidth)).padEnd(barWidth)}  ${n.toLocaleString()}`)
          })
        } else {
          out.push(formatTable(rows, columns, columns))
        }
        break
      }
      case 'pairs': {
        const w = Math.max(...b.pairs.map((p) => p.label.length), 1)
        for (const p of b.pairs) out.push(`${p.label.padEnd(w)}  ${p.value}`)
        break
      }
      case 'steps': out.push(b.steps.map((s) => `${s.state === 'done' ? '[x]' : s.state === 'active' ? '[>]' : '[ ]'} ${s.label}`).join('\n')); break
      case 'alert': out.push(`[${b.level.toUpperCase()}] ${b.text}`); break
      case 'link': out.push(`${b.label}: ${b.href}`); break
      case 'rule': out.push('-'.repeat(Math.min(width, 40))); break
      case 'children': out.push(b.blocks.map((child) => blocksToText(child, options)).join('\n\n')); break
      case 'raw': out.push(`(${b.type} widget: no terminal rendering yet)\n${JSON.stringify(b.data, null, 2)}`); break
    }
  }
  return out.join('\n')
}

/** The rows of a widget as CSV-able data: the first table or series, else nothing. */
export function widgetRows(blocks: RenderBlock[]): { columns: string[]; headers: string[]; rows: Row[] } | undefined {
  for (const b of blocks) {
    if (b.kind === 'table') return { columns: b.columns, headers: b.headers, rows: b.rows }
    if (b.kind === 'series') {
      const columns = ['label', ...b.datasets.map((d) => d.label || 'value')]
      return { columns, headers: columns, rows: b.labels.map((label, i) => Object.fromEntries([['label', label], ...b.datasets.map((d) => [d.label || 'value', d.data[i] ?? ''])])) }
    }
    if (b.kind === 'children') {
      for (const child of b.blocks) {
        const found = widgetRows(child)
        if (found) return found
      }
    }
  }
  return undefined
}
