/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The qqq program as a library: `createProgram()` builds the commander program with every command,
 * and `runCli(argv, { stdout, stderr })` runs one command line in-process with its output sent to
 * the given writers. The TUI's `:` command line uses runCli, so the CLI grammar is the TUI's URL
 * scheme and both heads share one dispatcher.
 */

import { Command, CommanderError } from 'commander'
import { Context, EXIT, describeError, io } from './context.js'
import { versionText } from './version.js'

export { buildDescription } from './version.js'
import { registerApi } from './commands/api.js'
import { registerAudit } from './commands/audit.js'
import { registerAuth } from './commands/auth.js'
import { registerBulk } from './commands/bulk.js'
import { registerReports } from './commands/reports.js'
import { registerCompletion } from './commands/completion.js'
import { registerConfig } from './commands/config.js'
import { registerDeveloper } from './commands/developer.js'
import { registerDoctor } from './commands/doctor.js'
import { registerExtensions } from './commands/extensions.js'
import { registerHelp } from './commands/help.js'
import { registerJob } from './commands/job.js'
import { registerMisc } from './commands/misc.js'
import { registerPrint } from './commands/print.js'
import { registerProcess } from './commands/process.js'
import { registerSavedView } from './commands/saved-view.js'
import { registerRelated } from './commands/related.js'
import { registerTable } from './commands/table.js'
import { registerUi } from './commands/ui.js'
import { registerWidget } from './commands/widget.js'

/** Builds a fresh program (a new Context per run). */
export function createProgram(): Command {
  const program = new Command()
  program
    .name('qqq')
    .description('Command-line client for QQQ applications, built only on the QQQ UI API (/qqq/v1).')
    .version(versionText(), '--version', 'print the version')
    .option('--server <url>', 'the QQQ server (default: QQQ_SERVER, or the default profile)')
    .option('-p, --profile <name>', 'the profile to use (default: QQQ_PROFILE, or the default profile)')
    .option('-O, --output <format>', 'json, table, text, csv or yaml (default: table on a terminal, json in a pipe; QQQ_OUTPUT)')
    .option('--json', 'same as --output json')
    .option('-Q, --query <jmespath>', 'reshape the output with a JMESPath expression, as `aws --query`')
    .option('--fields <names>', 'comma-separated columns to show in table, text and csv output')
    .option('-y, --yes', 'answer yes to confirmations (delete, cancel)')
    .option('--utc', 'show DATE_TIME values as raw UTC instants instead of in the local zone (TZ)')
    .option('--trace', 'print stack traces for unexpected errors')
    .exitOverride()
    .configureOutput({ writeOut: (text) => io.out(text), writeErr: (text) => io.err(text) })

  let context: Context | undefined
  const ctx = () => (context ??= new Context(program))

  registerAuth(program, ctx)
  registerMisc(program, ctx)
  registerTable(program, ctx)
  registerDeveloper(program, ctx)
  registerAudit(program, ctx)
  registerRelated(program, ctx)
  registerBulk(program, ctx)
  registerProcess(program, ctx)
  registerPrint(program, ctx)
  registerSavedView(program, ctx)
  registerJob(program, ctx)
  registerWidget(program, ctx)
  registerReports(program, ctx)
  registerApi(program, ctx)
  registerExtensions(program, ctx)
  registerCompletion(program, ctx)
  registerConfig(program, ctx)
  registerDoctor(program, ctx)
  registerHelp(program, ctx)
  registerUi(program, ctx)

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
        // a short-only option (the deprecated -o sort) has no long form
        const flag = (option.long ?? option.short)!
        if (value === true) argv.push(flag)
        else if (Array.isArray(value)) for (const v of value) argv.push(flag, String(v))
        else argv.push(flag, String(value))
      }
      await target.parseAsync(argv, { from: 'user' })
    })
  }
  alias('query', 'table', 'query', 'Query a table')
  alias('get', 'table', 'get', 'View one record')
  alias('run', 'process', 'run', 'Run a process')

  return program
}

export interface RunCliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  /** Whether the output may use terminal formatting (default false: table output is still chosen by --output). */
  isTTY?: boolean
  /** The width nested results are fitted to in table output (default: none). */
  width?: number
}

/**
 * Runs one command line in-process (argv without the program name) and returns its exit code.
 * Output written by commands goes to the writers; prompts are off (no terminal), so commands that
 * would ask need their values or --yes. One run at a time.
 */
export async function runCli(argv: string[], options: RunCliIo): Promise<number> {
  const saved = { out: io.out, err: io.err, isTTY: io.isTTY, width: io.width, stdoutWrite: process.stdout.write, stderrWrite: process.stderr.write, stdinTTY: Object.getOwnPropertyDescriptor(process.stdin, 'isTTY') }
  io.out = options.stdout
  io.err = options.stderr
  io.isTTY = () => options.isTTY ?? false
  io.width = () => options.width
  // a few commands write to the process streams directly; capture those too while the command runs
  process.stdout.write = ((chunk: string | Uint8Array) => { options.stdout(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)); return true }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array) => { options.stderr(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)); return true }) as typeof process.stderr.write
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true, writable: true })
  const program = createProgram()
  try {
    await program.parseAsync(argv, { from: 'user' })
    return typeof process.exitCode === 'number' ? process.exitCode : 0
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode === 0 ? 0 : EXIT.usage
    const { code, text } = describeError(error, Boolean(program.opts().trace))
    options.stderr(text + '\n')
    return code
  } finally {
    process.exitCode = undefined
    io.out = saved.out
    io.err = saved.err
    io.isTTY = saved.isTTY
    io.width = saved.width
    process.stdout.write = saved.stdoutWrite
    process.stderr.write = saved.stderrWrite
    if (saved.stdinTTY) Object.defineProperty(process.stdin, 'isTTY', saved.stdinTTY)
    else delete (process.stdin as { isTTY?: boolean }).isTTY
  }
}
