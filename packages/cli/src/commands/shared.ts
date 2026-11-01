/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { spawnSync } from 'node:child_process'
import { Option } from 'commander'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chipAnsi, deniedTableReason, displayDateTime, type TableAction, readFilePreferences, safeFileName, saveDownload, valueText as recordValueText, type DisplayOptions, type FieldMeta, type RecordLike } from '@qrun-io/qqq-core'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { UsageError } from '../context.js'

export type Json = Record<string, unknown>

/** Parses `name=value` pairs (`--set`, `--values`). */
export function parsePairs(pairs: string[] | undefined, flag: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const pair of pairs ?? []) {
    const at = pair.indexOf('=')
    if (at < 1) throw new UsageError(`${flag} takes name=value: ${pair}`)
    values[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return values
}

/** Reads a JSON argument: inline text, a file path, or `-` for stdin. */
export function readJson(source: string, flag: string): unknown {
  const inline = source.trim().startsWith('{') || source.trim().startsWith('[')
  const text = inline ? source : new TextDecoder().decode(readFileArg(source === '-' ? 0 : source, flag))
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new UsageError(`${flag}: not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * A record's value as text in a list cell (query rows, child lists, joined fields): the same
 * adornment rules as the record view (REVEAL masked unless `reveal`, CHIP, ERROR, DATE_TIME in the
 * local zone or raw with `display.utc`), without link targets or hints. Without field metadata,
 * the display value when the server sent one, else the raw value.
 */
export function valueText(record: Json, field: string, meta?: Json, display?: DisplayOptions, reveal?: boolean, color?: boolean): string {
  const fieldMeta = (((meta?.fields ?? {}) as Record<string, Json>)[field]) as FieldMeta | undefined
  const values = (record.values ?? {}) as Record<string, unknown>
  const displayValues = record.displayValues as Record<string, unknown> | undefined
  if (fieldMeta) {
    const shown = recordValueText({ ...fieldMeta, name: field }, { values, displayValues } as RecordLike, { cell: true, dateTime: display, reveal })
    return color && shown.chip ? chipAnsi(shown.text, shown.chip.color) : shown.text
  }
  const value = displayValues?.[field] ?? values[field]
  if (value === null || value === undefined) return ''
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/** A DATE_TIME instant outside a record (audits, comments, extension payloads) as the record view shows one. */
export function instantText(value: unknown, display?: DisplayOptions): string {
  return displayDateTime(value, undefined, display)
}

/** Reads a file a flag names (`--upload`, `--file`, `--form @file`, `--bytes`); a missing file is a usage error. */
export function readFileArg(path: string | number, flag: string): Uint8Array {
  try {
    return new Uint8Array(readFileSync(path))
  } catch (error) {
    throw new UsageError(`${flag}: cannot read ${path === 0 ? 'stdin' : path} (${error instanceof Error ? error.message : String(error)})`)
  }
}

/**
 * Where a download goes when no --out / --out-dir names a place: the download directory of the
 * file preferences the TUI shares (`qqq config set download-dir`), created when missing, else the
 * current directory.
 */
export function downloadDir(): string {
  const dir = readFilePreferences().downloadDir
  if (!dir) return '.'
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * The one way a command writes a downloaded file: `-` writes to stdout; a path the user named is
 * written as given (replacing a file); otherwise `defaultName` (already a safe file name) goes
 * into the download directory without replacing anything (name-1.ext, …). Returns the path
 * written, or undefined for stdout.
 */
export function writeDownload(out: string | undefined, defaultName: string, bytes: Uint8Array): string | undefined {
  if (out === '-') {
    process.stdout.write(bytes)
    return undefined
  }
  if (out !== undefined) return saveDownload(out, bytes, { explicit: true })
  const dir = downloadDir()
  return saveDownload(dir === '.' ? defaultName : join(dir, defaultName), bytes, { explicit: false })
}

/** `n record`/`n records`. */
export function plural(n: number, singular: string, pluralForm = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : pluralForm}`
}

/**
 * The flag convention, the same on every command: `-o` / `--out` is the output file; the sort is
 * `--order` (no short form). Until 1.1, `-o` still means the sort on commands that write no file
 * (table query, saved-view save, saved-report preview and set), with a deprecation note.
 */
export const ORDER_OPTION = ['--order <field...>', 'order by fields; prefix - for descending'] as const

/** The hidden `-o <field...>` that still sorts on commands without an output file (deprecated in 1.0). */
export function deprecatedOrderOption(): Option {
  return new Option('-o <field...>', 'deprecated: use --order (-o is the output file on every command from 1.1)').hideHelp()
}

const FILE_EXTENSION = /\.(csv|tsv|txt|xlsx|xls|json|ya?ml|xml|pdf|html?|zip|gz)$/i

/** Whether a value given as a sort field looks like a file path (`out.csv`, `./x`, `/tmp/y`). */
export function looksLikePath(value: string): boolean {
  return value.includes('/') || value.includes('\\') || value.startsWith('~') || value.startsWith('.') || FILE_EXTENSION.test(value)
}

/**
 * The sort fields of a command: --order plus the deprecated `-o` (noted), with a warning for a
 * value that looks like a file path (the old `-o` ambiguity: `export -o out.csv` used to sort).
 */
export function orderFrom(note: (text: string) => void, options: { order?: string[]; o?: string[] }): string[] | undefined {
  if (options.o?.length) note('warning: -o for the sort order is deprecated; use --order (from 1.1, -o means --out, the output file, on every command).')
  const order = [...(options.order ?? []), ...(options.o ?? [])]
  for (const value of order) {
    if (looksLikePath(value.replace(/^-/, ''))) note(`warning: the sort field "${value}" looks like a file path; --order takes field names (prefix - for descending). To write a file use -o/--out (table export), or redirect the output.`)
  }
  return order.length ? order : undefined
}

/** The footer every list ends with: `(3 records; joined: pet; more may exist: …)`. */
export function countFooter(n: number, singular: string, parts: Array<string | number | false | undefined | null> = [], pluralForm?: string): string {
  return `(${[plural(n, singular, pluralForm), ...parts.filter(Boolean)].join('; ')})`
}

/** A whole number option (`--limit`, `--skip`, …), checked: a usage error otherwise. */
export function intOption(text: string | undefined, flag: string, min = 0): number | undefined {
  if (text === undefined) return undefined
  const n = Number(text)
  if (!Number.isInteger(n) || n < min) throw new UsageError(`${flag} must be a whole number${min > 0 ? ` of at least ${min}` : ' (0 or more)'}: ${text}`)
  return n
}

/** A positive whole number option. */
export function positiveInt(text: string, flag: string): number {
  return intOption(text, flag, 1)!
}

/** The fields a query shows by default: the primary key, then the sections' fields by tier, then the rest; capped. */
export function defaultFields(meta: Json, cap = 8): string[] {
  const fields = (meta.fields ?? {}) as Record<string, Json>
  const pk = String(meta.primaryKeyField ?? 'id')
  const order: string[] = [pk]
  const sections = (meta.sections ?? []) as Json[]
  for (const tier of ['T1', 'T2', 'T3']) {
    for (const section of sections.filter((s) => s.tier === tier)) {
      for (const name of (section.fieldNames ?? []) as string[]) if (!order.includes(name) && fields[name] && !fields[name].isHidden) order.push(name)
    }
  }
  for (const name of Object.keys(fields)) if (!order.includes(name) && !fields[name]!.isHidden && !fields[name]!.isHeavy) order.push(name)
  return order.slice(0, cap)
}

/** Field labels for column headers. */
export function labelsFor(meta: Json, names: string[]): string[] {
  const fields = (meta.fields ?? {}) as Record<string, Json>
  return names.map((n) => String(fields[n]?.label ?? n))
}

/**
 * The temporary file name for editing: the name's characters other than letters, digits, `.`, `_`
 * and `-` become `_`. The name carries a table, primary key and field, which can hold anything.
 */
export function editFileName(name: string): string {
  return safeFileName(name).replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Runs the editor command on a file. $VISUAL / $EDITOR is a command line (`code --wait`), so it
 * goes through a shell; the path never becomes part of that command text: on POSIX it is the
 * shell's `$1` (as git runs its editor), on Windows the quoted `%QQQ_EDIT_FILE%` variable (a
 * Windows path cannot hold the `"` that would end the quotes).
 */
export function runEditor(editor: string, path: string): ReturnType<typeof spawnSync> {
  if (process.platform === 'win32') return spawnSync(`${editor} "%QQQ_EDIT_FILE%"`, { stdio: 'inherit', shell: true, env: { ...process.env, QQQ_EDIT_FILE: path } })
  return spawnSync('/bin/sh', ['-c', `${editor} "$1"`, 'qqq-editor', path], { stdio: 'inherit' })
}

/** Opens $VISUAL / $EDITOR (else vi) on a text and returns what was saved. */
export function editText(text: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-edit-'))
  const path = join(dir, editFileName(name))
  try {
    writeFileSync(path, text, { mode: 0o600 })
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
    const result = runEditor(editor, path)
    if (result.status !== 0) throw new UsageError(`${editor} exited with ${result.status ?? result.signal}; nothing was stored.`)
    return readFileSync(path, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Whether CHIP values are colored: table output on a terminal, unless NO_COLOR is set. */
export function useColor(format: string): boolean {
  return format === 'table' && Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
}

/**
 * Puts text on the clipboard: pbcopy (macOS), clip (Windows), wl-copy or xclip/xsel (Linux), else
 * the OSC 52 escape to the terminal (most terminals and tmux accept it). Returns how.
 */
export function copyToClipboard(text: string): string {
  const tries: Array<[string, string[]]> = process.platform === 'darwin' ? [['pbcopy', []]]
    : process.platform === 'win32' ? [['clip', []]]
      : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]
  for (const [cmd, args] of tries) {
    const result = spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
    if (result.status === 0) return `with ${cmd}`
  }
  if (!process.stderr.isTTY) throw new UsageError('No clipboard tool (pbcopy, clip, wl-copy, xclip, xsel) and no terminal for OSC 52.')
  process.stderr.write(`\x1b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\x07`)
  return 'through the terminal (OSC 52)'
}

/**
 * Refuses an action the table's metadata denies (a DISABLED table is listed with its permissions
 * false), exit 3 with the reason, before any request; the server would refuse it too.
 */
export function requireTable(meta: Json, action: TableAction): void {
  const reason = deniedTableReason(meta, action)
  if (reason) throw new UiApiError(403, { code: 'PERMISSION_DENIED', message: reason })
}
