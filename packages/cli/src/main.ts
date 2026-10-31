#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * qqq - the command-line client for QQQ applications. Every call is an operation of the QQQ UI API
 * (/qqq/v1); nothing is hard-coded about an application: apps, tables, fields and processes all
 * come from metadata. Grammar: `qqq <noun> <verb>` (table, process, job, widget, report, prefs, api), plus the flat
 * commands of 0.1 (apps, tables, query, get, run, jobs, tail) as aliases.
 */

import { CommanderError } from 'commander'
import { EXIT, describeError } from './context.js'
import { createProgram } from './program.js'

const program = createProgram()
program.parseAsync().catch((error: unknown) => {
  if (error instanceof CommanderError) {
    process.exitCode = error.exitCode === 0 ? 0 : EXIT.usage
    return
  }
  const { code, text } = describeError(error, Boolean(program.opts().trace))
  process.stderr.write(text + '\n')
  process.exitCode = code
})
