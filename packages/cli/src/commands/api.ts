/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { basename } from 'node:path'
import type { Command } from 'commander'
import { OPERATIONS, defaultListColumns, operation, parseColumnList, type OperationInfo } from '@qrun-io/qqq-core'
import type { Context } from '../context.js'
import { UsageError } from '../context.js'
import { parsePairs, readFileArg, readJson, writeDownload } from './shared.js'

export function registerApi(program: Command, ctx: () => Context): void {
  program.command('api [operationId]')
    .description('Call any UI API operation by its operationId (every operation of the document is reachable this way).')
    .option('--path <name=value...>', 'path parameters')
    .option('-q, --param <name=value...>', 'query parameters')
    .option('-b, --body-json <json|file|->', 'JSON request body (inline, a file, or - for stdin)')
    .option('-F, --form <name=value|name=@file...>', 'multipart form fields; @file uploads a file')
    .option('--bytes <file>', 'raw request body (application/octet-stream)')
    .option('-o, --out <file>', 'write a binary response to a file (- for stdout)')
    .option('-l, --list', 'list the operations instead of calling one')
    .option('-e, --extension <name>', 'with --list: only this extension\'s operations (`core` for core ones)')
    .action(async (operationId: string | undefined, options: OperationOptions & { list?: boolean; extension?: string }) => {
      const c = ctx()
      if (options.list || !operationId) {
        const selected = OPERATIONS.filter((o) => !options.extension || (options.extension === 'core' ? !o.extension : o.extension === options.extension))
        const rows = selected.map((o) => ({ operationId: o.id, extension: o.extension ?? '', method: o.method, path: o.path, body: o.bodyTypes.join('|'), summary: o.summary }))
        const extensions = new Set(selected.map((o) => o.extension).filter(Boolean)).size
        c.print({ data: rows, columns: ['operationId', 'extension', 'method', 'path', 'body'], footer: `(${rows.length} operation${rows.length === 1 ? '' : 's'}; ${extensions} extensions; qqq api <operationId> --path k=v --param k=v --body-json '{...}'; whether an extension is installed: qqq whoami)` })
        return
      }
      const op = operation(operationId)
      if (!op) throw new UsageError(`No operation "${operationId}"; \`qqq api --list\` shows them.`)
      await runOperation(c, op, options)
    })
}

/** The options every generic operation command takes. */
export interface OperationOptions {
  path?: string[]
  param?: string[]
  bodyJson?: string
  form?: string[]
  bytes?: string
  out?: string
  /** Table output: the columns of the result's lists (comma-separated). */
  columns?: string
}

/**
 * Calls one operation from command options and prints the result. An operation of an extension
 * the server does not list is refused before the request (ExtensionNotInstalledError, exit 5).
 */
export async function runOperation(c: Context, op: OperationInfo, options: OperationOptions, pathValues: Record<string, string> = {}): Promise<void> {
  if (op.extension) (await c.extensions()).requireOperation(op.id)
  const operationId = op.id
  let form: Record<string, string | Blob> | undefined
  if (options.form) {
    form = {}
    for (const [k, v] of Object.entries(parsePairs(options.form, '--form'))) {
      form[k] = v.startsWith('@') ? new File([readFileArg(v.slice(1), `--form ${k}`) as BlobPart], basename(v.slice(1))) : v
    }
  }
  const result = await c.call(operationId, {
    path: { ...pathValues, ...parsePairs(options.path, '--path') },
    query: parsePairs(options.param, '--param'),
    json: options.bodyJson !== undefined ? readJson(options.bodyJson, '--body-json') : undefined,
    form,
    bytes: options.bytes ? readFileArg(options.bytes, '--bytes') : undefined,
  })
  if (result.bytes) {
    if (!options.out) throw new UsageError(`${operationId} returned ${result.contentType} (${result.bytes.length} bytes); pass --out <file> (or --out - for stdout)`)
    const written = writeDownload(options.out, options.out, result.bytes)
    if (written) c.note(`wrote ${written} (${result.bytes.length} bytes, ${result.contentType})`)
    return
  }
  if (typeof result.data === 'string') {
    process.stdout.write(result.data.endsWith('\n') ? result.data : result.data + '\n')
    return
  }
  c.print({ data: result.data, layout: { columns: listColumns(c, op, options) } })
}

/** The list columns for table output: --columns, else the global --fields, else the operation's defaults. */
export function listColumns(c: Context, op: OperationInfo, options: { columns?: string }): Record<string, string[]> | undefined {
  const chosen = parseColumnList(options.columns) ?? c.fields
  return chosen ? { '*': chosen } : defaultListColumns(op.id)
}
