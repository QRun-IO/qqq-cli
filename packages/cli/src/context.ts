/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * What every command shares: the resolved server, the authenticated client, output rendering with
 * the global --output / --query / --fields options, confirmations, and the exit-code policy.
 */

import type { Command } from 'commander'
import { UiApiError, unwrap, type UiApiClient } from '@qrun-io/qqq-ui-api-client'
import { Collaboration, ExtensionNotInstalledError, ExtensionRegistry, KNOWN_EXTENSIONS, FilterSyntaxError, OUTPUT_FORMATS, ProcessError, defaultTimeZone, type DisplayOptions, applyQuery, callOperation, defaultFormat, extensionRegistry, getMetaData, getTableMetaData, render, type CallInput, type CallResult, type MetaDataDocument, type OutputFormat, type Printable } from '@qrun-io/qqq-core'
import { openRealtimeStream } from '@qrun-io/qqq-ui-api-client'
import { CLIENT_CHANNEL, authenticatedFetch, clientFor, currentToken, selectTarget, sessionCookieFor, target, type Target } from './session.js'

/** Exit codes, as in the design doc (KofTwentyTwo ADR-0031 shape). */
export const EXIT = { ok: 0, error: 1, usage: 2, auth: 3, transient: 4, notFound: 5, validation: 6, unexpected: 70 } as const

export interface GlobalOptions {
  server?: string
  profile?: string
  output?: OutputFormat
  json?: boolean
  query?: string
  fields?: string
  yes?: boolean
  trace?: boolean
  noPager?: boolean
  utc?: boolean
}

export class Context {
  readonly options: GlobalOptions
  private clientCache?: UiApiClient
  private registryCache?: Promise<ExtensionRegistry>

  constructor(program: Command) {
    this.options = program.opts<GlobalOptions>()
    if (this.options.output && !OUTPUT_FORMATS.includes(this.options.output)) {
      throw new UsageError(`--output must be one of ${OUTPUT_FORMATS.join(', ')}`)
    }
    selectTarget({ profile: this.options.profile, server: this.options.server })
  }

  /** The profile and server from --profile, QQQ_PROFILE, --server, QQQ_SERVER or the default profile. */
  get target(): Target {
    return target()
  }

  /** The server origin of the target. */
  get server(): string {
    return this.target.server
  }

  /** The authenticated typed client. */
  get client(): UiApiClient {
    this.clientCache ??= clientFor(this.target)
    return this.clientCache
  }

  /** The output format in effect. */
  get format(): OutputFormat {
    if (this.options.output) return this.options.output
    if (this.options.json) return 'json'
    return defaultFormat(Boolean(process.stdout.isTTY))
  }

  /** How DATE_TIME values are shown: in the TZ zone, or raw UTC instants with --utc. */
  get dateTimeDisplay(): DisplayOptions {
    return { utc: Boolean(this.options.utc), timeZone: defaultTimeZone() }
  }

  /** `--fields a,b,c` as a list, or undefined. */
  get fields(): string[] | undefined {
    return this.options.fields ? this.options.fields.split(',').map((f) => f.trim()).filter(Boolean) : undefined
  }

  /** Prints a result in the chosen format, after --query. */
  print(printable: Printable): void {
    process.stdout.write(render(printable, this.format, this.options.query) + '\n')
  }

  /** Reshapes data with --query without printing (for callers that print themselves). */
  shape<T>(data: T): unknown {
    return applyQuery(data, this.options.query)
  }

  /** The server's metadata, from the on-disk cache when fresh. */
  metaData(options: { refresh?: boolean } = {}): Promise<MetaDataDocument> {
    return getMetaData(this.server, authenticatedFetch(this.target), options)
  }

  /** A table's definition, cached for five minutes (fields, sections, capabilities). */
  tableMeta<T = Record<string, unknown>>(table: string, options: { refresh?: boolean } = {}): Promise<T> {
    return getTableMetaData<T>(this.server, table, authenticatedFetch(this.target), options)
  }

  /** The server's extensions (GET /version, cached with the metadata). */
  extensions(options: { refresh?: boolean } = {}): Promise<ExtensionRegistry> {
    // QQQ_EXTENSION_CHECK=off treats every extension the client knows as installed, for mock
    // servers (Prism) whose GET /version is only the document's example.
    if (process.env.QQQ_EXTENSION_CHECK === 'off') return Promise.resolve(new ExtensionRegistry(KNOWN_EXTENSIONS.map((e) => ({ name: e.name, version: e.documentVersion, pathPrefix: e.pathPrefix, known: true, meetsMinimum: true }))))
    this.registryCache ??= extensionRegistry(this.server, authenticatedFetch(this.target), options)
    return this.registryCache
  }

  /** The collaboration module for this server, with the realtime stream for presence. */
  async collaboration(): Promise<Collaboration> {
    const t = this.target
    return new Collaboration(await this.extensions(), {
      call: (id, input) => this.call(id, input),
      openStream: (signal) => (async function* () {
        const session = await sessionCookieFor(t)
        yield* openRealtimeStream({
          baseUrl: t.server,
          clientChannel: CLIENT_CHANNEL,
          signal,
          headers: session ? { Cookie: `sessionUUID=${session}` } : undefined,
          token: session ? undefined : () => currentToken(t),
        })
      })(),
    })
  }

  /** Calls an operation by id (the generic escape hatch). */
  call(id: string, input: CallInput): Promise<CallResult> {
    return callOperation(this.server, id, input, authenticatedFetch(this.target))
  }

  /** Unwraps a typed client call. */
  unwrap<T>(result: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
    return unwrap(result)
  }

  /** Asks on the terminal unless --yes; without a terminal and without --yes, refuses. */
  async confirm(question: string): Promise<boolean> {
    if (this.options.yes) return true
    if (!process.stdin.isTTY) throw new UsageError(`${question} Pass --yes to confirm without a terminal.`)
    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    try {
      const answer = await rl.question(`${question} [y/N] `)
      return /^y(es)?$/i.test(answer.trim())
    } finally {
      rl.close()
    }
  }

  /** A note for people, on stderr so pipes stay clean. */
  note(text: string): void {
    process.stderr.write(text + '\n')
  }
}

/** A mistake in how the command was called (exit 2). */
export class UsageError extends Error {}

/** Maps an error to its exit code and the stderr text. */
export function describeError(error: unknown, trace = false): { code: number; text: string } {
  if (error instanceof UsageError || error instanceof FilterSyntaxError) return { code: EXIT.usage, text: `Error: ${error.message}` }
  if (error instanceof ExtensionNotInstalledError) return { code: EXIT.notFound, text: `Error: ${error.message}` }
  if (error instanceof UiApiError) {
    const lines = [`Error: ${error.message} (${error.code}, HTTP ${error.status}${error.traceId ? `, trace ${error.traceId}` : ''})`]
    for (const fieldError of error.fieldErrors) lines.push(`  ${fieldError.field}: ${fieldError.message}`)
    if (error.code === 'UNAUTHENTICATED') lines.push('Sign in again with `qqq login`.')
    const code = error.code === 'UNAUTHENTICATED' || error.code === 'PERMISSION_DENIED' ? EXIT.auth
      : error.code === 'RATE_LIMITED' ? EXIT.transient
        : error.code === 'NOT_FOUND' ? EXIT.notFound
          : error.code === 'BAD_REQUEST' || error.code === 'CONFLICT' ? EXIT.validation
            : error.status >= 500 ? EXIT.unexpected : EXIT.error
    return { code, text: lines.join('\n') }
  }
  if (error instanceof ProcessError) return { code: error.isInputError ? EXIT.validation : EXIT.error, text: `Error: ${error.message}` }
  if (error instanceof TypeError && /fetch failed|ECONNREFUSED|ENOTFOUND|network/i.test(String((error as Error & { cause?: unknown }).cause ?? error.message))) {
    return { code: EXIT.transient, text: `Error: cannot reach the server (${String((error as Error & { cause?: { message?: string } }).cause?.message ?? error.message)})` }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: EXIT.error, text: trace && error instanceof Error && error.stack ? error.stack : `Error: ${message}` }
}
