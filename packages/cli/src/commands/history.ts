/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * `qqq history`: everything you did with the CLI and the TUI, like a shell history (the activity
 * log of core/session/activity-log.ts). Also where main.ts records each CLI invocation.
 */

import type { Command } from 'commander'
import { ACTIVITY_KINDS, NO_PROFILE, OUTPUT_FORMATS, REDACTED, absoluteTime, appendActivity, clearActivity, cliKind, commandWords, filterActivity, formatTable, isMutatingCommand, joinCommandLine, parseSince, readActivity, relativeTime, render, resolveProfile, splitCommandLine, type ActivityEntry, type OutputFormat } from '@qrun-io/qqq-core'
import { UsageError, io, type Context } from '../context.js'
import { countFooter, intOption } from './shared.js'

/**
 * What main.ts records for this invocation: `history rerun` replaces the argv with the command it
 * ran (as a shell records the expanded command, not `!5`); `history clear` is not recorded.
 */
export const invocation: { argv?: string[]; skip?: boolean } = {}

/** Commands never recorded: shell completion asks on every Tab. */
const UNRECORDED = new Set(['__complete'])

/** The profile and server a CLI invocation belongs to (the global options, QQQ_PROFILE, the default), or `none`. */
export function invocationTarget(options: { profile?: string; server?: string }): { profile: string; server?: string } {
  try {
    const t = resolveProfile(options)
    return { profile: t.name, server: t.server }
  } catch {
    return { profile: options.profile ?? process.env.QQQ_PROFILE ?? NO_PROFILE }
  }
}

/** The argv without --server, --profile and -p (and their values). */
export function withoutTarget(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--server' || a === '--profile' || a === '-p') {
      i++
      continue
    }
    if (/^--(server|profile)=/.test(a)) continue
    out.push(a)
  }
  return out
}

/** Records one CLI invocation (main.ts calls this once, on exit): the argv as typed, redacted, with exit code and duration. */
export function recordInvocation(argv: string[], options: { profile?: string; server?: string }, exit: number, startedAt: number): void {
  if (invocation.skip) return
  const args = invocation.argv ?? argv
  const [first] = commandWords(args)
  if (first && UNRECORDED.has(first)) return
  const command = `qqq ${joinCommandLine(args)}`.trim()
  // the summary leaves out the target options: the entry records the profile and server already
  const summary = `qqq ${joinCommandLine(withoutTarget(args))}`.trim()
  appendActivity({ ...invocationTarget(options), client: 'cli', kind: cliKind(args), summary, command, exit, ms: Date.now() - startedAt })
}

interface ListOptions {
  limit: string
  since?: string
  grep?: string
  kind?: string[]
  allProfiles?: boolean
  absolute?: boolean
  commands?: boolean
  format?: string
}

/** The rows of the listing (also the TUI's History screen). */
export function historyRows(entries: ActivityEntry[], options: { absolute?: boolean; commands?: boolean; allProfiles?: boolean; now?: Date } = {}) {
  return entries.map((e) => ({
    n: e.n,
    time: options.absolute ? absoluteTime(e.at) : relativeTime(e.at, options.now),
    ...(options.allProfiles ? { profile: e.profile } : {}),
    client: e.client,
    kind: e.kind,
    summary: e.summary + (e.exit ? `  [exit ${e.exit}]` : ''),
    ...(options.commands ? { command: e.command ?? '' } : {}),
  }))
}

function target(c: () => Context, allProfiles?: boolean): { profile?: string; allProfiles?: boolean } {
  if (allProfiles) return { allProfiles: true }
  let profile = NO_PROFILE
  try {
    profile = c().target.name
  } catch {
    // no server configured yet: the log of `none`
  }
  return { profile }
}

export function registerHistory(program: Command, ctx: () => Context): void {
  const list = (options: ListOptions) => {
    const c = ctx()
    const format = (options.format ?? c.format) as OutputFormat
    if (!OUTPUT_FORMATS.includes(format)) throw new UsageError(`--format must be one of ${OUTPUT_FORMATS.join(', ')}`)
    const kinds = options.kind?.flatMap((k) => k.split(',')).map((k) => k.trim()).filter(Boolean)
    for (const k of kinds ?? []) if (k !== 'ui' && !(ACTIVITY_KINDS as readonly string[]).includes(k)) throw new UsageError(`--kind takes ui or ${ACTIVITY_KINDS.join(', ')}: ${k}`)
    let since: Date | undefined
    try {
      since = options.since ? parseSince(options.since) : undefined
    } catch (e) {
      throw new UsageError((e as Error).message)
    }
    const all = readActivity(target(ctx, options.allProfiles))
    const limit = intOption(options.limit, '--limit', 0)
    const shown = filterActivity(all, { since, grep: options.grep, kind: kinds, limit })
    const rows = historyRows(shown, { absolute: options.absolute, commands: options.commands, allProfiles: options.allProfiles })
    const columns = Object.keys(rows[0] ?? { n: 0, time: '', client: '', kind: '', summary: '', ...(options.commands ? { command: '' } : {}) })
    const headers = columns.map((k) => (k === 'n' ? '#' : k[0]!.toUpperCase() + k.slice(1)))
    const hidden = all.length - shown.length
    const footer = countFooter(shown.length, 'entry', [hidden > 0 && `${hidden} older or filtered out; --limit 0 shows all`, !options.commands && shown.some((e) => e.command && e.command !== e.summary) && '--commands shows the command of each', shown.length > 0 && '`qqq history rerun <#>` runs one again'], 'entries')
    // table output: the summary gets more room than the usual 60-character cells, --commands shows each command in full
    const text = format === 'table' && !c.options.query
      ? `${formatTable(rows, columns, headers, options.commands ? 100_000 : 90)}\n${footer}`
      : render({ data: shown, rows, columns, headers, footer }, format, c.options.query, { width: io.width() })
    io.out(text + '\n')
  }

  const history = program.command('history')
    .description('Everything you did with the CLI and the TUI, like a shell history: number, time, client, summary; newest last. `history rerun <n>` runs a line again, `history clear` empties it.')
    .option('-l, --limit <n>', 'the last n entries (0: all)', '50')
    .option('--since <when>', 'only entries since a duration ago (30m, 2h, 3d, 1w) or a date (2026-11-01)')
    .option('-g, --grep <text>', 'only entries whose summary or command contains the text (any case)')
    .option('-k, --kind <kind...>', `only these kinds: cli, ui (the client) or ${ACTIVITY_KINDS.filter((k) => k !== 'cli').join(', ')}`)
    .option('--all-profiles', 'every profile\'s log, merged by time (default: the profile in use, --profile chooses)')
    .option('--absolute', 'absolute times (2026-11-01 14:03:22) instead of relative ones')
    .option('--commands', 'add the command that does each entry again, in full')
    .option('--format <format>', 'json, table, text, csv or yaml (as --output)')
    .addHelpText('after', '\nThe log is one JSONL file per profile: ~/.local/state/qqq/activity/<profile>.jsonl (QQQ_STATE_DIR moves it; rotated once to .1 at 5 MB).\nPasswords, tokens, PINs and secret values are never written. QQQ_HISTORY=off stops recording.\n')
    .action(list)

  history.command('rerun <n>')
    .option('--all-profiles', 'number as `qqq history --all-profiles` does')
    .description('Run entry n again (its CLI command; a TUI entry runs its CLI equivalent). Asks first when the command changes data (--yes skips).')
    .action(async (n: string, opts: { allProfiles?: boolean }, cmd: Command) => {
      const c = ctx()
      const parent = { ...cmd.parent!.opts<ListOptions>(), ...(opts.allProfiles ? { allProfiles: true } : {}) }
      const number = intOption(n, '<n>', 1)!
      const entry = readActivity(target(ctx, parent.allProfiles)).find((e) => e.n === number)
      if (!entry) throw new UsageError(`No history entry ${number} (\`qqq history\` lists them)`)
      const command = entry.command
      if (!command) throw new UsageError(`Entry ${number} (${entry.summary}) has no command to run again`)
      if (command.startsWith(':')) throw new UsageError(`Entry ${number} is a TUI command (${command}); run it on the : line of qqq ui`)
      if (command.includes(REDACTED)) throw new UsageError(`Entry ${number} had a secret that was not logged; type the command again: ${command}`)
      const argv = splitCommandLine(command.replace(/^qqq\s+/, ''))
      const [first, second] = commandWords(argv)
      if (first === 'history' && second === 'rerun') throw new UsageError('That entry is a history rerun itself')
      if (isMutatingCommand(argv) && !(await c.confirm(`Run again: ${command}? It changes data.`))) {
        c.note('not run')
        return
      }
      c.note(command)
      invocation.argv = argv
      const { createProgram } = await import('../program.js')
      await createProgram().parseAsync(argv, { from: 'user' })
    })

  history.command('clear')
    .option('--all-profiles', 'every profile\'s history')
    .description('Empty the history of the profile in use (--all-profiles: every profile). Asks first (--yes skips).')
    .action(async (opts: { allProfiles?: boolean }, cmd: Command) => {
      const c = ctx()
      const parent = { ...cmd.parent!.opts<ListOptions>(), ...(opts.allProfiles ? { allProfiles: true } : {}) }
      const which = target(ctx, parent.allProfiles)
      const count = readActivity(which).length
      if (!count) return c.note('The history is empty.')
      if (!(await c.confirm(`Clear ${count} history entr${count === 1 ? 'y' : 'ies'} of ${which.allProfiles ? 'every profile' : `profile ${which.profile}`}?`))) return c.note('not cleared')
      clearActivity(which)
      invocation.skip = true
      c.note(`cleared ${count} entr${count === 1 ? 'y' : 'ies'}`)
    })
}
