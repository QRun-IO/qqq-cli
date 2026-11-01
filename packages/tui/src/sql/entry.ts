/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** Opening the SQL Runner: from its app, `/`, F9 › Work and `:sql`, only with the extension installed. */

import type { AppStore } from '../store'
import type { MenuEntry } from '../types'
import { SQL_EXTENSION } from './apps'
import { SqlRunnerScreen } from './screen'

export function sqlWorkbenchInstalled(store: AppStore): boolean {
  return store.extensions.has(SQL_EXTENSION)
}

/** What `:sql` says without the extension. */
export function sqlMissingText(store: AppStore): string {
  return `The SQL Runner needs the sql-workbench extension (qbit-sql-workbench), which this server does not have (installed: ${store.extensions.describe() || 'none'}).`
}

/** Opens the runner (or, when it is already on top, loads the SQL into it). */
export function openSqlRunner(store: AppStore, options: { sql?: string; run?: boolean; notebookId?: number } = {}): void {
  if (!sqlWorkbenchInstalled(store)) return store.flash(sqlMissingText(store), 'error')
  const top = store.screen
  if (top instanceof SqlRunnerScreen) {
    if (options.notebookId !== undefined) top.openNotebook(options.notebookId)
    else if (options.sql) {
      top.addCell('SQL', options.sql)
      if (options.run) top.run()
    }
    return store.bump()
  }
  store.push(new SqlRunnerScreen(store, options))
}

/** `:sql`, `:sql <statement>` (opens and runs it), `:sql open <notebook id>`. */
export function sqlCommand(store: AppStore, rest: string): void {
  const text = rest.trim()
  const open = /^open\s+(\d+)$/i.exec(text)
  if (open) return openSqlRunner(store, { notebookId: Number(open[1]) })
  openSqlRunner(store, text ? { sql: text, run: true } : {})
}

/** The F9 › Work entry (and through it the palette's commands); none without the extension. */
export function sqlMenuEntries(store: AppStore): MenuEntry[] {
  if (!sqlWorkbenchInstalled(store)) return []
  return [{ id: 'work:sql', section: 'Work', label: 'SQL Runner', detail: 'SQL notebook over the instance\'s databases', command: 'sql', run: () => openSqlRunner(store) }]
}
