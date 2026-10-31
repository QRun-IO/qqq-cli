/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import { openRealtimeStream, unwrap } from '@qrun-io/qqq-ui-api-client'
import type { Context } from '../context.js'
import { CLIENT_CHANNEL, currentToken, sessionCookieFor } from '../session.js'
import type { Json } from './shared.js'

export function registerMisc(program: Command, ctx: () => Context): void {
  program.command('apps')
    .description('List the apps you may use.')
    .action(async () => {
      const c = ctx()
      const metaData = await c.metaData() as unknown as Json
      const apps = Object.values((metaData.apps ?? {}) as Record<string, Json>)
        .map((a) => ({ name: a.name, label: a.label, items: (a.children as unknown[] | undefined)?.length ?? 0 }))
        .sort((a, b) => String(a.label).localeCompare(String(b.label)))
      c.print({ data: apps, columns: ['name', 'label', 'items'] })
    })

  program.command('search <text>')
    .description('Search records across tables (the global search of the web UI).')
    .option('-t, --table <name>', 'only this table')
    .option('-l, --limit <n>', 'most results', '20')
    .action(async (text: string, options: { table?: string; limit: string }) => {
      const c = ctx()
      const result = await c.call('searchRecords', { json: { searchTerm: text, tableNames: options.table ? [options.table] : undefined, limitPerTable: Number(options.limit) } })
      const data = result.data as Json
      const results = ((data.results ?? []) as Json[]).map((r) => ({ table: r.tableName, key: r.recordId, label: r.recordLabel, details: Array.isArray(r.details) ? (r.details as unknown[]).map((d) => (typeof d === 'object' && d ? Object.values(d as Json).join(' ') : String(d))).join(' · ') : r.details ?? '' }))
      c.print({ data, rows: results, columns: ['table', 'key', 'label', 'details'], footer: `(${results.length} results)` })
    })

  program.command('tail')
    .description('Follow your jobs and notifications live (realtime stream, channel user:me).')
    .option('-c, --channel <channels...>', 'more channels, e.g. table:person or record:person:42')
    .action(async (options: { channel?: string[] }) => {
      const c = ctx()
      const origin = c.server
      const controller = new AbortController()
      process.on('SIGINT', () => controller.abort())
      const session = sessionCookieFor(origin)
      const stream = openRealtimeStream({ baseUrl: origin, token: () => currentToken(origin), clientChannel: CLIENT_CHANNEL, signal: controller.signal, ...(session ? { headers: { Cookie: `sessionUUID=${session}` } } : {}) } as never)
      for await (const message of stream) {
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
        const time = new Date().toISOString().slice(11, 19)
        const detail = payload.label ?? payload.title ?? payload.message ?? payload.jobId ?? ''
        const progress = payload.percent !== undefined && payload.percent !== null ? ` ${payload.percent}%` : ''
        console.log(`${time} ${message.event}${data.channel ? ` [${data.channel}]` : ''} ${detail}${progress}${payload.status ? ` ${payload.status}` : ''}`.trim())
      }
    })
}
