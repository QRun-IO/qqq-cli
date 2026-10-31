/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Command } from 'commander'
import { UsageError, type Context } from '../context.js'

/** The TUI entry in this checkout (dev); a packaged binary replaces this in M5. */
export function tuiEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return resolve(join(here, '..', '..', '..', 'tui', 'src', 'main.tsx'))
}

export function registerUi(program: Command, _ctx: () => Context): void {
  program.command('ui [route...]')
    .description('Open the terminal UI (OpenTUI on Bun). A route opens a screen directly, in the CLI grammar: `qqq ui table query person -w "lastName STARTS_WITH S"`, `qqq ui table get person 3`, `qqq ui process run sleepInteractive`.')
    .option('--theme <name>', 'high-contrast (default), classic or light; saved for next time')
    .option('--ascii', 'ASCII glyphs instead of box drawing and block characters')
    .option('--linear', 'one region at a time, no side pane (as QQQ_UI_LINEAR=1)')
    .option('--mouse', 'enable the mouse (off by default)')
    .allowUnknownOption(true)
    .action((route: string[], options: { theme?: string; ascii?: boolean; linear?: boolean; mouse?: boolean }) => {
      const entry = tuiEntry()
      if (!existsSync(entry)) throw new UsageError(`The TUI is not in this installation (looked for ${entry}).`)
      const globals = program.opts<{ profile?: string; server?: string }>()
      const args = ['run', entry]
      if (globals.profile) args.push('--profile', globals.profile)
      if (globals.server) args.push('--server', globals.server)
      if (options.theme) args.push('--theme', options.theme)
      if (options.ascii) args.push('--ascii')
      if (options.linear) args.push('--linear')
      if (options.mouse) args.push('--mouse')
      if (route.length) args.push('--', ...route)
      const result = spawnSync(process.env.QQQ_BUN ?? 'bun', args, { stdio: 'inherit' })
      if (result.error) throw new UsageError(`Cannot start Bun (${result.error.message}); install it (https://bun.sh) or set QQQ_BUN.`)
      process.exitCode = result.status ?? 1
    })
}
