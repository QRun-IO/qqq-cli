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

function known(store: AppStore, kind: 'tables' | 'processes' | 'apps', name: string): boolean {
  const map = store.meta?.[kind] as Record<string, unknown> | undefined
  if (map?.[name]) return true
  store.flash(`no ${kind === 'tables' ? 'table' : kind === 'processes' ? 'process' : 'app'} named "${name}"`, 'error')
  return false
}

export function openTable(store: AppStore, table: string, filter?: QueryFilter): void {
  if (!known(store, 'tables', table)) return
  store.push(new TableScreen(store, table, filter))
}

export function openRecord(store: AppStore, table: string, primaryKey: string | undefined, options: { cursor?: ResultCursor; label?: string } = {}): void {
  if (!known(store, 'tables', table)) return
  store.push(new RecordScreen(store, table, primaryKey, options.cursor, options.label))
}

/** After a create: the new record replaces the form. */
export function replaceWithRecord(store: AppStore, table: string, primaryKey: string): void {
  store.replace(new RecordScreen(store, table, primaryKey))
}

export function openForm(store: AppStore, table: string, options: FormOptions & { initial?: FieldValues }): void {
  if (!known(store, 'tables', table)) return
  const meta = store.meta?.tables?.[table] as { insertPermission?: boolean; editPermission?: boolean } | undefined
  if (options.mode !== 'edit' && meta?.insertPermission === false) return store.flash('you may not create records in this table', 'error')
  if (options.mode === 'edit' && meta?.editPermission === false) return store.flash('you may not edit records of this table', 'error')
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
  else if (node.type === 'REPORT') store.commands().commandLine(`report run ${node.name} --format csv`)
  else store.flash(`${node.type} ${node.label} has no terminal screen yet`)
}
