/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Record sharing (shareable tables such as saved reports and saved views), as the web share
 * dialog does it: the share processes (`getSharedRecords`, `insertSharedRecord`,
 * `editSharedRecord`, `deleteSharedRecord`, or the names `clientCapabilities.sharing` declares),
 * the audience possible values (`user:3`, `group:7`), and only the owner may share.
 */

import { callOperation } from '../api/call.js'

type J = Record<string, unknown>

export type ShareScope = 'READ_ONLY' | 'READ_WRITE'
export const SHARE_SCOPES: Array<{ id: ShareScope; label: string }> = [{ id: 'READ_ONLY', label: 'Read-Only' }, { id: 'READ_WRITE', label: 'Read and Edit' }]

export interface RecordShare {
  shareId: number
  scopeId: string
  audienceType: string
  audienceId: string
  audienceLabel: string
}

export interface ShareableTableMetaData {
  sharedRecordTableName?: string
  assetIdFieldName?: string
  scopeFieldName?: string
  audiencePossibleValueSourceName?: string
  audienceTypesPossibleValueSourceName?: string
  thisTableOwnerIdFieldName?: string
}

export class SharingError extends Error {}

type Operation = 'list' | 'insert' | 'edit' | 'delete'
const DEFAULT_PROCESSES: Record<Operation, string> = { list: 'getSharedRecords', insert: 'insertSharedRecord', edit: 'editSharedRecord', delete: 'deleteSharedRecord' }

/** The table's sharing metadata when the user can share its records (undefined: no share action). */
export function shareable(tableMeta: J): ShareableTableMetaData | undefined {
  const sharing = tableMeta.shareableTableMetaData as ShareableTableMetaData | undefined
  if (!sharing) return undefined
  const caps = tableMeta.clientCapabilities as { sharing?: { available?: boolean } } | undefined
  if (caps !== undefined && !caps.sharing?.available) return undefined
  return sharing
}

/** The process for a sharing operation: clientCapabilities.sharing names it, else the standard name. */
export function sharingProcess(tableMeta: J, operation: Operation): string {
  const caps = tableMeta.clientCapabilities as { sharing?: J } | undefined
  if (caps === undefined) return DEFAULT_PROCESSES[operation]
  const sharing = caps.sharing
  const name = sharing?.available ? sharing[`${operation}ProcessName`] : undefined
  if (typeof name !== 'string' || !name) throw new SharingError('This sharing operation is unavailable.')
  return name
}

/** Whether the user owns the record (only the owner may share); true when the table names no owner field. */
export function isRecordOwner(sharing: ShareableTableMetaData, record: { values?: J }, userId: string | undefined): boolean {
  const field = sharing.thisTableOwnerIdFieldName
  if (!field) return true
  return userId !== undefined && String(record.values?.[field] ?? '') === userId
}

/** Splits an audience option id (`user:3`) into its type and id. */
export function splitAudienceOption(optionId: string): { audienceType: string; audienceId: string } | undefined {
  const i = optionId.indexOf(':')
  if (i <= 0 || i === optionId.length - 1) return undefined
  return { audienceType: optionId.slice(0, i), audienceId: optionId.slice(i + 1) }
}

async function run(baseUrl: string, fetchImpl: typeof fetch, processName: string, values: J): Promise<J> {
  const result = await callOperation(baseUrl, 'initProcess', { path: { processName }, form: { values: JSON.stringify(values), stepTimeoutMillis: '60000' } }, fetchImpl)
  const response = (result.data ?? {}) as J
  if (typeof response.error === 'string' || response.type === 'ERROR') throw new SharingError(String(response.userFacingError ?? response.error ?? 'The sharing request failed'))
  return (response.values ?? {}) as J
}

export async function listShares(baseUrl: string, fetchImpl: typeof fetch, tableMeta: J, recordId: string | number): Promise<RecordShare[]> {
  const values = await run(baseUrl, fetchImpl, sharingProcess(tableMeta, 'list'), { tableName: tableMeta.name, recordId })
  const list = Array.isArray(values.resultList) ? values.resultList : []
  return list.flatMap((entry) => {
    const share = (entry as { values?: J })?.values
    if (!share) return []
    return [{ shareId: Number(share.shareId), scopeId: String(share.scopeId ?? ''), audienceType: String(share.audienceType ?? ''), audienceId: String(share.audienceId ?? ''), audienceLabel: String(share.audienceLabel ?? share.audienceId ?? '') }]
  })
}

export async function addShare(baseUrl: string, fetchImpl: typeof fetch, tableMeta: J, recordId: string | number, audience: string, scopeId: ShareScope): Promise<void> {
  const a = splitAudienceOption(audience)
  if (!a) throw new SharingError(`not an audience: ${audience} (expected type:id, such as user:3)`)
  await run(baseUrl, fetchImpl, sharingProcess(tableMeta, 'insert'), { tableName: tableMeta.name, recordId, audienceType: a.audienceType, audienceId: a.audienceId, scopeId })
}

export async function changeShare(baseUrl: string, fetchImpl: typeof fetch, tableMeta: J, recordId: string | number, shareId: number, scopeId: ShareScope): Promise<void> {
  await run(baseUrl, fetchImpl, sharingProcess(tableMeta, 'edit'), { tableName: tableMeta.name, recordId, shareId, scopeId })
}

export async function removeShare(baseUrl: string, fetchImpl: typeof fetch, tableMeta: J, recordId: string | number, shareId: number): Promise<void> {
  await run(baseUrl, fetchImpl, sharingProcess(tableMeta, 'delete'), { tableName: tableMeta.name, recordId, shareId })
}

/** Audience options (users and groups) from the audience possible value source. */
export async function audienceOptions(baseUrl: string, fetchImpl: typeof fetch, sharing: ShareableTableMetaData, searchTerm = ''): Promise<Array<{ id: string; label: string }>> {
  if (!sharing.audiencePossibleValueSourceName) return []
  const result = await callOperation(baseUrl, 'searchPossibleValues', { path: { possibleValueSourceName: sharing.audiencePossibleValueSourceName }, json: { searchTerm, useCase: 'FORM' } }, fetchImpl)
  return (((result.data ?? {}) as { options?: Array<{ id: unknown; label?: string }> }).options ?? []).map((o) => ({ id: String(o.id), label: String(o.label ?? o.id) }))
}
