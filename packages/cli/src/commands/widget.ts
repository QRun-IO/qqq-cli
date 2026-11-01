/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import { ReportError, blocksToText, formatCsv, listReports, loadWidget, reportFormat, reportRunPlan, safeFileName, widgetRows } from '@qrun-io/qqq-core'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { authenticatedFetch } from '../session.js'
import { UsageError, type Context } from '../context.js'
import { countFooter, parsePairs, positiveInt, writeDownload, type Json } from './shared.js'

export function registerWidget(program: Command, ctx: () => Context): void {
  const widget = program.command('widget').description('Widgets (dashboard tiles): list, get.')

  widget.command('list')
    .description('List the widgets the application declares.')
    .action(async () => {
      const c = ctx()
      const metaData = await c.metaData() as unknown as Json
      const rows = Object.values((metaData.widgets ?? {}) as Record<string, Json>).map((w) => ({ name: w.name, type: w.type, label: w.label ?? '' })).sort((a, b) => String(a.name).localeCompare(String(b.name)))
      c.print({ data: rows, columns: ['name', 'type', 'label'] })
    })

  widget.command('get <widget>')
    .description("A widget's data, rendered for the terminal as the web shows it: statistics as lines, tables aligned (typed cells, sub-rows, totals row), charts as bars or a labels-by-datasets table, html as text, parent widgets with their children (each sized in twelfths), data bag and script viewers with their versions; empty states and the server's dropdown message as the web words them.")
    .option('-i, --input <name=value...>', 'widget inputs (record id, dropdown selections)')
    .option('-r, --record <table=primaryKey>', 'the record the widget sits on (its id and table are sent; cronUI, pivot and filter setups read it)')
    .option('--run', 'a process widget: run its process here (with the widget\'s default values)')
    .option('--csv [file]', 'the widget\'s table or series as CSV (to a file when given)')
    .option('--ascii', 'ASCII bars instead of block characters')
    .action(async (name: string, options: { input?: string[]; record?: string; run?: boolean; csv?: string | boolean; ascii?: boolean }) => {
      const c = ctx()
      const widgets = ((await c.metaData() as unknown as Json).widgets ?? {}) as Record<string, Json>
      const params = parsePairs(options.input, '--input')
      let record: Json | undefined
      if (options.record) {
        const [table, pk] = Object.entries(parsePairs([options.record], '--record'))[0]!
        const got = await c.unwrap(c.client.GET('/qqq/v1/table/{tableName}/{primaryKey}', { params: { path: { tableName: table, primaryKey: pk } } })) as Json
        record = (((got.record ?? got) as Json).values ?? {}) as Json
        params.id ??= pk
        params.tableName ??= table
      }
      // a widget the metadata does not declare is still asked for (the server decides)
      const known = widgets[name] ? widgets : { ...widgets, [name]: { name, label: name } }
      const loaded = await loadWidget(c.server, authenticatedFetch(c.target), name, { widgets: known, params, record })
      if (options.run) {
        const pm = ((loaded.data as Json | undefined)?.processMetaData ?? {}) as Json
        if (!pm.name) throw new UsageError(`${name} is not a process widget (or names no process).`)
        const defaults = ((loaded.data as Json).defaultValues ?? {}) as Json
        const run = program.commands.find((x) => x.name() === 'process')!.commands.find((x) => x.name() === 'run')!
        await run.parseAsync([String(pm.name), ...(Object.keys(defaults).length ? ['--values-json', JSON.stringify(defaults)] : [])], { from: 'user' })
        return
      }
      if (options.csv) {
        const rows = widgetRows(loaded.blocks)
        if (!rows) throw new UsageError(`Widget ${name} has no table or series to export.`)
        const csv = formatCsv(rows.rows, rows.columns, rows.headers)
        const written = writeDownload(typeof options.csv === 'string' ? options.csv : '-', safeFileName(`${name}.csv`), new TextEncoder().encode(csv))
        if (written) c.note(`wrote ${written} (${rows.rows.length} rows)`)
        return
      }
      if (c.format === 'json' || c.format === 'yaml') {
        c.print({ data: loaded.data ?? { skipped: loaded.skipped } })
        return
      }
      process.stdout.write(blocksToText(loaded.blocks, { width: process.stdout.columns ?? 100, ascii: options.ascii }) + '\n')
      if (loaded.error) process.exitCode = 1
    })

  const report = program.command('report').description('Reports: list, run.')
  report.command('list')
    .description('The reports you may run, with their table and app.')
    .action(async () => {
      const c = ctx()
      const rows = listReports(await c.metaData() as unknown as Json)
      c.print({ data: rows, columns: ['name', 'label', 'table', 'app'], footer: rows.length ? '' : '(no reports in this application)' })
    })
  report.command('run <report>')
    .description('Run a report: through its process (input fields asked, or given with -v; the file comes from the download route) or, for a report without a process, the report route. TABLE, SUMMARY and PIVOT reports come back as the server writes them.')
    .option('--format <fmt>', 'csv, xlsx, json or tsv (pdf where the report allows)', 'csv')
    .option('-v, --values <name=value...>', 'report input values (report variables)')
    .option('-o, --out <file>', 'report route: output file, replaced if it exists, or - for stdout (default: <report>.<format> in the download directory)')
    .option('--out-dir <dir>', 'report process: where the file is saved (default: the download directory, else the current one)')
    .option('--route', 'use the report route even when the report has a process')
    .action(async (name: string, options: { format: string; values?: string[]; out?: string; outDir?: string; route?: boolean }) => {
      const c = ctx()
      const plan = reportRunPlan(await c.metaData() as unknown as Json, name)
      if (plan && !plan.hasPermission) throw new UiApiError(403, { code: 'PERMISSION_DENIED', message: `You do not have permission to run ${plan.label}.` })
      let format: string
      try {
        format = reportFormat(options.format)
      } catch (error) {
        if (error instanceof ReportError) throw new UsageError(error.message)
        throw error
      }
      if (plan?.processName && !options.route) {
        if (options.out) throw new UsageError(`${plan.label} runs through its process: use --out-dir (the file keeps the server's name), or --route with --out.`)
        const run = program.commands.find((x) => x.name() === 'process')!.commands.find((x) => x.name() === 'run')!
        await run.parseAsync([plan.processName, '-v', `reportName=${name}`, '-v', `reportFormat=${format}`, ...(options.values ?? []).flatMap((v) => ['-v', v]), ...(options.outDir ? ['--out-dir', options.outDir] : [])], { from: 'user' })
        return
      }
      // a report without a process (or --route): the streaming report route
      const result = await c.call('runReport', { path: { reportName: name }, query: { format: format.toLowerCase(), ...parsePairs(options.values, '--values') } })
      const bytes = result.bytes ?? new TextEncoder().encode(typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
      const written = writeDownload(options.out, safeFileName(`${name}.${format.toLowerCase()}`), bytes)
      if (written) c.note(`wrote ${written} (${bytes.length} bytes, ${result.contentType})`)
    })

  const prefs = program.command('prefs').description('Your preferences: list, get, set, action.')
  prefs.command('list').description('The preference sections.').action(async () => {
    const c = ctx()
    const data = (await c.call('listPreferenceSections', {})).data as Json
    const rows = ((data.sections ?? []) as Json[]).map((s) => ({ name: s.name, label: s.label, description: s.description ?? '', fields: ((s.fields ?? []) as Json[]).map((f) => f.name).join(', '), actions: ((s.actions ?? []) as Json[]).map((a) => a.name).join(', ') }))
    c.print({ data, rows, columns: ['name', 'label', 'description', 'fields', 'actions'] })
  })
  prefs.command('get <section>').description('One section with its current values.').action(async (section: string) => {
    const c = ctx()
    const data = (await c.call('getPreferenceSection', { path: { sectionName: section } })).data as Json
    const values = (data.values ?? {}) as Json
    const fields = ((data.fields ?? ((data.section as Json | undefined)?.fields) ?? []) as Json[])
    const rows = fields.length ? fields.map((f) => ({ field: f.name, label: f.label, value: values[String(f.name)] ?? '' })) : Object.entries(values).map(([field, value]) => ({ field, label: field, value }))
    c.print({ data, rows, columns: ['field', 'label', 'value'] })
  })
  prefs.command('set <section>').description('Change values in a section: --set name=value.').option('-s, --set <name=value...>', 'values').action(async (section: string, options: { set?: string[] }) => {
    const c = ctx()
    const values = parsePairs(options.set, '--set')
    if (!Object.keys(values).length) throw new UsageError('Give values with --set name=value.')
    const data = (await c.call('updatePreferenceSection', { path: { sectionName: section }, json: { values } })).data
    c.print({ data: data ?? {}, rows: Object.entries(values).map(([field, value]) => ({ updated: field, value })), columns: ['updated', 'value'] })
  })
  prefs.command('action <section> <action>').description("Run one of a section's actions.").action(async (section: string, action: string) => {
    const c = ctx()
    const data = (await c.call('runPreferenceSectionAction', { path: { sectionName: section, actionName: action }, json: {} })).data
    c.print({ data: data ?? {} })
  })

  program.command('help-search <text>').description("Search the application's help content.").option('-l, --limit <n>', 'most results', '20').action(async (text: string, options: { limit: string }) => {
    const c = ctx()
    const data = (await c.call('searchHelp', { query: { q: text, limit: String(positiveInt(options.limit, '--limit')) } })).data as Json
    const rows = ((data.results ?? []) as Json[]).map((r) => ({ kind: r.kind, name: r.name, label: r.label ?? '', table: r.table ?? '', href: r.href ?? '' }))
    c.print({ data, rows, columns: ['kind', 'name', 'label', 'table', 'href'], footer: countFooter(rows.length, 'result') })
  })
}
