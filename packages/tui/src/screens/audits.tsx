/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { auditSource, displayDateTime, getAudits } from '@qrun-io/qqq-core'
import type { AppStore } from '../store'
import { theme } from '../theme'
import type { Row } from './list'
import { LinesScreen } from './lines'

function show(v: unknown): string {
  return v === null || v === undefined || v === '' ? '(empty)' : typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** A record's audit history (kernel records/audits): newest first, who, when (local zone), what, and the changes. */
export class AuditScreen extends LinesScreen {
  readonly kind = 'audits'

  constructor(store: AppStore, readonly tableName: string, readonly primaryKey: string, label?: string) {
    super(store, `Audits · ${store.meta?.tables?.[tableName]?.label ?? tableName} ${label ?? primaryKey}`)
    this.refresh()
  }

  refresh(): void {
    const s = this.store
    this.start(async () => {
      const t = theme()
      const meta = await s.client!.tableMeta(this.tableName)
      const source = auditSource(meta as never, s.meta as never)
      if (!source) throw new Error(`No audit history is available for ${meta.label} (no audit process or table you may read).`)
      const { entries, total } = await getAudits(s.client!.server, s.client!.fetch, source, this.tableName, this.primaryKey)
      const rows: Row[] = [{ text: `${entries.length}${total !== null ? ` of ${total}` : ''} audit entr${entries.length === 1 ? 'y' : 'ies'}, newest first`, fg: t.dim }]
      for (const e of entries) {
        rows.push({ text: '' })
        rows.push({ text: `${displayDateTime(e.timestamp)}  ${e.user || '(unknown user)'}  ${e.action}`, fg: t.acc, bold: true, key: `a:${e.id}`, action: () => undefined })
        if (e.message) rows.push({ text: `  ${e.message}` })
        for (const c of e.changes) rows.push({ text: `  ${c.message ?? `${c.fieldName}: ${show(c.oldValue)} → ${show(c.newValue)}`}`, fg: t.fg })
      }
      return rows
    })
  }
}
