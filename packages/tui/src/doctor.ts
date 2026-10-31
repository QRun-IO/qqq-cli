/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The terminal check before the TUI starts (plain prompts on the terminal, nothing changes without
 * a y) and `qqq ui --check`. Detection and fixes are the kernel's (env/doctor).
 */

import { createInterface } from 'node:readline/promises'
import { appendTmuxConf, applyLiveFix, checkEnvironment, formatReport, readDoctorState, startupFindings, writeDoctorState, type Report } from '@qrun-io/qqq-core'

export async function runDoctor(options: { full: boolean }): Promise<{ report: Report }> {
  const started = Date.now()
  const report = checkEnvironment({ columns: process.stdout.columns, rows: process.stdout.rows })
  const state = readDoctorState()
  const ask = options.full ? report.findings.filter((f) => f.live || f.permanent) : startupFindings(report, state)
  if (options.full) process.stdout.write(formatReport(report) + '\n\n')
  if (!ask.length || !process.stdin.isTTY) {
    try {
      writeDoctorState({ lastCheck: new Date().toISOString() })
    } catch {
      // read-only config
    }
    return { report }
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const applied = new Set(state.applied ?? [])
  const dontAsk = new Set(state.dontAsk ?? [])
  const permanent = []
  try {
    if (!options.full) process.stdout.write(`qqq ui terminal check (${Date.now() - started} ms; qqq ui --no-check skips it):\n`)
    for (const f of ask) {
      process.stdout.write(`\n! ${f.message}\n`)
      if (f.live) {
        const a = (await rl.question('  Fix for this tmux server now? [y/N/never] ')).trim().toLowerCase()
        if (a === 'never') {
          dontAsk.add(f.id)
          continue
        }
        if (a === 'y' || a === 'yes') {
          applyLiveFix(f)
          applied.add(f.id)
          process.stdout.write('  fixed for this tmux server.\n')
        }
      }
      if (f.permanent) permanent.push(f)
    }
    if (permanent.length) {
      const a = (await rl.question(`\nMake ${permanent.length === 1 ? 'it' : 'them'} permanent in ~/.tmux.conf? [y/N] `)).trim().toLowerCase()
      if (a === 'y' || a === 'yes') process.stdout.write(`  appended to ${appendTmuxConf(permanent)}\n`)
      else process.stdout.write(`  To keep them, add to ~/.tmux.conf:\n${permanent.map((f) => `    ${f.permanent}`).join('\n')}\n`)
    }
  } finally {
    rl.close()
    try {
      writeDoctorState({ lastCheck: new Date().toISOString(), applied: [...applied], dontAsk: [...dontAsk] })
    } catch {
      // read-only config
    }
  }
  return { report }
}
