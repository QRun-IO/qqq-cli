/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The ESB extension in the TUI: the ESB_OVERVIEW widget drawn as the `:esb overview` table
 * (destinations with their publishers, triggers and counters), and Enter on a destination offering
 * the ESB of its tables and processes, its messages and its dead letters (the `:esb` commands).
 */

import { displayDateTime, type RenderBlock } from '@qrun-io/qqq-core'
import { TRUSTED_LINK, runTrustedCommand, type TrustedLink } from './links'
import { ChoiceOverlay } from './overlays/basic'
import type { AppStore } from './store'
import { errorText, shellQuote } from './util/text'

type J = Record<string, unknown>

const list = (v: unknown): J[] => (Array.isArray(v) ? v.filter((x): x is J => Boolean(x) && typeof x === 'object') : [])
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/** The overview as render blocks: one table row per destination (Enter opens it), then the providers. */
export function esbOverviewBlocks(data: J): RenderBlock[] {
  const destinations = list(data.destinations)
  const providers = list(data.providers)
  const columns = ['destination', 'type', 'provider', 'publishers', 'triggers', 'published', 'consumed', 'failed', 'deadLettered', 'lastActivity']
  const headers = ['Destination', 'Type', 'Provider', 'Publishers', 'Triggers', 'Published', 'Consumed', 'Failed', 'Dead', 'Last activity']
  const rows = destinations.map((d) => {
    const c = (d.counters ?? {}) as J
    return {
      destination: str(d.name), type: str(d.type), provider: str(d.provider),
      publishers: list(d.publishers).map((p) => str(p.name)).join(', ') || '0',
      triggers: list(d.triggers).map((t) => str(t.processLabel ?? t.processName ?? t.name)).join(', ') || '0',
      published: str(c.published ?? ''), consumed: str(c.consumed ?? ''), failed: str(c.failed ?? ''), deadLettered: str(c.deadLettered ?? ''),
      lastActivity: c.lastActivity ? displayDateTime(c.lastActivity) : '',
      [TRUSTED_LINK]: { kind: 'esb', destination: str(d.name) } as TrustedLink,
    }
  })
  const providerText = providers.map((p) => `${str(p.name)} ${p.connected === false ? 'disconnected' : 'connected'}`).join(', ')
  if (!rows.length) return [{ kind: 'text', text: `No ESB destinations${providerText ? ` (providers: ${providerText})` : ''}.` }]
  return [
    { kind: 'table', columns, headers, rows },
    { kind: 'text', text: `${rows.length} destination${rows.length === 1 ? '' : 's'}${providerText ? ` · ${providerText}` : ''} · Enter on a destination: its tables, processes, messages and dead letters` },
  ]
}

/** What Enter on a destination offers: the `:esb` command for each publisher, trigger, its messages and dead letters. */
export function destinationChoices(data: J, name: string): Array<{ label: string; line: string }> {
  const d = list(data.destinations).find((x) => str(x.name) === name)
  if (!d) return []
  const out: Array<{ label: string; line: string }> = []
  for (const p of list(d.publishers)) {
    if (str(p.kind).toUpperCase() === 'TABLE') out.push({ label: `ESB of table ${str(p.name)} (publishes ${list(p.events).length ? (p.events as string[]).join(' ') : 'events'})`, line: `esb table ${shellQuote(str(p.name))}` })
    else if (str(p.kind).toUpperCase() === 'PROCESS') out.push({ label: `ESB of process ${str(p.name)} (publishes)`, line: `esb process ${shellQuote(str(p.name))}` })
  }
  const topic = str(d.type).toUpperCase() === 'TOPIC'
  for (const t of list(d.triggers)) {
    const process = str(t.processName)
    if (process) out.push({ label: `ESB of process ${str(t.processLabel ?? process)} (triggered)`, line: `esb process ${shellQuote(process)}` })
    if (topic) out.push({ label: `Messages for trigger ${str(t.name)}`, line: `esb messages ${shellQuote(name)} --trigger ${shellQuote(str(t.name))}` })
    out.push({ label: `Dead letters of trigger ${str(t.name)}`, line: `esb dead-letters ${shellQuote(str(t.name))}` })
  }
  if (!topic) out.push({ label: `Messages waiting on ${name}`, line: `esb messages ${shellQuote(name)}` })
  return out
}

/** Enter on a destination row: loads the overview again and offers the destination's views. */
export function openDestination(store: AppStore, name: string): void {
  const client = store.client
  if (!client) return
  if (!store.extensions.has('esb')) return store.flash(store.extensions.missing('esb'), 'error')
  client.data<J>('getEsbOverview').then((data) => {
    const choices = destinationChoices(data, name)
    if (!choices.length) return store.flash(`no destination ${name} in the ESB overview`, 'error')
    store.open(new ChoiceOverlay(store, `ESB destination ${name}`, choices.map((c) => ({ label: c.label, value: c.line, detail: `:${c.line}` })), (line) => runTrustedCommand(store, line)))
  }).catch((e) => store.flash(errorText(e), 'error'))
}
