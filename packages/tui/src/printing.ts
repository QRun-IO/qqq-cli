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
import { FAILED_JOB_STATES, MAX_LIST_ROWS, Printing, canPrintLists, isFinalJobState, listScopeChoices, readRememberedPrinter, resolvePrinter, runProcess, tableHasPrint, whyNotPrintable, writeRememberedPrinter, type ListScope, type Printer, type PrintJob, type PrintOutcome, type ProcessMeta } from '@qrun-io/qqq-core'
import { ChoiceOverlay, type Choice } from './overlays/basic'
import type { AppStore } from './store'
import type { Screen } from './types'
import { errorText } from './util/text'
import { saveFile } from './overlays/files-helpers'

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

/**
 * The printer picker: printable printers first, the last used one on this profile preselected.
 * With `hint` (`:print <printer>`) the printer is chosen by name, id or unique prefix without the
 * picker. The choice is remembered for the profile, then `send` queues the print.
 */
export function pickPrinter(store: AppStore, title: string, send: (printing: Printing, printer: Printer) => void, hint?: string): void {
  const printing = printingOf(store)
  if (!printing) return store.flash(`Printing needs ${store.client ? 'the printing extension' : 'a server connection'}.`, 'error')
  const profile = store.status.profile
  store.run(printing.printers(), (printers) => {
    if (!printers.length) return store.message('No printers: no print agent has exposed a printer to this server yet.', 'info', 'Print')
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
    store.open(new ChoiceOverlay<Printer>(store, title, choices, go, 'printers that cannot print now are shown with the reason; the choice is remembered for this profile', initial))
  })
}

/** Queues the outcome of a print request and follows it (or says what went wrong). */
function queued(store: AppStore, printing: Printing, printer: Printer, what: string, work: Promise<PrintOutcome>): void {
  store.flash(`Sending ${what} to ${printer.name}…`)
  store.run(work, (outcome) => {
    if (!outcome.jobIds.length) return store.flash(`Nothing was printed: ${what} was not found (or is not visible to you).`, 'error')
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
  pickPrinter(store, `Print ${what} on…`, (printing, printer) => queued(store, printing, printer, what, printing.print({ table, ids, printer: printer.id }).then((jobIds) => ({ jobIds }))), hint)
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
export function captureScreenText(store: AppStore): string {
  const frame = store.captureScreen?.() ?? ''
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
    return printText(store, target.what, hint)
  }
  if (target.kind === 'text') return printText(store, target.title, hint)
  const grid = target.grid
  const choices = listScopeChoices({ total: grid.total, pageIndex: grid.pageIndex, pageSize: grid.pageSize, pageRows: grid.pageRows, selected: grid.selected, filtered: Boolean(grid.filterText), recordSheets: tableHasPrint(store.meta as never, grid.table) })
  const scoped = (scope: ListScope) => {
    if (scope.kind === 'sheets') return openPrintDialog(store, grid.table, scope.ids, `${scope.ids.length} ${grid.label} records`, hint)
    const what = scope.kind === 'all' ? `${grid.label}: ${grid.total === undefined ? 'all' : Math.min(grid.total, MAX_LIST_ROWS).toLocaleString('en-US')} rows` : scope.kind === 'page' ? `${grid.label}: page ${grid.pageIndex + 1}` : `${grid.label}: ${scope.ids.length} selected rows`
    pickPrinter(store, `Print ${what} on…`, (p, printer) => queued(store, p, printer, what, p.printTableList({
      table: grid.table, columns: grid.columns.map((c) => c.name), widths: grid.columns.every((c) => c.width) ? grid.columns.map((c) => c.width!) : undefined,
      filter: grid.filter, scope, title: grid.label, filterDescription: grid.filterText || undefined, printer: printer.id, primaryKeyField: grid.primaryKeyField,
    })), hint)
  }
  if (grid.selectAll) return scoped({ kind: 'all' })
  store.open(new ChoiceOverlay<ListScope>(store, `Print ${grid.label}: what?`, choices.map((c) => ({ label: c.label, value: c.value, detail: c.detail })), scoped, 'the table list uses the columns, filter and sort you see; the header repeats on every page'))
}

/** Prints the screen's text (monospace PDF). */
function printText(store: AppStore, title: string, hint?: string): void {
  const text = captureScreenText(store)
  if (!text.trim()) return store.flash('There is nothing on the screen to print.', 'error')
  const wide = text.split('\n').some((l) => l.length > 110)
  pickPrinter(store, `Print this screen (${title}) on…`, (p, printer) => queued(store, p, printer, `screen ${title}`, p.printText({ title, subtitle: `qqq ui · ${store.status.server.replace(/^https?:\/\//, '')}`, text, printer: printer.id, orientation: wide ? 'LANDSCAPE' : 'PORTRAIT' })), hint)
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
  saveFile(store, `Print: ${why}. Save the screen as text`, `${title.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-|-$/g, '') || 'screen'}.txt`, (path) => {
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
