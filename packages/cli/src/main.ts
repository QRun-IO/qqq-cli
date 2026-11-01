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

import { CommanderError } from 'commander'
import { EXIT, describeError, exitOnBrokenPipe, isBrokenPipe } from './context.js'
import { createProgram } from './program.js'
import { importLegacyCredentials } from './session.js'
import { recordInvocation } from './commands/history.js'

exitOnBrokenPipe()
const program = createProgram()
// every invocation goes to the activity log (`qqq history`) once, on exit: also when a command
// ends the process itself (the TUI, Ctrl-C at a prompt)
const startedAt = Date.now()
process.once('exit', (code) => {
  const opts = program.opts<{ profile?: string; server?: string }>()
  recordInvocation(process.argv.slice(2), { profile: opts.profile, server: opts.server }, typeof process.exitCode === 'number' ? process.exitCode : code, startedAt)
})
importLegacyCredentials().then(() => program.parseAsync()).catch((error: unknown) => {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : EXIT.usage
    return
  }
  // a stream that failed with EPIPE (an export piped into head): the reader left, nothing to report
  if (isBrokenPipe(error)) process.exit(0)
  const { code, text } = describeError(error, Boolean(program.opts().trace))
  process.stderr.write(text + '\n')
  process.exitCode = code
})
