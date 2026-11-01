/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The title-bar path of a screen (apps, table, record), shared by the title bar and printed headers. */

import type { AppTreeNode } from './client'
import type { AppStore } from './store'

/** The apps above a table, process or app in the app tree (labels, outermost first). */
export function appPath(nodes: AppTreeNode[], name: string, type: string, path: string[] = []): string[] | undefined {
  for (const n of nodes) {
    if (n.name === name && n.type === type) return path
    if (n.children) {
      const found = appPath(n.children, name, type, [...path, n.label])
      if (found) return found
    }
  }
  return undefined
}

/** The title-bar path of the top screen: its apps, the table, then the record or form. */
export function breadcrumbs(store: AppStore): string[] {
  const top = store.screen as (import('./types').Screen & { tableName?: string; processName?: string; appName?: string }) | undefined
  if (!top) return []
  const tree = (store.meta?.appTree ?? []) as AppTreeNode[]
  const tableLabel = top.tableName ? store.meta?.tables?.[top.tableName]?.label ?? top.tableName : undefined
  if (top.kind === 'table') return [...(appPath(tree, top.tableName!, 'TABLE') ?? []), top.title()]
  if (top.kind === 'record') return [...(appPath(tree, top.tableName!, 'TABLE') ?? []), tableLabel!, top.title()]
  if (top.kind === 'form') return [...(appPath(tree, top.tableName!, 'TABLE') ?? []), top.title()]
  if (top.kind === 'process') return [...(appPath(tree, top.processName!, 'PROCESS') ?? []), top.title()]
  if (top.kind === 'app') return [...(appPath(tree, top.appName!, 'APP') ?? []), top.title()]
  return [top.title()]
}
