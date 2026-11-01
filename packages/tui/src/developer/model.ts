/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The developer view's section model (docs/developer-view.md): sections of width-independent items
 * built from the server's developer panels, the ESB table section, the table metadata and the
 * record; the mapping of web links to TUI destinations; and the section bar's navigation. Pure: the
 * screens draw items and turn targets into actions.
 */

import type { DeveloperPanel } from '@qrun-io/qqq-core'

type J = Record<string, unknown>

export type ItemTone = 'fg' | 'dim' | 'acc' | 'acc2' | 'ok' | 'warn' | 'err'

/** Where a link of the web UI goes in the TUI; `browser` when there is no TUI screen for it. */
export type LinkTarget =
  | { kind: 'table-developer'; table: string }
  | { kind: 'record-developer'; table: string; primaryKey: string }
  | { kind: 'record'; table: string; primaryKey: string }
  | { kind: 'table'; table: string }
  | { kind: 'process'; process: string; recordId?: string }
  | { kind: 'browser'; url: string }

export interface Pair {
  label: string
  value: string
  target?: LinkTarget
}

export interface GridRow {
  cells: string[]
  /** What Enter does on the row. */
  run?: () => void
  /** The row's raw value, for `v` (viewer) and `y` (copy). */
  value?: unknown
}

export type Item =
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string; tone?: ItemTone }
  | { kind: 'pairs'; pairs: Pair[] }
  | { kind: 'grid'; headers: string[]; rows: GridRow[]; note?: string; empty?: string; title?: string }
  | { kind: 'code'; label: string; language?: string; code?: string; value?: unknown }
  | { kind: 'link'; label: string; target: LinkTarget; description?: string }
  | { kind: 'action'; label: string; detail?: string; run: () => void }
  | { kind: 'empty'; text: string }

export interface Section {
  id: string
  /** The name in the section bar. */
  label: string
  /** The heading over the body. */
  title: string
  status?: string
  statusTone?: ItemTone
  description?: string
  items: Item[]
  loading?: boolean
}

/** What the link mapping knows about the server: its address and which names are tables or processes. */
export interface LinkContext {
  server: string
  tables: Record<string, unknown>
  processes?: Record<string, unknown>
}

/** A server-relative web path as an absolute URL on the server. */
export function webUrl(server: string, href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return href
  return `${server.replace(/\/+$/, '')}/${href.replace(/^\/+/, '')}`
}

/**
 * Maps a web UI link to a TUI destination: `/app/{table}/dev` the table developer view,
 * `/app/{table}/{id}/dev` the record developer view, `/app/{table}/{id}` the record, `/app/{table}`
 * the grid, `/app/{process}` the process; anything else (the ESB overview, the SQL workbench, other
 * sites) is browser only.
 */
export function linkTarget(href: string, ctx: LinkContext): LinkTarget {
  const browser: LinkTarget = { kind: 'browser', url: webUrl(ctx.server, href) }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return browser
  const path = href.split(/[?#]/)[0]!
  const parts = path.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p) } catch { return p } })
  if (parts[0] !== 'app' || parts.length < 2) return browser
  const [, name, second, third] = parts as [string, string, string?, string?]
  if (Object.hasOwn(ctx.tables, name)) {
    if (parts.length === 2) return { kind: 'table', table: name }
    if (parts.length === 3 && second === 'dev') return { kind: 'table-developer', table: name }
    if (parts.length === 3) return { kind: 'record', table: name, primaryKey: second! }
    if (parts.length === 4 && third === 'dev') return { kind: 'record-developer', table: name, primaryKey: second! }
    return browser
  }
  if (parts.length === 2 && ctx.processes && Object.hasOwn(ctx.processes, name)) return { kind: 'process', process: name }
  return browser
}

/** A short description of where a target goes, for the line beside a link. */
export function targetText(target: LinkTarget): string {
  switch (target.kind) {
    case 'table-developer': return `table developer view · ${target.table}`
    case 'record-developer': return `record developer view · ${target.table} ${target.primaryKey}`
    case 'record': return `record · ${target.table} ${target.primaryKey}`
    case 'table': return `grid · ${target.table}`
    case 'process': return `process · ${target.process}`
    case 'browser': return target.url
  }
}

const TONES: Record<string, ItemTone> = { INFO: 'fg', SUCCESS: 'ok', WARNING: 'warn', ERROR: 'err' }

/** A panel status tone as an item tone (INFO stays the normal colour). */
export function toneOf(tone: unknown): ItemTone | undefined {
  return typeof tone === 'string' ? TONES[tone.toUpperCase()] : undefined
}

/** Why a column of a developer-panel table can be empty everywhere, by its header. */
const EMPTY_COLUMN_REASONS: Record<string, string> = {
  Queued: 'the broker did not report a queue depth (its management API is off, or the destination is a topic)',
  'Dead letters': 'the broker did not report a dead-letter queue depth (its management API is off)',
}

/** One dim line explaining the columns that are empty in every row (`—`), or undefined when none is. */
export function emptyColumnsNote(headers: string[], rows: string[][]): string | undefined {
  if (!rows.length) return undefined
  const empty = headers.filter((_, i) => rows.every((r) => (r[i] ?? '').trim() === ''))
  if (!empty.length) return undefined
  const reasons = empty.map((h) => EMPTY_COLUMN_REASONS[h] ? `${h}: ${EMPTY_COLUMN_REASONS[h]}` : undefined).filter(Boolean)
  return reasons.length === empty.length ? `— ${reasons.join('; ')}.` : `— ${empty.join(', ')}: the server reported no value.`
}

/** A developer panel's blocks as items (TEXT, KEY_VALUES, TABLE, CODE, LINKS, ACTIONS; others shown raw). */
export function panelItems(panel: DeveloperPanel, ctx: LinkContext, recordId?: string): Item[] {
  const items: Item[] = []
  if (panel.error) items.push({ kind: 'text', text: panel.error, tone: 'err' })
  for (const block of panel.blocks) {
    const label = typeof block.label === 'string' && block.label ? block.label : undefined
    switch (block.type) {
      case 'TEXT': {
        if (label) items.push({ kind: 'heading', text: label })
        items.push({ kind: 'text', text: String(block.text ?? ''), tone: toneOf(block.tone) ?? 'fg' })
        break
      }
      case 'KEY_VALUES':
        if (label) items.push({ kind: 'heading', text: label })
        items.push({ kind: 'pairs', pairs: ((block.items ?? []) as J[]).map((i) => ({ label: String(i.label ?? ''), value: String(i.value ?? ''), ...(typeof i.href === 'string' && i.href ? { target: linkTarget(i.href, ctx) } : {}) })) })
        break
      case 'TABLE': {
        const headers = ((block.columns ?? []) as unknown[]).map(String)
        const rows = ((block.rows ?? []) as unknown[][]).map((row) => headers.map((_, i) => { const v = row?.[i]; return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v) }))
        if (label) items.push({ kind: 'heading', text: label })
        const note = emptyColumnsNote(headers, rows)
        items.push({ kind: 'grid', headers, rows: rows.map((cells) => ({ cells, value: Object.fromEntries(headers.map((h, i) => [h, cells[i]])) })), empty: 'No rows.', ...(label ? { title: label } : {}), ...(note ? { note } : {}) })
        break
      }
      case 'CODE':
        items.push({ kind: 'code', label: label ?? 'Code', ...(typeof block.language === 'string' ? { language: block.language } : {}), code: String(block.code ?? '') })
        break
      case 'LINKS':
        if (label) items.push({ kind: 'heading', text: label })
        for (const link of (block.links ?? []) as J[]) items.push({ kind: 'link', label: String(link.label ?? link.href ?? ''), target: linkTarget(String(link.href ?? ''), ctx), ...(typeof link.description === 'string' ? { description: link.description } : {}) })
        break
      case 'ACTIONS':
        if (label) items.push({ kind: 'heading', text: label })
        for (const a of (block.actions ?? []) as J[]) {
          const process = String(a.processName ?? '')
          items.push({ kind: 'link', label: String(a.label ?? process), target: { kind: 'process', process, ...(a.includeRecordId && recordId !== undefined ? { recordId } : {}) }, ...(typeof a.description === 'string' ? { description: a.description } : {}) })
        }
        break
      default:
        items.push({ kind: 'code', label: `${label ?? String(block.type ?? 'Block')} (${String(block.type ?? 'block')}: no terminal rendering; shown as data)`, value: block })
    }
  }
  if (!items.length) items.push({ kind: 'empty', text: 'This panel has nothing to show.' })
  return items
}

/** A developer panel as a section. */
export function panelSection(panel: DeveloperPanel, ctx: LinkContext, options: { id?: string; label?: string; recordId?: string } = {}): Section {
  return {
    id: options.id ?? `panel:${panel.id}`,
    label: options.label ?? panel.title,
    title: panel.title,
    ...(panel.statusLabel ? { status: panel.statusLabel } : {}),
    ...(toneOf(panel.statusTone) ? { statusTone: toneOf(panel.statusTone)! } : {}),
    ...(panel.description ? { description: panel.description } : {}),
    items: panelItems(panel, ctx, options.recordId),
  }
}

/** A section with one dim line saying why it is empty. */
export function emptySection(id: string, label: string, title: string, why: string, description?: string): Section {
  return { id, label, title, items: [{ kind: 'empty', text: why }], ...(description ? { description } : {}) }
}

/** A section still loading. */
export function loadingSection(id: string, label: string, title: string): Section {
  return { id, label, title, loading: true, items: [{ kind: 'empty', text: 'loading…' }] }
}

function yesNo(v: unknown): string {
  return v === true ? 'yes' : v === false ? 'no' : ''
}

interface FieldMetaLike { name?: string; label?: string; type?: string; isRequired?: boolean; isHidden?: boolean; isHeavy?: boolean; isEditable?: boolean; possibleValueSourceName?: string | null; backendName?: string | null }

/** A table's metadata as items: summary, fields and sections. */
export function metadataItems(meta: J): Item[] {
  const fields = Object.entries((meta.fields ?? {}) as Record<string, FieldMetaLike>)
  const sections = (meta.sections ?? []) as Array<{ name?: string; label?: string; tier?: string; fieldNames?: string[]; hidden?: boolean }>
  const permissions = ['read', 'insert', 'edit', 'delete'].filter((p) => meta[`${p}Permission`] === true)
  const capabilities = Array.isArray(meta.capabilities) ? (meta.capabilities as unknown[]).map(String) : []
  const features = Array.isArray(meta.recordFeatures) ? (meta.recordFeatures as unknown[]).map((f) => (typeof f === 'string' ? f : String((f as J).name ?? (f as J).type ?? JSON.stringify(f)))) : []
  const pairs: Pair[] = [
    { label: 'Name', value: String(meta.name ?? '') },
    { label: 'Label', value: String(meta.label ?? '') },
    { label: 'Primary key', value: String(meta.primaryKeyField ?? '') },
    { label: 'Fields', value: String(fields.length) },
    { label: 'Sections', value: String(sections.length) },
    { label: 'Permissions', value: permissions.join(', ') || 'none' },
    { label: 'Capabilities', value: capabilities.join(', ') },
    ...(features.length ? [{ label: 'Record features', value: features.join(', ') }] : []),
    ...(meta.backendName ? [{ label: 'Backend', value: String(meta.backendName) }] : []),
    ...(meta.usesVariants !== undefined ? [{ label: 'Uses variants', value: yesNo(meta.usesVariants) }] : []),
    ...(meta.hasRestrictedFields !== undefined ? [{ label: 'Restricted fields', value: yesNo(meta.hasRestrictedFields) }] : []),
  ]
  const flags = (f: FieldMetaLike) => [f.isHidden ? 'hidden' : '', f.isHeavy ? 'heavy' : '', f.isEditable === false ? 'read-only' : ''].filter(Boolean).join(', ')
  return [
    { kind: 'pairs', pairs },
    { kind: 'heading', text: 'Fields' },
    { kind: 'grid', title: 'Fields', headers: ['Name', 'Label', 'Type', 'Required', 'Possible values', 'Flags'], rows: fields.map(([name, f]) => ({ cells: [name, String(f.label ?? ''), String(f.type ?? ''), f.isRequired ? 'yes' : '', String(f.possibleValueSourceName ?? ''), flags(f)], value: f })), empty: 'The table has no fields.' },
    { kind: 'heading', text: 'Sections' },
    { kind: 'grid', title: 'Sections', headers: ['Name', 'Label', 'Tier', 'Fields'], rows: sections.map((s) => ({ cells: [String(s.name ?? ''), String(s.label ?? ''), String(s.tier ?? ''), (s.fieldNames ?? []).join(', ')], value: s })), empty: 'The table has no sections.' },
  ]
}

/** The ESB of a table (`GET /esb/table/{t}`) as items: publications and subscribers with their counters. */
export function esbTableItems(data: J, ctx: LinkContext, when: (iso: unknown) => string): Item[] {
  const publications = (data.publications ?? []) as J[]
  const subscribers = (data.subscribers ?? []) as J[]
  const counters = (o: J | undefined) => ((o?.counters ?? {}) as J)
  const count = (v: unknown) => (v === null || v === undefined ? '' : String(v))
  const items: Item[] = []
  if (!publications.length && !subscribers.length) {
    items.push({ kind: 'empty', text: 'This table does not publish to the ESB, and no process subscribes to its events.' })
  }
  if (publications.length) {
    items.push({ kind: 'heading', text: 'Published to' })
    const rows = publications.map((p) => {
      const d = (p.destination ?? {}) as J
      const c = counters(d)
      return { cells: [String(d.name ?? ''), String(d.type ?? ''), String(d.provider ?? ''), ((p.events ?? []) as unknown[]).join(', '), count(c.published), count(c.publishFailures), count(((d.queueInfo ?? {}) as J).messageCount)], value: { ...p, lastActivity: c.lastActivity ? when(c.lastActivity) : null } }
    })
    const headers = ['Destination', 'Type', 'Provider', 'Events', 'Published', 'Failures', 'Queued']
    const note = emptyColumnsNote(headers, rows.map((r) => r.cells))
    items.push({ kind: 'grid', title: 'Published to', headers, rows, ...(note ? { note } : {}) })
  }
  if (subscribers.length) {
    items.push({ kind: 'heading', text: 'Subscribers (triggers)' })
    const rows = subscribers.map((s) => {
      const c = counters(s)
      return { cells: [String(s.name ?? ''), String(s.processLabel ?? s.processName ?? ''), String(s.state ?? ''), count(c.consumed), count(c.failed), count(c.deadLettered), count(((s.deadLetter ?? {}) as J).messageCount)], value: { ...s, lastActivity: c.lastActivity ? when(c.lastActivity) : null } }
    })
    const headers = ['Trigger', 'Process', 'State', 'Consumed', 'Failed', 'Dead-lettered', 'Dead letters']
    const note = emptyColumnsNote(headers, rows.map((r) => r.cells))
    items.push({ kind: 'grid', title: 'Subscribers', headers, rows, ...(note ? { note } : {}) })
  }
  if (publications.length || subscribers.length) items.push({ kind: 'text', text: 'Enter or v on a row shows every counter (retries, timings, last activity) and the broker names.', tone: 'dim' })
  const errors = [...publications.map((p) => (p.destination ?? {}) as J), ...subscribers].map((o) => ({ name: String(o.name ?? ''), error: counters(o).lastError })).filter((e) => e.error)
  if (errors.length) {
    items.push({ kind: 'heading', text: 'Last errors' })
    for (const e of errors) items.push({ kind: 'text', text: `${e.name}: ${typeof e.error === 'string' ? e.error : JSON.stringify(e.error)}`, tone: 'err' })
  }
  items.push({ kind: 'heading', text: 'ESB tools' })
  items.push({ kind: 'link', label: 'ESB overview', target: linkTarget('/app/esb', ctx) })
  return items
}

/** The section bar's state: which section is active; ←→ move, 1-9 jump. */
export class SectionNav {
  index = 0

  constructor(public sections: Section[] = []) {}

  get current(): Section | undefined {
    return this.sections[this.index]
  }

  /** Replaces the sections, staying on the same section (by id) when it is still there. */
  set(sections: Section[]): void {
    const id = this.current?.id
    this.sections = sections
    const again = id ? sections.findIndex((s) => s.id === id) : -1
    this.index = again >= 0 ? again : Math.min(this.index, Math.max(0, sections.length - 1))
  }

  /** Goes to the section with this id; false when there is none. */
  select(id: string): boolean {
    const i = this.sections.findIndex((s) => s.id === id)
    if (i < 0) return false
    this.index = i
    return true
  }

  /** Handles ← → (wrapping) and the digits 1-9; returns whether the key was one of those. */
  onKey(name: string): boolean {
    const n = this.sections.length
    if (!n) return false
    if (name === 'left') this.index = (this.index - 1 + n) % n
    else if (name === 'right') this.index = (this.index + 1) % n
    else if (/^[1-9]$/.test(name) && Number(name) <= n) this.index = Number(name) - 1
    else return false
    return true
  }

  /** The keys that switch sections, for the key line: `1-7`. */
  digits(): string {
    const n = Math.min(9, this.sections.length)
    return n <= 1 ? '1' : `1-${n}`
  }
}
