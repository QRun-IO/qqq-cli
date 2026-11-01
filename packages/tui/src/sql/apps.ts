/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Where the SQL Runner shows up: the apps whose page is a SQL_WORKBENCH widget (the Runner of the
 * qbit-sql-workbench app). Without the `sql-workbench` UI API extension those apps are taken out
 * of the metadata the TUI shows, so the tree, the palette and the app cards do not offer a screen
 * that cannot work. No drawing here: the store imports it.
 */

import type { MetaDataDocument } from '@qrun-io/qqq-core'

export const SQL_EXTENSION = 'sql-workbench'
export const SQL_WIDGET_TYPE = 'SQL_WORKBENCH'

type Apps = Record<string, { widgets?: string[]; children?: Array<{ name: string; type: string }>; childMap?: Record<string, unknown> }>
type Widgets = Record<string, { type?: string }>
interface TreeNode { type: string; name: string; children?: TreeNode[] }

/** The apps whose page carries a SQL_WORKBENCH widget. */
export function runnerApps(meta: MetaDataDocument | undefined): string[] {
  const apps = (meta?.apps ?? {}) as Apps
  const widgets = (meta?.widgets ?? {}) as Widgets
  return Object.entries(apps).filter(([, a]) => (a.widgets ?? []).some((w) => widgets[w]?.type === SQL_WIDGET_TYPE)).map(([name]) => name)
}

/** Whether an app is a Runner page. */
export function isRunnerApp(meta: MetaDataDocument | undefined, name: string): boolean {
  return runnerApps(meta).includes(name)
}

/** Whether a widget is a SQL_WORKBENCH widget (search hits on it open the Runner). */
export function isRunnerWidget(meta: MetaDataDocument | undefined, name: string): boolean {
  return ((meta?.widgets ?? {}) as Widgets)[name]?.type === SQL_WIDGET_TYPE
}

/** The metadata without the Runner apps and their SQL_WORKBENCH widgets when the extension is absent (unchanged when it is installed or there are none). */
export function hideRunnerApps(meta: MetaDataDocument, installed: boolean): MetaDataDocument {
  if (installed) return meta
  const hidden = new Set(runnerApps(meta))
  if (!hidden.size) return meta
  const prune = (nodes: TreeNode[] | undefined): TreeNode[] | undefined => nodes?.filter((n) => !(n.type === 'APP' && hidden.has(n.name))).map((n) => (n.children ? { ...n, children: prune(n.children) } : n))
  const apps: Apps = {}
  for (const [name, app] of Object.entries((meta.apps ?? {}) as Apps)) {
    if (hidden.has(name)) continue
    const childMap = app.childMap ? Object.fromEntries(Object.entries(app.childMap).filter(([k]) => !hidden.has(k))) : undefined
    apps[name] = { ...app, ...(app.children ? { children: app.children.filter((c) => !(c.type === 'APP' && hidden.has(c.name))) } : {}), ...(childMap ? { childMap } : {}) }
  }
  const widgets = Object.fromEntries(Object.entries((meta.widgets ?? {}) as Widgets).filter(([, w]) => w?.type !== SQL_WIDGET_TYPE))
  return { ...meta, apps, widgets, appTree: prune(meta.appTree as TreeNode[] | undefined) } as MetaDataDocument
}
