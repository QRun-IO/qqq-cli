/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A data bag's versions (newest first: sequence, message, when, author) and the selected
 * version's contents (JSON pretty-printed), as the dataBagViewer widget shows them; Enter on a
 * version shows its contents.
 */

import { displayDateTime } from '@qrun-io/qqq-core'
import type { AppStore } from '../store'
import { theme } from '../theme'
import type { Row } from './list'
import { LinesScreen } from './lines'

type J = Record<string, unknown>

function pretty(value: unknown): string[] {
  if (value === null || value === undefined || value === '') return ['(empty)']
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  try {
    return JSON.stringify(JSON.parse(text), null, 2).split('\n')
  } catch {
    return text.split('\n')
  }
}

export class DataBagScreen extends LinesScreen {
  readonly kind = 'data-bag'
  selected?: string

  constructor(store: AppStore, readonly dataBagId: string) {
    super(store, `Data bag ${dataBagId}`)
    this.refresh()
  }

  refresh(): void {
    const c = this.store.client!
    const t = theme()
    this.start(async () => {
      const bag = await c.record('dataBag', this.dataBagId, false).catch(() => undefined) as { values?: J } | undefined
      if (!bag) return [{ text: 'No such data bag.', fg: t.err }]
      const versions = (await c.query('dataBagVersion', { criteria: [{ fieldName: 'dataBagId', operator: 'EQUALS', values: [this.dataBagId] }], booleanOperator: 'AND', orderBys: [{ fieldName: 'sequenceNo', isAscending: false }], limit: 25 } as never)) as unknown as Array<{ values: J }>
      const rows: Row[] = [{ text: `${String(bag.values?.name ?? this.dataBagId)} · ${versions.length} version${versions.length === 1 ? '' : 's'}`, fg: t.acc, bold: true }]
      const chosen = versions.find((v) => String(v.values.id) === this.selected) ?? versions[0]
      for (const v of versions) {
        const id = String(v.values.id)
        rows.push({ text: `${id === String(chosen?.values.id) ? '▶' : ' '} Version ${String(v.values.sequenceNo)}${v === versions[0] ? ' (current)' : ''}  ${String(v.values.commitMessage ?? '')}  ${displayDateTime(v.values.createDate)}${v.values.author ? ` · ${String(v.values.author)}` : ''}`, key: `v:${id}`, action: () => { this.selected = id; this.refresh() } })
      }
      if (chosen) {
        const full = 'data' in chosen.values ? chosen.values : ((await c.record('dataBagVersion', String(chosen.values.id), false)) as { values?: J }).values ?? {}
        rows.push({ text: '' }, { text: `Contents of version ${String(chosen.values.sequenceNo)}`, fg: t.acc, bold: true })
        for (const l of pretty(full.data)) rows.push({ text: `  ${l}` })
      }
      return rows
    })
  }
}
