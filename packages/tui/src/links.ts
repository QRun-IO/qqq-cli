/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Links inside widgets and server HTML are web addresses written by the server. They are content,
 * never commands: the TUI reads a table (with its `filter`), a record, a process or an app out of
 * them, each checked against the metadata, and anything else only shows its address. Only links the
 * TUI builds itself (an ESB destination row) are trusted; they carry a symbol-keyed value that JSON
 * from a server cannot contain, and a command they run is shown first and confirmed when it changes data.
 */

import type { QueryFilter } from '@qrun-io/qqq-core'
import { linkTarget, webUrl } from './developer/model'
import type { AppStore } from './store'

/** The key of a TUI-built link on a widget row (a symbol: server JSON cannot set it). */
export const TRUSTED_LINK: unique symbol = Symbol('qqq.trustedLink')

/** A link the TUI built itself. */
export type TrustedLink = { kind: 'esb'; destination: string } | { kind: 'command'; line: string }

/** Where a server link goes. `notice` is inert: it is shown, never run or opened. */
export type LinkTarget =
  | { kind: 'table'; table: string; filter?: QueryFilter }
  | { kind: 'record'; table: string; primaryKey: string }
  | { kind: 'process'; process: string }
  | { kind: 'app'; app: string }
  | { kind: 'notice'; text: string }

interface Known {
  tables?: Record<string, unknown>
  processes?: Record<string, unknown>
  apps?: Record<string, unknown>
}

/** A record key is a plain path segment (no slashes, spaces, quotes or option dashes in front). */
const PLAIN_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.:@+=,~-]{0,199}$/
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,199}$/

/** A filter from a link's `filter` parameter, kept only when it has the shape of a QueryFilter. */
export function linkFilter(text: string | null): QueryFilter | undefined {
  if (!text || text.length > 20_000) return undefined
  try {
    const f = JSON.parse(text) as QueryFilter
    const ok = (g: unknown, depth: number): boolean => {
      if (!g || typeof g !== 'object' || depth > 5) return false
      const x = g as { criteria?: unknown; subFilters?: unknown; booleanOperator?: unknown }
      if (!Array.isArray(x.criteria)) return false
      if (!x.criteria.every((c) => c && typeof c === 'object' && typeof (c as { fieldName?: unknown }).fieldName === 'string' && typeof (c as { operator?: unknown }).operator === 'string')) return false
      if (x.booleanOperator !== undefined && x.booleanOperator !== 'AND' && x.booleanOperator !== 'OR') return false
      return x.subFilters === undefined || (Array.isArray(x.subFilters) && x.subFilters.every((s) => ok(s, depth + 1)))
    }
    return ok(f, 0) ? f : undefined
  } catch {
    return undefined
  }
}

/**
 * What a server link opens. `/app/{table}[/{id}]` and `/app/{process}` are read by the developer
 * view's linkTarget; the web's app paths (`/{app}/…/{table}[/{id}]?filter=…`) need every app on the
 * way to be an app and the table to be a table. Text starting with `:` and every other link is a
 * notice that only shows the text (never a command, never a browser).
 */
export function parseLink(href: string, known: Known = {}, server = ''): LinkTarget {
  const text = href.trim()
  const notice: LinkTarget = { kind: 'notice', text: /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || text.startsWith('/') ? webUrl(server, text) : text }
  if (!text || text.startsWith(':') || text.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(text) || !text.startsWith('/')) return notice
  const tables = known.tables ?? {}
  const strict = linkTarget(text, { server, tables, processes: known.processes })
  if (strict.kind === 'record' && PLAIN_KEY.test(strict.primaryKey)) return { kind: 'record', table: strict.table, primaryKey: strict.primaryKey }
  if (strict.kind === 'table') return { kind: 'table', table: strict.table, ...withFilter(text) }
  if (strict.kind === 'process') return { kind: 'process', process: strict.process }
  const parts = text.split(/[?#]/)[0]!.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p) } catch { return '' } })
  if (!parts.length || parts.some((p) => !p)) return notice
  const has = (map: Record<string, unknown> | undefined, name: string) => Boolean(map && NAME.test(name) && Object.hasOwn(map, name))
  // the web's paths: apps first, then a table (and a record key) or a process
  let i = 0
  while (i < parts.length && has(known.apps, parts[i]!) && !has(tables, parts[i]!)) i++
  if (i === 0) return notice
  const rest = parts.slice(i)
  if (!rest.length) return { kind: 'app', app: parts[i - 1]! }
  const [name, key, ...more] = rest as [string, string?, ...string[]]
  if (has(tables, name)) {
    if (key === undefined) return { kind: 'table', table: name, ...withFilter(text) }
    if (PLAIN_KEY.test(key) && (more.length === 0 || (more.length === 1 && (more[0] === 'edit' || more[0] === 'dev')))) return { kind: 'record', table: name, primaryKey: key }
    return notice
  }
  if (has(known.processes, name) && key === undefined) return { kind: 'process', process: name }
  return notice
}

function withFilter(text: string): { filter?: QueryFilter } {
  const q = text.indexOf('?')
  const filter = q >= 0 ? linkFilter(new URLSearchParams(text.slice(q + 1).split('#')[0]).get('filter')) : undefined
  return filter ? { filter } : {}
}

/** Opens what a server link points to inside the TUI; anything else only shows its address. */
export function followLink(store: AppStore, href: string): void {
  const target = parseLink(href, store.meta as Known | undefined, store.client?.server ?? '')
  void import('./nav').then((nav) => {
    switch (target.kind) {
      case 'table': return nav.openTable(store, target.table, target.filter)
      case 'record': return nav.openRecord(store, target.table, target.primaryKey)
      case 'process': return nav.openProcess(store, target.process)
      case 'app': return nav.openApp(store, target.app)
      case 'notice': return store.message(`This link has no screen in the terminal (it is shown, not opened):\n${target.text}`, 'info', 'Link')
    }
  })
}

/** Whether a command line changes data or runs work (it is confirmed before it runs). */
export function mutatingCommand(line: string): boolean {
  const words = line.trim().replace(/^:/, '').split(/\s+/)
  return words.slice(0, 2).some((w) => /^(create|update|delete|remove|run|cancel|retry|set|action|import|load|share|post-.*|put-.*|patch-.*|delete-.*)$/.test(w)) || words[0] === 'api'
}

/** Runs a command the TUI built: the status line shows it first; a mutating one asks. */
export function runTrustedCommand(store: AppStore, line: string): void {
  const go = () => {
    store.flash(`running :${line}`)
    void store.commands().run(line)
  }
  if (mutatingCommand(line)) store.confirm(`Run :${line}?`, go)
  else go()
}

/** Follows a TUI-built link. */
export function followTrusted(store: AppStore, link: TrustedLink): void {
  if (link.kind === 'command') return runTrustedCommand(store, link.line)
  void import('./esb').then((esb) => esb.openDestination(store, link.destination))
}

/** Enter on a widget line: its trusted link, else its server link. */
export function followLine(store: AppStore, line: { href?: string; trusted?: TrustedLink }): void {
  if (line.trusted) return followTrusted(store, line.trusted)
  if (line.href) followLink(store, line.href)
}
