/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A position in a query result: the table, its filter and sort, a page size, the index of the
 * current record and a cache of loaded pages. A grid pages through it; a record view opened from
 * the grid steps next and previous through the same result across page boundaries, and the grid
 * lands on the same row when the person goes back. Works for any query: a table, a saved view, a
 * filtered child list.
 */

import { callOperation } from '../api/call.js'
import type { QueryFilter } from '../filter/grammar.js'

/** A record as the query endpoint returns it. */
export interface QueryRecord {
  values: Record<string, unknown>
  displayValues?: Record<string, string>
  recordLabel?: string
  [key: string]: unknown
}

export interface ResultCursorOptions {
  baseUrl: string
  fetch: typeof fetch
  table: string
  /** Criteria, groups and order; skip and limit are managed by the cursor. */
  filter: QueryFilter
  pageSize: number
  primaryKeyField?: string
  index?: number
  total?: number
  /** Extra query parameters (tableVariant). */
  query?: Record<string, string | undefined>
}

export class ResultCursor {
  readonly table: string
  readonly filter: QueryFilter
  readonly primaryKeyField: string
  pageSize: number
  index: number
  total?: number
  private readonly baseUrl: string
  private readonly fetchImpl: typeof fetch
  private readonly query?: Record<string, string | undefined>
  private pages = new Map<number, QueryRecord[]>()

  constructor(options: ResultCursorOptions) {
    this.baseUrl = options.baseUrl
    this.fetchImpl = options.fetch
    this.table = options.table
    this.filter = { ...options.filter, skip: undefined, limit: undefined }
    this.pageSize = Math.max(1, options.pageSize)
    this.primaryKeyField = options.primaryKeyField ?? 'id'
    this.index = options.index ?? 0
    this.total = options.total
    this.query = options.query
  }

  /** The page number holding an index. */
  pageOf(index: number): number {
    return Math.floor(index / this.pageSize)
  }

  get pageCount(): number {
    return this.total === undefined ? 1 : Math.max(1, Math.ceil(this.total / this.pageSize))
  }

  /** Counts the matching records (also done by the first page load when unknown). */
  async count(): Promise<number> {
    const result = await callOperation(this.baseUrl, 'countTable', { path: { tableName: this.table }, query: this.query, json: { filter: this.wireFilter() } }, this.fetchImpl)
    this.total = Number((result.data as { count?: number }).count ?? 0)
    return this.total
  }

  /** One page of records, from the cache or the server. */
  async page(page: number, options: { refresh?: boolean } = {}): Promise<QueryRecord[]> {
    if (!options.refresh && this.pages.has(page)) return this.pages.get(page)!
    const filter = { ...this.wireFilter(), skip: page * this.pageSize, limit: this.pageSize }
    const [result] = await Promise.all([
      callOperation(this.baseUrl, 'queryTable', { path: { tableName: this.table }, query: this.query, json: { filter } }, this.fetchImpl),
      this.total === undefined || options.refresh ? this.count() : Promise.resolve(this.total),
    ])
    const records = ((result.data as { records?: QueryRecord[] }).records ?? [])
    this.pages.set(page, records)
    return records
  }

  /** Hands the cursor a page another component loaded with the same filter. */
  seed(page: number, records: QueryRecord[], total?: number): void {
    this.pages.set(page, records)
    if (total !== undefined) this.total = total
  }

  /** The record at an index (loading its page), or undefined past the end. */
  async at(index: number): Promise<QueryRecord | undefined> {
    if (index < 0 || (this.total !== undefined && index >= this.total)) return undefined
    const records = await this.page(this.pageOf(index))
    return records[index % this.pageSize]
  }

  async current(): Promise<QueryRecord | undefined> {
    return this.at(this.index)
  }

  /** Moves to the next record; stays and returns undefined at the end. */
  async next(): Promise<QueryRecord | undefined> {
    const record = await this.at(this.index + 1)
    if (record) this.index++
    return record
  }

  async previous(): Promise<QueryRecord | undefined> {
    if (this.index <= 0) return undefined
    const record = await this.at(this.index - 1)
    if (record) this.index--
    return record
  }

  /** The primary key of a record. */
  keyOf(record: QueryRecord | undefined): unknown {
    return record?.values?.[this.primaryKeyField]
  }

  /** The index of a primary key among the loaded pages, if loaded. */
  indexOfKey(key: unknown): number | undefined {
    for (const [page, records] of this.pages) {
      const at = records.findIndex((r) => String(this.keyOf(r)) === String(key))
      if (at >= 0) return page * this.pageSize + at
    }
    return undefined
  }

  /** After the record at `index` was deleted: one fewer, pages from there on reloaded; the index stays (now the next record). */
  removed(index: number): void {
    if (this.total !== undefined) this.total = Math.max(0, this.total - 1)
    const from = this.pageOf(index)
    for (const page of [...this.pages.keys()]) if (page >= from) this.pages.delete(page)
    if (this.total !== undefined && this.index >= this.total) this.index = Math.max(0, this.total - 1)
  }

  /** Drops every cached page (after a refresh or an edit that may reorder). */
  invalidate(): void {
    this.pages.clear()
    this.total = undefined
  }

  /** "record 4 of 1,234" (1-based). */
  describe(): string {
    return `record ${(this.index + 1).toLocaleString('en-US')} of ${this.total === undefined ? '…' : this.total.toLocaleString('en-US')}`
  }

  private wireFilter(): QueryFilter {
    const orderBys = this.filter.orderBys?.length ? this.filter.orderBys : [{ fieldName: this.primaryKeyField, isAscending: true }]
    const { skip: _skip, limit: _limit, ...rest } = this.filter
    return { ...rest, orderBys }
  }
}
