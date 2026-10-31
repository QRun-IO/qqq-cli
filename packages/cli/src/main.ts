#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * qqq - the command-line client for QQQ applications. Every call is an operation of the QQQ UI API
 * (/qqq/v1); nothing is hard-coded about an application: apps, tables, fields and processes all
 * come from metadata. Grammar: `qqq <noun> <verb>` (table, process, job, widget, report, prefs, api, and one noun per
 * extension: esb, collab, sql-workbench, ...), plus the flat
 * commands of 0.1 (apps, tables, query, get, run, jobs, tail) as aliases.
 */

import { Command, CommanderError } from 'commander'
import { UI_API_VERSION } from '@qrun-io/qqq-ui-api-client'
import { Context, EXIT, describeError } from './context.js'
import { CLI_VERSION } from './session.js'
import { registerApi } from './commands/api.js'
import { registerAudit } from './commands/audit.js'
import { registerAuth } from './commands/auth.js'
import { registerCompletion } from './commands/completion.js'
import { registerConfig } from './commands/config.js'
import { registerExtensions } from './commands/extensions.js'
import { registerHelp } from './commands/help.js'
import { registerJob } from './commands/job.js'
import { registerMisc } from './commands/misc.js'
import { registerProcess } from './commands/process.js'
import { registerSavedView } from './commands/saved-view.js'
import { registerRelated } from './commands/related.js'
import { registerTable } from './commands/table.js'
import { registerWidget } from './commands/widget.js'

const program = new Command()
program
  .name('qqq')
  .description('Command-line client for QQQ applications, built only on the QQQ UI API (/qqq/v1).')
  .version(`${CLI_VERSION} (UI API client ${UI_API_VERSION})`)
  .option('-s, --server <url>', 'the QQQ server (default: QQQ_SERVER, or the default profile)')
  .option('-p, --profile <name>', 'the profile to use (default: QQQ_PROFILE, or the default profile)')
  .option('-O, --output <format>', 'json, table, text, csv or yaml (default: table on a terminal, json in a pipe; QQQ_OUTPUT)')
  .option('--json', 'same as --output json')
  .option('-Q, --query <jmespath>', 'reshape the output with a JMESPath expression, as `aws --query`')
  .option('--fields <names>', 'comma-separated columns to show in table, text and csv output')
  .option('-y, --yes', 'answer yes to confirmations (delete, cancel)')
  .option('--utc', 'show DATE_TIME values as raw UTC instants instead of in the local zone (TZ)')
  .option('--trace', 'print stack traces for unexpected errors')
  .exitOverride()
  .configureOutput({ writeErr: (text) => process.stderr.write(text) })

let context: Context | undefined
const ctx = () => (context ??= new Context(program))

registerAuth(program, ctx)
registerMisc(program, ctx)
registerTable(program, ctx)
registerAudit(program, ctx)
registerRelated(program, ctx)
registerProcess(program, ctx)
registerSavedView(program, ctx)
registerJob(program, ctx)
registerWidget(program, ctx)
registerApi(program, ctx)
registerExtensions(program, ctx)
registerCompletion(program, ctx)
registerConfig(program, ctx)
registerHelp(program, ctx)

/** Flat aliases from 0.1: forward to the noun-verb commands with the same options. */
function alias(flat: string, noun: string, verb: string, description: string): void {
  const target = program.commands.find((c) => c.name() === noun)!.commands.find((c) => c.name() === verb)!
  const cmd = program.command(`${flat} ${target.registeredArguments.map((a) => (a.required ? `<${a.name()}>` : `[${a.name()}]`)).join(' ')}`.trim(), { hidden: true }).description(`${description} (alias of \`qqq ${noun} ${verb}\`)`)
  for (const option of target.options) cmd.addOption(option)
  cmd.action(async (...args: unknown[]) => {
    const commandArgs = args.slice(0, -2) as string[]
    const options = args[args.length - 2] as Record<string, unknown>
    const argv: string[] = [...commandArgs]
    for (const option of target.options) {
      const value = options[option.attributeName()]
      if (value === undefined || value === false) continue
      if (value === true) argv.push(option.long!)
      else if (Array.isArray(value)) for (const v of value) argv.push(option.long!, String(v))
      else argv.push(option.long!, String(value))
    }
    await target.parseAsync(argv, { from: 'user' })
  })
}
alias('query', 'table', 'query', 'Query a table')
alias('get', 'table', 'get', 'View one record')
alias('run', 'process', 'run', 'Run a process')

program.parseAsync().catch((error: unknown) => {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : EXIT.usage
    return
  }
  const { code, text } = describeError(error, Boolean(program.opts().trace))
  process.stderr.write(text + '\n')
  process.exitCode = code
})
