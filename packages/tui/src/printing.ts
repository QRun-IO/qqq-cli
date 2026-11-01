/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Printing in the TUI (printing extension, qbit-printing 2.x), over the kernel's Printing module:
 *
 * - `openPrintDialog`: Print… on a record (or the grid's selection): the printer picker (printers
 *   that cannot take a record print are shown with the reason and cannot be picked; the printer
 *   used last on this profile is preselected and marked), then the jobs are queued and tracked.
 * - `PrintTracker`: follows queued jobs until each is final; the status line shows `print 1/2`
 *   while they run and a flash says how they ended.
 * - `openPrintJobs`: the recent print jobs (`:printjobs`, F9 › Work › Print jobs).
 *
 * Without the extension the actions are not offered; a typed command says it needs it.
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { canSaveAsPdf, downloadProcessFile, formatDateValue, profileNameForServer, readConfig, saveDownload, type ContentSection, type PrintChrome, type RenderRequest, exportFileName, FAILED_JOB_STATES, MAX_LIST_ROWS, Printing, canPrintLists, isFinalJobState, listScopeChoices, readRememberedPrinter, resolvePrinter, runProcess, tableHasPrint, whyNotPrintable, writeRememberedPrinter, type ListScope, type Printer, type PrintJob, type PrintOutcome, type ProcessMeta } from '@qrun-io/qqq-core'
import { ChoiceOverlay, type Choice } from './overlays/basic'
import type { AppStore } from './store'
import type { Screen } from './types'
import { errorText } from './util/text'
import { saveFile } from './overlays/files-helpers'
import { breadcrumbs } from './breadcrumbs'
import { dateSettingsFor } from './controls/date-settings'
import { CLI_VERSION } from '@qrun-io/qqq-cli/program'
import { history } from './history/record'

/** The printing module of the store's server, or undefined without a client or the extension. */
export function printingOf(store: AppStore): Printing | undefined {
  if (!store.client || !store.extensions.has('printing')) return undefined
  const client = store.client
  return new Printing(store.extensions.registry, {
    call: (id, input) => client.call(id, input),
    runProcess: async (processName, { values, recordIds }) => {
      const meta = await client.processMeta(processName) as unknown as ProcessMeta
      return (await runProcess({ baseUrl: client.server, fetch: client.fetch, meta, values, records: recordIds.length ? { ids: recordIds } : undefined, stepTimeoutMillis: 60000 })).values
    },
    download: (reference) => downloadProcessFile(client.server, client.fetch, reference),
  })
}

/** Whether Print is offered on a table here (extension installed and the table has the Print process). */
export function canPrintTable(store: AppStore, table: string): boolean {
  return Boolean(store.client) && store.extensions.has('printing') && tableHasPrint(store.meta as never, table)
}

/** Why Print is not offered on a table, or undefined when it is. */
export function printUnavailable(store: AppStore, table: string): string | undefined {
  if (!store.extensions.has('printing')) return `needs the printing extension (${store.extensions.missing('printing')})`
  if (!tableHasPrint(store.meta as never, table)) return 'printing is not enabled for this table on the server'
  return undefined
}

/** The picker's rows: printable printers first; the remembered one marked; the rest with the reason. */
export function printerChoices(printers: Printer[], rememberedId: string | undefined): { choices: Choice<Printer>[]; initial: number } {
  const choices = printers.map((p) => {
    const why = whyNotPrintable(p)
    return {
      label: `${p.name}${p.id === rememberedId ? '  (last used)' : ''}`,
      value: p,
      detail: [p.device, p.status, p.formats.join(' ')].filter(Boolean).join(' · '),
      disabled: why ? `"${p.name}" cannot print now: ${why}` : undefined,
    }
  })
  const remembered = choices.findIndex((c) => c.value.id === rememberedId && !c.disabled)
  const firstPrintable = choices.findIndex((c) => !c.disabled)
  return { choices, initial: remembered >= 0 ? remembered : Math.max(0, firstPrintable) }
}

/** The first entry of the printer picker when the server can render to a PDF download. */
export const SAVE_AS_PDF = 'Save as PDF…'

/**
 * The printer picker: "Save as PDF…" first (when the server can render to a download and the
 * caller says what to render), then the printers, printable ones first, the last used one on this
 * profile preselected. With `hint` (`:print <printer>`) the printer is chosen by name, id or unique
 * prefix without the picker; `:print pdf` saves. A printer choice is remembered for the profile,
 * then `send` queues the print.
 */
export function pickPrinter(store: AppStore, title: string, send: (printing: Printing, printer: Printer) => void, hint?: string, renders?: RenderRequest[]): void {
  const printing = printingOf(store)
  if (!printing) return store.flash(`Printing needs ${store.client ? 'the printing extension' : 'a server connection'}.`, 'error')
  const canSave = Boolean(renders?.length) && canSaveAsPdf(store.meta as never)
  if (hint && /^(pdf|file)$/i.test(hint.trim())) {
    return canSave ? savePdfs(store, printing, renders!) : store.flash('This server cannot render to PDF (it needs the printingRenderToPdf process of qbit-printing).', 'error')
  }
  const profile = store.status.profile
  store.run(printing.printers(), (printers) => {
    if (!printers.length && !canSave) return store.message('No printers: no print agent has exposed a printer to this server yet.', 'info', 'Print')
    const go = (printer: Printer) => {
      writeRememberedPrinter(profile, { id: printer.id, name: printer.name })
      send(printing, printer)
    }
    if (hint) {
      let printer: Printer
      try {
        printer = resolvePrinter(printers, hint)
      } catch (e) {
        return store.flash(errorText(e), 'error')
      }
      const why = whyNotPrintable(printer)
      return why ? store.flash(`"${printer.name}" cannot print now: ${why}.`, 'error') : go(printer)
    }
    const { choices, initial } = printerChoices(printers, readRememberedPrinter(profile)?.id)
    const anyPrintable = choices.some((c) => !c.disabled)
    const all: Choice<Printer | 'pdf'>[] = [
      ...(canSave ? [{ label: SAVE_AS_PDF, value: 'pdf' as const, detail: 'render it and save it like a download: download folder, file dialog' }] : []),
      ...choices,
    ]
    const first = canSave && !anyPrintable ? 0 : initial + (canSave ? 1 : 0)
    store.open(new ChoiceOverlay<Printer | 'pdf'>(store, title, all, (choice) => (choice === 'pdf' ? savePdfs(store, printing, renders!) : go(choice)),
      'Save as PDF saves where downloads go; printers that cannot print now are shown with the reason; the printer is remembered for this profile', first))
  })
}

/**
 * Save as PDF: renders each document on the server and saves it as downloads and exports are
 * saved: the save dialog (or, with silent downloads, the download folder), the stamped default
 * name (`Customer-Ada-Lovelace_2026-11-01_120301.pdf`), no silent overwrite. More than one
 * document go next to the first, each with its own stamped name.
 */
export function savePdfs(store: AppStore, printing: Printing, renders: RenderRequest[]): void {
  store.flash(`Rendering ${renders.length === 1 ? 'the PDF' : `${renders.length} PDFs`}…`)
  const chrome = chromeOf(store)
  store.run(printing.renderToPdf(renders[0]!, new Date(), chrome), (first) => {
    saveFile(store, renders.length === 1 ? 'Save as PDF' : `Save ${renders.length} PDFs (the others go next to this one)`, first.fileName, (path) => {
      const saved = [saveDownload(path, first.bytes, { explicit: true })]
      const notes = first.message ? [first.message] : []
      const done = () => {
        history.record(store, { kind: 'print', summary: `Saved ${saved.length === 1 ? saved[0] : `${saved.length} PDFs to ${dirname(saved[0]!)}`}` })
        store.message([`Saved ${saved.length === 1 ? saved[0] : `${saved.length} PDFs to ${dirname(saved[0]!)}`} (${first.bytes.length.toLocaleString('en-US')} bytes${saved.length > 1 ? ' for the first' : ''}).`, ...notes].join('\n'), 'info', 'Save as PDF')
      }
      const rest = renders.slice(1)
      if (!rest.length) return done()
      store.run((async () => {
        for (const request of rest) {
          const pdf = await printing.renderToPdf(request, new Date(), chrome)
          if (pdf.message) notes.push(pdf.message)
          saved.push(saveDownload(join(dirname(path), pdf.fileName), pdf.bytes, { explicit: false }))
        }
      })(), done)
    })
  })
}

/** Queues the outcome of a print request and follows it (or says what went wrong). */
function queued(store: AppStore, printing: Printing, printer: Printer, what: string, work: Promise<PrintOutcome>): void {
  store.flash(`Sending ${what} to ${printer.name}…`)
  store.run(work, (outcome) => {
    if (!outcome.jobIds.length) return store.flash(`Nothing was printed: ${what} was not found (or is not visible to you).`, 'error')
    history.record(store, { kind: 'print', summary: `Printed ${what} on ${printer.name} (job${outcome.jobIds.length === 1 ? '' : 's'} ${outcome.jobIds.join(', ')})` })
    store.printTracker.track(printing, outcome.jobIds, what, printer.name, outcome.message)
  })
}

/**
 * Print… : the printer picker for records of a table, then queue and track. `what` names the
 * records for the messages ("Person Ada Lovelace", "3 Person records").
 */
export function openPrintDialog(store: AppStore, table: string, ids: string[], what: string, hint?: string): void {
  const unavailable = printUnavailable(store, table)
  if (!printingOf(store) || unavailable) return store.flash(`Print ${unavailable ?? 'needs a server connection'}.`, 'error')
  if (!ids.length) return store.flash('Nothing to print: select records first (Space).', 'error')
  pickPrinter(store, `Print ${what} on…`, (printing, printer) => queued(store, printing, printer, what, printing.print({ table, ids, printer: printer.id, chrome: chromeOf(store) }).then((jobIds) => ({ jobIds }))), hint, ids.map((id) => ({ kind: 'record' as const, table, id })))
}

// ---------------------------------------------------------------------------------------------
// Ctrl+P: print what you see
// ---------------------------------------------------------------------------------------------

/** What a grid hands to a print (TableScreen.printSpec). */
export interface GridPrintSpec {
  table: string
  label: string
  primaryKeyField: string
  /** Visible columns in order, with the widths the grid shows. */
  columns: Array<{ name: string; width?: number }>
  /** The grid's query filter with its sort (quick search included). */
  filter: Record<string, unknown>
  filterText: string
  total?: number
  pageIndex: number
  pageSize: number
  pageRows: number
  selected: string[]
  /** True when a whole result or first-N selection is active (Space selections are in `selected`). */
  selectAll: boolean
}

/** What Ctrl+P prints on a screen. */
export type PrintTarget =
  | { kind: 'record'; table: string; ids: string[]; what: string }
  | { kind: 'list'; grid: GridPrintSpec }
  | { kind: 'text'; title: string }

/** Ctrl+P on a screen: a record view prints a record sheet, a grid a table list, anything else its text. */
export function printTargetOf(screen: Screen | undefined): PrintTarget {
  const s = screen as (Screen & { tableName?: string; primaryKey?: unknown; meta?: { label?: string }; printSpec?: () => GridPrintSpec | undefined }) | undefined
  if (s?.kind === 'record' && s.tableName && s.primaryKey !== undefined) return { kind: 'record', table: s.tableName, ids: [String(s.primaryKey)], what: `${s.meta?.label ?? s.tableName} ${s.title()}` }
  if (s?.kind === 'table') {
    const grid = s.printSpec?.()
    if (grid) return { kind: 'list', grid }
  }
  return { kind: 'text', title: s?.title() ?? 'Screen' }
}

/**
 * The text of the screen as drawn (the renderer's character frame), without the status line and
 * the function-key bar, trailing spaces and trailing blank lines removed.
 */
export function captureScreenText(store: AppStore, captured?: string): string {
  const frame = captured ?? store.captureScreen?.() ?? ''
  const lines = frame.replace(/\r/g, '').split('\n')
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  const body = lines.slice(0, Math.max(0, lines.length - 2)).map((l) => l.replace(/\s+$/, ''))
  while (body.length && !body[body.length - 1]!.trim()) body.pop()
  return body.join('\n')
}

/**
 * Ctrl+P (or Print Screen, F8 Print, `:print [printer]`): prints what the screen shows. Without
 * the printing extension (or the 2.1 list and text prints) it saves instead: the grid's export,
 * else the screen text as a file, so the key always does something.
 */
export function printScreen(store: AppStore, hint?: string): void {
  const target = printTargetOf(store.screen)
  const printing = printingOf(store)
  if (!printing || (target.kind !== 'record' && !canPrintLists(store.meta as never))) return saveInstead(store, target)
  if (target.kind === 'record') {
    if (tableHasPrint(store.meta as never, target.table)) return openPrintDialog(store, target.table, target.ids, target.what, hint)
    if (!canPrintLists(store.meta as never)) return saveInstead(store, target)
    return askWhat(store, target.what, hint)
  }
  if (target.kind === 'text') return askWhat(store, target.title, hint)
  const grid = target.grid
  const choices = listScopeChoices({ total: grid.total, pageIndex: grid.pageIndex, pageSize: grid.pageSize, pageRows: grid.pageRows, selected: grid.selected, filtered: Boolean(grid.filterText), recordSheets: tableHasPrint(store.meta as never, grid.table) })
  const scoped = (scope: ListScope) => {
    if (scope.kind === 'sheets') return openPrintDialog(store, grid.table, scope.ids, `${scope.ids.length} ${grid.label} records`, hint)
    const what = scope.kind === 'all' ? `${grid.label}: ${grid.total === undefined ? 'all' : Math.min(grid.total, MAX_LIST_ROWS).toLocaleString('en-US')} rows` : scope.kind === 'page' ? `${grid.label}: page ${grid.pageIndex + 1}` : `${grid.label}: ${scope.ids.length} selected rows`
    const list = {
      table: grid.table, columns: grid.columns.map((c) => c.name), widths: grid.columns.every((c) => c.width) ? grid.columns.map((c) => c.width!) : undefined,
      filter: grid.filter, scope, title: grid.label, filterDescription: grid.filterText || undefined, primaryKeyField: grid.primaryKeyField,
    }
    pickPrinter(store, `Print ${what} on…`, (p, printer) => queued(store, p, printer, what, p.printTableList({ ...list, printer: printer.id, chrome: chromeOf(store) })), hint, [{ kind: 'list', list }])
  }
  if (grid.selectAll) return scoped({ kind: 'all' })
  store.open(new ChoiceOverlay<ListScope>(store, `Print ${grid.label}: what?`, choices.map((c) => ({ label: c.label, value: c.value, detail: c.detail })), scoped, 'the table list uses the columns, filter and sort you see; the header repeats on every page'))
}

/** Prints the screen's text (monospace PDF). */
function printText(store: AppStore, title: string, text: string, sections?: ContentSection[], hint?: string): void {
  const wide = !sections && text.split('\n').some((l) => l.length > 110)
  const page = { title, text, sections, orientation: wide ? 'LANDSCAPE' as const : 'PORTRAIT' as const }
  const chrome = chromeOf(store)
  const what = sections ? `${title} (content)` : `screen ${title}`
  pickPrinter(store, `Print ${sections ? 'the content of' : 'this screen'} (${title}) on…`, (p, printer) => queued(store, p, printer, what, p.printText({ ...page, printer: printer.id, chrome })), hint, [{ kind: 'text', ...page }])
}

// ---------------------------------------------------------------------------------------------
// the app's header and footer, and a screen's content as sections
// ---------------------------------------------------------------------------------------------

/**
 * The header and footer every printed page carries: the app (instance branding, else the
 * profile), the breadcrumb of the screen, the server (profile and host), the user, the time in
 * the profile's date format; the footer `qqq ui <version> · <server>` and, for grids, the filter.
 */
export function chromeOf(store: AppStore, footerNote?: string, now: Date = new Date()): PrintChrome {
  const branding = (store.meta as { branding?: { appName?: string } } | undefined)?.branding
  let host = store.status.server
  try {
    host = new URL(store.status.server).host
  } catch {
    host = store.status.server.replace(/^https?:\/\//, '')
  }
  const profile = store.status.profile
  const server = profile && profile !== host && profile !== profileNameForServer(store.status.server) ? `${profile} (${host})` : host
  let printedAt = now.toISOString()
  try {
    printedAt = formatDateValue(now.toISOString(), 'DATE_TIME', dateSettingsFor(store), { withSeconds: false })
  } catch {
    printedAt = now.toISOString()
  }
  return {
    app: branding?.appName ?? profileNote(profile) ?? 'QQQ',
    title: breadcrumbs(store).join(' › '),
    server,
    user: store.status.user,
    printedAt,
    footerLeft: `qqq ui ${CLI_VERSION} · ${server}`,
    footerNote,
  }
}

/** The profile's description (its note in config.json), if it has one. */
function profileNote(profile: string): string | undefined {
  try {
    return readConfig().profiles[profile]?.note || undefined
  } catch {
    return undefined
  }
}

const TOP_LEFT = new Set(['┌', '╭'])
const TOP_RIGHT = new Set(['┐', '╮'])
const BOTTOM_LEFT = new Set(['└', '╰'])
const BOX = /[─│┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝╟╢╠╣▏▕]/g

interface Box { top: number; left: number; bottom: number; right: number; title: string }

/** Boxes drawn with single lines in a character grid (their title from the top edge). */
function boxesOf(grid: string[][]): Box[] {
  const out: Box[] = []
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]!
    for (let c = 0; c < row.length; c++) {
      if (!TOP_LEFT.has(row[c]!)) continue
      let right = -1
      for (let x = c + 1; x < row.length; x++) {
        if (TOP_RIGHT.has(row[x]!)) { right = x; break }
        if (TOP_LEFT.has(row[x]!)) break
      }
      if (right < 0) continue
      let bottom = -1
      for (let y = r + 1; y <= grid.length; y++) {
        // a panel cut off by the bottom of its region runs to the end
        if (y === grid.length) { bottom = y; break }
        const ch = grid[y]![c]
        if (ch !== undefined && BOTTOM_LEFT.has(ch)) { bottom = y; break }
        if (ch !== '│' && ch !== '║') { bottom = y; break }
      }
      if (bottom < 0) continue
      const title = row.slice(c + 1, right).join('').replace(/^[─\s]+|[─\s]+$/g, '').trim()
      out.push({ top: r, left: c, bottom, right, title })
    }
  }
  return out
}

/** Text lines without box characters, trimmed; blank and border-only lines collapse. */
function cleanLines(lines: string[]): string[] {
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.replace(BOX, ' ').replace(/\s+$/, '')
    if (!line.trim()) {
      if (out.length && out[out.length - 1] !== '') out.push('')
      continue
    }
    out.push(line)
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  const indent = Math.min(...out.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length))
  return Number.isFinite(indent) && indent > 0 ? out.map((l) => l.slice(indent)) : out
}

/**
 * A screen's content as sections, read from the drawn frame: the content panel only (not the
 * Apps sidebar, the title bar, the status line or the key bar), each inner panel as a section
 * with its title and lines, the text around them as untitled sections, in reading order, borders
 * removed and the panel's key hint dropped.
 */
export function contentSections(frame: string): ContentSection[] {
  const lines = frame.replace(/\r/g, '').split('\n')
  while (lines.length && !lines[lines.length - 1]!.trim()) lines.pop()
  const body = lines.slice(1, Math.max(1, lines.length - 2))
  const grid = body.map((l) => Array.from(l))
  // the Apps sidebar ("Apps (Tab)", "Apps · type to find") is navigation, not content
  const boxes = boxesOf(grid).filter((b) => !/^Apps(\s+\(|\s+·|$)/.test(b.title))
  if (!boxes.length) {
    const text = cleanLines(body)
    return text.length ? [{ title: '', lines: text }] : []
  }
  const area = (b: Box) => (b.bottom - b.top) * (b.right - b.left)
  const panel = boxes.reduce((a, b) => (area(b) > area(a) ? b : a))
  const inside = boxes.filter((b) => b !== panel && b.top > panel.top && b.bottom <= panel.bottom && b.left >= panel.left && b.right <= panel.right)
  const children = inside.filter((b) => !inside.some((o) => o !== b && b.top > o.top && b.bottom < o.bottom && b.left > o.left && b.right < o.right))
  const sections: ContentSection[] = []
  let free: string[] = []
  const flush = () => {
    const text = cleanLines(free)
    if (text.length) sections.push({ title: '', lines: text })
    free = []
  }
  const freeRows: Array<{ row: number; text: string }> = []
  for (let r = panel.top + 1; r < panel.bottom; r++) {
    const cells = grid[r]!.slice(panel.left + 1, panel.right).map((ch, i) => (children.some((b) => r >= b.top && r <= b.bottom && panel.left + 1 + i >= b.left && panel.left + 1 + i <= b.right) ? ' ' : ch))
    freeRows.push({ row: r, text: cells.join('') })
  }
  // the panel's last line is its key hint ("a actions · … · Esc back"): not content
  const lastText = [...freeRows].reverse().find((f) => f.text.trim())
  if (lastText && /(Esc|a actions| · )/.test(lastText.text) && /(Esc|actions|Enter)/.test(lastText.text)) lastText.text = ''
  const starts = new Map<number, Box[]>()
  for (const b of children) starts.set(b.top, [...(starts.get(b.top) ?? []), b].sort((x, y) => x.left - y.left))
  for (const f of freeRows) {
    const opening = starts.get(f.row)
    if (opening) {
      flush()
      for (const b of opening) {
        const text = cleanLines(grid.slice(b.top + 1, b.bottom).map((row) => row.slice(b.left + 1, b.right).join('')))
        if (b.title || text.length) sections.push({ title: b.title, lines: text })
      }
    }
    free.push(f.text)
  }
  flush()
  return sections
}

/** Ctrl+P on a screen that is not a record or a grid: its content as a document, or the screen as drawn. */
function askWhat(store: AppStore, title: string, hint?: string): void {
  const frame = store.captureScreen?.() ?? ''
  const sections = contentSections(frame)
  const screen = captureScreenText(store, frame)
  if (!screen.trim()) return store.flash('There is nothing on the screen to print.', 'error')
  if (hint || !sections.length) return printText(store, title, screen, sections.length ? sections : undefined, hint)
  store.open(new ChoiceOverlay<'content' | 'screen'>(store, 'Print what?', [
    { label: 'Content', value: 'content', detail: "the screen's panels as a document: no navigation, no borders" },
    { label: 'Screen', value: 'screen', detail: 'the terminal as you see it, line for line' },
  ], (what) => printText(store, title, screen, what === 'content' ? sections : undefined), 'both carry the app header and footer'))
}



/** Without printing: the grid's export, else the screen text saved as a file. */
function saveInstead(store: AppStore, target: PrintTarget): void {
  const screen = store.screen as { exportDialog?: () => void } | undefined
  const why = store.extensions.has('printing') ? 'this server cannot print lists or screens' : 'printing is not installed on this server'
  if (target.kind === 'list' && screen?.exportDialog) {
    store.flash(`Print: ${why}; save the list as a file instead.`)
    return screen.exportDialog()
  }
  const text = captureScreenText(store)
  if (!text.trim()) return store.flash(`Print: ${why}, and there is nothing on the screen to save.`, 'error')
  const title = target.kind === 'record' ? target.what : target.kind === 'text' ? target.title : target.grid.label
  saveFile(store, `Print: ${why}. Save the screen as text`, exportFileName(title.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'screen', 'txt'), (path) => {
    writeFileSync(path, text + '\n')
    store.message(`Saved the screen to ${path}.`, 'info', 'Print')
  })
}

/** Follows queued print jobs and keeps `status.print` and the flash up to date. */
export class PrintTracker {
  private batches: Array<{ printing: Printing; ids: string[]; what: string; printer: string; jobs: PrintJob[]; note?: string }> = []
  private timer?: ReturnType<typeof setTimeout>

  constructor(private store: AppStore, readonly intervalMs = 1000, private readonly autoPoll = true) {}

  /** Jobs being followed. */
  get active(): number {
    return this.batches.reduce((n, b) => n + b.ids.length, 0)
  }

  track(printing: Printing, ids: string[], what: string, printer: string, note?: string): void {
    this.batches.push({ printing, ids, what, printer, jobs: [], note })
    this.update()
    this.store.flash(`Queued ${ids.length === 1 ? 'a print job' : `${ids.length} print jobs`} for ${what} on ${printer}.${note ? ` ${note}` : ''}`)
    this.schedule()
  }

  private schedule(): void {
    if (!this.autoPoll || this.timer || !this.batches.length) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.poll().finally(() => this.schedule())
    }, this.intervalMs)
  }

  /** One round: reads every followed job; finished batches are reported and dropped. */
  async poll(): Promise<void> {
    for (const batch of [...this.batches]) {
      try {
        batch.jobs = await batch.printing.jobs({ ids: batch.ids })
      } catch {
        continue
      }
      if (batch.jobs.length >= batch.ids.length && batch.jobs.every((j) => isFinalJobState(j.status))) {
        this.batches = this.batches.filter((b) => b !== batch)
        const failed = batch.jobs.filter((j) => (FAILED_JOB_STATES as readonly string[]).includes(j.status))
        if (failed.length) this.store.flash(`Print of ${batch.what} on ${batch.printer}: ${failed.length} of ${batch.jobs.length} ${failed[0]!.status}${failed[0]!.message ? ` (${failed[0]!.message})` : ''}.`, 'error')
        else this.store.flash(`Printed ${batch.what} on ${batch.printer}.${batch.note ? ` ${batch.note}` : ''}`)
      }
    }
    this.update()
    this.store.bump()
  }

  /** `print 1/2 RECEIVED` while jobs run; empty when none. */
  private update(): void {
    const jobs = this.batches.flatMap((b) => (b.jobs.length ? b.jobs : b.ids.map((id) => ({ id, status: 'QUEUED' }) as PrintJob)))
    if (!jobs.length) {
      this.store.status.print = undefined
      return
    }
    const done = jobs.filter((j) => isFinalJobState(j.status)).length
    const current = jobs.find((j) => !isFinalJobState(j.status))
    this.store.status.print = `print ${done}/${jobs.length}${current ? ` ${current.status}` : ''}`
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.batches = []
  }
}

/** The recent print jobs; Enter shows one in the output pane (`print job status <id>`). */
export function openPrintJobs(store: AppStore): void {
  const printing = printingOf(store)
  if (!printing) return store.flash(`Print jobs need ${store.client ? `the printing extension (${store.extensions.missing('printing')})` : 'a server connection'}.`, 'error')
  store.run(printing.jobs({ limit: 50 }), (jobs) => {
    if (!jobs.length) return store.message('No print jobs yet.', 'info', 'Print jobs')
    store.open(new ChoiceOverlay(store, 'Print jobs (newest first)', jobs.map((j) => ({ label: j.title, value: j.id, detail: `${j.status}${j.printer ? ` · ${j.printer}` : ''}${j.message ? ` · ${j.message}` : ''}` })), (id) => void store.commands().run(`print job status ${id}`), 'Enter: details'))
  })
}
