/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { writeFileSync } from 'node:fs'
import type { Command } from 'commander'
import { blocksToText, formatCsv, widgetRows, widgetToBlocks } from '@qrun-io/qqq-core'
import { UsageError, type Context } from '../context.js'
import { parsePairs, type Json } from './shared.js'

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
    .description("A widget's data, rendered for the terminal: statistics as lines, tables aligned, charts as bars or a labels-by-datasets table, html as text.")
    .option('-i, --input <name=value...>', 'widget inputs (record id, dropdown selections)')
    .option('--csv [file]', 'the widget\'s table or series as CSV (to a file when given)')
    .option('--ascii', 'ASCII bars instead of block characters')
    .action(async (name: string, options: { input?: string[]; csv?: string | boolean; ascii?: boolean }) => {
      const c = ctx()
      const result = await c.call('getWidgetData', { path: { widgetName: name }, json: parsePairs(options.input, '--input') })
      const data = result.data
      const blocks = widgetToBlocks(data)
      if (options.csv) {
        const rows = widgetRows(blocks)
        if (!rows) throw new UsageError(`Widget ${name} has no table or series to export.`)
        const csv = formatCsv(rows.rows, rows.columns, rows.headers)
        if (typeof options.csv === 'string') {
          writeFileSync(options.csv, csv)
          c.note(`wrote ${options.csv} (${rows.rows.length} rows)`)
        } else {
          process.stdout.write(csv)
        }
        return
      }
      if (c.format === 'json' || c.format === 'yaml') {
        c.print({ data })
        return
      }
      process.stdout.write(blocksToText(blocks, { width: process.stdout.columns ?? 100, ascii: options.ascii }) + '\n')
    })

  program.command('report').description('Reports: run.').command('run <report>')
    .description('Run a report and save its output (csv, xlsx, json, pdf as the report allows).')
    .option('--format <fmt>', 'output format', 'csv')
    .option('-o, --out <file>', 'output file (default: <report>.<format>)')
    .action(async (name: string, options: { format: string; out?: string }) => {
      const c = ctx()
      const result = await c.call('runReport', { path: { reportName: name }, query: { format: options.format } })
      const out = options.out ?? `${name}.${options.format}`
      const bytes = result.bytes ?? new TextEncoder().encode(typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
      writeFileSync(out, bytes)
      c.note(`wrote ${out} (${bytes.length} bytes, ${result.contentType})`)
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
    const data = (await c.call('searchHelp', { query: { q: text, limit: options.limit } })).data as Json
    const rows = ((data.results ?? []) as Json[]).map((r) => ({ kind: r.kind, name: r.name, label: r.label ?? '', table: r.table ?? '', href: r.href ?? '' }))
    c.print({ data, rows, columns: ['kind', 'name', 'label', 'table', 'href'], footer: `(${rows.length} results)` })
  })
}
