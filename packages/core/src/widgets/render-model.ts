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

/** Context a widget is rendered in: its metadata (label, footer, type) and the hosting record's values. */
export interface WidgetRenderContext {
  /** The widget's metadata (`GET /metaData` widgets entry): label, footerHTML, type, defaultValues, gridColumns. */
  meta?: J
  /** The record the widget sits on (record sections): cronUI, pivotTableSetup and filterAndColumnsSetup read it. */
  record?: J
}

/** Formats a number as the web does (en-US separators); text stays as it is. */
function num(v: unknown): string {
  if (typeof v === 'number') return v.toLocaleString('en-US')
  return str(v)
}

/** The empty-state text the web shows for a display type with no data. */
export const EMPTY_STATE: Record<string, string> = {
  table: 'No rows found', multiTable: 'No tables to show', chart: 'No chart data available', stepper: 'No steps to show', fieldValueList: 'No values to show',
  multiStatistics: 'No statistics available', usaMap: 'No locations to show', parentWidget: 'No child widgets to show', quickSightChart: 'No dashboard is available to embed.',
  rowBuilder: 'No rows', cronUI: 'No schedule set', process: 'No process is available.', dataBagViewer: 'No data bag was specified.', scriptViewer: 'No script was specified.',
  pivotTableSetup: 'This report does not use a pivot table.', childRecordList: 'No records found',
}

const PIVOT_FUNCTIONS: Record<string, string> = { SUM: 'Sum', COUNT: 'Count', COUNT_NUMS: 'Count Numbers', AVERAGE: 'Average', MAX: 'Max', MIN: 'Min', PRODUCT: 'Product', STD_DEV: 'StdDev', STD_DEVP: 'StdDevp', VAR: 'Var', VARP: 'Varp' }

function parseJsonValue(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try { return JSON.parse(v) } catch { return undefined }
}

/** A pivot table definition (`pivotTableJson`) as Rows / Columns / Values lines. */
export function pivotTableBlocks(record: J | undefined, fieldLabel: (name: string) => string = (n) => n): RenderBlock[] {
  const values = (record?.values ?? record ?? {}) as J
  const pivot = parseJsonValue(values.pivotTableJson) as J | undefined
  if (values.usePivotTable === false || !pivot) return [{ kind: 'text', text: EMPTY_STATE.pivotTableSetup! }]
  const names = (list: unknown) => ((list ?? []) as J[]).map((x) => fieldLabel(String(x.fieldName))).join(', ') || 'None'
  const vals = ((pivot.values ?? []) as J[]).map((x) => `${PIVOT_FUNCTIONS[String(x.function)] ?? str(x.function)} of ${fieldLabel(String(x.fieldName))}`).join(', ') || 'None'
  return [{ kind: 'pairs', pairs: [{ label: 'Rows', value: names(pivot.rows) }, { label: 'Columns', value: names(pivot.columns) }, { label: 'Values', value: vals }] }]
}

/** A saved filter and columns (`queryFilterJson`, `columnsJson`) as the web's sentences. */
export function filterAndColumnsBlocks(record: J | undefined, payload: J = {}, fieldLabel: (name: string) => string = (n) => n): RenderBlock[] {
  const values = (record?.values ?? record ?? {}) as J
  const filter = (parseJsonValue(values[String(payload.filterFieldName ?? 'queryFilterJson')]) ?? {}) as J
  const rawColumns = parseJsonValue(values[String(payload.columnsFieldName ?? payload.columnFieldName ?? 'columnsJson')])
  const out: RenderBlock[] = []
  const describe = (f: J): string[] => [
    ...((f.criteria ?? []) as J[]).map((c) => `${fieldLabel(String(c.fieldName))} ${String(c.operator ?? '').toLowerCase().replace(/_/g, ' ')}${((c.values ?? []) as unknown[]).length ? ` ${((c.values ?? []) as unknown[]).map(str).join(', ')}` : ''}${c.otherFieldName ? ` ${fieldLabel(String(c.otherFieldName))}` : ''}`),
    ...((f.subFilters ?? []) as J[]).map((sub) => `(${describe(sub).join(sub.booleanOperator === 'OR' ? ' or ' : ' and ')})`),
  ]
  const lines = describe(filter)
  out.push({ kind: 'text', text: lines.length ? `${filter.booleanOperator === 'OR' ? 'Match any of' : 'Match all of'}:\n${lines.map((l) => `  ${l}`).join('\n')}` : 'No filters' })
  if (!payload.hideSortBy) {
    const sorts = ((filter.orderBys ?? []) as J[]).map((o) => `${fieldLabel(String(o.fieldName))} ${o.isAscending === false ? 'descending' : 'ascending'}`)
    if (sorts.length) out.push({ kind: 'text', text: `Sorted by ${sorts.join(', then ')}` })
  }
  if (!payload.hideColumns) {
    const list = Array.isArray(rawColumns) ? rawColumns : Array.isArray((rawColumns as J | undefined)?.columns) ? (rawColumns as J).columns as unknown[] : []
    const visible = list.map((c) => (typeof c === 'string' ? { name: c, isVisible: true } : c as J)).filter((c) => c.isVisible !== false && c.name !== '__check__').map((c) => fieldLabel(String(c.name)))
    out.push({ kind: 'text', text: `Columns: ${visible.length ? visible.join(', ') : 'All columns'}` })
  }
  return out
}

/** Turns one widget payload into render blocks (with the widget's metadata and hosting record when known). */
export function widgetToBlocks(data: unknown, context: WidgetRenderContext = {}): RenderBlock[] {
  const w = (data ?? {}) as J
  const meta = context.meta ?? {}
  const blocks: RenderBlock[] = []
  const label = (w.label ?? meta.label) as string | undefined
  const title = (w.title ?? label) as string | undefined
  if (title) blocks.push({ kind: 'heading', text: htmlToText(String(title)), sub: w.sublabel ? htmlToText(String(w.sublabel)) : w.description && w.type !== 'location' ? htmlToText(String(w.description)) : undefined })
  if (meta.hasPermission === false || w.hasPermission === false) {
    blocks.push({ kind: 'alert', level: 'warning', text: 'You do not have permission to view this data.' })
    return blocks
  }
  // a required dropdown without a selection: the backend's message replaces the body
  if (typeof w.dropdownNeedsSelectedText === 'string' && w.dropdownNeedsSelectedText) {
    blocks.push({ kind: 'alert', level: 'info', text: htmlToText(w.dropdownNeedsSelectedText) })
    return blocks
  }
  const type = String(meta.type ?? w.type ?? w.blockTypeName ?? '')
  const empty = (t = type) => blocks.push({ kind: 'text', text: EMPTY_STATE[t] ?? 'No data' })
  switch (type) {
    case 'statistics':
      blocks.push({ kind: 'stat', value: w.isCurrency && typeof w.count === 'number' ? w.count.toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : num(w.count), context: w.countContext ? String(w.countContext) : undefined, delta: w.percentageAmount !== undefined && w.percentageAmount !== null ? { amount: Number(w.percentageAmount), label: w.percentageLabel ? String(w.percentageLabel) : undefined, good: (Number(w.percentageAmount) >= 0) === (typeof w.increaseIsGood === 'boolean' ? w.increaseIsGood : true) } : undefined })
      break
    case 'multiStatistics': {
      const groups = (w.statisticsGroupData ?? w.groups ?? []) as J[]
      if (!groups.length) empty()
      for (const group of groups) {
        const head = [group.icon ? `(${str(group.icon)})` : '', str(group.header ?? group.label), group.subheader ? str(group.subheader) : ''].filter(Boolean).join(' ')
        if (head) blocks.push({ kind: 'text', text: head })
        for (const st of ((group.statisticList ?? group.statisticsList ?? group.statistics ?? []) as J[])) blocks.push({ kind: 'stat', label: str(st.label), value: num(st.value ?? st.count), context: st.url ? `<${str(st.url)}>` : st.context ? String(st.context) : undefined })
      }
      break
    }
    case 'table':
    case 'multiTable': {
      const tables = type === 'multiTable' ? ((w.tableDataList ?? w.tables ?? []) as J[]) : [w]
      if (!tables.length) empty()
      for (const t of tables) blocks.push(...tableBlocks(t, t !== w))
      break
    }
    case 'chart': case 'barChart': case 'horizontalBarChart': case 'stackedBarChart': case 'lineChart': case 'smallLineChart': case 'pieChart': {
      const cd = (w.chartData ?? {}) as J
      const datasets = ((cd.datasets ?? (cd.dataset ? [cd.dataset] : [])) as J[]).map((d) => ({ label: str(d.label), data: ((d.data ?? []) as unknown[]).map(Number) }))
      const chart = type === 'pieChart' ? 'pie' : type === 'stackedBarChart' ? 'stackedBar' : type === 'horizontalBarChart' ? 'horizontalBar' : type === 'barChart' ? 'bar' : type === 'chart' ? 'chart' : 'line'
      const sub = w.chartSubheaderData as J | undefined
      if (sub && sub.mainNumber !== undefined) blocks.push({ kind: 'stat', value: str(sub.mainNumber), delta: sub.vsPreviousPercent !== undefined ? { amount: Number(sub.vsPreviousPercent), label: sub.vsDescription ? String(sub.vsDescription) : undefined, good: typeof sub.isGoodVsPrevious === 'boolean' ? sub.isGoodVsPrevious : undefined } : undefined })
      const labels = ((cd.labels ?? []) as unknown[]).map(str)
      if (!labels.length && !datasets.some((d) => d.data.length)) empty('chart')
      else blocks.push({ kind: 'series', labels, datasets, chart })
      break
    }
    case 'html':
      blocks.push({ kind: 'text', text: typeof w.text === 'string' ? w.text : htmlToText(str(w.html)) })
      break
    case 'generic':
      if (w.html) blocks.push({ kind: 'text', text: htmlToText(str(w.html)) })
      break
    case 'alert': {
      if (w.hideWidget === true || (!w.html && !w.message && !w.text)) break
      const level = String(w.alertType ?? 'INFO').toLowerCase()
      const items = Array.isArray(w.bulletList) ? (w.bulletList as unknown[]).map((b) => `• ${htmlToText(str(b))}`).join('\n') : ''
      blocks.push({ kind: 'alert', level: level === 'warning' || level === 'error' || level === 'success' ? level : 'info', text: [typeof w.text === 'string' ? w.text : htmlToText(str(w.html ?? w.message)), items].filter(Boolean).join('\n') })
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
      if (pairs.length) blocks.push({ kind: 'pairs', pairs })
      else empty()
      break
    }
    case 'stepper': {
      const active = Number(w.activeStep ?? 0)
      const steps = (w.steps ?? []) as J[]
      if (steps.length) blocks.push({ kind: 'steps', steps: steps.map((st, i) => ({ label: str(st.label), state: i < active ? 'done' : i === active ? 'active' : 'todo' })) })
      else empty()
      break
    }
    case 'quickSightChart':
      if (w.url ?? w.embedUrl) blocks.push({ kind: 'link', label: 'QuickSight dashboard (web only)', href: str(w.url ?? w.embedUrl) })
      else empty()
      break
    case 'location':
      if (w.imageUrl) blocks.push({ kind: 'link', label: 'Image', href: str(w.imageUrl) })
      if (w.title && w.title !== title) blocks.push({ kind: 'text', text: str(w.title) })
      for (const k of ['description', 'location']) if (w[k]) blocks.push({ kind: 'text', text: htmlToText(str(w[k])) })
      if (w.footerText) blocks.push({ kind: 'rule' }, { kind: 'text', text: str(w.footerText) })
      break
    case 'usaMap': {
      const markers = ((w.mapMarkerList ?? w.markers ?? []) as J[]).filter((m) => m && typeof m.latitude === 'number' && typeof m.longitude === 'number')
      if (!markers.length) empty()
      else blocks.push({ kind: 'table', columns: ['name', 'latitude', 'longitude'], headers: ['Location', 'Latitude', 'Longitude'], rows: markers.map((m) => ({ name: str(m.name), latitude: str(m.latitude), longitude: str(m.longitude) })) })
      break
    }
    case 'childRecordList': {
      const childMeta = (w.childTableMetaData ?? {}) as J
      const fields = (childMeta.fields ?? {}) as Record<string, J>
      const records = (((w.queryOutput ?? {}) as J).records ?? []) as J[]
      const names = Object.keys(fields).filter((n) => !fields[n]!.isHidden).slice(0, 8)
      if (!records.length) empty()
      else blocks.push({ kind: 'table', columns: names, headers: names.map((n) => str(fields[n]!.label ?? n)), rows: records.map((r) => Object.fromEntries(names.map((n) => [n, str(((r.displayValues ?? {}) as J)[n] ?? ((r.values ?? {}) as J)[n])]))) })
      if (w.totalRows !== undefined) blocks.push({ kind: 'text', text: `${str(w.totalRows)} ${str(childMeta.label ?? 'records')}` })
      break
    }
    case 'process': {
      const pm = (w.processMetaData ?? {}) as J
      if (!pm.name) {
        empty()
        break
      }
      const defaults = (w.defaultValues ?? {}) as J
      blocks.push({ kind: 'text', text: `Process ${str(pm.label ?? pm.name)}: qqq process run ${str(pm.name)}${Object.entries(defaults).map(([k, v]) => ` -v ${k}=${str(v)}`).join('')} (or widget get --run)` })
      break
    }
    case 'cronUI': {
      const dv = (meta.defaultValues ?? {}) as J
      const record = (context.record?.values ?? context.record ?? {}) as J
      const expression = record[String(dv.cronExpressionFieldName ?? 'cronExpression')]
      const zone = record[String(dv.timeZoneFieldName ?? 'cronTimeZoneId')]
      if (!expression && (context.record || !w.cronDescription)) {
        empty()
        if (w.error) blocks.push({ kind: 'alert', level: 'error', text: str(w.error) })
        break
      }
      const pairs = [...(expression ? [{ label: 'Cron Expression', value: str(expression) }] : []), ...(w.cronDescription ? [{ label: 'Description', value: str(w.cronDescription) }] : []), ...(zone ? [{ label: 'Time Zone', value: str(zone) }] : [])]
      blocks.push({ kind: 'pairs', pairs })
      if (w.error) blocks.push({ kind: 'alert', level: 'error', text: str(w.error) })
      break
    }
    case 'dynamicForm': {
      const fields = ((w.fieldList ?? []) as J[]).filter((f) => !f.isHidden)
      const record = (w.recordOfFieldValues ?? {}) as J
      const merged = w.mergedDynamicFormValuesIntoFieldName ? parseJsonValue(((context.record?.values ?? context.record ?? {}) as J)[String(w.mergedDynamicFormValuesIntoFieldName)]) as J | undefined : undefined
      const values = (merged ?? record.values ?? {}) as J
      const display = (merged ? {} : record.displayValues ?? {}) as J
      if (!fields.length) {
        if (w.noFieldsMessage) blocks.push({ kind: 'text', text: str(w.noFieldsMessage) })
        break
      }
      blocks.push({ kind: 'pairs', pairs: fields.map((f) => ({ label: str(f.label ?? f.name), value: str(display[String(f.name)] ?? values[String(f.name)] ?? '') })) })
      break
    }
    case 'pivotTableSetup':
      blocks.push(...pivotTableBlocks(context.record))
      break
    case 'filterAndColumnsSetup':
      blocks.push(...filterAndColumnsBlocks(context.record, w))
      break
    case 'rowBuilder': {
      const dv = (meta.defaultValues ?? {}) as J
      const records = (w.records ?? []) as J[]
      const declared = ((dv.frontendFields ?? dv.fields ?? []) as J[]).filter((f) => !f.isHidden)
      const names = declared.length ? declared.map((f) => String(f.name)) : [...new Set(records.flatMap((r) => Object.keys((r.values ?? {}) as J)))]
      const labels = declared.length ? declared.map((f) => str(f.label ?? f.name)) : names
      if (dv.inlineHeading) blocks.push({ kind: 'text', text: str(dv.inlineHeading) })
      if (!records.length) empty()
      else blocks.push({ kind: 'table', columns: names, headers: labels, rows: records.map((r) => Object.fromEntries(names.map((n) => [n, str(((r.displayValues ?? {}) as J)[n] ?? ((r.values ?? {}) as J)[n])]))) })
      break
    }
    case 'dataBagViewer':
    case 'scriptViewer':
      // these read their records with more requests: loadWidget (widgets/loader) fills them in
      blocks.push({ kind: 'text', text: (w.queryParams as J | undefined)?.id !== undefined ? `${type} for ${str((w.queryParams as J).id)}` : EMPTY_STATE[type]! })
      break
    case 'block':
    case 'composite':
    case 'parentWidget':
    case 'parent': {
      // a payload that is itself one leaf block (Material block widget)
      if (typeof w.blockTypeName === 'string' && w.blockTypeName !== 'COMPOSITE' && !('blocks' in w)) {
        blocks.push(...blockToBlocks(w))
        break
      }
      const children = ((w.blocks ?? w.childWidgets ?? w.children ?? []) as unknown[])
      if (children.length) blocks.push({ kind: 'children', blocks: children.map((child) => blockToBlocks(child as J)) })
      else if (Array.isArray(w.childWidgetNameList)) blocks.push({ kind: 'text', text: (w.childWidgetNameList as string[]).length ? `children: ${(w.childWidgetNameList as string[]).join(', ')}` : EMPTY_STATE.parentWidget! })
      else if (type === 'parentWidget') empty()
      break
    }
    default:
      blocks.push({ kind: 'raw', type: type || 'unknown', data })
  }
  if (typeof w.footerText === 'string' && w.footerText && type !== 'location') blocks.push({ kind: 'text', text: w.footerText })
  const footer = w.footerHTML ?? meta.footerHTML
  if (typeof footer === 'string' && footer) blocks.push({ kind: 'text', text: htmlToText(footer) })
  return blocks
}

/** A table payload: header line with link, columns without hidden ones, typed cells, sub-rows, sticky last row, empty state. */
function tableBlocks(t: J, nested: boolean): RenderBlock[] {
  const out: RenderBlock[] = []
  if (nested && t.label) out.push({ kind: 'text', text: String(t.label) })
  if (t.linkURL) out.push({ kind: 'link', label: str(t.linkText ?? t.linkURL), href: str(t.linkURL) })
  const columns = ((t.columns ?? []) as J[]).filter((c) => c.type !== 'hidden')
  const rows = (t.rows ?? []) as J[]
  if (!rows.length) {
    out.push({ kind: 'text', text: t.noRowsFoundHTML ? htmlToText(str(t.noRowsFoundHTML)) : EMPTY_STATE.table! })
    return out
  }
  const cell = (r: J, c: J): string => {
    const v = r[String(c.accessor)]
    switch (c.type) {
      case 'html': return htmlToText(str(v))
      case 'htmlAndTooltip': return `${htmlToText(str(v))}${r.tooltip ? ` (${htmlToText(str(r.tooltip))})` : ''}`
      case 'image': return [r.imageLabel ? str(r.imageLabel) : '', r.imageTotal ? num(r.imageTotal) : '', r.imageTotalType ? str(r.imageTotalType) : '', r.imageUrl ? `<${str(r.imageUrl)}>` : ''].filter(Boolean).join(' ')
      case 'composite': case 'block': return v && typeof v === 'object' ? blocksToText(widgetToBlocks({ ...(v as J), type: 'composite' })).replace(/\n+/g, ' ') : str(v)
      default: return typeof v === 'number' ? (v === 0 ? '0' : v.toLocaleString('en-US')) : v && typeof v === 'object' ? '' : str(v)
    }
  }
  const flat: Row[] = []
  const visit = (list: J[], depth: number) => {
    for (const r of list) {
      flat.push(Object.fromEntries(columns.map((c, i) => [String(c.accessor), `${i === 0 && depth ? `${'  '.repeat(depth)}↳ ` : ''}${cell(r, c)}`])))
      if (Array.isArray(r.subRows)) visit(r.subRows as J[], depth + 1)
    }
  }
  visit(rows, 0)
  const sticky = t.fixedStickyLastRow === true && flat.length > 1 ? flat.pop() : undefined
  out.push({ kind: 'table', columns: columns.map((c) => String(c.accessor)), headers: columns.map((c) => htmlToText(str(c.header ?? c.accessor))), rows: sticky ? [...flat, Object.fromEntries(columns.map((c) => [String(c.accessor), '-'.repeat(3)])), sticky] : flat })
  return out
}

/** A block inside a composite widget (`blockTypeName`: BIG_NUMBER, TEXT, INPUT_FIELD, BUTTON, …). */
function blockToBlocks(b: J): RenderBlock[] {
  const kind = String(b.blockTypeName ?? b.type ?? '')
  const v = (b.values ?? {}) as J
  const tip = (b.tooltip as J | undefined)?.title
  const withTip = (blocks: RenderBlock[]): RenderBlock[] => (tip && blocks.length && blocks[blocks.length - 1]!.kind === 'text' ? [...blocks.slice(0, -1), { kind: 'text', text: `${(blocks[blocks.length - 1] as { text: string }).text} (${htmlToText(str(tip))})` }] : blocks)
  switch (kind) {
    case 'BIG_NUMBER':
      return [{ kind: 'stat', label: v.heading ? str(v.heading) : undefined, value: str(v.number), context: v.context ? str(v.context) : undefined }]
    case 'NUMBER_ICON_BADGE':
      return [{ kind: 'stat', label: v.label ? str(v.label) : v.iconName ? `(${str(v.iconName)})` : undefined, value: str(v.number) }]
    case 'UP_OR_DOWN_NUMBER': {
      const up = v.isUp === true || v.isUp === 'true'
      const good = typeof v.isGood === 'boolean' ? v.isGood : typeof v.isUpGood === 'boolean' ? v.isUpGood === up : undefined
      return [{ kind: 'stat', label: v.heading ? str(v.heading) : undefined, value: `${up ? '▲' : '▼'} ${str(v.number)}`, context: [v.context ? str(v.context) : '', good === true ? '(good)' : good === false ? '(bad)' : ''].filter(Boolean).join(' ') || undefined }]
    }
    case 'TEXT': {
      const style = (b.styles ?? {}) as J
      const text = [v.startIcon ? `(${str(typeof v.startIcon === 'object' ? (v.startIcon as J).name : v.startIcon)})` : '', str(v.interpolatedText ?? v.text), v.endIcon ? `(${str(typeof v.endIcon === 'object' ? (v.endIcon as J).name : v.endIcon)})` : ''].filter(Boolean).join(' ')
      if (style.format === 'alert' || style.format === 'banner') return [{ kind: 'alert', level: 'info', text }]
      return withTip([{ kind: 'text', text }])
    }
    case 'PROGRESS_BAR': {
      const percent = Number(v.percent ?? 0)
      const filled = Math.max(0, Math.min(20, Math.round(percent / 5)))
      return [{ kind: 'stat', label: v.heading ? str(v.heading) : undefined, value: `${'█'.repeat(filled)}${'░'.repeat(20 - filled)} ${v.value !== undefined ? str(v.value) : `${percent.toFixed(1)}%`}` }]
    }
    case 'DIVIDER':
      return [{ kind: 'rule' }]
    case 'COMPOSITE':
      return widgetToBlocks({ ...b, type: 'composite', blocks: b.blocks ?? b.subBlocks ?? v.blocks ?? [] })
    case 'TABLE_SUB_ROW_DETAIL_ROW':
      return [{ kind: 'pairs', pairs: [{ label: str(v.label), value: str(v.value) }] }]
    case 'INPUT_FIELD': {
      const f = (v.fieldMetaData ?? {}) as J
      // a seeded DATE_TIME is shown in the local zone, seconds kept, as the web's datetime-local control does
      const seeded = v.value !== undefined && v.value !== null && v.value !== '' ? (f.type === 'DATE_TIME' ? displayDateTime(v.value) : str(v.value)) : undefined
      return [{ kind: 'text', text: `${str(f.label ?? f.name)}${f.isRequired ? ' *' : ''}: [${seeded ?? str(v.placeholder ?? (f.type ? String(f.type).toLowerCase() : 'input'))}]${v.submitOnEnter === true ? ' (Enter submits)' : ''}` }]
    }
    case 'BUTTON':
      return [{ kind: 'text', text: `[ ${str(v.label ?? 'Button')} ]` }]
    case 'AUDIO':
      return v.path ? [{ kind: 'link', label: 'Audio', href: str(v.path) }] : []
    case 'IMAGE':
      return v.path ? [{ kind: 'link', label: v.alt ? str(v.alt) : 'Image', href: str(v.path) }] : []
    case 'ICON':
      return [{ kind: 'text', text: `(${str(typeof v.name === 'object' && v.name ? (v.name as J).name : v.name)})` }]
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
