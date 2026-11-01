/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Loads widgets as the web's ConnectedWidget does and turns them into render blocks: the
 * widget's metadata decides first (unknown or denied widgets make no request), the payload is
 * fetched once with the record and dropdown parameters, parent widgets load their children
 * (skipping unknown and denied ones without a request), and the viewer widgets (data bag,
 * script) read the records they show.
 */

import { callOperation } from '../api/call.js'
import { widgetToBlocks, type RenderBlock } from './render-model.js'

type J = Record<string, unknown>

/** One loaded widget: its blocks and the facts a dashboard lays out by. */
export interface LoadedWidget {
  name: string
  label: string
  type: string
  /** Twelfths of the row the widget takes (`gridColumns`, default 12). */
  gridColumns: number
  /** A card (the default) or plain (isCard=false). */
  isCard: boolean
  blocks: RenderBlock[]
  /** The payload as the server sent it (undefined when no request was made). */
  data?: unknown
  /** Why the widget was not requested (unknown, no permission). */
  skipped?: string
  error?: string
}

export interface LoadWidgetOptions {
  /** The widgets entry of `GET /metaData` (name to metadata). */
  widgets: Record<string, J>
  /** Request parameters: the record id, the table name, dropdown selections. */
  params?: Record<string, string>
  /** The hosting record (values) for cronUI, pivotTableSetup, filterAndColumnsSetup, dynamicForm. */
  record?: J
  /** How deep parent widgets may nest (default 3). */
  depth?: number
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
}

/** Loads one widget (and, for a parent widget, its children). */
export async function loadWidget(baseUrl: string, fetchImpl: typeof fetch, name: string, options: LoadWidgetOptions): Promise<LoadedWidget> {
  const meta = options.widgets[name]
  const base = { name, label: String(meta?.label ?? name), type: String(meta?.type ?? ''), gridColumns: Number(meta?.gridColumns ?? 12) || 12, isCard: meta?.isCard !== false }
  if (!meta) return { ...base, blocks: [{ kind: 'alert', level: 'warning', text: `Unknown widget ${name}` }], skipped: 'unknown widget' }
  if (meta.hasPermission === false) return { ...base, blocks: [{ kind: 'heading', text: base.label }, { kind: 'alert', level: 'warning', text: 'You do not have permission to view this data.' }], skipped: 'no permission' }
  let data: J
  try {
    data = (await callOperation(baseUrl, 'getWidgetData', { path: { widgetName: name }, json: options.params ?? {} }, fetchImpl)).data as J
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return { ...base, blocks: [{ kind: 'heading', text: base.label }, { kind: 'alert', level: 'error', text: `An error occurred loading widget content. ${text}` }], error: text }
  }
  const type = String(meta.type ?? data?.type ?? '')
  const blocks = widgetToBlocks(data, { meta, record: options.record })
  if ((type === 'parentWidget') && Array.isArray(data?.childWidgetNameList) && data.hasPermission !== false && !data.dropdownNeedsSelectedText) {
    const names = data.childWidgetNameList as string[]
    const depth = options.depth ?? 3
    const children = depth > 0 ? await Promise.all(names.map((child) => loadWidget(baseUrl, fetchImpl, child, { ...options, depth: depth - 1 }))) : []
    const shown = children.filter((child) => !child.skipped)
    const skipped = children.filter((child) => child.skipped).map((child) => `${child.name} (${child.skipped})`)
    const head = blocks.filter((b) => b.kind === 'heading')
    const tabs = data.layoutType === 'TABS'
    return { ...base, type, data, blocks: [...head, ...(shown.length ? [{ kind: 'children', blocks: shown.map((child) => [{ kind: 'heading', text: `${tabs ? 'Tab: ' : ''}${child.label}`, sub: tabs ? undefined : `${child.gridColumns}/12` } as RenderBlock, ...child.blocks.filter((b, i) => !(i === 0 && b.kind === 'heading'))]) } as RenderBlock] : [{ kind: 'text', text: 'No child widgets to show' } as RenderBlock]), ...(skipped.length ? [{ kind: 'text', text: `skipped: ${skipped.join(', ')}` } as RenderBlock] : [])] }
  }
  if (type === 'dataBagViewer') return { ...base, type, data, blocks: [...blocks.filter((b) => b.kind === 'heading'), ...await dataBagBlocks(baseUrl, fetchImpl, (data.queryParams as J | undefined)?.id ?? options.params?.id)] }
  if (type === 'scriptViewer') return { ...base, type, data, blocks: [...blocks.filter((b) => b.kind === 'heading'), ...await scriptViewerBlocks(baseUrl, fetchImpl, (data.queryParams as J | undefined)?.id ?? options.params?.id)] }
  return { ...base, type, data, blocks }
}

async function getRecord(baseUrl: string, fetchImpl: typeof fetch, table: string, id: unknown): Promise<J | undefined> {
  try {
    const data = (await callOperation(baseUrl, 'getRecord', { path: { tableName: table, primaryKey: String(id) } }, fetchImpl)).data as J
    return (data.record ?? data) as J
  } catch {
    return undefined
  }
}

async function query(baseUrl: string, fetchImpl: typeof fetch, table: string, filter: J): Promise<J[]> {
  const data = (await callOperation(baseUrl, 'queryTable', { path: { tableName: table }, json: { filter } }, fetchImpl)).data as J
  return (data.records ?? []) as J[]
}

const v = (r: J | undefined): J => ((r?.values ?? r ?? {}) as J)

/** The dataBagViewer: the bag's versions (newest first, the newest is current) and the current version's data. */
export async function dataBagBlocks(baseUrl: string, fetchImpl: typeof fetch, id: unknown, versionNo?: string): Promise<RenderBlock[]> {
  if (id === undefined || id === null || id === '') return [{ kind: 'text', text: 'No data bag was specified.' }]
  const bag = await getRecord(baseUrl, fetchImpl, 'dataBag', id)
  if (!bag) return [{ kind: 'text', text: 'Data bag data could not be found.' }]
  let versions: J[]
  try {
    versions = await query(baseUrl, fetchImpl, 'dataBagVersion', { criteria: [{ fieldName: 'dataBagId', operator: 'EQUALS', values: [id] }], orderBys: [{ fieldName: 'sequenceNo', isAscending: false }], booleanOperator: 'AND', skip: 0, limit: 25 })
  } catch {
    return [{ kind: 'text', text: 'Error loading data bag data.' }]
  }
  if (!versions.length) return [{ kind: 'text', text: 'There are not any versions of this data bag.' }]
  const rows = versions.map((r, i) => ({ version: `Version ${str(v(r).sequenceNo)}${i === 0 ? ' (current)' : ''}`, message: str(v(r).commitMessage), created: str(v(r).createDate), author: str((r.displayValues as J | undefined)?.author ?? v(r).author) }))
  const chosen = (versionNo ? versions.find((r) => str(v(r).sequenceNo) === versionNo) : versions[0]) ?? versions[0]!
  let data = v(chosen).data
  if (data === undefined || data === null) data = v(await getRecord(baseUrl, fetchImpl, 'dataBagVersion', v(chosen).id)).data
  const parsed = typeof data === 'string' ? (() => { try { return JSON.stringify(JSON.parse(data as string), null, 2) } catch { return data as string } })() : data === undefined || data === null ? '' : JSON.stringify(data, null, 2)
  return [
    { kind: 'text', text: str(v(bag).name ?? v(bag).id) },
    { kind: 'table', columns: ['version', 'message', 'created', 'author'], headers: ['Version', 'Message', 'Created', 'Author'], rows },
    { kind: 'heading', text: `Version ${str(v(chosen).sequenceNo)}` },
    { kind: 'text', text: parsed || 'This version has no contents.' },
  ]
}

/** The scriptViewer: the script's revisions (current marked) and the current revision's files. */
export async function scriptViewerBlocks(baseUrl: string, fetchImpl: typeof fetch, id: unknown, revisionNo?: string): Promise<RenderBlock[]> {
  if (id === undefined || id === null || id === '') return [{ kind: 'text', text: 'No script was specified.' }]
  const script = await getRecord(baseUrl, fetchImpl, 'script', id)
  if (!script) return [{ kind: 'text', text: 'Script could not be found.' }]
  let revisions: J[]
  try {
    revisions = await query(baseUrl, fetchImpl, 'scriptRevision', { criteria: [{ fieldName: 'scriptId', operator: 'EQUALS', values: [id] }], orderBys: [{ fieldName: 'sequenceNo', isAscending: false }], booleanOperator: 'AND', skip: 0, limit: 25 })
  } catch {
    return [{ kind: 'text', text: 'Error loading script.' }]
  }
  const current = v(script).currentScriptRevisionId
  const rows = revisions.map((r) => ({ revision: `${str(v(r).sequenceNo)}${String(v(r).id) === String(current) ? ' (current)' : ''}`, message: str(v(r).commitMessage), created: str(v(r).createDate), author: str(v(r).author) }))
  const chosen = (revisionNo ? revisions.find((r) => str(v(r).sequenceNo) === revisionNo) : revisions.find((r) => String(v(r).id) === String(current))) ?? revisions[0]
  const out: RenderBlock[] = [{ kind: 'text', text: str(v(script).name ?? v(script).id) }, ...(rows.length ? [{ kind: 'table', columns: ['revision', 'message', 'created', 'author'], headers: ['Revision', 'Message', 'Created', 'Author'], rows } as RenderBlock] : [{ kind: 'text', text: 'No revisions' } as RenderBlock])]
  if (chosen) {
    const files = await query(baseUrl, fetchImpl, 'scriptRevisionFile', { criteria: [{ fieldName: 'scriptRevisionId', operator: 'EQUALS', values: [v(chosen).id] }], orderBys: [{ fieldName: 'id', isAscending: true }], booleanOperator: 'AND', skip: 0, limit: 100 }).catch(() => [] as J[])
    for (const f of files) out.push({ kind: 'heading', text: str(v(f).fileName) }, { kind: 'text', text: str(v(f).contents) })
    if (!files.length && (v(chosen).contents ?? v(chosen).content)) out.push({ kind: 'text', text: str(v(chosen).contents ?? v(chosen).content) })
  }
  return out
}

/** Loads a dashboard's widgets once each, all at once, in declared order. */
export async function loadDashboard(baseUrl: string, fetchImpl: typeof fetch, names: string[], options: LoadWidgetOptions): Promise<LoadedWidget[]> {
  return Promise.all(names.map((name) => loadWidget(baseUrl, fetchImpl, name, options)))
}

