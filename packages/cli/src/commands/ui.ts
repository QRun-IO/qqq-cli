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

/**
 * A qqq binary built with the terminal UI (scripts/build-binaries.mjs --with-tui) sets this before the
 * CLI starts: it runs the bundled TUI in this process with the given arguments.
 */
declare global {
  var __qqqRunTui: ((args: string[]) => Promise<void>) | undefined
}

/** What qqq ui says when neither a bundled TUI nor a source checkout is there. */
export const NO_TUI_MESSAGE = [
  'The terminal UI (qqq ui) is not part of this installation: the npm package and the plain qqq binaries carry the CLI only.',
  'To get it:',
  '  - a qqq binary built with the UI (its qqq --version says "with ui"): https://github.com/QRun-IO/qqq-cli/releases',
  '  - or from source, with Node 20+ and Bun 1.4+ (https://bun.sh):',
  '      git clone https://github.com/QRun-IO/qqq-cli && cd qqq-cli && npm ci && npm run build',
  '      node packages/cli/dist/main.js ui',
].join('\n')

/** The TUI entry in a source checkout, next to this package (dev). */
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
    .option('--check', 'check the terminal and tmux setup, offer fixes, and exit')
    .option('--no-check', 'skip the quick terminal check at startup')
    .allowUnknownOption(true)
    .action(async (route: string[], options: { theme?: string; ascii?: boolean; linear?: boolean; mouse?: boolean; check?: boolean }) => {
      const globals = program.opts<{ profile?: string; server?: string }>()
      const args: string[] = []
      if (globals.profile) args.push('--profile', globals.profile)
      if (globals.server) args.push('--server', globals.server)
      if (options.theme) args.push('--theme', options.theme)
      if (options.ascii) args.push('--ascii')
      if (options.linear) args.push('--linear')
      if (options.mouse) args.push('--mouse')
      if (options.check === true) args.push('--check')
      if (options.check === false) args.push('--no-check')
      if (route.length) args.push('--', ...route)
      if (globalThis.__qqqRunTui) return globalThis.__qqqRunTui(args)
      const entry = tuiEntry()
      if (!existsSync(entry)) throw new UsageError(NO_TUI_MESSAGE)
      const result = spawnSync(process.env.QQQ_BUN ?? 'bun', ['run', entry, ...args], { stdio: 'inherit' })
      if (result.error) throw new UsageError(`Cannot start Bun (${result.error.message}); install it (https://bun.sh) or set QQQ_BUN.`)
      process.exitCode = result.status ?? 1
    })
}
