/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The terminal check behind `qqq ui` (at startup, `--check`) and `qqq doctor`: tmux root-table
 * bindings that take keys the TUI needs (PgUp/PgDn, F1 to F10, Home/End, Esc, `/`, `?`, `:`),
 * tmux options (alternate screen, TERM, truecolor), the terminal program, colors, size. Each
 * finding can carry a live fix (tmux commands for the running server, never a file edit) and the
 * lines for a permanent fix (appended to ~/.tmux.conf only when the person says yes). No terminal
 * UI code here; tmux is run through an injectable function so tests use fake output.
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readConfig, writeConfig } from '../session/profiles.js'

export type Level = 'ok' | 'info' | 'warn'

export interface Finding {
  id: string
  level: Level
  message: string
  /** tmux commands (argv) that fix it for the running server. */
  live?: string[][]
  /** Lines to add to ~/.tmux.conf (or another file) for good. */
  permanent?: string
  /** A note when the fix is in the terminal's own settings. */
  advice?: string
}

export interface Report {
  terminal: string
  inTmux: boolean
  findings: Finding[]
}

/** Runs tmux and returns stdout ('' on failure); quick, never more than a second. */
export type TmuxRunner = (args: string[]) => string

export const defaultTmux: TmuxRunner = (args) => {
  const r = spawnSync('tmux', args, { encoding: 'utf8', timeout: 1000 })
  return r.status === 0 ? String(r.stdout ?? '') : ''
}

/** Keys the TUI needs, as tmux names them, with the key tmux should pass on. */
const NEEDED: Record<string, string> = {
  PPage: 'PPage', NPage: 'NPage', PageUp: 'PPage', PageDown: 'NPage', Home: 'Home', End: 'End', Escape: 'Escape',
  F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10',
  '/': '/', '?': '?', ':': ':',
}

export interface Binding {
  key: string
  command: string
}

/** Parses `tmux list-keys -T root` lines into key and command. */
export function parseRootBindings(output: string): Binding[] {
  const out: Binding[] = []
  for (const line of output.split('\n')) {
    const m = /^bind-key\s+(?:-r\s+)?-T\s+root\s+(\S+)\s+(.*)$/.exec(line.trim())
    if (m) out.push({ key: m[1]!.replace(/^\\/, ''), command: m[2]!.trim() })
  }
  return out
}

/** Whether a binding already hands the key to full-screen programs (`#{alternate_on}` then `send-keys` of the key). */
export function passesToFullScreen(binding: Binding): boolean {
  return /#\{alternate_on\}/.test(binding.command) && /send-keys\s+(\S+)/.test(binding.command)
}

/** The live fix: rebind so full-screen programs get the key and the shell keeps the old behaviour. */
export function tmuxFixCommand(binding: Binding): string[] {
  const pass = NEEDED[binding.key] ?? binding.key
  return ['bind-key', '-n', binding.key, 'if-shell', '-F', '#{alternate_on}', `send-keys ${pass}`, binding.command || '']
}

/** The same fix as a ~/.tmux.conf line. */
export function tmuxConfLine(binding: Binding): string {
  const pass = NEEDED[binding.key] ?? binding.key
  const original = binding.command ? `{ ${binding.command} }` : "''"
  return `bind-key -n ${binding.key} if-shell -F "#{alternate_on}" "send-keys ${pass}" ${original}`
}

export const CONF_MARK_BEGIN = '# >>> qqq ui: let full-screen programs have their keys >>>'
export const CONF_MARK_END = '# <<< qqq ui <<<'

/** Detects the terminal program from the environment. */
export function detectTerminal(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WT_SESSION) return 'Windows Terminal'
  if (env.KITTY_WINDOW_ID || /kitty/.test(env.TERM ?? '')) return 'kitty'
  if (env.WEZTERM_PANE || env.TERM_PROGRAM === 'WezTerm') return 'WezTerm'
  if (env.TERM_PROGRAM === 'iTerm.app' || env.LC_TERMINAL === 'iTerm2') return 'iTerm2'
  if (env.TERM_PROGRAM === 'Apple_Terminal') return 'Terminal.app'
  if (env.TERM_PROGRAM === 'vscode') return 'VS Code'
  return env.TERM_PROGRAM || env.TERM || 'unknown'
}

export interface CheckOptions {
  env?: NodeJS.ProcessEnv
  /** process.platform (tests pass one). */
  platform?: string
  columns?: number
  rows?: number
  tmux?: TmuxRunner
}

/** Runs every check. */
export function checkEnvironment(options: CheckOptions = {}): Report {
  const env = options.env ?? process.env
  const tmux = options.tmux ?? defaultTmux
  const findings: Finding[] = []
  const inTmux = Boolean(env.TMUX)
  const terminal = detectTerminal(env)
  if (inTmux) {
    const outer = tmux(['show-environment', '-g', 'TERM_PROGRAM']).replace(/^TERM_PROGRAM=/, '').trim()
    const bindings = parseRootBindings(tmux(['list-keys', '-T', 'root']))
    for (const b of bindings) {
      if (!(b.key in NEEDED) || passesToFullScreen(b)) continue
      findings.push({
        id: `tmux-key-${b.key}`,
        level: 'warn',
        message: `tmux takes ${b.key} before any program sees it (root binding: ${b.command.slice(0, 80)}${b.command.length > 80 ? '…' : ''}).`,
        live: [tmuxFixCommand(b)],
        permanent: tmuxConfLine(b),
      })
    }
    const alt = tmux(['show', '-gv', 'alternate-screen']).trim()
    if (alt === 'off') findings.push({ id: 'tmux-alternate-screen', level: 'warn', message: 'tmux alternate-screen is off: full-screen programs draw into the scrollback.', live: [['set', '-g', 'alternate-screen', 'on']], permanent: 'set -g alternate-screen on' })
    const term = env.TERM ?? ''
    if (!/^(tmux|screen)-256color$/.test(term)) findings.push({ id: 'tmux-term', level: 'info', message: `TERM is ${term || 'unset'} inside tmux; tmux-256color (or screen-256color) gives the right keys and colors.`, permanent: 'set -g default-terminal "tmux-256color"' })
    const overrides = tmux(['show', '-gv', 'terminal-overrides']) + tmux(['show', '-gv', 'terminal-features'])
    if (!/Tc|RGB/.test(overrides)) findings.push({ id: 'tmux-truecolor', level: 'info', message: 'tmux does not pass true color (no Tc or RGB in terminal-overrides/terminal-features); themes fall back to 256 colors.', live: [['set', '-as', 'terminal-overrides', ',*:Tc']], permanent: "set -as terminal-overrides ',*:Tc'" })
    if (outer) findings.push({ id: 'outer-terminal', level: 'ok', message: `tmux runs in ${outer}.` })
  }
  if (!/truecolor|24bit/i.test(env.COLORTERM ?? '')) findings.push({ id: 'truecolor', level: 'info', message: 'COLORTERM does not announce true color; colors are approximated.' })
  if (!/UTF-?8/i.test(`${env.LC_ALL ?? ''}${env.LC_CTYPE ?? ''}${env.LANG ?? ''}`)) findings.push({ id: 'unicode', level: 'warn', message: 'The locale is not UTF-8; box drawing and block characters may not show. qqq ui --ascii uses plain characters.', advice: 'export LANG=en_US.UTF-8 (or your locale with .UTF-8), or run qqq ui --ascii' })
  if (options.columns !== undefined && options.rows !== undefined && (options.columns < 80 || options.rows < 24)) findings.push({ id: 'size', level: 'warn', message: `The terminal is ${options.columns}x${options.rows}; qqq ui needs at least 80x24.` })
  if (env.TERM === 'dumb') findings.push({ id: 'dumb', level: 'warn', message: 'TERM is dumb: no alternate screen or cursor control. Use the qqq CLI.' })
  if (terminal === 'Terminal.app') findings.push({ id: 'terminal-app-fkeys', level: 'info', message: 'Terminal.app: F1 to F10 go to macOS unless "Use F1, F2, etc. keys as standard function keys" is on (System Settings › Keyboard), or hold fn.', advice: 'Fallbacks: Esc then 1..0 for F1..F10; every F-key action is also in the F9 menu and on the : command line.' })
  if ((options.platform ?? process.platform) === 'darwin' && terminal !== 'Terminal.app') findings.push({ id: 'macos-fkeys', level: 'info', message: `macOS: F1 to F12 send media and system keys unless "Use F1, F2, etc. keys as standard function keys" is on (System Settings › Keyboard › Keyboard Shortcuts › Function Keys), or hold fn.${terminal === 'iTerm2' ? ' iTerm2 also binds some F-keys in Profiles › Keys.' : ''}`, advice: 'Fallbacks that always work: Esc then 1..0 (F1..F10), the F9 menu entries and the : command line.' })
  if (terminal === 'iTerm2') findings.push({ id: 'iterm-page-keys', level: 'info', message: 'iTerm2: if PgUp/PgDn scroll the window instead of reaching qqq ui, set Profiles › Keys › Key Mappings for Page Up/Down to "Send Escape Sequence" ([5~ and [6~), and turn off "Scroll wheel sends arrow keys in alternate screen mode" only if you prefer wheel scrolling.' })
  return { terminal, inTmux, findings }
}

/** Runs the live fix of a finding against the running tmux server. */
export function applyLiveFix(finding: Finding, tmux: TmuxRunner = defaultTmux): void {
  for (const args of finding.live ?? []) tmux(args)
}

/** Appends the permanent fixes in one marked block to a tmux config file (default ~/.tmux.conf); returns the file. */
export function appendTmuxConf(findings: Finding[], file = join(homedir(), '.tmux.conf')): string {
  const lines = findings.map((f) => f.permanent).filter((l): l is string => Boolean(l))
  if (!lines.length) return file
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const fresh = lines.filter((l) => !existing.includes(l))
  if (!fresh.length) return file
  appendFileSync(file, `${existing && !existing.endsWith('\n') ? '\n' : ''}\n${CONF_MARK_BEGIN}\n${fresh.join('\n')}\n${CONF_MARK_END}\n`)
  return file
}

/** The report as text lines. */
export function formatReport(report: Report): string {
  const out = [`terminal: ${report.terminal}${report.inTmux ? ' (inside tmux)' : ''}`]
  if (!report.findings.filter((f) => f.level !== 'ok').length) out.push('everything qqq ui needs is in place')
  for (const f of report.findings) {
    out.push(`${f.level === 'warn' ? '!' : f.level === 'info' ? '-' : '✓'} ${f.message}`)
    if (f.permanent) out.push(`    fix: ${f.permanent}`)
    if (f.advice) out.push(`    ${f.advice}`)
  }
  return out.join('\n')
}

export interface DoctorState {
  lastCheck?: string
  applied?: string[]
  /** Findings the person asked not to be asked about again. */
  dontAsk?: string[]
}

export function readDoctorState(env: NodeJS.ProcessEnv = process.env): DoctorState {
  return { ...(((readConfig(env).ui as { doctor?: DoctorState } | undefined)?.doctor) ?? {}) }
}

export function writeDoctorState(patch: Partial<DoctorState>, env: NodeJS.ProcessEnv = process.env): DoctorState {
  const config = readConfig(env)
  const doctor = { ...readDoctorState(env), ...patch }
  config.ui = { ...config.ui, doctor } as never
  writeConfig(config, env)
  return doctor
}

/** The findings worth asking about at startup: warnings with a fix that were not dismissed. */
export function startupFindings(report: Report, state: DoctorState = readDoctorState()): Finding[] {
  return report.findings.filter((f) => f.level === 'warn' && (f.live || f.permanent) && !(state.dontAsk ?? []).includes(f.id))
}
