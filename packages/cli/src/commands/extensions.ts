/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * One noun per extension (qbit or module): `qqq esb ...`, `qqq collab ...`, `qqq sql-workbench ...`.
 * Every operation of an extension is a subcommand, generated from the operation index
 * (`get-overview`, `put-favorites`, `get-records-comments <table> <pk>`), taking its path parameters
 * as arguments or --path, plus --param and --body-json. First-class commands (esb, collab) sit next
 * to the generated ones. Every subcommand checks the server's GET /version first: an extension that
 * is not installed stops with exit 5 and the list of what is installed.
 */

import type { Command } from 'commander'
import { KNOWN_EXTENSIONS, OPERATIONS, operationsOf, type OperationInfo } from '@qrun-io/qqq-core'
import type { Context } from '../context.js'
import { runOperation, type OperationOptions } from './api.js'
import type { Json } from './shared.js'
import { registerCollab } from './collab.js'

/** The noun of each extension; the extension's own name unless it is long. */
export const NOUNS: Record<string, string> = { collaboration: 'collab' }

export function nounOf(extension: string): string {
  return NOUNS[extension] ?? extension
}

function kebab(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()
}

/**
 * Subcommand names for an extension's operations: the method and the literal path segments after
 * the extension's prefix (`GET /qbit/collaboration/records/{table}/{pk}/comments` is
 * `get-records-comments`); names that would collide get `-by-<param>`, then the operationId.
 */
export function subcommandNames(extension: string, pathPrefix: string, operations: OperationInfo[]): Map<string, OperationInfo> {
  const base = `/qqq/v1${pathPrefix}`
  const first = operations.map((op) => {
    const segments = op.path.startsWith(base) ? op.path.slice(base.length).split('/').filter(Boolean) : op.path.split('/').filter(Boolean)
    const literals = segments.filter((s) => !s.startsWith('{'))
    return { op, name: `${op.method.toLowerCase()}-${literals.length ? literals.map(kebab).join('-') : extension}` }
  })
  const count = (name: string, list: { name: string }[]) => list.filter((x) => x.name === name).length
  const second = first.map((x) => (count(x.name, first) > 1 && x.op.pathParams.length ? { op: x.op, name: `${x.name}-by-${x.op.pathParams.map(kebab).join('-')}` } : x))
  const names = new Map<string, OperationInfo>()
  for (const x of second) names.set(count(x.name, second) > 1 ? kebab(x.op.id) : x.name, x.op)
  return names
}

/** Adds one generated subcommand per operation of an extension to its noun. */
export function addOperationCommands(noun: Command, extension: string, pathPrefix: string, ctx: () => Context): void {
  const taken = new Set(noun.commands.map((c) => c.name()))
  for (const [name, op] of subcommandNames(extension, pathPrefix, operationsOf(extension))) {
    if (taken.has(name)) continue
    const args = op.pathParams.map((p) => ` [${p}]`).join('')
    const cmd = noun.command(`${name}${args}`)
      .description(`${op.summary || op.id} (${op.method} ${op.path.replace('/qqq/v1', '')}; operation ${op.id})`)
      .option('-p, --path <name=value...>', 'path parameters (or give them as arguments)')
      .option('-q, --param <name=value...>', `query parameters${op.queryParams.length ? `: ${op.queryParams.join(', ')}` : ''}`)
    if (op.bodyTypes.includes('application/json') || op.bodyTypes.length === 0) cmd.option('-b, --body-json <json|file|->', 'JSON request body (inline, a file, or - for stdin)')
    if (op.bodyTypes.includes('multipart/form-data')) cmd.option('-F, --form <name=value|name=@file...>', 'multipart form fields; @file uploads a file')
    cmd.option('-o, --out <file>', 'write a binary response to a file')
    cmd.action(async (...actionArgs: unknown[]) => {
      const values = actionArgs.slice(0, op.pathParams.length) as (string | undefined)[]
      const options = actionArgs[op.pathParams.length] as OperationOptions
      const pathValues: Record<string, string> = {}
      op.pathParams.forEach((p, i) => {
        if (values[i] !== undefined) pathValues[p] = values[i]!
      })
      await runOperation(ctx(), op, options, pathValues)
    })
  }
}

/** Requires the extension on the target server (exit 5 with the installed list when it is absent). */
export async function requireExtension(c: Context, name: string): Promise<void> {
  ;(await c.extensions()).require(name)
}

function counters(destination: Json | undefined): Json {
  const c = (destination?.counters ?? {}) as Json
  return { published: c.published ?? '', consumed: c.consumed ?? '', failed: c.failed ?? '', deadLettered: c.deadLettered ?? '', inFlight: c.inFlight ?? '', lastActivity: String(c.lastActivity ?? '').slice(0, 19) }
}

function registerEsb(noun: Command, ctx: () => Context): void {
  const run = async (id: string, path: Record<string, string> = {}, query: Record<string, string | undefined> = {}) => {
    const c = ctx()
    await requireExtension(c, 'esb')
    return { c, data: (await c.call(id, { path, query })).data as Json }
  }
  const columns = ['role', 'destination', 'type', 'detail', 'state', 'published', 'consumed', 'failed', 'deadLettered', 'inFlight', 'lastActivity']
  const linkRows = (data: Json) => [
    ...((data.publications ?? []) as Json[]).map((p) => {
      const d = p.destination as Json | undefined
      return { role: 'publishes', destination: d?.name ?? '', type: d?.type ?? '', detail: ((p.events ?? []) as string[]).join(' '), state: '', ...counters(d) }
    }),
    ...((data.subscribers ?? data.triggers ?? []) as Json[]).map((s) => {
      const d = s.destination as Json | undefined
      return { role: 'trigger', destination: d?.name ?? '', type: d?.type ?? '', detail: s.processLabel ?? s.processName ?? s.name ?? '', state: s.state ?? '', ...counters(d) }
    }),
  ]

  noun.command('overview')
    .description('Broker connections and every destination with its publishers and triggers (needs ESB permission).')
    .action(async () => {
      const { c, data } = await run('getEsbOverview')
      const rows = ((data.destinations ?? []) as Json[]).map((d) => ({ destination: d.name, type: d.type, provider: d.provider, publishers: ((d.publishers ?? []) as unknown[]).length, triggers: ((d.triggers ?? []) as unknown[]).length, ...counters(d) }))
      c.print({ data, rows, columns: ['destination', 'type', 'provider', 'publishers', 'triggers', 'published', 'consumed', 'failed', 'deadLettered', 'lastActivity'], footer: `(${((data.providers ?? []) as unknown[]).length} providers, ${rows.length} destinations)` })
    })

  noun.command('table <table>')
    .description('What a table publishes and which processes it triggers.')
    .action(async (table: string) => {
      const { c, data } = await run('getEsbTableByTable', { table })
      c.print({ data, rows: linkRows(data), columns })
    })

  noun.command('process <process>')
    .description('What a process publishes and what triggers it.')
    .action(async (process: string) => {
      const { c, data } = await run('getEsbProcessByProcess', { process })
      c.print({ data, rows: linkRows(data), columns })
    })

  const messageRows = (data: Json) => ((data.messages ?? []) as Json[]).map((m) => ({ messageId: m.messageId, timestamp: String(m.timestamp ?? '').slice(0, 19), deliveries: m.deliveryCount ?? '', event: m.event ?? '', body: String(m.rawBody ?? '').slice(0, 80) }))

  noun.command('dead-letters <trigger>')
    .description("A trigger's dead letters.")
    .option('-l, --limit <n>', 'most messages', '20')
    .option('--offset <n>', 'skip this many')
    .action(async (trigger: string, options: { limit: string; offset?: string }) => {
      const { c, data } = await run('getEsbDeadLettersByTrigger', { trigger }, { limit: options.limit, offset: options.offset })
      const rows = messageRows(data)
      c.print({ data, rows, columns: ['messageId', 'timestamp', 'deliveries', 'event', 'body'], footer: `(${rows.length} dead letters${data.hasMore ? ', more with --offset' : ''})` })
    })

  noun.command('messages <destination>')
    .description('Messages waiting on a destination (a topic needs --trigger: its messages are kept per trigger).')
    .option('-t, --trigger <name>', 'the trigger (subscription) of a topic')
    .option('-l, --limit <n>', 'most messages', '20')
    .option('--offset <n>', 'skip this many')
    .action(async (destination: string, options: { trigger?: string; limit: string; offset?: string }) => {
      const { c, data } = await run('getEsbMessagesByDestination', { destination }, { trigger: options.trigger, limit: options.limit, offset: options.offset })
      const rows = messageRows(data)
      c.print({ data, rows, columns: ['messageId', 'timestamp', 'deliveries', 'event', 'body'], footer: `(${rows.length} messages${data.hasMore ? ', more with --offset' : ''})` })
    })
}

export function registerExtensions(program: Command, ctx: () => Context): void {
  program.command('extensions')
    .description('Extensions (qbits) this client knows and which ones the server has installed.')
    .action(async () => {
      const c = ctx()
      const registry = await c.extensions()
      const rows: Json[] = KNOWN_EXTENSIONS.map((e) => {
        const installed = registry.installed.find((i) => i.name === e.name)
        return {
          extension: e.name,
          noun: `qqq ${nounOf(e.name)}`,
          installed: installed ? installed.version ?? 'yes' : '',
          status: !installed ? 'not installed' : installed.meetsMinimum ? 'ok' : `needs ${e.minVersion}+`,
          client: e.documentVersion ?? '',
          minimum: e.minVersion ?? '',
          operations: operationsOf(e.name).length,
          channels: e.channels.join(' '),
        }
      })
      for (const u of registry.unknown()) rows.push({ extension: u.name, noun: '', installed: u.version ?? 'yes', status: 'unknown to this client', client: '', minimum: '', operations: 0, channels: '' })
      c.print({ data: { installed: registry.installed, known: KNOWN_EXTENSIONS }, rows, columns: ['extension', 'noun', 'installed', 'status', 'client', 'minimum', 'operations', 'channels'], footer: `(installed: ${registry.describe()}; ${OPERATIONS.filter((o) => o.extension).length} extension operations in this client)` })
    })

  for (const e of KNOWN_EXTENSIONS) {
    const name = nounOf(e.name)
    const noun = program.command(name).description(`${e.label} (${e.name} extension${e.minVersion ? ` ${e.minVersion}+` : ''}, ${e.repository}): ${e.description || 'operations'}`)
    if (name !== e.name) noun.alias(e.name)
    if (e.name === 'esb') registerEsb(noun, ctx)
    if (e.name === 'collaboration') registerCollab(noun, ctx)
    addOperationCommands(noun, e.name, e.pathPrefix, ctx)
    noun.addHelpText('after', `\nEvery ${e.name} operation is a subcommand; path parameters go as arguments or --path name=value.\nNot installed on the server: exit 5 with the installed list (see \`qqq extensions\`).`)
  }
}
