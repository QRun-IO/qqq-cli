/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The record view as text: sections in metadata order (hidden sections and hidden fields never
 * shown), each value through its adornments (LINK, CHIP, REVEAL, RENDER_HTML, CODE_EDITOR, ERROR,
 * FILE_DOWNLOAD, WIDGET, TOOLTIP, FILE_UPLOAD), and the help content that applies to a view
 * screen. Mirrors the Next UI's FieldValue and adornment-utils, minus what only a browser can do.
 */

import type { FieldMeta } from '../forms/fields.js'
import { blocksToText, htmlToText, widgetToBlocks } from '../widgets/render-model.js'
import { displayDateTime, type DisplayOptions } from '../forms/datetime.js'
import { helpContentText } from '../help/help-content.js'
import type { RecordLike, SectionMeta, TableMetaLike } from './associations.js'

export interface HelpContent {
  summary?: string
  title?: string
  content?: string
  format?: 'TEXT' | 'HTML' | 'MARKDOWN' | string
  contentAsText?: string
  contentAsHtml?: string
  roles?: string[]
  links?: Array<{ label?: string; url?: string }>
}

/** The roles that apply to a record view, most specific first (Next's VIEW_SCREEN_HELP_ROLES). */
export const VIEW_SCREEN_HELP_ROLES = ['VIEW_SCREEN', 'READ_SCREENS', 'ALL_SCREENS'] as const

/** The help entry for a screen: the first entry naming one of the roles (in role order), else one with no roles. */
export function selectHelpContent(entries: unknown, roles: readonly string[] = VIEW_SCREEN_HELP_ROLES): HelpContent | undefined {
  const list = (Array.isArray(entries) ? entries : entries && typeof entries === 'object' ? [entries] : []) as HelpContent[]
  const usable = list.filter((e) => Boolean(e && (e.content?.trim() || e.contentAsHtml?.trim() || e.summary?.trim() || e.contentAsText?.trim())))
  for (const role of roles) {
    const match = usable.find((e) => e.roles?.includes(role))
    if (match) return match
  }
  return usable.find((e) => !e.roles || e.roles.length === 0)
}

/** Help content as plain text: TEXT as written, HTML and MARKDOWN through the server's rendered HTML. */
export function helpEntryText(entry: HelpContent | undefined): string {
  if (!entry) return ''
  let text = (helpContentText(entry as unknown as Record<string, unknown>) || entry.summary || '').trim()
  if (entry.title && !text.startsWith(entry.title)) text = `${entry.title}: ${text}`
  const links = (entry.links ?? []).filter((l) => l?.url).map((l) => `${l.label ?? l.url} <${l.url}>`)
  return links.length ? `${text}${text ? ' ' : ''}(${links.join(', ')})` : text
}

/** Table help for a view: the table's `helpContent`, or its `helpContents` slots (every slot that has view help, by slot name). */
export function tableViewHelp(table: TableMetaLike, roles: readonly string[] = VIEW_SCREEN_HELP_ROLES): Array<{ slot: string; text: string }> {
  const out: Array<{ slot: string; text: string }> = []
  const single = selectHelpContent(table.helpContent, roles)
  if (single) out.push({ slot: 'table', text: helpEntryText(single) })
  const slots = table.helpContents
  if (slots && typeof slots === 'object' && !Array.isArray(slots)) {
    for (const [slot, entries] of Object.entries(slots as Record<string, unknown>)) {
      const entry = selectHelpContent(entries, roles)
      if (entry) out.push({ slot, text: helpEntryText(entry) })
    }
  }
  return out
}

export type Adornment = { type: string; values?: Record<string, unknown> }

export function findAdornment(field: FieldMeta, type: string): Adornment | undefined {
  return field.adornments?.find((a) => a.type === type)
}

function adornmentString(field: FieldMeta, type: string, key: string): string | undefined {
  const value = findAdornment(field, type)?.values?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export type LinkTarget = { kind: 'record'; tableName: string; primaryKey: string } | { kind: 'url'; href: string; external: boolean }

/** Where a LINK adornment points: a record (static or dynamic table) or a URL. */
export function linkTarget(field: FieldMeta, record: RecordLike): LinkTarget | undefined {
  const adornment = findAdornment(field, 'LINK')
  const raw = record.values[field.name]
  if (!adornment || raw === null || raw === undefined || raw === '') return undefined
  const staticTable = adornmentString(field, 'LINK', 'toRecordFromTable')
  const dynamicTable = adornment.values?.toRecordFromTableDynamic ? record.displayValues?.[`${field.name}:toRecordFromTableDynamic`] : undefined
  const tableName = staticTable ?? (typeof dynamicTable === 'string' && dynamicTable ? dynamicTable : undefined)
  if (tableName) return { kind: 'record', tableName, primaryKey: String(raw) }
  if (adornment.values?.toRecordFromTableDynamic) return undefined
  const href = String(raw).trim()
  if (/^https?:\/\//i.test(href)) return { kind: 'url', href, external: true }
  if (href.startsWith('/') && !href.startsWith('//')) return { kind: 'url', href, external: false }
  return undefined
}

/**
 * The related record a field points at: its LINK adornment's record, or, for a possible-value
 * field whose source is a table, that table's record (Next shows both as record links).
 */
export function relatedRecordTarget(field: FieldMeta, record: RecordLike, tableNames?: Iterable<string>): { tableName: string; primaryKey: string } | undefined {
  const link = linkTarget(field, record)
  if (link?.kind === 'record') return { tableName: link.tableName, primaryKey: link.primaryKey }
  const raw = record.values[field.name]
  const source = field.possibleValueSourceName
  if (!source || raw === null || raw === undefined || raw === '') return undefined
  const known = tableNames ? new Set(tableNames) : undefined
  if (known && !known.has(source)) return undefined
  return { tableName: source, primaryKey: String(raw) }
}

const FIELD_DOWNLOAD_PATH = /^\/data\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)\/([^?#]+)(\?[^#]*)?$/

/**
 * A stored file a FILE_DOWNLOAD field offers: its name, and either the UI API route
 * (`downloadRecordFieldFile`: table, key, field, file name) or an outside URL.
 */
export function fileDownload(field: FieldMeta, record: RecordLike): { fileName: string; route?: { tableName: string; primaryKey: string; fieldName: string; filename: string }; url?: string } | undefined {
  const adornment = findAdornment(field, 'FILE_DOWNLOAD')
  if (!adornment) return undefined
  const dynamic = adornment.values?.downloadUrlDynamic ? record.displayValues?.[`${field.name}:downloadUrlDynamic`] : undefined
  const url = typeof dynamic === 'string' && dynamic ? dynamic : record.values[field.name]
  if (typeof url !== 'string' || !url || (!url.startsWith('/') && !/^https?:\/\//i.test(url)) || url.startsWith('//')) return undefined
  const display = record.displayValues?.[field.name]
  const last = url.split('?')[0]!.split('/').pop() || field.label
  const fileName = typeof display === 'string' && display && display !== url ? display : safeDecode(last)
  const match = FIELD_DOWNLOAD_PATH.exec(url)
  if (match && !dynamic) return { fileName, route: { tableName: safeDecode(match[1]!), primaryKey: safeDecode(match[2]!), fieldName: safeDecode(match[3]!), filename: safeDecode(match[4]!) } }
  return { fileName, url }
}

function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

/** TOOLTIP text (dynamic per record, else static). */
export function tooltipText(field: FieldMeta, record: RecordLike): string | undefined {
  const adornment = findAdornment(field, 'TOOLTIP')
  if (!adornment) return undefined
  if (adornment.values?.tooltipDynamic) {
    const dynamic = record.displayValues?.[`${field.name}:tooltipDynamic`]
    if (typeof dynamic === 'string' && dynamic) return dynamic
  }
  return adornmentString(field, 'TOOLTIP', 'staticText')
}

export const MASK = '••••••••'

export interface ValueOptions {
  /** Show REVEAL values instead of the mask. */
  reveal?: boolean
  /** Table names the user can open (possible-value sources that are tables become record links). */
  tableNames?: Iterable<string>
  /** The record's table and key, for the download command hint. */
  tableName?: string
  primaryKey?: string
  /** Widget metadata, for WIDGET adornments (a missing widget is reported, as Next does). */
  widgets?: Record<string, unknown>
  /** Text placeholder for empty values (default empty). */
  empty?: string
  /** DATE_TIME display: the viewer's zone (default), another zone, or the raw UTC instant (`--utc`). */
  dateTime?: DisplayOptions
  /**
   * A cell of a record list rather than the record view: the same adornment rules (REVEAL masked,
   * CHIP, ERROR, DATE_TIME in the zone), without link targets, download hints or tooltips.
   */
  cell?: boolean
}

/** A field value rendered for a terminal. */
export interface ValueText {
  text: string
  /** The record or URL the value links to. */
  link?: { tableName: string; primaryKey: string } | { url: string }
  /** A downloadable file. */
  file?: ReturnType<typeof fileDownload>
  /** The adornment that decided the rendering. */
  adornment?: string
  masked?: boolean
  error?: boolean
  /** CHIP style for the value (`color.<value>`, `icon.<value>` of the adornment): the CLI colors it on a terminal, the TUI draws it. */
  chip?: { color: ChipColor; icon?: string }
}

/** CHIP colors the backend declares (AdornmentType.ChipValues). */
export type ChipColor = 'default' | 'info' | 'primary' | 'secondary' | 'success' | 'warning' | 'error'

/** The chip color and icon a CHIP adornment gives a raw value. */
export function chipStyle(field: FieldMeta, raw: unknown): { color: ChipColor; icon?: string } {
  const values = (findAdornment(field, 'CHIP')?.values ?? {}) as Record<string, unknown>
  const colorMap = (values.colorMap ?? {}) as Record<string, unknown>
  const color = String(values[`color.${String(raw)}`] ?? colorMap[String(raw)] ?? 'default').toLowerCase()
  const icon = values[`icon.${String(raw)}`]
  const known: ChipColor[] = ['default', 'info', 'primary', 'secondary', 'success', 'warning', 'error']
  const alias: Record<string, ChipColor> = { green: 'success', red: 'error', yellow: 'warning', orange: 'warning', blue: 'info', gray: 'default', grey: 'default' }
  return { color: known.includes(color as ChipColor) ? color as ChipColor : alias[color] ?? 'default', ...(typeof icon === 'string' && icon ? { icon } : {}) }
}

function str(value: unknown): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** Renders one value through its adornments, in Next's order; TOOLTIP text is appended in parentheses. */
export function valueText(field: FieldMeta, record: RecordLike, options: ValueOptions = {}): ValueText {
  const out = valueTextWithoutTooltip(field, record, options)
  if (options.cell) return out
  const tip = tooltipText(field, record)
  if (tip && out.text) out.text = `${out.text} (${tip})`
  return out
}

function valueTextWithoutTooltip(field: FieldMeta, record: RecordLike, options: ValueOptions): ValueText {
  const raw = record.values[field.name]
  const display = record.displayValues?.[field.name]
  const value = display ?? raw
  const empty = options.empty ?? ''

  // a PASSWORD field is never shown (the server should not return it; when it does, it stays masked)
  if (field.type === 'PASSWORD') return { text: raw === null || raw === undefined || raw === '' ? empty : '••••••' }

  const widget = findAdornment(field, 'WIDGET')
  if (widget) {
    const widgetName = typeof widget.values?.widgetName === 'string' ? widget.values.widgetName : ''
    if (options.widgets && !options.widgets[widgetName]) return { text: `Error: Could not load widget [${widgetName}]`, adornment: 'WIDGET', error: true }
    if (raw === null || raw === undefined) return { text: empty, adornment: 'WIDGET' }
    const text = blocksToText(widgetToBlocks(raw), { width: 80 })
    return { text: text || str(raw), adornment: 'WIDGET' }
  }

  if (findAdornment(field, 'LINK')) {
    if (value === null || value === undefined || value === '') return { text: empty, adornment: 'LINK' }
    const target = options.cell ? undefined : linkTarget(field, record)
    if (target?.kind === 'record') return { text: `${str(value)} → ${target.tableName} ${target.primaryKey}`, link: { tableName: target.tableName, primaryKey: target.primaryKey }, adornment: 'LINK' }
    if (target?.kind === 'url') return { text: str(value) === target.href ? target.href : `${str(value)} <${target.href}>`, link: { url: target.href }, adornment: 'LINK' }
    return { text: str(value), adornment: 'LINK' }
  }

  if (findAdornment(field, 'REVEAL')) {
    if (value === null || value === undefined || value === '') return { text: empty, adornment: 'REVEAL' }
    return options.reveal ? { text: str(raw ?? value), adornment: 'REVEAL' } : { text: MASK, adornment: 'REVEAL', masked: true }
  }

  if (findAdornment(field, 'RENDER_HTML')) return { text: htmlToText(str(raw)), adornment: 'RENDER_HTML' }

  if (findAdornment(field, 'CHIP')) {
    if (value === null || value === undefined || value === '') return { text: empty, adornment: 'CHIP' }
    const chip = chipStyle(field, raw ?? value)
    return { text: `[${str(value)}]${chip.icon && !options.cell ? ` (icon ${chip.icon})` : ''}`, adornment: 'CHIP', chip }
  }

  if (findAdornment(field, 'CODE_EDITOR')) return { text: str(raw ?? value), adornment: 'CODE_EDITOR' }

  if (findAdornment(field, 'ERROR')) {
    const text = str(raw ?? value)
    return { text: text ? `! ${text}` : empty, adornment: 'ERROR', error: Boolean(text) }
  }

  if (findAdornment(field, 'FILE_DOWNLOAD')) {
    const file = fileDownload(field, record)
    if (!file) return { text: empty, adornment: 'FILE_DOWNLOAD' }
    if (options.cell) return { text: file.fileName, file, adornment: 'FILE_DOWNLOAD' }
    const hint = file.route && options.tableName ? ` (qqq table download ${options.tableName} ${options.primaryKey ?? file.route.primaryKey} ${field.name})` : file.url ? ` <${file.url}>` : ''
    return { text: `${file.fileName}${hint}`, file, adornment: 'FILE_DOWNLOAD' }
  }

  if (value === null || value === undefined || value === '') return { text: empty }

  if (field.type === 'DATE_TIME') return { text: displayDateTime(raw, display, options.dateTime) }

  // HTML fields are shown as their text (the web renders them sanitized); $EDITOR edits the source
  if (field.type === 'HTML' && typeof raw === 'string') return { text: htmlToText(raw) }

  if (field.type === 'BLOB' && typeof raw === 'string') {
    const bytes = Math.floor(raw.replace(/=+$/, '').length * 3 / 4)
    const hint = options.tableName && !options.cell ? ` (qqq table download ${options.tableName} ${options.primaryKey ?? ''} ${field.name})`.replace('  ', ' ') : ''
    return { text: `<file, ${bytes} bytes>${hint}`, ...(findAdornment(field, 'FILE_UPLOAD') ? { adornment: 'FILE_UPLOAD' } : {}) }
  }

  const related = options.cell ? undefined : relatedRecordTarget(field, record, options.tableNames)
  if (related) return { text: `${str(value)} → ${related.tableName} ${related.primaryKey}`, link: related }

  return { text: str(value), ...(findAdornment(field, 'FILE_UPLOAD') ? { adornment: 'FILE_UPLOAD' } : {}) }
}

/** One section of the record view. */
export interface ViewSection {
  name: string
  label: string
  tier?: string
  help?: string
  fields: Array<{ field: FieldMeta; value: ValueText; help?: string }>
  /** A widget section (child list or other widget): rendered by the caller. */
  widgetName?: string
}

/**
 * The record view: sections in metadata order without hidden sections or hidden fields; fields
 * that no section lists come last under "Other Fields" unless they appear only in hidden sections.
 * Without sections, every visible non-heavy field.
 */
export function recordView(table: TableMetaLike, record: RecordLike, options: ValueOptions & { helpContent?: boolean } = {}): ViewSection[] {
  const fields = table.fields
  const sections = (table.sections ?? []) as SectionMeta[]
  const placed = new Set<string>()
  const out: ViewSection[] = []
  const pk = table.primaryKeyField ?? 'id'
  const entry = (name: string) => {
    const field = fields[name]!
    const help = options.helpContent ? helpEntryText(selectHelpContent(field.helpContents)) : ''
    return { field, value: valueText(field, record, { ...options, tableName: options.tableName ?? table.name, primaryKey: options.primaryKey ?? str(record.values[pk]) }), ...(help ? { help } : {}) }
  }
  for (const section of sections) {
    for (const name of section.fieldNames ?? []) placed.add(name)
    if (section.isHidden) continue
    const help = options.helpContent ? helpEntryText(selectHelpContent(section.helpContents)) : ''
    const names = (section.fieldNames ?? []).filter((n) => fields[n] && !fields[n]!.isHidden)
    if (!names.length && !section.widgetName) continue
    out.push({ name: section.name, label: section.label ?? section.name, ...(section.tier ? { tier: section.tier } : {}), ...(help ? { help } : {}), fields: names.map(entry), ...(section.widgetName ? { widgetName: section.widgetName } : {}) })
  }
  const rest = Object.keys(fields).filter((n) => !placed.has(n) && !fields[n]!.isHidden && (!sections.length ? !fields[n]!.isHeavy || record.values[n] !== undefined : true))
  if (rest.length) {
    const ordered = rest.includes(pk) ? [pk, ...rest.filter((n) => n !== pk)] : rest
    out.push({ name: sections.length ? 'otherFields' : 'fields', label: sections.length ? 'Other Fields' : 'Fields', fields: ordered.map(entry) })
  }
  return out
}
