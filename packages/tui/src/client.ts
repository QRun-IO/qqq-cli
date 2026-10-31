/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The TUI's view of one server, entirely through the kernel: every call is a UI API operation by
 * id (callOperation), metadata comes through the kernel's on-disk cache, and authentication is the
 * kernel's login fetch. Tests construct it with a fake fetch.
 */

import { callOperation, getMetaData, getTableMetaData, type CallInput, type CallResult, type MetaDataDocument, type ProcessMeta, type QueryFilter, type QueryRecord } from '@qrun-io/qqq-core'

export const TUI_VERSION = '0.1.0-dev'
export const TUI_CHANNEL = `tui/qqq ${TUI_VERSION}`

export type Json = Record<string, unknown>

export interface FieldMetaData {
  name: string
  label: string
  type: string
  isRequired?: boolean
  isEditable?: boolean | null
  isHidden?: boolean
  isHeavy?: boolean
  possibleValueSourceName?: string | null
  adornments?: Array<{ type: string; values?: Json }> | null
  helpContents?: Array<{ contentAsText?: string; content?: string; roles?: string[] | null }> | null
  [key: string]: unknown
}

export interface SectionMetaData {
  name: string
  label: string
  tier?: string
  fieldNames?: string[]
  hidden?: boolean
  widgetName?: string
  [key: string]: unknown
}

export interface Association {
  name: string
  associatedTableName: string
  join?: { name?: string; type?: string; leftTable?: string; rightTable?: string; joinOns?: Array<{ leftField: string; rightField: string }> }
  label?: string
}

export interface TableMetaData {
  name: string
  label: string
  primaryKeyField: string
  fields: Record<string, FieldMetaData>
  sections?: SectionMetaData[]
  associations?: Association[] | null
  capabilities?: string[]
  insertPermission?: boolean
  editPermission?: boolean
  deletePermission?: boolean
  helpContents?: Array<{ contentAsText?: string }> | null
  [key: string]: unknown
}

export interface AppTreeNode {
  type: string
  name: string
  label: string
  children?: AppTreeNode[]
}

export interface VersionInfo {
  apiVersion: string
  features?: string[]
  extensions?: Array<{ name: string; version: string; pathPrefix?: string; description?: string }>
}

export class TuiClient {
  readonly server: string
  readonly fetch: typeof fetch
  private readonly useCache: boolean
  private tableCache = new Map<string, TableMetaData>()
  private processCache = new Map<string, ProcessMeta>()
  metaDataFetchedAt?: number

  constructor(options: { server: string; fetch: typeof fetch; useCache?: boolean }) {
    this.server = options.server
    this.fetch = options.fetch
    this.useCache = options.useCache ?? true
  }

  call(id: string, input: CallInput = {}): Promise<CallResult> {
    return callOperation(this.server, id, input, this.fetch)
  }

  async data<T = Json>(id: string, input: CallInput = {}): Promise<T> {
    return (await this.call(id, input)).data as T
  }

  version(): Promise<VersionInfo> {
    return this.data<VersionInfo>('getVersion')
  }

  async metaData(refresh = false): Promise<MetaDataDocument> {
    const doc = this.useCache ? await getMetaData(this.server, this.fetch, { refresh }) : await this.data<MetaDataDocument>('getMetaData')
    this.metaDataFetchedAt = Date.now()
    return doc
  }

  async tableMeta(table: string, refresh = false): Promise<TableMetaData> {
    if (!refresh && this.tableCache.has(table)) return this.tableCache.get(table)!
    const meta = this.useCache ? await getTableMetaData<TableMetaData>(this.server, table, this.fetch, { refresh }) : await this.data<TableMetaData>('getTableMetaData', { path: { tableName: table } })
    this.tableCache.set(table, meta)
    return meta
  }

  async processMeta(name: string): Promise<ProcessMeta> {
    if (this.processCache.has(name)) return this.processCache.get(name)!
    const meta = await this.data<ProcessMeta>('getProcessMetaData', { path: { processName: name } })
    this.processCache.set(name, meta)
    return meta
  }

  clearCaches(): void {
    this.tableCache.clear()
    this.processCache.clear()
  }

  async query(table: string, filter: QueryFilter): Promise<QueryRecord[]> {
    return ((await this.data<{ records?: QueryRecord[] }>('queryTable', { path: { tableName: table }, json: { filter } })).records ?? [])
  }

  async count(table: string, filter: QueryFilter): Promise<number> {
    return Number((await this.data<{ count?: number }>('countTable', { path: { tableName: table }, json: { filter } })).count ?? 0)
  }

  async record(table: string, primaryKey: unknown, associations = false): Promise<QueryRecord & { associatedRecords?: Record<string, QueryRecord[]> }> {
    const data = await this.data<Json>('getRecord', { path: { tableName: table, primaryKey: String(primaryKey) }, query: associations ? { includeAssociations: 'true' } : undefined })
    return (data.record ?? data) as QueryRecord
  }

  async insert(table: string, values: Json): Promise<QueryRecord> {
    const data = await this.data<Json>('insertRecord', { path: { tableName: table }, json: values })
    return (data.record ?? data) as QueryRecord
  }

  async update(table: string, primaryKey: unknown, values: Json): Promise<QueryRecord> {
    const data = await this.data<Json>('updateRecord', { path: { tableName: table, primaryKey: String(primaryKey) }, json: values })
    return (data.record ?? data) as QueryRecord
  }

  async remove(table: string, primaryKey: unknown): Promise<void> {
    await this.call('deleteRecord', { path: { tableName: table, primaryKey: String(primaryKey) } })
  }

  async export(table: string, format: string, filter: QueryFilter, fieldNames?: string[]): Promise<{ bytes: Uint8Array; contentType: string }> {
    const result = await this.call('exportTable', { path: { tableName: table }, json: { format, filter, fieldNames } })
    const bytes = result.bytes ?? new TextEncoder().encode(typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
    return { bytes, contentType: result.contentType }
  }

  widget(name: string, input: Json = {}): Promise<Json> {
    return this.data<Json>('getWidgetData', { path: { widgetName: name }, json: input })
  }

  async ping(): Promise<number> {
    const t = performance.now()
    await this.call('getVersion')
    return performance.now() - t
  }
}
