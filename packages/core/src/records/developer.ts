/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Developer mode: a record's associated scripts (with their revisions, stored and logged through
 * the v1 `/table/{t}/{pk}/developer…` routes), the developer panels the instance's providers add
 * for a record (rendered to the neutral render blocks), and the application APIs that expose a
 * table with their OpenAPI documents. Revision code lives in the scripts model's
 * `scriptRevisionFile` table, read with a query as the web UI does.
 */

import { callOperation } from '../api/call.js'
import type { RenderBlock } from '../widgets/render-model.js'

type J = Record<string, unknown>

/** The scripts model's revision file table (one row per file of a revision: `fileName`, `contents`). */
export const SCRIPT_REVISION_FILE_TABLE = 'scriptRevisionFile'

export interface AssociatedScript {
  /** The field of the record's table that references the script. */
  fieldName: string
  scriptTypeId?: unknown
  /** The script record, when the record references one. */
  script?: J
  /** Its revisions, newest first. */
  revisions: J[]
  scriptType?: J
  testInputFields: J[]
  testOutputFields: J[]
}

export interface RecordDeveloper {
  record: J
  scripts: AssociatedScript[]
}

const values = (record: J | undefined): J => ((record?.values ?? {}) as J)

/** A record with its table's associated scripts (`GET /table/{t}/{pk}/developer`). */
export async function getRecordDeveloper(baseUrl: string, fetchImpl: typeof fetch, table: string, primaryKey: string): Promise<RecordDeveloper> {
  const data = (await callOperation(baseUrl, 'getRecordDeveloperMode', { path: { tableName: table, primaryKey } }, fetchImpl)).data as J
  return {
    record: (data.record ?? {}) as J,
    scripts: ((data.associatedScripts ?? []) as J[]).map((s) => {
      const definition = (s.associatedScript ?? {}) as J
      return {
        fieldName: String(definition.fieldName ?? ''),
        ...(definition.scriptTypeId !== undefined ? { scriptTypeId: definition.scriptTypeId } : {}),
        ...(s.script ? { script: s.script as J } : {}),
        revisions: (s.scriptRevisions ?? []) as J[],
        ...(s.scriptType ? { scriptType: s.scriptType as J } : {}),
        testInputFields: (s.testInputFields ?? []) as J[],
        testOutputFields: (s.testOutputFields ?? []) as J[],
      }
    }),
  }
}

/** Finds an associated script by its field name. */
export function findAssociatedScript(developer: RecordDeveloper, fieldName: string): AssociatedScript {
  const found = developer.scripts.find((s) => s.fieldName === fieldName)
  if (!found) throw new DeveloperError(`No associated script on field "${fieldName}"${developer.scripts.length ? `; script fields: ${developer.scripts.map((s) => s.fieldName).join(', ')}` : ' (the table has no associated scripts)'}`)
  return found
}

/**
 * A revision of a script: by sequence number (as people number them), else by id; the newest
 * (the script's current one, or the first listed) when none is asked for.
 */
export function pickRevision(script: AssociatedScript, revision?: string): J | undefined {
  if (!script.revisions.length) return undefined
  if (revision === undefined) {
    const current = values(script.script).currentScriptRevisionId
    return script.revisions.find((r) => current !== undefined && current !== null && String(values(r).id) === String(current)) ?? script.revisions[0]
  }
  const hit = script.revisions.find((r) => String(values(r).sequenceNo) === revision) ?? script.revisions.find((r) => String(values(r).id) === revision)
  if (!hit) throw new DeveloperError(`No revision ${revision}; revisions: ${script.revisions.map((r) => `${String(values(r).sequenceNo ?? '?')} (id ${String(values(r).id)})`).join(', ')}`)
  return hit
}

/** The files of a revision (`fileName`, `contents`), in id order. */
export async function getScriptRevisionFiles(baseUrl: string, fetchImpl: typeof fetch, revisionId: string): Promise<Array<{ fileName: string; contents: string }>> {
  const filter = { criteria: [{ fieldName: 'scriptRevisionId', operator: 'EQUALS', values: [revisionId] }], booleanOperator: 'AND', orderBys: [{ fieldName: 'id', isAscending: true }], skip: 0, limit: 100 }
  const data = (await callOperation(baseUrl, 'queryTable', { path: { tableName: SCRIPT_REVISION_FILE_TABLE }, json: { filter } }, fetchImpl)).data as J
  return ((data.records ?? []) as J[]).map((r) => ({ fileName: String(values(r).fileName ?? ''), contents: String(values(r).contents ?? '') }))
}

/** A revision's code as one text: a single file as is, several with a `// file: name` line before each. */
export function scriptText(revision: J | undefined, files: Array<{ fileName: string; contents: string }>): string {
  if (files.length === 1) return files[0]!.contents
  if (files.length > 1) return files.map((f) => `// file: ${f.fileName}\n${f.contents}`).join('\n\n')
  // older script models kept the code on the revision itself
  const v = values(revision)
  return String(v.contents ?? v.content ?? '')
}

/** Stores new code for the script a record references (a new revision; the script is created when the record has none). */
export async function storeScript(baseUrl: string, fetchImpl: typeof fetch, table: string, primaryKey: string, fieldName: string, contents: string, commitMessage?: string): Promise<{ scriptId: number; scriptName: string; scriptRevisionId: number; scriptRevisionSequenceNo: number }> {
  const data = (await callOperation(baseUrl, 'storeAssociatedScript', { path: { tableName: table, primaryKey, fieldName }, json: { contents, ...(commitMessage ? { commitMessage } : {}) } }, fetchImpl)).data as J
  return { scriptId: Number(data.scriptId), scriptName: String(data.scriptName ?? ''), scriptRevisionId: Number(data.scriptRevisionId), scriptRevisionSequenceNo: Number(data.scriptRevisionSequenceNo) }
}

export interface ScriptLog {
  id: unknown
  startTimestamp: string
  endTimestamp: string
  hadError: boolean
  error: string
  lines: Array<{ timestamp: string; text: string }>
  values: J
}

/** A revision's run logs, newest first, each with its lines. */
export async function getScriptLogs(baseUrl: string, fetchImpl: typeof fetch, table: string, primaryKey: string, fieldName: string, revisionId: string): Promise<ScriptLog[]> {
  const data = (await callOperation(baseUrl, 'getAssociatedScriptLogs', { path: { tableName: table, primaryKey, fieldName, scriptRevisionId: revisionId } }, fetchImpl)).data as J
  return ((data.scriptLogRecords ?? []) as J[]).map((r) => {
    const v = values(r)
    return {
      id: v.id,
      startTimestamp: String(v.startTimestamp ?? ''),
      endTimestamp: String(v.endTimestamp ?? ''),
      hadError: v.hadError === true,
      error: String(v.error ?? ''),
      lines: ((v.scriptLogLine ?? []) as J[]).map((line) => ({ timestamp: String(values(line).timestamp ?? ''), text: String(values(line).text ?? '') })),
      values: v,
    }
  })
}

export interface DeveloperPanel {
  id: string
  title: string
  order: number
  description?: string
  statusLabel?: string
  statusTone?: string
  error?: string
  blocks: J[]
}

/** The developer panels of a record, in the server's order (order, then title). */
export async function listDeveloperPanels(baseUrl: string, fetchImpl: typeof fetch, table: string, primaryKey: string): Promise<DeveloperPanel[]> {
  const data = (await callOperation(baseUrl, 'listRecordDeveloperPanels', { path: { tableName: table, primaryKey } }, fetchImpl)).data as J
  return ((data.panels ?? []) as J[]).map((p) => ({
    id: String(p.id ?? ''),
    title: String(p.title ?? p.id ?? ''),
    order: Number(p.order ?? 0),
    ...(typeof p.description === 'string' ? { description: p.description } : {}),
    ...(typeof p.statusLabel === 'string' ? { statusLabel: p.statusLabel } : {}),
    ...(typeof p.statusTone === 'string' ? { statusTone: p.statusTone } : {}),
    ...(typeof p.error === 'string' ? { error: p.error } : {}),
    blocks: (p.blocks ?? []) as J[],
  }))
}

const TONE: Record<string, 'info' | 'warning' | 'error' | 'success'> = { INFO: 'info', SUCCESS: 'success', WARNING: 'warning', ERROR: 'error' }

/** A panel as render blocks: heading with its status, then each block (unknown block types shown raw). */
export function panelToBlocks(panel: DeveloperPanel): RenderBlock[] {
  const out: RenderBlock[] = [{ kind: 'heading', text: panel.title, ...(panel.statusLabel ? { sub: panel.statusLabel } : {}) }]
  if (panel.description) out.push({ kind: 'text', text: panel.description })
  if (panel.error) out.push({ kind: 'alert', level: 'error', text: panel.error })
  for (const block of panel.blocks) {
    const label = typeof block.label === 'string' && block.label ? block.label : undefined
    switch (block.type) {
      case 'TEXT':
        if (block.tone && TONE[String(block.tone)] && block.tone !== 'INFO') out.push({ kind: 'alert', level: TONE[String(block.tone)]!, text: String(block.text ?? '') })
        else out.push({ kind: 'text', text: `${label ? `${label}: ` : ''}${String(block.text ?? '')}` })
        break
      case 'KEY_VALUES':
        if (label) out.push({ kind: 'text', text: label })
        out.push({ kind: 'pairs', pairs: ((block.items ?? []) as J[]).map((i) => ({ label: String(i.label ?? ''), value: `${String(i.value ?? '')}${i.href ? ` (${String(i.href)})` : ''}` })) })
        break
      case 'TABLE': {
        if (label) out.push({ kind: 'text', text: label })
        const headers = ((block.columns ?? []) as unknown[]).map(String)
        const columns = headers.map((_, i) => `c${i}`)
        out.push({ kind: 'table', columns, headers, rows: ((block.rows ?? []) as unknown[][]).map((row) => Object.fromEntries(columns.map((c, i) => [c, row?.[i] ?? '']))) })
        break
      }
      case 'CODE':
        out.push({ kind: 'text', text: `${label ? `${label}${block.language ? ` (${String(block.language)})` : ''}:\n` : ''}${String(block.code ?? '')}` })
        break
      case 'LINKS':
        if (label) out.push({ kind: 'text', text: label })
        for (const link of (block.links ?? []) as J[]) out.push({ kind: 'link', label: `${String(link.label ?? '')}${link.description ? ` (${String(link.description)})` : ''}`, href: String(link.href ?? '') })
        break
      case 'ACTIONS':
        if (label) out.push({ kind: 'text', text: label })
        out.push({ kind: 'pairs', pairs: ((block.actions ?? []) as J[]).map((a) => ({ label: String(a.label ?? a.processName ?? ''), value: `qqq process run ${String(a.processName ?? '')}${a.includeRecordId ? ' -r <id>' : ''}${a.description ? `  (${String(a.description)})` : ''}` })) })
        break
      default:
        out.push({ kind: 'raw', type: String(block.type ?? 'block'), data: block })
    }
  }
  return out
}

export interface TableApi {
  name: string
  label: string
  path: string
  currentVersion?: string
  versions: Array<{ version: string; semanticVersion?: string; tableSpecPath?: string }>
}

/** The application APIs that expose a table. */
export async function listTableApis(baseUrl: string, fetchImpl: typeof fetch, table: string): Promise<TableApi[]> {
  const data = (await callOperation(baseUrl, 'listTableApis', { path: { tableName: table } }, fetchImpl)).data as J
  return ((data.apis ?? []) as J[]).map((a) => ({
    name: String(a.name ?? ''),
    label: String(a.label ?? a.name ?? ''),
    path: String(a.path ?? ''),
    ...(a.currentVersion ? { currentVersion: String(a.currentVersion) } : {}),
    versions: ((a.versions ?? []) as J[]).map((v) => ({ version: String(v.version ?? ''), ...(v.semanticVersion ? { semanticVersion: String(v.semanticVersion) } : {}), ...(v.tableSpecPath ? { tableSpecPath: String(v.tableSpecPath) } : {}) })),
  }))
}

/** A table's OpenAPI document in one version of one API (the API's own format). */
export async function getTableApiDocument(baseUrl: string, fetchImpl: typeof fetch, table: string, apiName: string, version: string): Promise<J> {
  return (await callOperation(baseUrl, 'getTableApiDocument', { path: { tableName: table, apiName, version } }, fetchImpl)).data as J
}

/** A developer-mode request cannot be done (unknown script field or revision). */
export class DeveloperError extends Error {}

/** The answer of an application API request: status, content type, and JSON (or text). */
export interface TableApiResponse { status: number; contentType: string; data: unknown }

/**
 * Sends one request to an application API (the developer page's playground): `{server}{api.path}{version}/{subpath}`
 * with the client's session, the method, query and JSON body given. A non-2xx answer is returned, not thrown.
 */
export async function callTableApi(baseUrl: string, fetchImpl: typeof fetch, api: Pick<TableApi, 'path'>, version: string, method: string, subpath: string, options: { query?: Record<string, string>; body?: unknown } = {}): Promise<TableApiResponse> {
  const base = `${baseUrl.replace(/\/+$/, '')}/${api.path.replace(/^\/+|\/+$/g, '')}`.replace(/\/+$/, '')
  const url = new URL(`${base}/${encodeURIComponent(version)}/${subpath.replace(/^\/+/, '')}`)
  for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v)
  const init: RequestInit = { method: method.toUpperCase(), headers: { accept: 'application/json' } }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
    init.headers = { ...init.headers as Record<string, string>, 'content-type': 'application/json' }
  }
  const response = await fetchImpl(url, init)
  const contentType = response.headers.get('content-type') ?? ''
  const text = await response.text()
  let data: unknown = text
  if (/json/.test(contentType) && text) {
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
  }
  return { status: response.status, contentType, data }
}

/** The answer of a script test run (the `testScript` process). */
export interface ScriptTestResult { output: unknown; values: J; logLines: Array<{ timestamp?: string; text: string }>; exception?: string }

/**
 * Runs a script's code against test inputs, as the developer page's Test tab does: the
 * `testScript` process with the script id, the revision's API name and version, the files
 * (`fileNames` and `fileContents:<name>`) and the script type's test input fields.
 */
export async function testScript(baseUrl: string, fetchImpl: typeof fetch, input: { scriptId: unknown; apiName?: string; apiVersion?: string; files: Array<{ fileName: string; contents: string }>; inputs: Record<string, string> }): Promise<ScriptTestResult> {
  const values: Record<string, string> = {
    scriptId: String(input.scriptId),
    ...(input.apiName ? { apiName: input.apiName } : {}),
    ...(input.apiVersion ? { apiVersion: input.apiVersion } : {}),
    fileNames: input.files.map((f) => f.fileName).join(','),
    ...Object.fromEntries(input.files.map((f) => [`fileContents:${f.fileName}`, f.contents])),
    ...input.inputs,
  }
  const data = (await callOperation(baseUrl, 'initProcess', { path: { processName: 'testScript' }, form: { values: JSON.stringify(values), stepTimeoutMillis: '60000' } }, fetchImpl)).data as J
  if (data.type === 'ERROR') throw new DeveloperError(String(data.userFacingError ?? data.error ?? 'The script test failed to run'))
  const out = (data.values ?? {}) as J
  const exception = out.exception
  return {
    output: out.outputObject,
    values: out,
    logLines: ((out.scriptLogLines ?? []) as J[]).map((l) => { const v = values_(l); return { ...(v.timestamp ? { timestamp: String(v.timestamp) } : {}), text: String(v.text ?? v.message ?? '') } }),
    ...(exception !== undefined && exception !== null ? { exception: typeof exception === 'object' ? String((exception as J).message ?? JSON.stringify(exception)) : String(exception) } : {}),
  }
}

function values_(record: unknown): J {
  return ((record as J | undefined)?.values ?? record ?? {}) as J
}
