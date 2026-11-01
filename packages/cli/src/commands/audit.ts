/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import { auditSource, getAudits } from '@qrun-io/qqq-core'
import { UsageError, type Context } from '../context.js'
import { authenticatedFetch } from '../session.js'
import { countFooter, instantText, type Json } from './shared.js'

export function registerAudit(program: Command, ctx: () => Context): void {
  program.command('audit').description('Audit history: list.').command('list <table> <primaryKey>')
    .description("A record's audit history: who changed what, newest first (the audit process, or the audit table when you may not run it).")
    .option('--asc', 'oldest first')
    .action(async (table: string, primaryKey: string, options: { asc?: boolean }) => {
      const c = ctx()
      const meta = await c.tableMeta<Json>(table)
      const source = auditSource(meta, await c.metaData() as unknown as Json)
      if (!source) throw new UsageError(`No audits you may read for ${meta.label} on this server (no audit process or table).`)
      const fields = (meta.fields ?? {}) as Record<string, Json>
      const { entries, total } = await getAudits(c.server, authenticatedFetch(c.target), source, table, primaryKey, { ascending: options.asc })
      const rows = entries.flatMap((e) => (e.changes.length ? e.changes : [undefined]).map((change, i) => ({
        when: i ? '' : instantText(e.timestamp, c.dateTimeDisplay),
        user: i ? '' : e.user,
        action: i ? '' : e.action.toLowerCase(),
        change: change ? (change.message ?? `${String(fields[change.fieldName]?.label ?? change.fieldName)}: ${String(change.oldValue ?? '')} -> ${String(change.newValue ?? '')}`) : e.message,
      })))
      c.print({ data: entries, rows, columns: ['when', 'user', 'action', 'change'], footer: countFooter(entries.length, 'audit', [total !== null && total > entries.length && `of ${total}`, `read through the ${source.kind === 'process' ? `${source.processName} process` : `${source.tableName} table`}`]) })
    })
}
