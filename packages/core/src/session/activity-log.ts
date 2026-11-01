/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The activity log: everything you did with the CLI and the TUI, like a shell history. One
 * append-only JSONL file per profile in the state directory:
 *
 *   ~/.local/state/qqq/activity/<profile>.jsonl   (QQQ_STATE_DIR overrides; XDG_STATE_HOME honoured)
 *
 * One line per event: when (ISO time with the local offset), profile, server, client (cli or ui),
 * kind, a one-line summary, and the command that does it again when there is one. A file over
 * ~5 MB is rotated once to `<profile>.jsonl.1` (an older .1 is replaced). Secrets never reach the
 * file: token, password, PIN and secret flags, `name=value` pairs and filter criteria on secret
 * names, Authorization headers and bearer tokens are written as `***`. QQQ_HISTORY=off turns
 * the log off.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from './local-state.js'

export type ActivityClient = 'cli' | 'ui'

/**
 * What an event was: a CLI invocation that is none of the others (`cli`), a TUI `:` command
 * (`command`), opening a screen (`open`), a query with a filter, a record created, edited or
 * deleted (`record`), a process run, an export, a print, a server switch, a sign-in or sign-out.
 */
export const ACTIVITY_KINDS = ['cli', 'command', 'open', 'query', 'record', 'process', 'export', 'print', 'server', 'auth'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]

/** What a TUI event opened, so the History screen can open it again. */
export interface ActivityTarget {
  type: 'app' | 'table' | 'record' | 'process' | 'report' | 'widget'
  name: string
  key?: string
}

export interface ActivityEvent {
  /** ISO time with the local offset (2026-11-01T14:03:22.120-05:00). */
  at: string
  profile: string
  server?: string
  client: ActivityClient
  kind: ActivityKind
  /** One line for people; never field values. */
  summary: string
  /** The command that does it again: `qqq …` for the CLI, `:…` for a TUI-only command. */
  command?: string
  /** CLI invocations: the exit code and the duration in milliseconds. */
  exit?: number
  ms?: number
  target?: ActivityTarget
}

/** An event as read back, with its history number (1 is the oldest kept). */
export interface ActivityEntry extends ActivityEvent {
  n: number
}

/** The size at which the file is rotated to `.1`. */
export const ACTIVITY_MAX_BYTES = 5 * 1024 * 1024

/** The profile name used when no profile could be resolved (no server yet). */
export const NO_PROFILE = 'none'

export function activityEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !/^(off|0|false|no)$/i.test(env.QQQ_HISTORY ?? '')
}

export function activityDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), 'activity')
}

function safeName(profile: string): string {
  return (profile || NO_PROFILE).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '_')
}

/** The log file of a profile. */
export function activityFile(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(activityDir(env), `${safeName(profile)}.jsonl`)
}

/** A time as ISO 8601 with the local offset instead of Z. */
export function localIsoTime(date = new Date()): string {
  const offset = -date.getTimezoneOffset()
  const local = new Date(date.getTime() + offset * 60_000)
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${local.toISOString().slice(0, -1)}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

// ---- redaction ----

const SECRET_WORDS = new Set(['pass', 'password', 'passwd', 'passphrase', 'pin', 'secret', 'token', 'apikey', 'bearer', 'credential', 'credentials', 'cookie', 'authorization', 'otp', 'mfa'])

/** Whether a flag, field or header name names a secret (`--token`, `apiKey`, `client_secret`, `userPassword`). */
export function isSecretName(name: string): boolean {
  const words = name.replace(/^-+/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    if (SECRET_WORDS.has(words[i]!)) return true
    if (words[i] === 'key' && (words[i - 1] === 'api' || words[i - 1] === 'private' || words[i - 1] === 'access')) return true
  }
  return false
}

export const REDACTED = '***'

const CRITERION = /([A-Za-z_][\w.]*)(\s*(?:!=|<>|>=|<=|=|<|>|~)\s*|\s+(?:[A-Z][A-Z_]+|[a-z][a-z_]*)\s+)("[^"]*"|'[^']*'|\S+)/g

/** Redacts the secret parts of one argument that is not a flag's value of its own. */
function redactArg(arg: string): string {
  if (/^bearer\s+\S/i.test(arg)) return `Bearer ${REDACTED}`
  // a JWT or another long opaque token on its own
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(arg)) return REDACTED
  // a header: `Authorization: Bearer x`, `X-Api-Key: y`
  const header = /^([A-Za-z][\w-]*):\s*(.+)$/.exec(arg)
  if (header && isSecretName(header[1]!)) return `${header[1]}: ${REDACTED}`
  // name=value pairs (--set, --values, -v, query strings)
  if (/^[A-Za-z_][\w.-]*=/.test(arg)) {
    const at = arg.indexOf('=')
    if (isSecretName(arg.slice(0, at))) return `${arg.slice(0, at + 1)}${REDACTED}`
  }
  // filter criteria: `password = x`, `apiKey EQUALS y`
  return arg.replace(CRITERION, (all, name: string, op: string) => (isSecretName(name) ? `${name}${op}${REDACTED}` : all))
}

/**
 * The arguments with every secret replaced by `***`: the value of a secret flag (`--token x`,
 * `--password=y`, `--pin 1234`), secret `name=value` pairs, secret headers, bearer tokens, and
 * criteria on secret names in filter text.
 */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const flag = /^(--?[A-Za-z][\w-]*)(=(.*))?$/.exec(arg)
    if (flag && isSecretName(flag[1]!)) {
      if (flag[2] !== undefined) out.push(`${flag[1]}=${REDACTED}`)
      else {
        out.push(arg)
        if (i + 1 < argv.length && !/^--?[A-Za-z]/.test(argv[i + 1]!)) {
          out.push(REDACTED)
          i++
        }
      }
      continue
    }
    out.push(flag ? arg : redactArg(arg))
  }
  return out
}

/** Splits a command line as a shell would (quotes and backslashes; no expansion). */
export function splitCommandLine(line: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) current += line[++i]
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (ch === '\\' && i + 1 < line.length) {
      current += line[++i]
      has = true
    } else if (/\s/.test(ch)) {
      if (has || current) out.push(current)
      current = ''
      has = false
    } else current += ch
  }
  if (has || current) out.push(current)
  return out
}

/** Quotes one argument for a shell when it needs it. */
export function quoteArg(arg: string): string {
  return arg === REDACTED || /^[A-Za-z0-9_./:=,@+%-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, '\\$1')}"`
}

/** The arguments as one command line, redacted and quoted. */
export function joinCommandLine(argv: readonly string[]): string {
  return redactArgv(argv).map(quoteArg).join(' ')
}

/** A typed command line with its secrets redacted (the TUI's `:` line, a CLI equivalent). */
export function redactCommandLine(line: string): string {
  const argv = splitCommandLine(line)
  const redacted = redactArgv(argv)
  return redacted.every((a, i) => a === argv[i]) ? line : redacted.map(quoteArg).join(' ')
}

// ---- writing ----

/** Rotates the file to `.1` once it is over the limit (an older `.1` is replaced). */
function rotate(file: string, maxBytes: number): void {
  try {
    if (statSync(file).size >= maxBytes) renameSync(file, `${file}.1`)
  } catch {
    // no file yet
  }
}

/**
 * Appends one event to its profile's log (time added when missing); secrets in the summary and
 * the command are redacted again here. Never throws: a read-only home must not break a command.
 */
export function appendActivity(event: Omit<ActivityEvent, 'at'> & { at?: string }, options: { env?: NodeJS.ProcessEnv; maxBytes?: number } = {}): void {
  const env = options.env ?? process.env
  if (!activityEnabled(env)) return
  try {
    const dir = activityDir(env)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = activityFile(event.profile, env)
    rotate(file, options.maxBytes ?? ACTIVITY_MAX_BYTES)
    const line: ActivityEvent = {
      at: event.at ?? localIsoTime(),
      profile: event.profile || NO_PROFILE,
      ...(event.server ? { server: event.server } : {}),
      client: event.client,
      kind: event.kind,
      summary: redactCommandLine(event.summary.replace(/[\r\n]+/g, ' ')),
      ...(event.command ? { command: redactCommandLine(event.command.replace(/[\r\n]+/g, ' ')) } : {}),
      ...(event.exit !== undefined ? { exit: event.exit } : {}),
      ...(event.ms !== undefined ? { ms: event.ms } : {}),
      ...(event.target ? { target: event.target } : {}),
    }
    appendFileSync(file, JSON.stringify(line) + '\n', { mode: 0o600 })
  } catch {
    // not critical
  }
}

// ---- reading ----

function readFile(file: string): ActivityEvent[] {
  if (!existsSync(file)) return []
  const out: ActivityEvent[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line) as ActivityEvent
      if (e && typeof e.at === 'string' && typeof e.summary === 'string') out.push(e)
    } catch {
      // a torn line (two writers at once) is skipped
    }
  }
  return out
}

/** The profiles that have a log. */
export function activityProfiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const dir = activityDir(env)
  if (!existsSync(dir)) return []
  return [...new Set(readdirSync(dir).filter((f) => /\.jsonl(\.1)?$/.test(f)).map((f) => f.replace(/\.jsonl(\.1)?$/, '')))].sort()
}

/**
 * The events of one profile (the rotated file first), or of every profile merged by time, oldest
 * first and numbered from 1 like a shell history.
 */
export function readActivity(options: { profile?: string; allProfiles?: boolean; env?: NodeJS.ProcessEnv } = {}): ActivityEntry[] {
  const env = options.env ?? process.env
  const profiles = options.allProfiles ? activityProfiles(env) : [options.profile ?? NO_PROFILE]
  let events: ActivityEvent[] = []
  for (const p of profiles) {
    const file = activityFile(p, env)
    events.push(...readFile(`${file}.1`), ...readFile(file))
  }
  if (options.allProfiles) events = events.map((e, i) => ({ e, i, t: Date.parse(e.at) })).sort((a, b) => (a.t - b.t) || (a.i - b.i)).map((x) => x.e)
  return events.map((e, i) => ({ ...e, n: i + 1 }))
}

/** Removes a profile's log (and its rotated file), or every profile's; returns how many events went. */
export function clearActivity(options: { profile?: string; allProfiles?: boolean; env?: NodeJS.ProcessEnv } = {}): number {
  const env = options.env ?? process.env
  const count = readActivity(options).length
  const profiles = options.allProfiles ? activityProfiles(env) : [options.profile ?? NO_PROFILE]
  for (const p of profiles) {
    const file = activityFile(p, env)
    rmSync(file, { force: true })
    rmSync(`${file}.1`, { force: true })
  }
  return count
}

// ---- listing ----

const UNITS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }

/** `--since`: a duration back from now (`30m`, `2h`, `3d`, `1w`) or a date/time (`2026-11-01`, `2026-11-01T09:00`). */
export function parseSince(text: string, now = new Date()): Date {
  const rel = /^(\d+)\s*([smhdw])$/i.exec(text.trim())
  if (rel) return new Date(now.getTime() - Number(rel[1]) * UNITS[rel[2]!.toLowerCase()]!)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(text.trim()) ? new Date(`${text.trim()}T00:00:00`) : new Date(text.trim())
  if (Number.isNaN(date.getTime())) throw new Error(`--since takes a duration (30m, 2h, 3d, 1w) or a date (2026-11-01): ${text}`)
  return date
}

/** Whether an event matches a `--kind`: its kind, or its client (cli, ui). */
export function matchesKind(entry: ActivityEvent, kind: string): boolean {
  const k = kind.toLowerCase()
  return entry.kind === k || entry.client === k
}

export interface ActivityFilter {
  since?: Date
  grep?: string
  kind?: string[]
  limit?: number
}

/** The entries that match, newest last, the last `limit` of them; numbers stay as they were. */
export function filterActivity(entries: readonly ActivityEntry[], filter: ActivityFilter): ActivityEntry[] {
  const needle = filter.grep?.toLowerCase()
  const kinds = filter.kind?.flatMap((k) => k.split(',')).map((k) => k.trim()).filter(Boolean)
  const out = entries.filter((e) => (!filter.since || Date.parse(e.at) >= filter.since.getTime())
    && (!needle || `${e.summary}\n${e.command ?? ''}\n${e.kind}\n${e.client}`.toLowerCase().includes(needle))
    && (!kinds?.length || kinds.some((k) => matchesKind(e, k))))
  return filter.limit !== undefined && filter.limit > 0 ? out.slice(-filter.limit) : out
}

/** How long ago, short: `now`, `45s`, `12m`, `3h`, `2d`, else the date. */
export function relativeTime(at: string, now = new Date()): string {
  const t = Date.parse(at)
  if (Number.isNaN(t)) return at
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000))
  if (s < 5) return 'now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`
  return at.slice(0, 10)
}

/** The local time of an event as `2026-11-01 14:03:22` (the stored offset is the writer's zone). */
export function absoluteTime(at: string): string {
  return at.length >= 19 ? `${at.slice(0, 10)} ${at.slice(11, 19)}` : at
}

/** `1.2s`, `340ms`, `2m 5s`. */
export function durationText(ms: number | undefined): string {
  if (ms === undefined) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`
}

// ---- CLI invocations ----

/** The CLI's global options that take a value (skipped when finding the command words). */
const VALUE_OPTIONS = new Set(['--server', '-p', '--profile', '-O', '--output', '-Q', '--query', '--fields'])

/** The command words of an argv (`table query person -w …` gives table, query, person). */
export function commandWords(argv: readonly string[]): string[] {
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (VALUE_OPTIONS.has(a)) {
      i++
      continue
    }
    if (a.startsWith('-')) continue
    words.push(a)
  }
  return words
}

/** The kind of a CLI invocation, from its command words. */
export function cliKind(argv: readonly string[]): ActivityKind {
  const [noun, verb] = commandWords(argv)
  if (noun === 'login' || noun === 'logout') return 'auth'
  if (noun === 'print') return 'print'
  if (noun === 'run' || (noun === 'process' && verb === 'run')) return 'process'
  if (noun === 'query' || (noun === 'table' && (verb === 'query' || verb === 'count'))) return 'query'
  if (noun === 'table' && (verb === 'create' || verb === 'update' || verb === 'delete')) return 'record'
  if (noun === 'bulk') return 'record'
  if ((noun === 'table' && verb === 'export') || noun === 'export') return 'export'
  return 'cli'
}

/** Whether a CLI command changes data on the server (re-running it asks first). */
export function isMutatingCommand(argv: readonly string[]): boolean {
  const [noun, verb] = commandWords(argv)
  if (!noun) return false
  if (noun === 'run' || noun === 'bulk' || noun === 'print') return true
  if (noun === 'api') return argv.some((a, i) => /^(-X|--method)$/.test(argv[i - 1] ?? '') && !/^(GET|HEAD|OPTIONS)$/i.test(a)) || argv.some((a) => /^--method=(?!get|head|options)/i.test(a))
  if (noun === 'history') return verb === 'clear'
  return /^(create|update|delete|run|set|cancel|retry|action|save|remove|clear|edit|add|use|share|import|upload|lock|unlock|send|post|start|stop|apply)$/.test(verb ?? '')
}
