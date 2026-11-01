/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Printing (the printing extension, qbit-printing 2.x):
 *
 *   qqq print <table> <id...> [--printer <name|id>] [--copies n] [--no-wait]   print records
 *   qqq print list <table> [-w criteria] [--order f] [--columns a,b] [--page n]  a table list
 *   qqq print text [file|-] --title t                                          text (a capture)
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
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { profileNameForServer, formatDateValue, localeFromEnv, readDateSettings, resolveDateSettings, saveDownload, type PrintChrome, type RenderedPdf, type RenderRequest, FAILED_JOB_STATES, MAX_LIST_ROWS, printFilter, isFinalJobState, jobStateSummary, printProcessName, PRINT_PROCESS_PREFIX, readRememberedPrinter, resolvePrinter, whyNotPrintable, writeRememberedPrinter, type Printer, type PrintJob, type Printing } from '@qrun-io/qqq-core'
import { EXIT, UsageError, type Context } from '../context.js'
import { getLogin } from '../session.js'
import { CLI_VERSION } from '../version.js'
import { ORDER_OPTION, countFooter, instantText, positiveInt, writeDownload, type Json } from './shared.js'
import { resolvedFilterFrom, type QueryOptions } from './table.js'

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

/**
 * The app's header and footer for what the CLI prints: the instance's branding name (else the
 * profile), the title, the server (profile and host), the signed-in user, the time in the
 * profile's date format; the footer `qqq <version> · <server>`.
 */
async function chromeFor(c: Context, title?: string): Promise<PrintChrome> {
  const t = c.target
  let host = t.server
  try {
    host = new URL(t.server).host
  } catch {
    host = t.server
  }
  const server = t.name && t.name !== host && t.name !== profileNameForServer(t.server) ? `${t.name} (${host})` : host
  let app: string | undefined
  try {
    app = ((await c.metaData()) as unknown as { branding?: { appName?: string } }).branding?.appName
  } catch {
    app = undefined
  }
  const login = await getLogin(t).catch(() => undefined)
  const user = login && login.kind === 'session' ? String((login.user as { name?: string } | undefined)?.name ?? '') : ''
  let printedAt = new Date().toISOString()
  try {
    printedAt = formatDateValue(printedAt, 'DATE_TIME', resolveDateSettings(readDateSettings(t.name), localeFromEnv()), { withSeconds: false })
  } catch {
    // the ISO instant stays
  }
  return { app: app ?? t.name, title, server, user: user || undefined, printedAt, footerLeft: `qqq ${CLI_VERSION} · ${server}` }
}

/**
 * --to-file: renders each document on the server and saves it as downloads are saved: a folder
 * given gets the stamped default names, a file name given is written as given (one document
 * only), no path saves to the download folder (`qqq config get download-dir`) with the stamped
 * name, never overwriting.
 */
async function saveAsPdf(c: Context, printing: Printing, requests: RenderRequest[], out: string | true, title?: string): Promise<void> {
  const chrome = await chromeFor(c, title)
  const path = out === true ? undefined : out
  const folder = path !== undefined && path !== '-' && existsSync(path) && statSync(path).isDirectory()
  if (path !== undefined && !folder && requests.length > 1) throw new UsageError('--to-file with several documents takes a folder (or no path: the download folder).')
  const rows: Json[] = []
  for (const request of requests) {
    const pdf: RenderedPdf = await printing.renderToPdf(request, new Date(), chrome)
    if (pdf.message) c.note(pdf.message)
    const written = folder ? saveDownload(join(path!, pdf.fileName), pdf.bytes, { explicit: false }) : writeDownload(path, pdf.fileName, pdf.bytes)
    if (written) {
      c.note(`Saved ${written} (${pdf.bytes.length.toLocaleString('en-US')} bytes)`)
      rows.push({ saved: written, bytes: pdf.bytes.length })
    }
  }
  if (path !== '-') c.print({ data: rows, rows, columns: ['saved', 'bytes'] })
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
    .option('--to-file [path]', 'save each record sheet as a PDF instead of printing: a folder, a file (one record), or the download folder')
    .action(async (table: string, ids: string[], options: { printer?: string; copies: string; wait: boolean; timeout: string; toFile?: string | true }) => {
      const c = ctx()
      const printing = await printingOf(c)
      const tables = await printableTables(c)
      if (!tables.includes(table)) throw new UsageError(`Print is not enabled for table "${table}" on this server${tables.length ? ` (tables with Print: ${tables.join(', ')})` : ''}.`)
      if (options.toFile !== undefined) return saveAsPdf(c, printing, ids.map((id) => ({ kind: 'record' as const, table, id })), options.toFile)
      const copies = positiveInt(options.copies, '--copies')
      const printer = await choosePrinter(c, printing, options.printer)
      if (options.printer) writeRememberedPrinter(c.target.name, { id: printer.id, name: printer.name })
      c.note(`Printing ${ids.length} ${table} record${ids.length === 1 ? '' : 's'} on "${printer.name}"${copies > 1 ? `, ${copies} copies each` : ''} (${printProcessName(table)})`)
      const jobIds = await printing.print({ table, ids, printer: printer.id, copies, chrome: await chromeFor(c) })
      if (!jobIds.length) throw new Error(`Nothing was printed: no ${table} record ${ids.join(', ')} was found (or you may not see ${ids.length === 1 ? 'it' : 'them'}).`)
      const jobs = options.wait ? await follow(c, printing, jobIds, positiveInt(options.timeout, '--timeout')) : await printing.jobs({ ids: jobIds })
      c.print({ data: { printer: { id: printer.id, name: printer.name }, jobs }, rows: jobRows(jobs, c), columns: JOB_COLUMNS, footer: countFooter(jobs.length, 'job', [jobStateSummary(jobs), !options.wait && `follow: qqq print job status ${jobIds.join(' ')} --watch`]) })
    })

  print.command('list <table>')
    .description(`Print a table list (printing 2.1): the whole result of the criteria in the column order given (up to ${MAX_LIST_ROWS.toLocaleString('en-US')} rows; more prints the first rows and says so), or one page with --page.`)
    .option('-w, --where <criteria...>', 'criteria, ANDed (as table query)')
    .option('-g, --group <expression...>', 'a group with AND/OR and parentheses')
    .option('--or', 'OR the --where criteria instead of AND')
    .option(...ORDER_OPTION)
    .option('-S, --search <text>', 'quick search, ANDed with the filter')
    .option('-c, --columns <names>', 'comma-separated fields, in order (default: the visible fields)')
    .option('--page <n>', 'print only this page (1-based), of --page-size rows')
    .option('--page-size <n>', 'rows per page for --page', '20')
    .option('--title <text>', 'the heading (default: the table label)')
    .option('--orientation <o>', 'AUTO (landscape when the columns need it), PORTRAIT or LANDSCAPE', 'AUTO')
    .option('--paper <size>', 'LETTER or A4', 'LETTER')
    .option('-P, --printer <name|id>', 'the printer (remembered for this profile); default: the remembered one')
    .option('--copies <n>', 'copies (1-100)', '1')
    .option('--no-wait', 'return once the job is queued')
    .option('--timeout <seconds>', 'how long to wait for the job', '300')
    .option('--to-file [path]', 'save the table list as a PDF instead of printing: a folder, a file, - for stdout, or the download folder')
    .action(async (table: string, options: QueryOptions & { columns?: string; page?: string; pageSize: string; title?: string; orientation: string; paper: string; printer?: string; copies: string; wait: boolean; timeout: string; toFile?: string | true }) => {
      const c = ctx()
      const printing = await printingOf(c)
      const meta = await c.tableMeta<Json>(table)
      const fields = (meta.fields ?? {}) as Record<string, Json>
      const columns = options.columns ? options.columns.split(',').map((s) => s.trim()).filter(Boolean) : Object.values(fields).filter((f) => !f.isHidden && f.type !== 'BLOB').map((f) => String(f.name))
      for (const name of columns) if (!fields[name]) throw new UsageError(`${table} has no field ${name}`)
      const orientation = options.orientation.toUpperCase()
      if (!['AUTO', 'PORTRAIT', 'LANDSCAPE'].includes(orientation)) throw new UsageError('--orientation takes AUTO, PORTRAIT or LANDSCAPE')
      const paper = options.paper.toUpperCase()
      if (paper !== 'LETTER' && paper !== 'A4') throw new UsageError('--paper takes LETTER or A4')
      const filter = await resolvedFilterFrom(c, { ...options, pageSize: '500' }, meta, columns)
      const pageSize = positiveInt(options.pageSize, '--page-size')
      const scope = options.page ? { kind: 'page' as const, skip: (positiveInt(options.page, '--page') - 1) * pageSize, limit: pageSize } : { kind: 'all' as const }
      if (options.toFile !== undefined) {
        const described = [printFilter(filter as never), options.search ? `quick "${options.search}"` : ''].filter(Boolean).join(' · ')
        return saveAsPdf(c, printing, [{ kind: 'list', list: { table, columns, filter: filter as unknown as Record<string, unknown>, scope, title: options.title ?? String(meta.label ?? table), filterDescription: described || undefined, orientation: orientation as 'AUTO', pageSize: paper as 'LETTER', primaryKeyField: String(meta.primaryKeyField ?? 'id') } }], options.toFile, String(meta.label ?? table))
      }
      const printer = await choosePrinter(c, printing, options.printer)
      if (options.printer) writeRememberedPrinter(c.target.name, { id: printer.id, name: printer.name })
      const described = [printFilter(filter as never), options.search ? `quick "${options.search}"` : ''].filter(Boolean).join(' · ')
      c.note(`Printing ${scope.kind === 'all' ? 'all rows of' : `page ${options.page} of`} ${meta.label ?? table}${described ? ` where ${described}` : ''} on "${printer.name}"`)
      const outcome = await printing.printTableList({ table, columns, filter: filter as unknown as Record<string, unknown>, scope, title: options.title ?? String(meta.label ?? table), filterDescription: described || undefined, printer: printer.id, copies: positiveInt(options.copies, '--copies'), orientation: orientation as 'AUTO', pageSize: paper as 'LETTER', primaryKeyField: String(meta.primaryKeyField ?? 'id'), chrome: await chromeFor(c, String(meta.label ?? table)) })
      if (outcome.message) c.note(outcome.message)
      if (!outcome.jobIds.length) throw new Error('The server queued no print job.')
      const jobs = options.wait ? await follow(c, printing, outcome.jobIds, positiveInt(options.timeout, '--timeout')) : await printing.jobs({ ids: outcome.jobIds })
      c.print({ data: { printer: { id: printer.id, name: printer.name }, jobs, message: outcome.message ?? null }, rows: jobRows(jobs, c), columns: JOB_COLUMNS, footer: countFooter(jobs.length, 'job', [jobStateSummary(jobs)]) })
    })

  print.command('text [file]')
    .description('Print text as a monospace PDF (printing 2.1): a file, or stdin with - or no file (a terminal capture, a log).')
    .requiredOption('--title <text>', 'the heading')
    .option('--subtitle <text>', 'a line under the heading')
    .option('--landscape', 'landscape pages (wide text)')
    .option('-P, --printer <name|id>', 'the printer (remembered for this profile); default: the remembered one')
    .option('--copies <n>', 'copies (1-100)', '1')
    .option('--no-wait', 'return once the job is queued')
    .option('--timeout <seconds>', 'how long to wait for the job', '120')
    .option('--to-file [path]', 'save the text page as a PDF instead of printing: a folder, a file, or the download folder')
    .action(async (file: string | undefined, options: { title: string; subtitle?: string; landscape?: boolean; printer?: string; copies: string; wait: boolean; timeout: string; toFile?: string | true }) => {
      const c = ctx()
      const printing = await printingOf(c)
      const text = readFileSync(file === undefined || file === '-' ? 0 : file, 'utf8')
      if (!text.trim()) throw new UsageError('Nothing to print: the text is empty.')
      if (options.toFile !== undefined) return saveAsPdf(c, printing, [{ kind: 'text', title: options.title, subtitle: options.subtitle, text, orientation: options.landscape ? 'LANDSCAPE' : 'PORTRAIT' }], options.toFile, options.title)
      const printer = await choosePrinter(c, printing, options.printer)
      if (options.printer) writeRememberedPrinter(c.target.name, { id: printer.id, name: printer.name })
      const outcome = await printing.printText({ title: options.title, subtitle: options.subtitle, text, printer: printer.id, copies: positiveInt(options.copies, '--copies'), orientation: options.landscape ? 'LANDSCAPE' : 'PORTRAIT', chrome: await chromeFor(c, options.title) })
      const jobs = options.wait ? await follow(c, printing, outcome.jobIds, positiveInt(options.timeout, '--timeout')) : await printing.jobs({ ids: outcome.jobIds })
      c.print({ data: { printer: { id: printer.id, name: printer.name }, jobs }, rows: jobRows(jobs, c), columns: JOB_COLUMNS, footer: countFooter(jobs.length, 'job', [jobStateSummary(jobs)]) })
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
