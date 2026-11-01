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
import { Assistant, Collaboration, Printing, downloadProcessFile, missingQBitMessage, runProcess, type ProcessMeta, ExtensionNotInstalledError, OperationInputError, ExtensionRegistry, KNOWN_EXTENSIONS, FilterSyntaxError, OUTPUT_FORMATS, ProcessError, UnsafeFileNameError, defaultTimeZone, type DisplayOptions, applyQuery, callOperation, defaultFormat, extensionRegistry, getMetaData, getTableMetaData, render, type CallInput, type CallResult, type MetaDataDocument, type OutputFormat, type Printable } from '@qrun-io/qqq-core'
import { openRealtimeStream } from '@qrun-io/qqq-ui-api-client'
import { CLIENT_CHANNEL, authenticatedFetch, clientFor, currentToken, selectTarget, sessionCookieHeaderFor, target, type Target } from './session.js'

/** A write that ends the process quietly (status 0) when it throws because the reader has gone. */
function safeWrite(stream: NodeJS.WriteStream, text: string): void {
  try {
    stream.write(text)
  } catch (error) {
    if (isBrokenPipe(error)) process.exit(0)
    throw error
  }
}

/**
 * Where output goes. The CLI writes to the process streams; `runCli` (the TUI's `:` command line)
 * points these at a pane for the duration of one command.
 */
export const io = {
  out: (text: string): void => { safeWrite(process.stdout, text) },
  err: (text: string): void => { safeWrite(process.stderr, text) },
  isTTY: (): boolean => Boolean(process.stdout.isTTY),
  /** The terminal width table output fits nested results in; undefined when not on a terminal. */
  width: (): number | undefined => (process.stdout.isTTY ? process.stdout.columns : undefined),
}

/** What a write to a pipe whose reader has gone ends with: EPIPE, or (macOS, a stream already torn down) the errors that follow it. */
const BROKEN_PIPE_CODES = new Set(['EPIPE', 'ECONNRESET', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END'])

/** Whether an error is a write to a pipe whose reader has gone (`qqq table query | head -1`). */
export function isBrokenPipe(error: unknown): boolean {
  return BROKEN_PIPE_CODES.has(String((error as NodeJS.ErrnoException | undefined)?.code))
}

/**
 * A pipe nobody reads any more ends the command at once with status 0, as `yes | head` does, whatever
 * else was going on: the process exits from the stream's error event, from a write that throws, and
 * from an uncaught error that is one, so no later code can turn it into a failure.
 */
export function exitOnBrokenPipe(streams: Array<NodeJS.WriteStream> = [process.stdout, process.stderr], exit: (code: number) => void = (code) => process.exit(code), on: (event: 'uncaughtException', listener: (error: Error) => void) => unknown = (event, listener) => process.on(event, listener)): void {
  for (const stream of streams) {
    stream.on('error', (error) => {
      if (isBrokenPipe(error)) exit(0)
      else throw error
    })
  }
  on('uncaughtException', (error) => {
    if (isBrokenPipe(error)) exit(0)
    else {
      process.stderr.write(`${error.stack ?? error.message}\n`)
      process.exit(1)
    }
  })
}

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
    return defaultFormat(io.isTTY())
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
    io.out(render(printable, this.format, this.options.query, { width: io.width() }) + '\n')
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
        const session = await sessionCookieHeaderFor(t)
        yield* openRealtimeStream({
          baseUrl: t.server,
          clientChannel: CLIENT_CHANNEL,
          signal,
          headers: session ? { Cookie: session } : undefined,
          token: session ? undefined : () => currentToken(t),
        })
      })(),
    })
  }

  /** The assistant module for this server: the feature probe and streamed questions. */
  async assistant(): Promise<Assistant> {
    const t = this.target
    return new Assistant(await this.extensions(), { call: (id, input) => this.call(id, input), fetch: authenticatedFetch(t), baseUrl: t.server })
  }

  /** The printing module for this server: printers, jobs and Print through the qbit's tables and processes. */
  async printing(): Promise<Printing> {
    const t = this.target
    return new Printing(await this.extensions(), {
      call: (id, input) => this.call(id, input),
      runProcess: async (processName, { values, recordIds }) => {
        const meta = await this.unwrap(this.client.GET('/qqq/v1/metaData/process/{processName}', { params: { path: { processName } } })) as unknown as ProcessMeta
        const outcome = await runProcess({ baseUrl: t.server, fetch: authenticatedFetch(t), meta, values, records: recordIds.length ? { ids: recordIds } : undefined, stepTimeoutMillis: 60000 })
        return outcome.values
      },
      download: (reference) => downloadProcessFile(t.server, authenticatedFetch(t), reference),
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

  /**
   * Asks on the terminal unless --yes; without a terminal and without --yes, refuses. Ctrl-C at the
   * question exits 130 (prompt.ask passes it on as SIGINT), never a silent "no".
   */
  async confirm(question: string): Promise<boolean> {
    if (this.options.yes) return true
    if (!process.stdin.isTTY) throw new UsageError(`${question} Pass --yes to confirm without a terminal.`)
    const { ask } = await import('./prompt.js')
    return /^y(es)?$/i.test(await ask(`${question} [y/N] `))
  }

  /** A note for people, on stderr so pipes stay clean. */
  note(text: string): void {
    io.err(text + '\n')
  }
}

/** A mistake in how the command was called (exit 2). */
export class UsageError extends Error {}

/** Maps an error to its exit code and the stderr text. */
export function describeError(error: unknown, trace = false): { code: number; text: string } {
  if (error instanceof UsageError || error instanceof FilterSyntaxError || error instanceof UnsafeFileNameError || error instanceof OperationInputError) return { code: EXIT.usage, text: `Error: ${error.message}` }
  if (error instanceof ExtensionNotInstalledError) return { code: EXIT.notFound, text: `Error: ${error.message}` }
  if (error instanceof UiApiError) {
    // a server failure that only says a QBit is missing (attachments without Object Storage): one plain line
    const missing = missingQBitMessage(error)
    if (missing) return { code: EXIT.unexpected, text: `Error: ${missing}` }
    const lines = [`Error: ${error.message} (${error.code}, HTTP ${error.status}${error.traceId ? `, trace ${error.traceId}` : ''})`]
    for (const fieldError of error.fieldErrors) lines.push(`  ${fieldError.field}: ${fieldError.message}`)
    if (error.code === 'UNAUTHENTICATED') lines.push('Sign in again with `qqq login`.')
    const code = error.code === 'UNAUTHENTICATED' || error.code === 'PERMISSION_DENIED' ? EXIT.auth
      : error.code === 'RATE_LIMITED' ? EXIT.transient
        : error.code === 'NOT_FOUND' ? EXIT.notFound
          : error.code === 'BAD_REQUEST' || error.code === 'CONFLICT' ? EXIT.validation
            // a gateway or an overloaded server: try again later, as a refused connection
            : error.status === 502 || error.status === 503 || error.status === 504 ? EXIT.transient
              : error.status >= 500 ? EXIT.unexpected : EXIT.error
    return { code, text: lines.join('\n') }
  }
  if (error instanceof ProcessError) return { code: error.isInputError ? EXIT.validation : EXIT.error, text: `Error: ${error.message}` }
  if (error instanceof TypeError && /fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|network|bad port/i.test(`${error.message} ${String((error as Error & { cause?: unknown }).cause ?? '')}`)) {
    return { code: EXIT.transient, text: `Error: cannot reach the server (${String((error as Error & { cause?: { message?: string } }).cause?.message ?? error.message)})` }
  }
  const message = error instanceof Error ? error.message : String(error)
  return { code: EXIT.error, text: trace && error instanceof Error && error.stack ? error.stack : `Error: ${message}` }
}
