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
