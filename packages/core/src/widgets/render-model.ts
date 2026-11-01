/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The neutral render model: a widget payload (any `WidgetData` shape, chosen by `type`) becomes a
 * list of blocks that the CLI prints and the TUI draws. New widget types are handled here once.
 */

import { formatTable, type Row } from '../render/output.js'
import { displayDateTime } from '../forms/datetime.js'

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

/**
 * What some widgets read besides their payload: the widget metadata (defaultValues name record
 * fields: cronUI), the record of a record-view section, its table's field labels.
 */
export interface WidgetContext {
  meta?: { type?: string | null; defaultValues?: J }
  record?: { values?: J; displayValues?: J }
  fields?: Record<string, { label?: string }>
}

function typedCell(column: J, value: unknown): string {
  const type = String(column.type ?? '')
  if (value === null || value === undefined) return ''
  if (type === 'html' || type === 'htmlAndTooltip') return htmlToText(str(value))
  if (type === 'image') return `[image ${str((value as J)?.alt ?? value)}]`
  if (type === 'composite' && value && typeof value === 'object') return blocksToText(blockToBlocks(value as J), { width: 40 }).replace(/\n+/g, ' ')
  if (typeof value === 'number') return value.toLocaleString('en-US', { maximumFractionDigits: 6 })
  if (typeof value === 'string' && /^-?\d{4,}(\.\d+)?$/.test(value) && (type === 'number' || type === 'numeric')) return Number(value).toLocaleString('en-US', { maximumFractionDigits: 6 })
  return str(value)
}

/** Turns one widget payload into render blocks. */
export function widgetToBlocks(data: unknown, context: WidgetContext = {}): RenderBlock[] {
  const w = (data ?? {}) as J
  const blocks: RenderBlock[] = []
  // an alert that hides itself, or has nothing to say, renders nothing (web: no card at all)
  if (String(w.type ?? '') === 'alert' && (w.hideWidget === true || !(w.html || w.text || w.message || w.bulletList))) return []
  // a payload that is one block (Material's block widget) renders that block
  if (typeof w.blockTypeName === 'string' && w.blockTypeName !== 'COMPOSITE' && !('blocks' in w) && !w.type) return blockToBlocks(w)
  const title = (w.title ?? w.label) as string | undefined
  if (title) blocks.push({ kind: 'heading', text: htmlToText(String(title)), sub: w.sublabel ? htmlToText(String(w.sublabel)) : w.description ? htmlToText(String(w.description)) : undefined })
  if (w.hasPermission === false) {
    blocks.push({ kind: 'alert', level: 'warning', text: 'You do not have permission to view this data.' })
    return blocks
  }
  // an untyped payload with chart data is a bar chart (the web's default)
  const type = String(w.type ?? context.meta?.type ?? w.blockTypeName ?? (w.chartData ? 'barChart' : ''))
  switch (type) {
    case 'statistics':
      if (w.count === undefined || w.count === null) {
        blocks.push({ kind: 'text', text: 'No value' })
        break
      }
      blocks.push({ kind: 'stat', value: str(w.count), context: w.countContext ? String(w.countContext) : undefined, delta: w.percentageAmount !== undefined && w.percentageAmount !== null ? { amount: Number(w.percentageAmount), label: w.percentageLabel ? String(w.percentageLabel) : undefined, good: typeof w.increaseIsGood === 'boolean' ? (Number(w.percentageAmount) >= 0) === w.increaseIsGood : undefined } : undefined })
      break
    case 'multiStatistics':
      for (const group of ((w.statisticsGroupData ?? w.groups ?? []) as J[])) {
        if (group.header ?? group.label) blocks.push({ kind: 'text', text: String(group.header ?? group.label) })
        for (const s of ((group.statisticsList ?? group.statisticList ?? group.statistics ?? []) as J[])) blocks.push({ kind: 'stat', label: str(s.label), value: str(s.count ?? s.value), context: s.context ? String(s.context) : undefined })
      }
      break
    case 'table':
    case 'multiTable': {
      const tables = type === 'multiTable' ? ((w.tableDataList ?? w.tables ?? []) as J[]) : [w]
      for (const t of tables) {
        const columns = ((t.columns ?? []) as J[]).filter((c) => c.type !== 'hidden')
        const rows = ((t.rows ?? []) as J[]).map((r) => Object.fromEntries(columns.map((c) => [String(c.accessor), typedCell(c, r[String(c.accessor)])])))
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
      if (!datasets.some((d) => d.data.length)) blocks.push({ kind: 'text', text: 'No data to chart' })
      else blocks.push({ kind: 'series', labels: ((cd.labels ?? []) as unknown[]).map(str), datasets, chart })
      break
    }
    case 'html':
    case 'generic': {
      const text = typeof w.text === 'string' ? w.text : htmlToText(str(w.html))
      if (text) blocks.push({ kind: 'text', text })
      else if (type === 'html') blocks.push({ kind: 'text', text: 'Nothing to show' })
      break
    }
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
      const values = { ...((record.values ?? {}) as J), ...((record.displayValues ?? {}) as J) }
      const indent = (w.fieldIndentLevels ?? {}) as Record<string, number>
      const icons = (w.fieldLabelPrefixIconNames ?? {}) as Record<string, string>
      const pairs = fields.length
        ? fields.map((f) => ({ label: `${'  '.repeat(Number(indent[String(f.name)] ?? 0))}${icons[String(f.name)] ? '• ' : ''}${str(f.label ?? f.name)}`, value: str(values[String(f.name)]) }))
        : Object.entries(values).map(([k, v]) => ({ label: k, value: str(v) }))
      if (pairs.length) blocks.push({ kind: 'pairs', pairs })
      else blocks.push({ kind: 'text', text: 'No values to show' })
      break
    }
    case 'dynamicForm': {
      const fields = ((w.fieldList ?? []) as J[]).filter((f) => f && !f.isHidden)
      const rec = (w.recordOfFieldValues ?? {}) as J
      const values = { ...((rec.values ?? {}) as J), ...((rec.displayValues ?? {}) as J) }
      if (fields.length) blocks.push({ kind: 'pairs', pairs: fields.map((f) => ({ label: `${str(f.label ?? f.name)}${f.isRequired ? ' *' : ''}`, value: str(values[String(f.name)]) })) })
      else blocks.push({ kind: 'text', text: str(w.noFieldsMessage) || 'No fields to show' })
      break
    }
    case 'filterAndColumnsSetup': {
      const rv = (context.record?.values ?? {}) as J
      const parse = (v: unknown): J | undefined => { if (v && typeof v === 'object') return v as J; try { return typeof v === 'string' && v ? JSON.parse(v) as J : undefined } catch { return undefined } }
      const filter = parse(rv[String(w.filterFieldName ?? 'queryFilterJson')]) ?? {}
      const crit = ((filter.criteria ?? []) as J[]).map((c) => `${str(context.fields?.[String(c.fieldName)]?.label ?? c.fieldName)} ${String(c.operator ?? '').toLowerCase().replace(/_/g, ' ')} ${((c.values ?? []) as unknown[]).map(str).join(', ')}${c.otherFieldName ? str(c.otherFieldName) : ''}`.trim())
      const sorts = ((filter.orderBys ?? []) as J[]).map((o) => `${str(o.fieldName)} ${o.isAscending === false ? 'descending' : 'ascending'}`)
      const cols = ((parse(rv[String(w.columnsFieldName ?? w.columnFieldName ?? 'columnsJson')])?.columns ?? []) as J[]).filter((c) => c.isVisible !== false).map((c) => str(c.name))
      const pairs = [{ label: 'Table', value: str(w.tableName ?? rv.tableName) || '(none)' }, { label: 'Filter', value: crit.length ? crit.join(` ${String(filter.booleanOperator ?? 'AND')} `) : '(no criteria)' }, { label: 'Sort', value: sorts.join(', ') || '(default)' }]
      if (w.hideColumns !== true) pairs.push({ label: 'Columns', value: cols.join(', ') || '(all)' })
      blocks.push({ kind: 'pairs', pairs })
      break
    }
    case 'pivotTableSetup': {
      const rv = (context.record?.values ?? {}) as J
      let pivot: J | undefined
      try { pivot = typeof rv.pivotTableJson === 'string' && rv.pivotTableJson ? JSON.parse(rv.pivotTableJson) as J : (rv.pivotTableJson as J | undefined) ?? undefined } catch { pivot = undefined }
      if (!pivot) blocks.push({ kind: 'text', text: 'No pivot table' })
      else {
        const names = (k: string) => ((pivot![k] ?? []) as J[]).map((x) => `${str(x.fieldName)}${x.function ? ` (${str(x.function).toLowerCase()})` : ''}`).join(', ') || '(none)'
        blocks.push({ kind: 'pairs', pairs: [{ label: 'Rows', value: names('rows') }, { label: 'Columns', value: names('columns') }, { label: 'Values', value: names('values') }] })
      }
      break
    }
    case 'dataBagViewer':
      blocks.push({ kind: 'text', text: 'Data bag versions and contents (Enter on the widget)' })
      break
    case 'scriptViewer':
      blocks.push({ kind: 'text', text: 'Script revisions, files and logs (Enter on the widget)' })
      break
    case 'cronUI': {
      const dv = (context.meta?.defaultValues ?? {}) as J
      const exprField = typeof dv.cronExpressionFieldName === 'string' ? dv.cronExpressionFieldName : undefined
      const zoneField = typeof dv.timeZoneFieldName === 'string' ? dv.timeZoneFieldName : undefined
      const expr = exprField ? str(context.record?.values?.[exprField]) : ''
      if (!expr && (context.record || !w.cronDescription)) {
        blocks.push({ kind: 'text', text: 'No schedule set' })
        break
      }
      const pairs: Array<{ label: string; value: string }> = []
      if (expr) pairs.push({ label: context.fields?.[exprField!]?.label ?? 'Cron Expression', value: expr })
      if (w.cronDescription) pairs.push({ label: 'Description', value: str(w.cronDescription) })
      if (zoneField) pairs.push({ label: context.fields?.[zoneField]?.label ?? 'Time Zone', value: str(context.record?.displayValues?.[zoneField] ?? context.record?.values?.[zoneField]) })
      blocks.push({ kind: 'pairs', pairs })
      if (w.error) blocks.push({ kind: 'alert', level: 'error', text: str(w.error) })
      break
    }
    case 'stepper': {
      const active = Number(w.activeStep ?? 0)
      blocks.push({ kind: 'steps', steps: ((w.steps ?? []) as J[]).map((s, i) => ({ label: str(s.label), state: i < active ? 'done' : i === active ? 'active' : 'todo' })) })
      break
    }
    case 'quickSightChart':
      if (w.url || w.embedUrl) blocks.push({ kind: 'link', label: 'QuickSight dashboard (opens in a browser)', href: str(w.url ?? w.embedUrl) })
      else blocks.push({ kind: 'text', text: 'No dashboard is available to embed.' })
      break
    case 'location': {
      const lines = [w.imageUrl ? `[image ${str(w.imageUrl)}]` : '', w.title && w.title !== title ? str(w.title) : '', w.description && !w.sublabel && w.title ? '' : '', str(w.location ?? w.address), w.latitude !== undefined ? `${str(w.latitude)}, ${str(w.longitude)}` : ''].filter(Boolean)
      if (w.description && w.title) lines.splice(1, 0, htmlToText(str(w.description)))
      blocks.push({ kind: 'text', text: lines.join('\n') || 'No location to show' })
      break
    }
    case 'usaMap': {
      const markers = ((w.mapMarkerList ?? w.markers ?? []) as J[]).filter((m) => m && typeof m === 'object')
      if (!markers.length) blocks.push({ kind: 'text', text: 'No locations to show' })
      else {
        blocks.push({ kind: 'table', columns: ['name', 'latitude', 'longitude'], headers: ['Name', 'Latitude', 'Longitude'], rows: markers.map((m) => ({ name: str(m.name), latitude: str(m.latitude), longitude: str(m.longitude) })) })
        blocks.push({ kind: 'text', text: `${markers.length} marker${markers.length === 1 ? '' : 's'} (the map itself is drawn in a browser)` })
      }
      break
    }
    case 'process': {
      const pm = (w.processMetaData ?? {}) as J
      if (!pm.name) blocks.push({ kind: 'text', text: 'No process is available.' })
      else blocks.push({ kind: 'text', text: `Process: ${str(pm.label ?? pm.name)} — Enter on the widget runs it here` })
      break
    }
    case 'rowBuilder': {
      const records = ((w.records ?? w.rows ?? ((w.queryOutput ?? {}) as J).records ?? []) as J[])
      const fields = (w.fields ?? (w.childTableMetaData as J | undefined)?.fields ?? {}) as Record<string, J> | J[]
      const list = (Array.isArray(fields) ? fields : Object.values(fields)).filter((f) => f && !f.isHidden).slice(0, 8)
      const names = list.length ? list.map((f) => String(f.name)) : [...new Set(records.flatMap((r) => Object.keys(((r.values ?? r) as J))))].slice(0, 8)
      if (!records.length) blocks.push({ kind: 'text', text: 'No rows' })
      else blocks.push({ kind: 'table', columns: names, headers: names.map((n) => str(list.find((f) => f.name === n)?.label ?? n)), rows: records.map((r) => Object.fromEntries(names.map((n) => [n, str(((r.displayValues ?? {}) as J)[n] ?? ((r.values ?? r) as J)[n])]))) })
      break
    }
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
      else blocks.push({ kind: 'text', text: type === 'parentWidget' ? 'No child widgets to show' : 'Nothing to show' })
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
      return widgetToBlocks({ ...b, type: 'composite', blocks: b.blocks ?? b.subBlocks ?? v.blocks ?? [] })
    case 'TABLE_SUB_ROW_DETAIL_ROW':
      return [{ kind: 'pairs', pairs: [{ label: str(v.label), value: str(v.value) }] }]
    case 'INPUT_FIELD': {
      const f = (v.fieldMetaData ?? {}) as J
      const seeded = v.value
      const shown = seeded === undefined || seeded === null || seeded === '' ? undefined
        : f.type === 'DATE_TIME' ? displayDateTime(seeded)
          : f.type === 'PASSWORD' ? '••••••' : f.type === 'BOOLEAN' ? (seeded === true || seeded === 'true' ? 'yes' : 'no') : str(seeded)
      return [{ kind: 'text', text: `${str(f.label ?? f.name)}${f.isRequired ? ' *' : ''}: [${shown ?? str(v.placeholder ?? (f.type ? String(f.type).toLowerCase() : 'input'))}]${v.submitOnEnter === true ? ' (Enter submits)' : ''}` }]
    }
    case 'IMAGE':
      return [{ kind: 'text', text: `[image ${str(v.alt ?? v.path)}]` }]
    case 'AUDIO':
      return [{ kind: 'text', text: `[audio ${str(v.path)}] (plays in a browser)` }]
    case 'ICON':
      return [{ kind: 'text', text: `[${str(v.name)}]` }]
    case 'BUTTON':
      return [{ kind: 'text', text: `[ ${str(v.label ?? v.actionCode ?? v.controlCode)} ]` }]
    default:
      return [{ kind: 'alert', level: 'warning', text: `Unsupported block type ${kind || '(none)'}` }]
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
