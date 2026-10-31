/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Command } from 'commander'
import { OPERATIONS, operation } from '@qrun-io/qqq-core'
import type { Context } from '../context.js'
import { UsageError } from '../context.js'
import { parsePairs, readJson } from './shared.js'

export function registerApi(program: Command, ctx: () => Context): void {
  program.command('api [operationId]')
    .description('Call any UI API operation by its operationId (every operation of the document is reachable this way).')
    .option('-p, --path <name=value...>', 'path parameters')
    .option('-q, --param <name=value...>', 'query parameters')
    .option('-b, --body-json <json|file|->', 'JSON request body (inline, a file, or - for stdin)')
    .option('-F, --form <name=value|name=@file...>', 'multipart form fields; @file uploads a file')
    .option('--bytes <file>', 'raw request body (application/octet-stream)')
    .option('-o, --out <file>', 'write a binary response to a file')
    .option('-l, --list', 'list the operations instead of calling one')
    .action(async (operationId: string | undefined, options: { path?: string[]; param?: string[]; bodyJson?: string; form?: string[]; bytes?: string; out?: string; list?: boolean }) => {
      const c = ctx()
      if (options.list || !operationId) {
        const rows = OPERATIONS.map((o) => ({ operationId: o.id, method: o.method, path: o.path, body: o.bodyTypes.join('|'), summary: o.summary }))
        c.print({ data: rows, columns: ['operationId', 'method', 'path', 'body'], footer: `(${rows.length} operations; qqq api <operationId> --path k=v --param k=v --body-json '{...}')` })
        return
      }
      const op = operation(operationId)
      if (!op) throw new UsageError(`No operation "${operationId}"; \`qqq api --list\` shows them.`)
      let form: Record<string, string | Blob> | undefined
      if (options.form) {
        form = {}
        for (const [k, v] of Object.entries(parsePairs(options.form, '--form'))) {
          form[k] = v.startsWith('@') ? new File([readFileSync(v.slice(1))], basename(v.slice(1))) : v
        }
      }
      const result = await c.call(operationId, {
        path: parsePairs(options.path, '--path'),
        query: parsePairs(options.param, '--param'),
        json: options.bodyJson !== undefined ? readJson(options.bodyJson, '--body-json') : undefined,
        form,
        bytes: options.bytes ? new Uint8Array(readFileSync(options.bytes)) : undefined,
      })
      if (result.bytes) {
        if (!options.out) throw new UsageError(`${operationId} returned ${result.contentType} (${result.bytes.length} bytes); pass --out <file>`)
        writeFileSync(options.out, result.bytes)
        c.note(`wrote ${options.out} (${result.bytes.length} bytes, ${result.contentType})`)
        return
      }
      if (typeof result.data === 'string') {
        process.stdout.write(result.data.endsWith('\n') ? result.data : result.data + '\n')
        return
      }
      c.print({ data: result.data })
    })
}
