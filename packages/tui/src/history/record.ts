/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * What the TUI writes to the activity log (`qqq history`, the History screen): one `history.record`
 * call at each place something is done. The profile and server come from the store; every event
 * is `client: ui`. Summaries never carry field values; filter values on password fields are `***`.
 */

import { REDACTED, appendActivity, cliKind, isSecretName, printFilter, splitCommandLine, type ActivityKind, type ActivityTarget, type QueryFilter } from '@qrun-io/qqq-core'
import type { AppStore } from '../store'
import { shellQuote } from '../util/text'

export interface UiEvent {
  kind: ActivityKind
  summary: string
  /** `qqq …` (the CLI equivalent) or `:…` (a TUI-only command). */
  command?: string
  target?: ActivityTarget
}

/** The text two events share when they are the same action (`:table get p 1` and `qqq table get p 1`). */
function sameAction(command: string | undefined): string | undefined {
  return command?.replace(/^(qqq\s+|:)/, '').trim()
}

/**
 * `:` commands the TUI does itself (theme, lock, the Servers dialog …): logged as `:…`, re-run on
 * the `:` line only. Everything else on the `:` line is a CLI command (`qqq …`).
 */
const TUI_ONLY = new Set(['quit', 'q', 'exit', 'home', 'reset', 'tags', 'audits', 'audit', 'dev', 'developer', 'actions', 'back', 'help', 'menu', 'goto', 'palette', 'view', 'theme', 'ascii', 'linear', 'mouse', 'splash', 'shortcuts', 'lock', 'saver', 'pin', 'idle', 'refresh', 'filter', 'export', 'jobs', 'printjobs', 'print', 'profile', 'servers', 'server', 'signout', 'connection', 'open', 'record', 'app', 'sql', 'dates', 'helpkeys', 'views', 'share', 'doctor', 'check', 'history'])

let last: { action?: string; at: number; words?: string[] } = { at: 0 }

export const history = {
  /**
   * Writes one event for the store's profile and server. An event that repeats the action of the
   * one just written (a `:` line that opened the screen it names) is left out.
   */
  record(store: AppStore, event: UiEvent): void {
    try {
      const action = sameAction(event.command)
      const now = Date.now()
      if (action && action === last.action && now - last.at < 2000) return
      // the screen a `:` line just opened (`:table get person 3` → the record) is that line's event
      const t = event.target
      if (t && last.words && now - last.at < 2000 && last.words.includes(t.name) && (t.key === undefined || last.words.includes(String(t.key)))) return
      last = { action, at: now, words: event.kind === 'command' || event.summary.startsWith(':') ? splitCommandLine(event.summary.replace(/^:/, '')) : undefined }
      appendActivity({ profile: store.target?.name ?? store.status.profile, server: store.client?.server ?? store.target?.server ?? store.status.server, client: 'ui', ...event })
    } catch {
      // never in the way of the screen
    }
  },

  /** Forgets the last event (tests). */
  reset(): void {
    last = { at: 0 }
  },
}

/** A `:` line as an event: a CLI command gets its `qqq` form and kind, a TUI command stays `:…`. */
export function commandEvent(line: string): UiEvent {
  const text = line.trim().replace(/^:/, '').replace(/^qqq\s+/, '')
  const argv = splitCommandLine(text)
  const tui = TUI_ONLY.has(argv[0] ?? '')
  return { kind: tui ? 'command' : cliKind(argv) === 'cli' ? 'command' : cliKind(argv), summary: `:${text}`, command: tui ? `:${text}` : `qqq ${text}` }
}

/** A filter with the values of password (and secret-named) fields replaced by `***`. */
export function redactFilter(filter: QueryFilter, fieldType: (name: string) => string | undefined): QueryFilter {
  return {
    ...filter,
    criteria: filter.criteria.map((c) => (fieldType(c.fieldName) === 'PASSWORD' || isSecretName(c.fieldName) ? { ...c, values: (c.values ?? []).map(() => REDACTED) } : c)),
    ...(filter.subFilters ? { subFilters: filter.subFilters.map((f) => redactFilter(f, fieldType)) } : {}),
  }
}

/** `table query person -g "…" -o -id` with secret values redacted (the table screen's CLI equivalent). */
export function queryCommand(table: string, filter: QueryFilter, fieldType: (name: string) => string | undefined, sort?: { field: string; asc: boolean } | null): string {
  const parts = ['qqq', 'table', 'query', table]
  const text = printFilter(redactFilter(filter, fieldType))
  if (text) parts.push('-g', shellQuote(text))
  if (sort) parts.push('--order', (sort.asc ? '' : '-') + sort.field)
  return parts.join(' ')
}

function tableLabel(store: AppStore, table: string): string {
  return store.meta?.tables?.[table]?.label ?? table
}

function fieldTypeOf(store: AppStore, table: string): (name: string) => string | undefined {
  const fields = (store.meta?.tables?.[table] as { fields?: Record<string, { type?: string }> } | undefined)?.fields
  return (name) => fields?.[name]?.type
}

/** Opened a table, or queried it when the filter has criteria. */
export function tableEvent(store: AppStore, table: string, filter?: QueryFilter, sort?: { field: string; asc: boolean } | null, fieldType = fieldTypeOf(store, table)): UiEvent {
  const has = Boolean(filter && (filter.criteria.length || filter.subFilters?.length))
  const command = queryCommand(table, filter ?? { criteria: [], booleanOperator: 'AND' }, fieldType, sort)
  if (!has) return { kind: 'open', summary: `Opened table ${tableLabel(store, table)}`, command, target: { type: 'table', name: table } }
  const n = (filter!.criteria.length) + (filter!.subFilters?.length ?? 0)
  return { kind: 'query', summary: `Queried ${tableLabel(store, table)} with ${n} condition${n === 1 ? '' : 's'}`, command, target: { type: 'table', name: table } }
}

export function recordEvent(store: AppStore, table: string, key: string | undefined, label?: string): UiEvent {
  return { kind: 'open', summary: `Opened ${tableLabel(store, table)} ${key ?? ''}${label && label !== key ? ` "${label}"` : ''}`.trim(), command: key !== undefined ? `qqq table get ${table} ${shellQuote(String(key))}` : undefined, target: { type: 'record', name: table, key } }
}

/** Created, edited or deleted a record: which one, never its values. */
export function changeEvent(store: AppStore, verb: 'Created' | 'Edited' | 'Deleted', table: string, key: string | undefined, fields?: string[]): UiEvent {
  const what = `${tableLabel(store, table)} ${key ?? ''}`.trim()
  const command = verb === 'Deleted' ? `qqq table delete ${table} ${shellQuote(String(key))}` : key !== undefined ? `qqq table get ${table} ${shellQuote(String(key))}` : undefined
  return { kind: 'record', summary: `${verb} ${what}${fields?.length ? ` (${fields.length} field${fields.length === 1 ? '' : 's'}: ${fields.slice(0, 6).join(', ')}${fields.length > 6 ? ', …' : ''})` : ''}`, command, target: verb === 'Deleted' ? undefined : { type: 'record', name: table, key } }
}

export function processLabel(store: AppStore, name: string): string {
  return (store.meta?.processes as Record<string, { label?: string }> | undefined)?.[name]?.label ?? name
}

export function openEvent(store: AppStore, type: 'app' | 'process', name: string): UiEvent {
  if (type === 'app') return { kind: 'open', summary: `Opened app ${(store.meta?.apps as Record<string, { label?: string }> | undefined)?.[name]?.label ?? name}`, command: `qqq apps show ${name}`, target: { type: 'app', name } }
  return { kind: 'open', summary: `Opened process ${processLabel(store, name)}`, command: `qqq process run ${name}`, target: { type: 'process', name } }
}

/** A process run that ended: its outcome and how long it took. */
export function processEvent(store: AppStore, name: string, outcome: 'complete' | 'cancelled' | 'failed', command: string, ms?: number, error?: string): UiEvent {
  const took = ms !== undefined ? ` in ${ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}` : ''
  return { kind: 'process', summary: `Ran ${processLabel(store, name)}: ${outcome}${took}${error ? ` (${error.slice(0, 120)})` : ''}`, command: `qqq ${command}`, target: { type: 'process', name } }
}

/** Whether a `:` command is one the TUI does itself (not the CLI). */
export function isTuiCommand(word: string): boolean {
  return TUI_ONLY.has(word)
}
