/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Printing (the printing extension, qbit-printing 2.x):
 *
 *   qqq print <table> <id...> [--printer <name|id>] [--copies n] [--no-wait]   print records
 *   qqq print job list [--status s] [--limit n]                                 recent jobs
 *   qqq print job status <jobId...> [--watch]                                   job states
 *   qqq print job cancel <jobId...>                                             cancel queued jobs
 *   qqq printer list [--printable]                                              printers
 *   qqq printer use <printer> | forget | show                                   the remembered printer
 *   qqq printer devices                                                         print agents, health
 *
 * The kernel's Printing module does the work; every command needs the extension (exit 5 with the
 * installed list otherwise). The printer given with --printer, or chosen with `printer use`, is
 * remembered per profile and used when --printer is left out.
 */

import type { Command } from 'commander'
import { FAILED_JOB_STATES, isFinalJobState, jobStateSummary, printProcessName, PRINT_PROCESS_PREFIX, readRememberedPrinter, resolvePrinter, whyNotPrintable, writeRememberedPrinter, type Printer, type PrintJob, type Printing } from '@qrun-io/qqq-core'
import { EXIT, UsageError, type Context } from '../context.js'
import { countFooter, instantText, positiveInt, type Json } from './shared.js'

const JOB_COLUMNS = ['id', 'title', 'status', 'printer', 'copies', 'created', 'message']
const PRINTER_COLUMNS = ['default', 'name', 'device', 'status', 'approved', 'exposed', 'formats', 'id']

async function printingOf(c: Context): Promise<Printing> {
  const printing = await c.printing()
  ;(await c.extensions()).require('printing')
  return printing
}

function jobRows(jobs: PrintJob[], c: Context): Json[] {
  return jobs.map((j) => ({ id: j.id, title: j.title, status: j.status, printer: j.printer ?? '', copies: j.copies ?? '', created: instantText(j.createdAt ?? '', c.dateTimeDisplay), message: j.message ?? '' }))
}

function printerRows(printers: Printer[], remembered: string | undefined): Json[] {
  return printers.map((p) => ({ default: p.id === remembered ? '*' : '', name: p.name, device: p.device ?? '', status: p.status ?? '', approved: p.approved ? 'yes' : 'no', exposed: p.exposed ? 'yes' : 'no', formats: p.formats.join(' '), id: p.id }))
}

/** Tables the server offers Print on, from the metadata. */
async function printableTables(c: Context): Promise<string[]> {
  const processes = ((await c.metaData() as unknown as Json).processes ?? {}) as Record<string, unknown>
  return Object.keys(processes).filter((n) => n.startsWith(PRINT_PROCESS_PREFIX)).map((n) => n.slice(PRINT_PROCESS_PREFIX.length)).sort()
}

/** --printer, else the remembered one; checked against the printers that can take a record print. */
async function choosePrinter(c: Context, printing: Printing, wanted: string | undefined): Promise<Printer> {
  const printers = await printing.printers()
  const remembered = readRememberedPrinter(c.target.name)
  let printer: Printer | undefined
  if (wanted) printer = resolvePrinter(printers, wanted)
  else if (remembered) {
    printer = printers.find((p) => p.id === remembered.id)
    if (!printer) throw new UsageError(`The remembered printer${remembered.name ? ` "${remembered.name}"` : ''} is gone; choose one with --printer (see \`qqq printer list\`).`)
  } else {
    const printable = printers.filter((p) => !whyNotPrintable(p))
    if (printable.length === 1) printer = printable[0]
    else throw new UsageError(printable.length ? `Choose a printer with --printer: ${printable.map((p) => p.name).join(', ')} (it is remembered for this profile).` : 'No printer can take a print: none is approved and exposed by a connected print agent (see `qqq printer list` and `qqq printer devices`).')
  }
  const why = whyNotPrintable(printer!)
  if (why) throw new UsageError(`Printer "${printer!.name}" cannot print now: ${why}.`)
  return printer!
}

/** Prints the job lines as their states change, then the final table; exit 1 when any failed. */
async function follow(c: Context, printing: Printing, ids: string[], timeoutSeconds: number): Promise<PrintJob[]> {
  const human = c.format !== 'json' && c.format !== 'yaml'
  const seen = new Map<string, string>()
  const jobs = await printing.watch(ids, {
    timeoutMs: timeoutSeconds * 1000,
    onChange: (list) => {
      if (!human) return
      for (const j of list) {
        if (seen.get(j.id) === j.status) continue
        seen.set(j.id, j.status)
        c.note(`  ${j.id}  ${j.status}${j.message && isFinalJobState(j.status) ? `  ${j.message}` : ''}`)
      }
    },
  })
  if (jobs.some((j) => (FAILED_JOB_STATES as readonly string[]).includes(j.status))) process.exitCode = EXIT.error
  else if (!jobs.every((j) => isFinalJobState(j.status))) {
    c.note(`Still waiting after ${timeoutSeconds} s (${jobStateSummary(jobs)}); is the print agent running? Follow with \`qqq print job status ${ids.join(' ')} --watch\`.`)
    process.exitCode = EXIT.transient
  }
  return jobs
}

export function registerPrint(program: Command, ctx: () => Context): void {
  const print = program.command('print').description('Print records and follow print jobs (printing extension).')

  print.command('record <table> <ids...>', { isDefault: true })
    .description('Print records of a table as record sheets (`qqq print person 1 2`); waits until each job has printed.')
    .option('-P, --printer <name|id>', 'the printer (remembered for this profile); default: the remembered one')
    .option('-c, --copies <n>', 'copies of each record (1-100)', '1')
    .option('--no-wait', 'return once the jobs are queued')
    .option('--timeout <seconds>', 'how long to wait for the jobs', '120')
    .action(async (table: string, ids: string[], options: { printer?: string; copies: string; wait: boolean; timeout: string }) => {
      const c = ctx()
      const printing = await printingOf(c)
      const tables = await printableTables(c)
      if (!tables.includes(table)) throw new UsageError(`Print is not enabled for table "${table}" on this server${tables.length ? ` (tables with Print: ${tables.join(', ')})` : ''}.`)
      const copies = positiveInt(options.copies, '--copies')
      const printer = await choosePrinter(c, printing, options.printer)
      if (options.printer) writeRememberedPrinter(c.target.name, { id: printer.id, name: printer.name })
      c.note(`Printing ${ids.length} ${table} record${ids.length === 1 ? '' : 's'} on "${printer.name}"${copies > 1 ? `, ${copies} copies each` : ''} (${printProcessName(table)})`)
      const jobIds = await printing.print({ table, ids, printer: printer.id, copies })
      if (!jobIds.length) throw new Error(`Nothing was printed: no ${table} record ${ids.join(', ')} was found (or you may not see ${ids.length === 1 ? 'it' : 'them'}).`)
      const jobs = options.wait ? await follow(c, printing, jobIds, positiveInt(options.timeout, '--timeout')) : await printing.jobs({ ids: jobIds })
      c.print({ data: { printer: { id: printer.id, name: printer.name }, jobs }, rows: jobRows(jobs, c), columns: JOB_COLUMNS, footer: countFooter(jobs.length, 'job', [jobStateSummary(jobs), !options.wait && `follow: qqq print job status ${jobIds.join(' ')} --watch`]) })
    })

  const job = print.command('job').description('Print jobs: list, status, cancel.')

  job.command('list')
    .description('Recent print jobs, newest first.')
    .option('-s, --status <states>', 'only these states, comma separated (QUEUED, CLAIMED, RECEIVED, SUBMITTING, SPOOLED, SPOOLER_COMPLETED, FAILED, OUTCOME_UNKNOWN)')
    .option('-l, --limit <n>', 'most jobs', '25')
    .action(async (options: { status?: string; limit: string }) => {
      const c = ctx()
      const jobs = await (await printingOf(c)).jobs({ status: options.status?.split(',').map((s) => s.trim()).filter(Boolean), limit: positiveInt(options.limit, '--limit') })
      c.print({ data: jobs, rows: jobRows(jobs, c), columns: JOB_COLUMNS, footer: countFooter(jobs.length, 'job', [jobs.length ? jobStateSummary(jobs) : undefined]) })
    })

  job.command('status <jobIds...>')
    .description('The state of print jobs; --watch follows them until each has printed or failed.')
    .option('-w, --watch', 'follow until every job is final')
    .option('--timeout <seconds>', 'with --watch: how long to follow', '120')
    .action(async (jobIds: string[], options: { watch?: boolean; timeout: string }) => {
      const c = ctx()
      const printing = await printingOf(c)
      const jobs = options.watch ? await follow(c, printing, jobIds, positiveInt(options.timeout, '--timeout')) : await printing.jobs({ ids: jobIds })
      const missing = jobIds.filter((id) => !jobs.some((j) => j.id === id))
      if (!jobs.length) throw new Error(`No print job ${missing.join(', ')} (or it is not visible to you).`)
      c.print({ data: jobs, rows: jobRows(jobs, c), columns: JOB_COLUMNS, footer: countFooter(jobs.length, 'job', [jobStateSummary(jobs), missing.length && `not found: ${missing.join(', ')}`]) })
    })

  job.command('cancel <jobIds...>')
    .description('Cancel print jobs still queued in QQQ (a job a print agent already took is handled at the agent).')
    .action(async (jobIds: string[]) => {
      const c = ctx()
      const printing = await printingOf(c)
      if (!(await c.confirm(`Cancel ${jobIds.length} print job${jobIds.length === 1 ? '' : 's'}?`))) return
      await printing.cancel(jobIds)
      const jobs = await printing.jobs({ ids: jobIds })
      c.print({ data: jobs, rows: jobRows(jobs, c), columns: JOB_COLUMNS, footer: countFooter(jobs.length, 'job', [jobStateSummary(jobs)]) })
    })

  const printer = program.command('printer').description('Printers and print agents (printing extension); the printer `qqq print` uses.')

  printer.command('list')
    .description('Printers you can see: approved, exposed by their agent, formats. * marks the remembered one.')
    .option('--printable', 'only printers that can take a record print now')
    .action(async (options: { printable?: boolean }) => {
      const c = ctx()
      const printers = await (await printingOf(c)).printers({ printableOnly: options.printable })
      const remembered = readRememberedPrinter(c.target.name)
      c.print({ data: { printers, remembered: remembered ?? null }, rows: printerRows(printers, remembered?.id), columns: PRINTER_COLUMNS, footer: countFooter(printers.length, 'printer', [`${printers.filter((p) => !whyNotPrintable(p)).length} can print`, remembered ? `remembered: ${remembered.name ?? remembered.id}` : 'none remembered (qqq printer use <printer>)']) })
    })

  printer.command('use <printer>')
    .description('Remember a printer for this profile (name, unique name prefix or id).')
    .action(async (wanted: string) => {
      const c = ctx()
      const chosen = resolvePrinter(await (await printingOf(c)).printers(), wanted)
      writeRememberedPrinter(c.target.name, { id: chosen.id, name: chosen.name })
      const why = whyNotPrintable(chosen)
      c.note(`Printer for profile ${c.target.name}: "${chosen.name}"${why ? ` (it cannot print now: ${why})` : ''}.`)
    })

  printer.command('show')
    .description('The printer remembered for this profile.')
    .action(async () => {
      const c = ctx()
      const remembered = readRememberedPrinter(c.target.name)
      c.print({ data: remembered ?? null, rows: [{ profile: c.target.name, printer: remembered?.name ?? '', id: remembered?.id ?? '' }], columns: ['profile', 'printer', 'id'] })
    })

  printer.command('forget')
    .description('Forget the printer remembered for this profile.')
    .action(async () => {
      const c = ctx()
      writeRememberedPrinter(c.target.name, undefined)
      c.note(`No printer remembered for profile ${c.target.name}.`)
    })

  printer.command('devices')
    .description('Print agents: presence and health (ONLINE, OFFLINE, PAUSED, DISCONNECTED, REVOKED), version, last seen.')
    .action(async () => {
      const c = ctx()
      const devices = await (await printingOf(c)).devices()
      const rows = devices.map((d) => ({ name: d.name, status: d.status ?? '', agent: d.agentVersion ?? '', facility: d.facility ?? '', location: d.location ?? '', lastSeen: instantText(d.lastSeenAt ?? '', c.dateTimeDisplay), id: d.id }))
      c.print({ data: devices, rows, columns: ['name', 'status', 'agent', 'facility', 'location', 'lastSeen', 'id'], footer: countFooter(devices.length, 'device', [`${devices.filter((d) => d.status === 'ONLINE').length} online`]) })
    })
}
