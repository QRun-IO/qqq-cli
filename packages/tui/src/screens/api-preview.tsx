/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The first rows of an API-versioned report setup, read through the application API's query and count. */

import { formatTable, type QueryFilter } from '@qrun-io/qqq-core'
import type { AppStore } from '../store'
import { theme } from '../theme'
import type { Row } from './list'
import { LinesScreen } from './lines'

type J = Record<string, unknown>

export class ApiPreviewScreen extends LinesScreen {
  readonly kind = 'api-preview'

  constructor(store: AppStore, private base: string, readonly tableName: string, private filter: QueryFilter) {
    super(store, `Preview · ${tableName} (application API)`)
    this.refresh()
  }

  refresh(): void {
    const c = this.store.client!
    const t = theme()
    this.start(async () => {
      const post = async (path: string, body: unknown) => {
        const r = await c.fetch(`${c.server}${this.base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        if (!r.ok) throw new Error(`the API answered ${r.status}`)
        return await r.json() as J
      }
      const [q, n] = await Promise.all([post('/query', { filter: { ...this.filter, limit: 50 } }), post('/count', { filter: this.filter }).catch((): J => ({}))])
      const records = ((q.records ?? []) as Array<{ values?: J }>).map((r) => r.values ?? {})
      const columns = [...new Set(records.flatMap((r) => Object.keys(r)))].slice(0, 10)
      const rows: Row[] = [{ text: `${String(n.count ?? records.length)} records (first ${records.length} shown)`, fg: t.acc, bold: true }]
      for (const l of formatTable(records.map((r) => Object.fromEntries(columns.map((k) => [k, r[k] === null || r[k] === undefined ? '' : String(r[k])]))), columns).split('\n')) rows.push({ text: l })
      return rows
    })
  }
}
