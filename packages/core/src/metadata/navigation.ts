/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Navigation listings from the instance metadata: an app's home (its sections of processes,
 * reports, tables and widgets, as the web UI's app home groups them), and the reports a user may run.
 */

type J = Record<string, unknown>

export interface AppSectionItem {
  type: 'TABLE' | 'PROCESS' | 'REPORT' | 'WIDGET' | 'APP'
  name: string
  label: string
}

export interface AppSection {
  name: string
  label: string
  items: AppSectionItem[]
}

export interface AppHome {
  name: string
  label: string
  sections: AppSection[]
  widgets: string[]
}

function label(metaData: J, type: string, name: string): string {
  const collection = type === 'TABLE' ? 'tables' : type === 'PROCESS' ? 'processes' : type === 'REPORT' ? 'reports' : type === 'WIDGET' ? 'widgets' : 'apps'
  const entry = ((metaData[collection] ?? {}) as Record<string, J>)[name]
  return String(entry?.label ?? name)
}

function visible(metaData: J, type: string, name: string): boolean {
  const collection = type === 'TABLE' ? 'tables' : type === 'PROCESS' ? 'processes' : type === 'REPORT' ? 'reports' : type === 'WIDGET' ? 'widgets' : 'apps'
  const entry = ((metaData[collection] ?? {}) as Record<string, J>)[name]
  if (!entry) return false
  if (entry.isHidden) return false
  if (type === 'TABLE') return entry.readPermission !== false
  return entry.hasPermission !== false
}

/**
 * An app's home: its declared sections (each listing tables, processes and reports by name) in
 * order; without sections, one section per kind from the app's children. Items the user may not
 * use, and hidden ones, are left out.
 */
export function appHome(metaData: J, appName: string): AppHome | undefined {
  const app = ((metaData.apps ?? {}) as Record<string, J>)[appName]
  if (!app) return undefined
  const sections: AppSection[] = []
  const declared = (app.sections ?? []) as J[]
  for (const section of declared) {
    const items: AppSectionItem[] = []
    for (const [key, type] of [['processes', 'PROCESS'], ['reports', 'REPORT'], ['tables', 'TABLE']] as const) {
      for (const name of (section[key] ?? []) as string[]) if (visible(metaData, type, name)) items.push({ type, name, label: label(metaData, type, name) })
    }
    if (items.length) sections.push({ name: String(section.name ?? ''), label: String(section.label ?? section.name ?? ''), items })
  }
  if (declared.length) {
    // sections list tables, processes and reports; child apps are only in the children
    const apps = ((app.children ?? []) as J[]).filter((c) => c.type === 'APP' && visible(metaData, 'APP', String(c.name)))
      .map((c) => ({ type: 'APP' as const, name: String(c.name), label: String(c.label ?? label(metaData, 'APP', String(c.name))) }))
    if (apps.length) sections.push({ name: 'apps', label: 'Apps', items: apps })
  }
  if (!declared.length) {
    const children = (app.children ?? []) as J[]
    for (const [type, sectionLabel] of [['PROCESS', 'Actions'], ['REPORT', 'Reports'], ['TABLE', 'Data'], ['APP', 'Apps']] as const) {
      const items = children.filter((c) => c.type === type && visible(metaData, type, String(c.name))).map((c) => ({ type, name: String(c.name), label: String(c.label ?? label(metaData, type, String(c.name))) }))
      if (items.length) sections.push({ name: type.toLowerCase(), label: sectionLabel, items })
    }
  }
  const widgets = ((app.widgets ?? []) as string[]).filter((w) => visible(metaData, 'WIDGET', w))
  return { name: appName, label: String(app.label ?? appName), sections, widgets }
}

export interface ReportListing {
  name: string
  label: string
  table: string
  app: string
}

/** The reports the user may run, each with the first app that lists it. */
export function listReports(metaData: J): ReportListing[] {
  const reports = Object.values((metaData.reports ?? {}) as Record<string, J>).filter((r) => !r.isHidden && r.hasPermission !== false)
  const appOf = new Map<string, string>()
  for (const app of Object.values((metaData.apps ?? {}) as Record<string, J>)) {
    for (const child of (app.children ?? []) as J[]) if (child.type === 'REPORT' && !appOf.has(String(child.name))) appOf.set(String(child.name), String(app.name))
    for (const section of (app.sections ?? []) as J[]) for (const r of (section.reports ?? []) as string[]) if (!appOf.has(r)) appOf.set(r, String(app.name))
  }
  return reports.map((r) => ({ name: String(r.name), label: String(r.label ?? r.name), table: String(r.tableName ?? ''), app: appOf.get(String(r.name)) ?? '' }))
    .sort((a, b) => a.label.localeCompare(b.label))
}

/** What a person can try on a table. */
export type TableAction = 'read' | 'insert' | 'edit' | 'delete'

const PERMISSION_FIELD: Record<TableAction, string> = { read: 'readPermission', insert: 'insertPermission', edit: 'editPermission', delete: 'deletePermission' }
const ACTION_TEXT: Record<TableAction, string> = { read: 'view', insert: 'create records in', edit: 'edit records in', delete: 'delete records from' }

/**
 * Why a table refuses an action, from its metadata (a table the user may not use but whose deny
 * behavior is DISABLED is listed with its permissions false), or undefined when it is allowed.
 * Copying a record needs insert permission.
 */
export function deniedTableReason(table: J, action: TableAction): string | undefined {
  if (table[PERMISSION_FIELD[action]] !== false) return undefined
  return `You do not have permission to ${ACTION_TEXT[action]} ${String(table.label ?? table.name)}.`
}

/** Why a process refuses to run (DISABLED: listed with hasPermission false), or undefined. */
export function deniedProcessReason(process: J): string | undefined {
  return process.hasPermission === false ? `You do not have permission to run ${String(process.label ?? process.name)}.` : undefined
}

/** Something one can open from navigation: an app, a table, a process or a report, with the app it sits in. */
export interface NavigationTarget {
  type: 'APP' | 'TABLE' | 'PROCESS' | 'REPORT'
  name: string
  label: string
  /** The label of the app it is listed under ('' when none). */
  app: string
}

/** Every navigable, permitted app, table, process and report (as the command palette lists them), with its app context. */
export function navigationTargets(metaData: J): NavigationTarget[] {
  const out: NavigationTarget[] = []
  const seen = new Set<string>()
  const apps = (metaData.apps ?? {}) as Record<string, J>
  const visit = (appName: string, trail: string[]) => {
    const app = apps[appName]
    if (!app || trail.includes(appName) || !visible(metaData, 'APP', appName)) return
    const appLabel = String(app.label ?? appName)
    if (!seen.has(`APP:${appName}`)) {
      seen.add(`APP:${appName}`)
      out.push({ type: 'APP', name: appName, label: appLabel, app: trail.length ? String(apps[trail[trail.length - 1]!]?.label ?? '') : '' })
    }
    const children = [...((app.children ?? []) as J[]), ...((app.sections ?? []) as J[]).flatMap((s) => [...((s.tables ?? []) as string[]).map((n) => ({ type: 'TABLE', name: n })), ...((s.processes ?? []) as string[]).map((n) => ({ type: 'PROCESS', name: n })), ...((s.reports ?? []) as string[]).map((n) => ({ type: 'REPORT', name: n }))])]
    for (const child of children) {
      const type = String(child.type)
      const name = String(child.name)
      if (type === 'APP') visit(name, [...trail, appName])
      else if ((type === 'TABLE' || type === 'PROCESS' || type === 'REPORT') && !seen.has(`${type}:${name}`) && visible(metaData, type, name)) {
        seen.add(`${type}:${name}`)
        out.push({ type, name, label: label(metaData, type, name), app: appLabel })
      }
    }
  }
  const tree = (metaData.appTree ?? []) as J[]
  const roots = tree.length ? tree.filter((n) => n.type === 'APP').map((n) => String(n.name)) : Object.keys(apps)
  for (const root of roots) visit(root, [])
  for (const name of Object.keys(apps)) visit(name, [])
  return out
}

/**
 * Finds navigation targets by label as the palette does: every word must appear in the label (or
 * name), case-insensitively; exact and prefix matches first, then by label.
 */
export function findNavigationTargets(metaData: J, text: string, types?: Array<NavigationTarget['type']>): NavigationTarget[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  const score = (t: NavigationTarget) => {
    const l = t.label.toLowerCase()
    return l === text.toLowerCase() ? 0 : l.startsWith(text.toLowerCase()) ? 1 : 2
  }
  return navigationTargets(metaData)
    .filter((t) => (!types || types.includes(t.type)) && words.every((w) => t.label.toLowerCase().includes(w) || t.name.toLowerCase().includes(w)))
    .sort((a, b) => score(a) - score(b) || a.label.localeCompare(b.label))
}

/** The landing page: counts of what the user may open, quick actions (permitted processes listed in apps) and one card per top-level app. */
export interface HomePage {
  counts: { apps: number; tables: number; processes: number; reports: number; widgets: number }
  quickActions: NavigationTarget[]
  apps: Array<{ name: string; label: string; tables: number; processes: number; reports: number; widgets: number; apps: number }>
}

export function homePage(metaData: J, quickActionLimit = 8): HomePage {
  const targets = navigationTargets(metaData)
  const count = (type: NavigationTarget['type']) => targets.filter((t) => t.type === type).length
  const widgets = Object.keys((metaData.widgets ?? {}) as J).filter((w) => visible(metaData, 'WIDGET', w)).length
  const tree = (metaData.appTree ?? []) as J[]
  const roots = (tree.length ? tree.filter((n) => n.type === 'APP').map((n) => String(n.name)) : Object.keys((metaData.apps ?? {}) as J)).filter((a) => visible(metaData, 'APP', a))
  const apps = roots.map((name) => {
    const home = appHome(metaData, name)!
    const items = home.sections.flatMap((s) => s.items)
    return { name, label: home.label, tables: items.filter((i) => i.type === 'TABLE').length, processes: items.filter((i) => i.type === 'PROCESS').length, reports: items.filter((i) => i.type === 'REPORT').length, widgets: home.widgets.length, apps: items.filter((i) => i.type === 'APP').length }
  })
  return { counts: { apps: count('APP'), tables: count('TABLE'), processes: count('PROCESS'), reports: count('REPORT'), widgets }, quickActions: targets.filter((t) => t.type === 'PROCESS').slice(0, quickActionLimit), apps }
}
