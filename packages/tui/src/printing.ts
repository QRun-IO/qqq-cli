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

import { FAILED_JOB_STATES, Printing, isFinalJobState, readRememberedPrinter, runProcess, tableHasPrint, whyNotPrintable, writeRememberedPrinter, type Printer, type PrintJob, type ProcessMeta } from '@qrun-io/qqq-core'
import { ChoiceOverlay, type Choice } from './overlays/basic'
import type { AppStore } from './store'

/** The printing module of the store's server, or undefined without a client or the extension. */
export function printingOf(store: AppStore): Printing | undefined {
  if (!store.client || !store.extensions.has('printing')) return undefined
  const client = store.client
  return new Printing(store.extensions.registry, {
    call: (id, input) => client.call(id, input),
    runProcess: async (processName, { values, recordIds }) => {
      const meta = await client.processMeta(processName) as unknown as ProcessMeta
      return (await runProcess({ baseUrl: client.server, fetch: client.fetch, meta, values, records: { ids: recordIds }, stepTimeoutMillis: 60000 })).values
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
 * Print… : the printer picker for records of a table, then queue and track. `what` names the
 * records for the messages ("Person Ada Lovelace", "3 Person records").
 */
export function openPrintDialog(store: AppStore, table: string, ids: string[], what: string): void {
  const printing = printingOf(store)
  const unavailable = printUnavailable(store, table)
  if (!printing || unavailable) return store.flash(`Print ${unavailable ?? 'needs a server connection'}.`, 'error')
  if (!ids.length) return store.flash('Nothing to print: select records first (Space).', 'error')
  const profile = store.status.profile
  store.run(printing.printers(), (printers) => {
    if (!printers.length) return store.message('No printers: no print agent has exposed a printer to this server yet.', 'info', 'Print')
    const { choices, initial } = printerChoices(printers, readRememberedPrinter(profile)?.id)
    store.open(new ChoiceOverlay<Printer>(store, `Print ${what} on…`, choices, (printer) => {
      writeRememberedPrinter(profile, { id: printer.id, name: printer.name })
      store.flash(`Sending ${what} to ${printer.name}…`)
      store.run(printing.print({ table, ids, printer: printer.id }), (jobIds) => {
        if (!jobIds.length) return store.flash(`Nothing was printed: ${what} was not found (or is not visible to you).`, 'error')
        store.printTracker.track(printing, jobIds, what, printer.name)
      })
    }, 'printers that cannot print now are shown with the reason; the choice is remembered for this profile', initial))
  })
}

/** Follows queued print jobs and keeps `status.print` and the flash up to date. */
export class PrintTracker {
  private batches: Array<{ printing: Printing; ids: string[]; what: string; printer: string; jobs: PrintJob[] }> = []
  private timer?: ReturnType<typeof setTimeout>

  constructor(private store: AppStore, readonly intervalMs = 1000, private readonly autoPoll = true) {}

  /** Jobs being followed. */
  get active(): number {
    return this.batches.reduce((n, b) => n + b.ids.length, 0)
  }

  track(printing: Printing, ids: string[], what: string, printer: string): void {
    this.batches.push({ printing, ids, what, printer, jobs: [] })
    this.update()
    this.store.flash(`Queued ${ids.length === 1 ? 'a print job' : `${ids.length} print jobs`} for ${what} on ${printer}.`)
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
        else this.store.flash(`Printed ${batch.what} on ${batch.printer}.`)
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
