/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import { openRealtimeStream, unwrap } from '@qrun-io/qqq-ui-api-client'
import { appHome, blocksToText, callOperation, findNavigationTargets, formatTable, homePage, loadDashboard, type NavigationTarget } from '@qrun-io/qqq-core'
import { UsageError, type Context } from '../context.js'
import { CLIENT_CHANNEL, authenticatedFetch, currentToken, sessionCookieHeaderFor } from '../session.js'
import { countFooter, positiveInt, type Json } from './shared.js'

export function registerMisc(program: Command, ctx: () => Context): void {
  const listApps = async () => {
    const c = ctx()
    const metaData = await c.metaData() as unknown as Json
    const apps = Object.values((metaData.apps ?? {}) as Record<string, Json>)
      .map((a) => ({ name: a.name, label: a.label, items: (a.children as unknown[] | undefined)?.length ?? 0, widgets: (a.widgets as unknown[] | undefined)?.length ?? 0 }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)))
    c.print({ data: apps, columns: ['name', 'label', 'items', 'widgets'] })
  }
  const apps = program.command('apps').description('Apps: list (the default), show.').action(listApps)
  apps.command('list').description('List the apps you may use.').action(listApps)
  apps.command('show <app>')
    .description("An app's home: its sections of actions (processes), reports and data (tables, with record counts), and its widgets.")
    .option('--no-counts', 'skip the record count of each table')
    .option('--widgets', 'also load and show every widget of the app (once each, in declared order, sized in twelfths): a dashboard app as the web shows it')
    .option('--ascii', 'with --widgets, ASCII bars instead of block characters')
    .action(async (name: string, options: { counts: boolean; widgets?: boolean; ascii?: boolean }) => {
      const c = ctx()
      const metaData = await c.metaData() as unknown as Json
      const home = appHome(metaData, name)
      if (!home) throw new UsageError(`No app named ${name} (see \`qqq apps\`)`)
      const tables = (metaData.tables ?? {}) as Record<string, Json>
      const fetchImpl = authenticatedFetch(c.target)
      const rows = await Promise.all(home.sections.flatMap((section) => section.items.map(async (item) => {
        let count: unknown = ''
        if (item.type === 'TABLE' && options.counts && ((tables[item.name]?.capabilities ?? []) as string[]).includes('TABLE_COUNT')) {
          try {
            count = ((await callOperation(c.server, 'countTable', { path: { tableName: item.name }, json: { filter: { criteria: [], booleanOperator: 'AND' } } }, fetchImpl)).data as Json).count ?? ''
          } catch {
            count = '?'
          }
        }
        return { section: section.label, type: item.type.toLowerCase(), name: item.name, label: item.label, records: count }
      })))
      const widgets = home.widgets.map((w) => ({ section: 'Widgets', type: 'widget', name: w, label: String(((metaData.widgets ?? {}) as Record<string, Json>)[w]?.label ?? w), records: '' }))
      if (!options.widgets) {
        c.print({ data: { ...home, items: [...rows, ...widgets] }, rows: [...rows, ...widgets], columns: ['section', 'type', 'name', 'label', 'records'], footer: home.label })
        return
      }
      const started = Date.now()
      const loaded = await loadDashboard(c.server, fetchImpl, home.widgets, { widgets: (metaData.widgets ?? {}) as Record<string, Json> })
      if (c.format === 'json' || c.format === 'yaml') {
        c.print({ data: { ...home, items: rows, widgets: loaded.map((w) => ({ name: w.name, label: w.label, type: w.type, gridColumns: w.gridColumns, isCard: w.isCard, data: w.data, skipped: w.skipped, error: w.error })) } })
        return
      }
      const width = process.stdout.columns ?? 100
      const parts = [home.label, ...(rows.length ? [formatTable(rows, ['section', 'type', 'name', 'label', 'records'], ['Section', 'Type', 'Name', 'Label', 'Records'])] : [])]
      for (const w of loaded) {
        const body = blocksToText(w.blocks.filter((b, i) => !(i === 0 && b.kind === 'heading')), { width, ascii: options.ascii })
        parts.push(`${w.isCard ? '== ' : ''}${w.label} (${w.gridColumns}/12)${w.isCard ? ' ==' : ''}\n${body}`)
      }
      process.stdout.write(parts.join('\n\n') + '\n')
      c.note(`${loaded.length} widget${loaded.length === 1 ? '' : 's'} loaded once each in ${Date.now() - started} ms${loaded.some((w) => w.skipped) ? `; skipped: ${loaded.filter((w) => w.skipped).map((w) => `${w.name} (${w.skipped})`).join(', ')}` : ''}`)
    })

  program.command('home')
    .description('The landing page: counts of what you may open, quick actions (processes in your apps, with the command to run each) and one card per app.')
    .action(async () => {
      const c = ctx()
      const metaData = await c.metaData() as unknown as Json
      const home = homePage(metaData)
      if (c.format === 'json' || c.format === 'yaml') {
        c.print({ data: home })
        return
      }
      const counts = `${home.counts.apps} apps, ${home.counts.tables} tables, ${home.counts.processes} processes, ${home.counts.reports} reports, ${home.counts.widgets} widgets`
      const actions = home.quickActions.length ? formatTable(home.quickActions.map((a) => ({ action: a.label, app: a.app, command: `qqq process run ${a.name}` })), ['action', 'app', 'command'], ['Quick action', 'App', 'Command']) : '(no quick actions)'
      const cards = formatTable(home.apps.map((a) => ({ app: a.label, name: a.name, tables: a.tables || '', processes: a.processes || '', reports: a.reports || '', widgets: a.widgets || '', apps: a.apps || '' })), ['app', 'name', 'tables', 'processes', 'reports', 'widgets', 'apps'], ['App', 'Name', 'Tables', 'Processes', 'Reports', 'Widgets', 'Apps'])
      process.stdout.write(`${String((metaData.branding as Json | undefined)?.appName ?? c.server)}\n${counts}\n\n${actions}\n\n${cards}\n`)
    })

  program.command('find <text...>')
    .description('Find an app, table, process or report by label (the command palette): type, app, and the command that opens it.')
    .option('-t, --type <type>', 'only apps, tables, processes or reports')
    .action(async (words: string[], options: { type?: string }) => {
      const c = ctx()
      const types = options.type ? [({ app: 'APP', apps: 'APP', table: 'TABLE', tables: 'TABLE', process: 'PROCESS', processes: 'PROCESS', report: 'REPORT', reports: 'REPORT' } as Record<string, NavigationTarget['type']>)[options.type.toLowerCase()] ?? (() => { throw new UsageError(`--type: app, table, process or report`) })()] : undefined
      const found = findNavigationTargets(await c.metaData() as unknown as Json, words.join(' '), types)
      const command = (t: NavigationTarget) => t.type === 'APP' ? `qqq apps show ${t.name}` : t.type === 'TABLE' ? `qqq table query ${t.name}` : t.type === 'PROCESS' ? `qqq process run ${t.name}` : `qqq report run ${t.name}`
      c.print({ data: found, rows: found.map((t) => ({ label: t.label, type: t.type.toLowerCase(), app: t.app, command: command(t) })), columns: ['label', 'type', 'app', 'command'], footer: countFooter(found.length, 'match', [], 'matches') })
    })

  program.command('search <text>')
    .description('Search records across tables (the global search of the web UI).')
    .option('-t, --table <name>', 'only this table')
    .option('-l, --limit <n>', 'most results', '20')
    .action(async (text: string, options: { table?: string; limit: string }) => {
      const c = ctx()
      const result = await c.call('searchRecords', { json: { searchTerm: text, tableNames: options.table ? [options.table] : undefined, limitPerTable: positiveInt(options.limit, '--limit') } })
      const data = result.data as Json
      const results = ((data.results ?? []) as Json[]).map((r) => ({ table: r.tableName, key: r.recordId, label: r.recordLabel, details: Array.isArray(r.details) ? (r.details as unknown[]).map((d) => (typeof d === 'object' && d ? Object.values(d as Json).join(' ') : String(d))).join(' · ') : r.details ?? '' }))
      c.print({ data, rows: results, columns: ['table', 'key', 'label', 'details'], footer: countFooter(results.length, 'result') })
    })

  program.command('tail')
    .description('Follow your jobs and notifications live (realtime stream, channel user:me).')
    .option('-c, --channel <channels...>', 'more channels, e.g. table:person or record:person:42')
    .action(async (options: { channel?: string[] }) => {
      const c = ctx()
      const t = c.target
      const origin = t.server
      const controller = new AbortController()
      process.on('SIGINT', () => controller.abort())
      const session = await sessionCookieHeaderFor(t)
      const stream = openRealtimeStream({ baseUrl: origin, token: () => currentToken(t), clientChannel: CLIENT_CHANNEL, signal: controller.signal, ...(session ? { headers: { Cookie: session } } : {}) } as never)
      try {
        await follow(stream)
      } catch (error) {
        // Ctrl-C ends a follow as `tail -f` does: quietly, exit 130
        if (!controller.signal.aborted) throw error
      }
      if (controller.signal.aborted) process.exitCode = 130
      async function follow(messages: typeof stream): Promise<void> {
        for await (const message of messages) {
          const data = (message.data ?? {}) as Json
          if (message.event === 'hello') {
            const connectionId = String(data.connectionId ?? (data.data as Json | undefined)?.connectionId ?? '')
            const add = ['user:me', ...(options.channel ?? [])]
            await unwrap(c.client.POST('/qqq/v1/realtime/subscriptions', { body: { connectionId, add } }))
            c.note(`Following ${add.join(', ')} on ${origin} (Ctrl-C to stop).`)
            continue
          }
          if (c.format === 'json') {
            console.log(JSON.stringify(message))
            continue
          }
          const payload = (data.data ?? data) as Json
          const time = new Date().toTimeString().slice(0, 8)
          const detail = payload.label ?? payload.title ?? payload.message ?? payload.jobId ?? ''
          const progress = payload.percent !== undefined && payload.percent !== null ? ` ${payload.percent}%` : ''
          console.log(`${time} ${message.event}${data.channel ? ` [${data.channel}]` : ''} ${detail}${progress}${payload.status ? ` ${payload.status}` : ''}`.trim())
        }
      }
    })
}
