/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Named actions that keys bind to: the Shift bank (shift-bank.ts) binds by name, and so can any other
 * key (F12 and Ctrl+G bind `assistant.toggle`). Each action says whether it applies on the current
 * screen; one that does not says why, and the bar dims its key.
 */

import { openForm, permits } from '../nav'
import { openHistory } from '../history/screen'
import { openSqlRunner, sqlWorkbenchInstalled } from '../sql/entry'
import type { AppStore } from '../store'
import type { MenuEntry } from '../types'

export interface NamedAction {
  /** Why it does not apply here; undefined when it does. */
  unavailable(store: AppStore): string | undefined
  run(store: AppStore): void
}

/** The parts of the table grid the actions use (screens/table.tsx). */
interface GridLike {
  kind: string
  tableName: string
  meta?: unknown
  currentRecord?: unknown
  keyOf?(record: unknown): string | undefined
  bulkActions?(): void
  bulkEntries?(): MenuEntry[]
  tableProcesses?(): unknown[]
  savedViews?(): void
  exportDialog?(): void
  variant?: unknown
}

/** The parts of the record view the actions use (screens/record.tsx). */
interface RecordLike {
  kind: string
  tableName: string
  primaryKey?: string
  meta?: unknown
  tableVariant?: string
}

function grid(store: AppStore): GridLike | undefined {
  const s = store.screen as unknown as GridLike | undefined
  return s?.kind === 'table' ? s : undefined
}

function record(store: AppStore): RecordLike | undefined {
  const s = store.screen as unknown as RecordLike | undefined
  return s?.kind === 'record' ? s : undefined
}

/** The record to copy: the record on screen, or the grid row under the cursor. */
function copySource(store: AppStore): { table: string; key: string; meta: unknown; tableVariant?: string } | undefined {
  const r = record(store)
  if (r?.primaryKey !== undefined) return { table: r.tableName, key: r.primaryKey, meta: r.meta, tableVariant: r.tableVariant }
  const g = grid(store)
  const key = g?.keyOf?.(g.currentRecord)
  return g && key !== undefined ? { table: g.tableName, key, meta: g.meta } : undefined
}

export const ACTIONS = {
  'help.keys': {
    unavailable: () => undefined,
    run: (s) => s.commands().help(),
  },
  servers: {
    unavailable: () => undefined,
    run: (s) => s.commands().servers(),
  },
  'sql.open': {
    unavailable: (s) => sqlWorkbenchInstalled(s) ? undefined : 'needs the sql-workbench extension',
    run: (s) => openSqlRunner(s),
  },
  'grid.bulk': {
    unavailable: (s) => {
      const g = grid(s)
      if (!g) return 'bulk actions work on a table grid'
      return (g.bulkEntries?.().length ?? 0) + (g.tableProcesses?.().length ?? 0) ? undefined : 'this table has no bulk actions or processes'
    },
    run: (s) => grid(s)?.bulkActions?.(),
  },
  'meta.refresh': {
    unavailable: (s) => s.client ? undefined : 'not connected',
    run: (s) => s.run(s.client!.metaData(true), (m) => {
      s.setMeta(m)
      s.client!.clearCaches()
      s.flash('metadata refreshed')
    }),
  },
  'grid.views': {
    unavailable: (s) => grid(s) ? undefined : 'saved views work on a table grid',
    run: (s) => grid(s)?.savedViews?.(),
  },
  'record.copy': {
    unavailable: (s) => {
      const src = copySource(s)
      if (!src) return 'copy works on a record or a grid row'
      return permits(src.meta as never, 'insert') ? undefined : 'copying needs permission to create records'
    },
    run: (s) => {
      const src = copySource(s)
      if (src) openForm(s, src.table, { mode: 'copy', primaryKey: src.key, ...(src.tableVariant ? { tableVariant: src.tableVariant } : {}) })
    },
  },
  export: {
    unavailable: (s) => grid(s) ? undefined : 'export works on a table grid',
    run: (s) => grid(s)?.exportDialog?.(),
  },
  history: {
    unavailable: () => undefined,
    run: (s) => openHistory(s),
  },
  'assistant.toggle': {
    unavailable: (s) => s.extensions.has('assistant') ? undefined : 'needs the assistant extension',
    run: (s) => s.toggleAssistant(),
  },
} satisfies Record<string, NamedAction>

export type ActionName = keyof typeof ACTIONS

/** Runs a named action, or says why it does not apply here. */
export function runAction(store: AppStore, name: ActionName, label: string = name): void {
  const action: NamedAction = ACTIONS[name]
  const why = action.unavailable(store)
  if (why) return store.flash(`${label}: ${why}`)
  action.run(store)
}
