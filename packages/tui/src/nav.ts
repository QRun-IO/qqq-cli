/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** Opening screens: the one place that knows which screen shows what. */

import type { FieldValues, QueryFilter, ResultCursor } from '@qrun-io/qqq-core'
import type { AppTreeNode } from './client'
import { AppHomeScreen } from './screens/app-home'
import { FormScreen, type FormOptions } from './screens/form'
import { ProcessScreen, type ProcessOptions } from './screens/process'
import { RecordScreen } from './screens/record'
import { TableScreen } from './screens/table'
import type { AppStore } from './store'

/**
 * Whether a table, process or app can be opened: unknown names (hidden from this user: not in
 * the metadata) are refused; disabled ones (hasPermission false) are listed but explain the denial.
 */
function known(store: AppStore, kind: 'tables' | 'processes' | 'apps', name: string): boolean {
  const map = store.meta?.[kind] as Record<string, { hasPermission?: boolean; label?: string }> | undefined
  const what = kind === 'tables' ? 'table' : kind === 'processes' ? 'process' : 'app'
  const entry = map?.[name]
  if (entry && entry.hasPermission === false) {
    store.message(`You do not have permission to ${kind === 'processes' ? 'run' : 'view'} ${entry.label ?? name}.`, 'error', 'Permission denied')
    return false
  }
  if (entry) return true
  store.flash(`no ${what} named "${name}"`, 'error')
  return false
}

type TableOp = 'insert' | 'edit' | 'delete'
const CAPABILITY: Record<TableOp, string> = { insert: 'TABLE_INSERT', edit: 'TABLE_UPDATE', delete: 'TABLE_DELETE' }
const PERMISSION: Record<TableOp, 'insertPermission' | 'editPermission' | 'deletePermission'> = { insert: 'insertPermission', edit: 'editPermission', delete: 'deletePermission' }

/** Whether the user may insert, edit or delete in a table: its permission flag and (when listed) its capabilities. */
export function permits(meta: { insertPermission?: boolean; editPermission?: boolean; deletePermission?: boolean; capabilities?: string[] } | undefined, op: TableOp): boolean {
  if (!meta) return true
  if (meta[PERMISSION[op]] === false) return false
  if (Array.isArray(meta.capabilities) && meta.capabilities.length && !meta.capabilities.includes(CAPABILITY[op])) return false
  return true
}

export function openTable(store: AppStore, table: string, filter?: QueryFilter): void {
  if (!known(store, 'tables', table)) return
  store.push(new TableScreen(store, table, filter))
}

export function openRecord(store: AppStore, table: string, primaryKey: string | undefined, options: { cursor?: ResultCursor; label?: string; tableVariant?: string } = {}): void {
  if (!known(store, 'tables', table)) return
  store.push(new RecordScreen(store, table, primaryKey, options.cursor, options.label, options.tableVariant))
}

/** After a create: the new record replaces the form. */
export function replaceWithRecord(store: AppStore, table: string, primaryKey: string): void {
  store.replace(new RecordScreen(store, table, primaryKey))
}

export function openForm(store: AppStore, table: string, options: FormOptions & { initial?: FieldValues }): void {
  if (!known(store, 'tables', table)) return
  const meta = store.meta?.tables?.[table] as Parameters<typeof permits>[0]
  if (options.mode !== 'edit' && !permits(meta, 'insert')) return store.flash(options.mode === 'copy' ? 'copying needs permission to create records in this table' : 'you may not create records in this table', 'error')
  if (options.mode === 'edit' && !permits(meta, 'edit')) return store.flash('you may not edit records of this table', 'error')
  store.push(new FormScreen(store, table, options))
}

export function openProcess(store: AppStore, name: string, options: ProcessOptions = {}): void {
  if (!known(store, 'processes', name)) return
  store.push(new ProcessScreen(store, name, options))
}

export function openApp(store: AppStore, name: string): void {
  if (!known(store, 'apps', name)) return
  store.push(new AppHomeScreen(store, name))
}

export function openNode(store: AppStore, node: AppTreeNode): void {
  if (node.type === 'TABLE') openTable(store, node.name)
  else if (node.type === 'PROCESS') openProcess(store, node.name)
  else if (node.type === 'APP') openApp(store, node.name)
  else if (node.type === 'REPORT') void import('./screens/report').then((r) => r.openReport(store, node.name))
  else store.flash(`${node.type} ${node.label} has no terminal screen yet`)
}
