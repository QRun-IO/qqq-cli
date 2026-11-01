/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The SQL Runner's editor model, free of drawing: a multi-line buffer driven by key events,
 * statement splitting (the statement under the cursor), `:name` parameters, a tokenizer for the
 * syntax tint, completion of table and column names from the schema endpoint, the SQL position of
 * a server error, the run history, and notebook cells. Tests drive all of it without a terminal.
 */

import { History } from '@qrun-io/qqq-core'
import { isPrintable, type Key } from '../keys'

// ---- the buffer ----

/** A multi-line text buffer with a cursor (row, col), driven by key events. */
export class SqlBuffer {
  lines: string[]
  row = 0
  col = 0
  /** First visible line and column (kept by the view so the cursor stays visible). */
  top = 0
  left = 0

  constructor(text = '') {
    this.lines = text.split(/\r\n|\r|\n/)
    this.end()
  }

  get text(): string {
    return this.lines.join('\n')
  }

  /** Replaces the text; the cursor goes to the end. */
  set(text: string): void {
    this.lines = text.split(/\r\n|\r|\n/)
    this.top = 0
    this.left = 0
    this.end()
  }

  /** Cursor to the end of the text. */
  end(): void {
    this.row = this.lines.length - 1
    this.col = this.lines[this.row]!.length
  }

  get line(): string {
    return this.lines[this.row] ?? ''
  }

  /** The cursor as a character offset into `text`. */
  offset(): number {
    let n = 0
    for (let i = 0; i < this.row; i++) n += this.lines[i]!.length + 1
    return n + this.col
  }

  /** Moves the cursor to a character offset. */
  setOffset(offset: number): void {
    let rest = Math.max(0, Math.min(offset, this.text.length))
    for (let i = 0; i < this.lines.length; i++) {
      const len = this.lines[i]!.length
      if (rest <= len) {
        this.row = i
        this.col = rest
        return
      }
      rest -= len + 1
    }
    this.end()
  }

  /** Inserts text at the cursor (line breaks split lines; tabs become two spaces). */
  insert(text: string): void {
    const clean = text.replace(/\r\n|\r/g, '\n').replace(/\t/g, '  ')
    const parts = clean.split('\n')
    const before = this.line.slice(0, this.col)
    const after = this.line.slice(this.col)
    if (parts.length === 1) {
      this.lines[this.row] = before + clean + after
      this.col += clean.length
      return
    }
    const middle = parts.slice(1, -1)
    const last = parts[parts.length - 1]!
    this.lines.splice(this.row, 1, before + parts[0], ...middle, last + after)
    this.row += parts.length - 1
    this.col = last.length
  }

  /** A line break that keeps the indent of the current line. */
  newline(): void {
    const indent = /^\s*/.exec(this.line)![0].slice(0, this.col)
    this.insert('\n' + indent)
  }

  backspace(): void {
    if (this.col > 0) {
      // in leading whitespace, remove back to the previous two-space stop
      const lead = /^ */.exec(this.line)![0].length
      const n = this.col <= lead && this.col >= 2 ? (this.col % 2 === 0 ? 2 : 1) : 1
      this.lines[this.row] = this.line.slice(0, this.col - n) + this.line.slice(this.col)
      this.col -= n
    } else if (this.row > 0) {
      const prev = this.lines[this.row - 1]!
      this.lines.splice(this.row - 1, 2, prev + this.line)
      this.row--
      this.col = prev.length
    }
  }

  del(): void {
    if (this.col < this.line.length) this.lines[this.row] = this.line.slice(0, this.col) + this.line.slice(this.col + 1)
    else if (this.row < this.lines.length - 1) this.lines.splice(this.row, 2, this.line + this.lines[this.row + 1])
  }

  move(dRow: number): void {
    this.row = Math.max(0, Math.min(this.lines.length - 1, this.row + dRow))
    this.col = Math.min(this.col, this.line.length)
  }

  /** The identifier (with an optional `qualifier.`) that ends at the cursor. */
  wordBefore(): { qualifier?: string; prefix: string; from: number } {
    const before = this.line.slice(0, this.col)
    const m = /(?:([A-Za-z_][\w$]*|"[^"]+")\.)?([A-Za-z_][\w$]*|"[^"]*)?$/.exec(before)!
    const prefix = m[2] ?? ''
    const qualifier = m[1]?.replace(/"/g, '')
    return { qualifier, prefix, from: this.offset() - prefix.length }
  }

  /** Replaces `length` characters before the cursor with text. */
  replaceBefore(length: number, text: string): void {
    const at = this.offset()
    const all = this.text
    const next = all.slice(0, at - length) + text + all.slice(at)
    const top = this.top
    this.lines = next.split('\n')
    this.top = top
    this.setOffset(at - length + text.length)
  }

  /** Handles an editing or movement key; returns whether it was one. Enter is the caller's. */
  handle(key: Key, pageLines = 10): boolean {
    if (key.ctrl && !key.meta) {
      switch (key.name) {
        case 'a': this.col = 0; return true
        case 'e': this.col = this.line.length; return true
        case 'u': this.lines[this.row] = this.line.slice(this.col); this.col = 0; return true
        case 'w': {
          const before = this.line.slice(0, this.col).replace(/\S+\s*$/, '')
          this.lines[this.row] = before + this.line.slice(this.col)
          this.col = before.length
          return true
        }
        case 'home': this.row = 0; this.col = 0; return true
        case 'end': this.end(); return true
        case 'left': {
          const before = this.line.slice(0, this.col).replace(/\w+\W*$|\W+$/, '')
          this.col = before.length
          return true
        }
        case 'right': {
          const m = /^\W*\w+|^\W+/.exec(this.line.slice(this.col))
          this.col += m ? m[0].length : 0
          return true
        }
        default: return false
      }
    }
    switch (key.name) {
      case 'backspace': this.backspace(); return true
      case 'delete': this.del(); return true
      case 'left':
        if (this.col > 0) this.col--
        else if (this.row > 0) { this.row--; this.col = this.line.length }
        return true
      case 'right':
        if (this.col < this.line.length) this.col++
        else if (this.row < this.lines.length - 1) { this.row++; this.col = 0 }
        return true
      case 'up': this.move(-1); return true
      case 'down': this.move(1); return true
      case 'home': {
        const lead = /^\s*/.exec(this.line)![0].length
        this.col = this.col === lead ? 0 : lead
        return true
      }
      case 'end': this.col = this.line.length; return true
      case 'pageup': this.move(-pageLines); return true
      case 'pagedown': this.move(pageLines); return true
      default:
        if (isPrintable(key) && !key.meta) {
          this.insert(key.sequence)
          return true
        }
        return false
    }
  }

  /** Scrolls so the cursor is inside a view of `height` lines and `width` columns. */
  scrollTo(height: number, width: number): void {
    if (this.row < this.top) this.top = this.row
    if (this.row >= this.top + height) this.top = this.row - height + 1
    this.top = Math.max(0, Math.min(this.top, Math.max(0, this.lines.length - 1)))
    if (this.col < this.left) this.left = this.col
    if (this.col >= this.left + width) this.left = this.col - width + 1
  }
}

// ---- scanning: statements, parameters, tokens ----

export type TokenKind = 'keyword' | 'string' | 'quoted' | 'number' | 'comment' | 'param' | 'ident' | 'punct' | 'space'

export interface Token {
  kind: TokenKind
  text: string
  start: number
}

/** SQL keywords tinted in the editor (servers add theirs through the schema endpoint). */
export const SQL_KEYWORDS = new Set(('SELECT FROM WHERE AND OR NOT IN IS NULL LIKE ILIKE BETWEEN EXISTS AS ON JOIN INNER LEFT RIGHT FULL OUTER CROSS NATURAL USING ' +
  'GROUP BY ORDER HAVING LIMIT OFFSET FETCH FIRST NEXT ROWS ROW ONLY UNION ALL INTERSECT EXCEPT MINUS DISTINCT CASE WHEN THEN ELSE END ' +
  'WITH RECURSIVE VALUES INSERT INTO UPDATE SET DELETE MERGE CREATE ALTER DROP TABLE VIEW INDEX ASC DESC NULLS LAST TRUE FALSE ' +
  'COUNT SUM AVG MIN MAX CAST COALESCE NULLIF EXPLAIN ANALYZE SHOW OVER PARTITION WINDOW FILTER LATERAL TOP ANY SOME').split(' '))

/**
 * Tokenizes SQL with the backend scanner's rules: `--` and `/* *\/` comments, '…' strings, "…" and
 * `…` quoted identifiers, $tag$ dollar quotes, `::` casts, `:name` parameters, numbers, words.
 */
export function tokenize(sql: string, keywords: Set<string> = SQL_KEYWORDS): Token[] {
  const out: Token[] = []
  const n = sql.length
  let i = 0
  const push = (kind: TokenKind, end: number) => {
    out.push({ kind, text: sql.slice(i, end), start: i })
    i = end
  }
  while (i < n) {
    const c = sql[i]!
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i)
      push('comment', end < 0 ? n : end)
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      push('comment', end < 0 ? n : end + 2)
    } else if (c === "'" || c === '"' || c === '`') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === c && sql[j + 1] === c) j += 2
        else if (sql[j] === c) break
        else j++
      }
      push(c === "'" ? 'string' : 'quoted', Math.min(n, j + 1))
    } else if (c === '$' && /^\$([A-Za-z_]\w*)?\$/.test(sql.slice(i))) {
      const tag = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i))![0]
      const end = sql.indexOf(tag, i + tag.length)
      push('string', end < 0 ? n : end + tag.length)
    } else if (c === ':' && next === ':') {
      push('punct', i + 2)
    } else if (c === ':' && next !== undefined && /[A-Za-z_]/.test(next) && sql[i - 1] !== ':') {
      let j = i + 1
      while (j < n && /\w/.test(sql[j]!)) j++
      push('param', j)
    } else if (/\s/.test(c)) {
      let j = i + 1
      while (j < n && /\s/.test(sql[j]!)) j++
      push('space', j)
    } else if (/[0-9]/.test(c) || (c === '.' && next !== undefined && /[0-9]/.test(next) && !/[\w)]/.test(sql[i - 1] ?? ''))) {
      const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(sql.slice(i))!
      push('number', i + m[0].length)
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < n && /[\w$]/.test(sql[j]!)) j++
      push(keywords.has(sql.slice(i, j).toUpperCase()) ? 'keyword' : 'ident', j)
    } else {
      push('punct', i + 1)
    }
  }
  return out
}

/** Splits tokens into display lines: tokens that cross a line break (comments, strings) are cut. */
export function tokenLines(sql: string, keywords?: Set<string>): Token[][] {
  const lines: Token[][] = [[]]
  for (const t of tokenize(sql, keywords)) {
    const parts = t.text.split('\n')
    let start = t.start
    parts.forEach((p, i) => {
      if (i > 0) lines.push([])
      if (p) lines[lines.length - 1]!.push({ kind: t.kind, text: p, start })
      start += p.length + 1
    })
  }
  return lines
}

export interface Statement {
  start: number
  end: number
  text: string
}

/** The statements of a text, split at `;` outside strings, quoted names and comments (blank ones dropped). */
export function splitStatements(sql: string): Statement[] {
  const out: Statement[] = []
  let start = 0
  const flush = (end: number) => {
    const raw = sql.slice(start, end)
    const lead = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (text && tokenize(text).some((t) => t.kind !== 'comment' && t.kind !== 'space')) out.push({ start: start + lead, end: start + lead + text.length, text })
  }
  for (const t of tokenize(sql)) {
    if (t.kind === 'punct' && t.text === ';') {
      flush(t.start)
      start = t.start + 1
    }
  }
  flush(sql.length)
  return out
}

/**
 * The statement to run for a cursor offset: the one containing it, else the one that ended just
 * before it (the cursor after `;`), else the next one; undefined for a blank text.
 */
export function statementAt(sql: string, offset: number): Statement | undefined {
  const all = splitStatements(sql)
  if (all.length <= 1) return all[0]
  const inside = all.find((s) => offset >= s.start && offset <= s.end)
  if (inside) return inside
  const before = [...all].reverse().find((s) => s.end <= offset)
  return before ?? all[0]
}

/** The `:name` parameters of SQL in order of first appearance (the server's scanner rules). */
export function extractParameters(sql: string): string[] {
  const seen: string[] = []
  for (const t of tokenize(sql)) if (t.kind === 'param' && !seen.includes(t.text.slice(1))) seen.push(t.text.slice(1))
  return seen
}

/** A parameter value as the server binds it: numbers and booleans for typed parameters, else text; '' is null. */
export function coerceParameter(raw: string | undefined, type?: string): string | number | boolean | null {
  if (raw === undefined || raw === '') return null
  if (type === 'INTEGER' || type === 'DECIMAL') {
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  }
  if (type === 'BOOLEAN') return /^(true|1|yes|y)$/i.test(raw.trim())
  return raw
}

// ---- completion ----

/** The parts of GET /sql-workbench/schema/{backend} the runner reads. */
export interface SqlSchema {
  backendName?: string
  dialect?: string
  schemas?: Array<{ name: string; tables?: Array<{ name: string; type?: string; columns?: Array<{ name: string; typeName?: string; nullable?: boolean }> }> }>
  qqqTables?: Array<{ name: string; label?: string; sqlName?: string; fields?: Array<{ name: string; label?: string; sqlName?: string; type?: string }> }>
  keywords?: string[]
  functions?: string[]
  truncated?: boolean
}

/** Every keyword word the schema endpoint lists, plus the built-in ones. */
export function keywordSet(schema?: SqlSchema): Set<string> {
  const set = new Set(SQL_KEYWORDS)
  for (const k of schema?.keywords ?? []) for (const w of k.split(/\s+/)) if (/^[A-Za-z_]+$/.test(w)) set.add(w.toUpperCase())
  return set
}

/** The tables of a schema document: name, schema, columns. */
export function schemaTables(schema?: SqlSchema): Array<{ name: string; schema: string; columns: Array<{ name: string; typeName?: string }> }> {
  return (schema?.schemas ?? []).flatMap((s) => (s.tables ?? []).map((t) => ({ name: t.name, schema: s.name, columns: t.columns ?? [] })))
}

/** Tables named after FROM / JOIN / UPDATE / INTO in a statement, with their aliases (upper-cased keys). */
export function referencedTables(sql: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /\b(?:FROM|JOIN|UPDATE|INTO)\s+((?:"[^"]+"|[\w$]+)(?:\.(?:"[^"]+"|[\w$]+))?)(?:\s+(?:AS\s+)?([A-Za-z_][\w$]*))?/gi
  for (let m = re.exec(sql); m; m = re.exec(sql)) {
    const table = m[1]!.replace(/"/g, '').split('.').pop()!
    out.set(table.toUpperCase(), table)
    const alias = m[2]
    if (alias && !SQL_KEYWORDS.has(alias.toUpperCase())) out.set(alias.toUpperCase(), table)
  }
  return out
}

export interface Completion {
  /** Offset where the replaced word starts. */
  from: number
  prefix: string
  candidates: string[]
}

/**
 * Completion at a cursor: after `alias.` the columns of that table; otherwise columns of the tables
 * the statement names, then table names (database names and QQQ tables' SQL names), then keywords.
 * Case-insensitive prefix match; keywords follow the case the user typed.
 */
export function complete(sql: string, offset: number, schema?: SqlSchema): Completion {
  const before = sql.slice(0, offset)
  const m = /(?:([A-Za-z_][\w$]*|"[^"]+")\.)?([A-Za-z_][\w$]*)?$/.exec(before)!
  const prefix = m[2] ?? ''
  const from = offset - prefix.length
  const qualifier = m[1]?.replace(/"/g, '')
  const statement = statementAt(sql, offset)?.text ?? sql
  const tables = schemaTables(schema)
  const byName = new Map(tables.map((t) => [t.name.toUpperCase(), t]))
  const refs = referencedTables(statement)
  const columnsOf = (name: string) => byName.get((refs.get(name.toUpperCase()) ?? name).toUpperCase())?.columns.map((c) => c.name) ?? []
  const up = prefix.toUpperCase()
  const match = (list: string[]) => list.filter((c) => c.toUpperCase().startsWith(up) && c.toUpperCase() !== up)
  if (qualifier) return { from, prefix, candidates: [...new Set(match(columnsOf(qualifier)))] }
  if (!prefix) return { from, prefix, candidates: [] }
  const columns = [...new Set([...refs.values()].flatMap((t) => columnsOf(t)))]
  const names = [...tables.map((t) => t.name), ...(schema?.qqqTables ?? []).map((t) => t.sqlName ?? t.name)]
  const lower = prefix === prefix.toLowerCase()
  const keywords = [...keywordSet(schema)].map((k) => (lower ? k.toLowerCase() : k))
  const functions = (schema?.functions ?? []).filter((f) => /^[A-Za-z_]\w*$/.test(f))
  const seen = new Set<string>()
  const unique = [...match(columns).sort(), ...match(names).sort(), ...match(keywords).sort(), ...match(functions).sort()].filter((c) => !seen.has(c.toUpperCase()) && Boolean(seen.add(c.toUpperCase())))
  return { from, prefix, candidates: unique }
}

/** The longest common prefix of candidates, ignoring case (taken from the first). */
export function commonPrefix(candidates: string[]): string {
  if (!candidates.length) return ''
  let p = candidates[0]!
  for (const c of candidates.slice(1)) {
    let i = 0
    while (i < p.length && i < c.length && p[i]!.toUpperCase() === c[i]!.toUpperCase()) i++
    p = p.slice(0, i)
  }
  return p
}

// ---- errors ----

export interface SqlPosition {
  /** Character offset into the statement text (when the server says where). */
  offset?: number
  line: number
  col?: number
}

/** Line and column (1-based) of an offset in a text. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  return { line, col: offset - before.lastIndexOf('\n') }
}

/**
 * Where in the statement a database error points, when its message says: H2's `[*]` marker inside
 * the quoted statement, PostgreSQL's `Position: N`, `line N, column M`, or MySQL's `at line N`.
 */
export function errorPosition(message: string, sql: string): SqlPosition | undefined {
  const h2 = /"((?:[^"]|"")*\[\*\](?:[^"]|"")*)"/.exec(message)
  if (h2) {
    const quoted = h2[1]!.replace(/""/g, '"')
    const at = quoted.indexOf('[*]')
    const whole = quoted.replace('[*]', '')
    let offset: number | undefined
    const idx = sql.indexOf(whole)
    if (idx >= 0) offset = idx + at
    else if (whole.endsWith(sql)) offset = at - (whole.length - sql.length)
    else {
      // a prefix the server added (EXPLAIN …): match the text after the marker
      const tail = whole.slice(at)
      const t = tail ? sql.lastIndexOf(tail) : sql.length
      if (t >= 0) offset = t
    }
    if (offset !== undefined && offset >= 0 && offset <= sql.length) return { offset, ...lineCol(sql, offset) }
  }
  const pg = /\bPosition: (\d+)/i.exec(message)
  if (pg) {
    const offset = Math.min(sql.length, Math.max(0, Number(pg[1]) - 1))
    return { offset, ...lineCol(sql, offset) }
  }
  const lc = /\bline (\d+),? col(?:umn)? (\d+)/i.exec(message)
  if (lc) return { line: Number(lc[1]), col: Number(lc[2]) }
  const my = /\bat line (\d+)/i.exec(message)
  if (my) return { line: Number(my[1]) }
  return undefined
}

// ---- history ----

/**
 * The SQL run history for Ctrl+↑↓: every statement that was run, newest first, kept on disk by the
 * kernel's History (one JSON string per line, so multi-line SQL survives).
 */
export class SqlHistory {
  private readonly store: { entries(): string[]; add(line: string): void }
  /** -1: the draft (what was in the editor before browsing). */
  index = -1
  draft = ''

  constructor(store?: { entries(): string[]; add(line: string): void }) {
    this.store = store ?? new History('sql')
  }

  entries(): string[] {
    return this.store.entries().map((l) => {
      try {
        const v = JSON.parse(l) as unknown
        return typeof v === 'string' ? v : l
      } catch {
        return l
      }
    })
  }

  add(sql: string): void {
    const text = sql.trim()
    if (text) this.store.add(JSON.stringify(text))
    this.index = -1
  }

  /** Older (dir 1) or newer (dir -1) entry; returns the text to show, or undefined at the end. */
  step(dir: 1 | -1, current: string): string | undefined {
    const list = this.entries()
    if (this.index === -1 && dir === 1) this.draft = current
    const next = this.index + dir
    if (next < -1 || next >= list.length) return undefined
    this.index = next
    return next === -1 ? this.draft : list[next]
  }

  reset(): void {
    this.index = -1
  }
}

// ---- notebooks ----

export interface NotebookCell {
  cellKey: string
  cellType: 'SQL' | 'MARKDOWN'
  title?: string | null
  content: string
  backendName?: string | null
  sortOrder?: number
}

export interface NotebookParameter {
  name: string
  type?: string
  defaultValue?: string | null
  label?: string | null
}

export interface Notebook {
  id?: number
  title: string
  description?: string | null
  visibility?: string
  ownerName?: string | null
  defaultBackendName?: string | null
  parameters?: NotebookParameter[]
  currentVersion?: number
  canEdit?: boolean
  cells: NotebookCell[]
}

export function newCellKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `cell-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

/** A notebook that is not saved yet: one SQL cell. */
export function scratchNotebook(sql = ''): Notebook {
  return { title: 'Untitled', canEdit: true, cells: [{ cellKey: newCellKey(), cellType: 'SQL', content: sql, title: null, backendName: null }] }
}

/** Every parameter a notebook's SQL cells use, with the declared ones first. */
export function notebookParameters(notebook: Notebook): string[] {
  const names = (notebook.parameters ?? []).map((p) => p.name)
  for (const c of notebook.cells) if (c.cellType === 'SQL') for (const n of extractParameters(c.content)) if (!names.includes(n)) names.push(n)
  return names
}

/** The body of POST/PUT /notebooks for a notebook and the current parameter values. */
export function notebookRequest(notebook: Notebook, values: Record<string, string>, comment?: string): Record<string, unknown> {
  return {
    title: notebook.title.trim() || 'Untitled notebook',
    description: notebook.description ?? null,
    defaultBackendName: notebook.defaultBackendName ?? null,
    parameters: notebookParameters(notebook).map((name) => {
      const declared = notebook.parameters?.find((p) => p.name === name)
      return { name, type: declared?.type ?? 'STRING', defaultValue: values[name] ?? declared?.defaultValue ?? null, label: declared?.label ?? null }
    }),
    cells: notebook.cells.map((c, i) => ({ cellKey: c.cellKey, cellType: c.cellType, title: c.title ?? null, content: c.content, backendName: c.backendName ?? null, sortOrder: i })),
    ...(comment ? { comment } : {}),
  }
}

/** Moves a cell by `delta` places; returns its new index. */
export function moveCell(cells: NotebookCell[], index: number, delta: number): number {
  const to = Math.max(0, Math.min(cells.length - 1, index + delta))
  if (to === index) return index
  const [cell] = cells.splice(index, 1)
  cells.splice(to, 0, cell!)
  return to
}

/** The one-line summary of a cell for lists: its title, else its first non-blank line. */
export function cellSummary(cell: NotebookCell): string {
  if (cell.title?.trim()) return cell.title.trim()
  const first = cell.content.split('\n').map((l) => (cell.cellType === 'MARKDOWN' ? l.replace(/^\s*(#{1,6}|[-*+>])\s+/, '') : l).trim()).find((l) => l) ?? ''
  return first || (cell.cellType === 'SQL' ? '(empty SQL)' : '(empty notes)')
}

/** Markdown as plain text lines for the terminal: headings, bullets, quotes and code kept; inline marks dropped. */
export function markdownLines(markdown: string): Array<{ text: string; style: 'heading' | 'code' | 'quote' | 'text' }> {
  const out: Array<{ text: string; style: 'heading' | 'code' | 'quote' | 'text' }> = []
  let code = false
  const inline = (s: string) => s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(\*|_)(\S.*?)\1/g, '$2').replace(/`([^`]+)`/g, '$1')
  for (const raw of markdown.split('\n')) {
    if (/^\s*```/.test(raw)) {
      code = !code
      continue
    }
    if (code) {
      out.push({ text: `  ${raw}`, style: 'code' })
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(raw)
    if (h) out.push({ text: inline(h[2]!), style: 'heading' })
    else if (/^\s*[-*+]\s+/.test(raw)) out.push({ text: raw.replace(/^(\s*)[-*+]\s+/, '$1• ').replace(/^(\s*• )(.*)$/, (_m, a: string, b: string) => a + inline(b)), style: 'text' })
    else if (/^\s*>/.test(raw)) out.push({ text: `│ ${inline(raw.replace(/^\s*>\s?/, ''))}`, style: 'quote' })
    else if (/^\s*([-*_])\1\1+\s*$/.test(raw)) out.push({ text: '─'.repeat(20), style: 'text' })
    else out.push({ text: inline(raw), style: 'text' })
  }
  return out
}
