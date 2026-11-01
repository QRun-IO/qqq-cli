/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Links inside widgets and server HTML (`/jobs/jobs_job?filter=…`, `/app/alerts_channel`,
 * `/people/person/3`) are web addresses; the TUI reads the table, record, process or app out of
 * them and opens its own screen instead of printing the address.
 */

import type { QueryFilter } from '@qrun-io/qqq-core'
import type { AppStore } from './store'

export type LinkTarget =
  | { kind: 'table'; table: string; filter?: QueryFilter }
  | { kind: 'record'; table: string; primaryKey: string }
  | { kind: 'process'; process: string }
  | { kind: 'app'; app: string }
  | { kind: 'command'; line: string }
  | { kind: 'esb'; destination: string }
  | { kind: 'external'; url: string }

interface Known {
  tables?: Record<string, unknown>
  processes?: Record<string, unknown>
  apps?: Record<string, unknown>
}

function parseFilter(text: string | null): QueryFilter | undefined {
  if (!text) return undefined
  try {
    const f = JSON.parse(text) as QueryFilter
    return f && typeof f === 'object' && Array.isArray(f.criteria) ? f : undefined
  } catch {
    return undefined
  }
}

/**
 * What a link opens. `:line` runs a command; `esb:name` is an ESB destination; absolute links to
 * another site stay external. A web path is read from the end: the last known table (with the
 * `filter` parameter, or a record key after it), else a process, else an app.
 */
export function parseLink(href: string, known: Known = {}): LinkTarget | undefined {
  const text = href.trim()
  if (!text) return undefined
  if (text.startsWith(':')) return { kind: 'command', line: text.slice(1).trim() }
  if (text.startsWith('esb:')) return { kind: 'esb', destination: text.slice(4) }
  let url: URL
  try {
    url = new URL(text, 'http://relative.invalid')
  } catch {
    return undefined
  }
  if (url.host !== 'relative.invalid' && !/^\//.test(text)) return { kind: 'external', url: text }
  const segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s))
  const filter = parseFilter(url.searchParams.get('filter'))
  const has = (map: Record<string, unknown> | undefined, name: string) => Boolean(map && Object.prototype.hasOwnProperty.call(map, name))
  const anyKnown = Boolean(known.tables || known.processes || known.apps)
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!
    if (has(known.tables, seg)) {
      const next = segments[i + 1]
      if (next !== undefined && next !== 'edit' && next !== 'create' && next !== 'new') return { kind: 'record', table: seg, primaryKey: next }
      return { kind: 'table', table: seg, ...(filter ? { filter } : {}) }
    }
    if (has(known.processes, seg)) return { kind: 'process', process: seg }
  }
  for (let i = segments.length - 1; i >= 0; i--) if (has(known.apps, segments[i]!)) return { kind: 'app', app: segments[i]! }
  // without metadata the web's convention holds: the last segment names the table
  if (!anyKnown && segments.length) return { kind: 'table', table: segments[segments.length - 1]!, ...(filter ? { filter } : {}) }
  return url.host !== 'relative.invalid' ? { kind: 'external', url: text } : undefined
}

/** Opens what a link points to inside the TUI (a filtered grid, a record, a process, an app). */
export function followLink(store: AppStore, href: string): void {
  const target = parseLink(href, store.meta as Known | undefined)
  if (!target) return store.flash(`nothing in this terminal opens ${href}`)
  void import('./nav').then((nav) => {
    switch (target.kind) {
      case 'table': return nav.openTable(store, target.table, target.filter)
      case 'record': return nav.openRecord(store, target.table, target.primaryKey)
      case 'process': return nav.openProcess(store, target.process)
      case 'app': return nav.openApp(store, target.app)
      case 'command': return void store.commands().run(target.line)
      case 'esb': return void import('./esb').then((esb) => esb.openDestination(store, target.destination))
      case 'external': return store.message(`This link leaves the application:\n${target.url}`, 'info', 'Link')
    }
  })
}
