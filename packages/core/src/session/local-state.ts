/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Local client state that is not configuration: command histories (~/.local/state/qqq/history-*),
 * recently viewed records, and the screen-lock PIN (a salted scrypt hash in the config file, never
 * the PIN). QQQ_STATE_DIR overrides the state directory; XDG_STATE_HOME is honoured.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readConfig, writeConfig } from './profiles.js'

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.QQQ_STATE_DIR ?? join(env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'qqq')
}

/** Commands that carried a secret are never written to a history. */
export function isSecretCommand(line: string): boolean {
  return /\b(pass(word)?|pin|secret|token|api[-_]?key)\b/i.test(line)
}

/** A persistent, capped command history (newest last on disk, newest first from `entries`). */
export class History {
  private lines: string[]
  private readonly file: string
  constructor(readonly name: string, private readonly cap = 3000, env: NodeJS.ProcessEnv = process.env) {
    this.file = join(stateDir(env), `history-${name.replace(/[^A-Za-z0-9_-]+/g, '_')}`)
    this.lines = existsSync(this.file) ? readFileSync(this.file, 'utf8').split('\n').filter(Boolean) : []
  }

  /** Newest first. */
  entries(): string[] {
    return [...this.lines].reverse()
  }

  /** Adds a line (not blank, not a repeat of the newest, not a secret) and saves. */
  add(line: string): void {
    const text = line.trim()
    if (!text || isSecretCommand(text) || this.lines[this.lines.length - 1] === text) return
    this.lines.push(text)
    if (this.lines.length > this.cap) this.lines = this.lines.slice(-this.cap)
    try {
      mkdirSync(stateDir(), { recursive: true, mode: 0o700 })
      writeFileSync(this.file, this.lines.join('\n') + '\n', { mode: 0o600 })
    } catch {
      // a read-only home must not break the client
    }
  }

  /** Newest-first entries containing the text (Ctrl+R). */
  search(text: string): string[] {
    const needle = text.toLowerCase()
    return this.entries().filter((l) => l.toLowerCase().includes(needle))
  }
}

export interface RecentItem {
  kind: 'record' | 'table' | 'process'
  table?: string
  key?: string
  name?: string
  label: string
  at: string
}

/** Recently viewed records and screens of a server, newest first (kept in the config file's ui section). */
export function readRecents(server: string, env: NodeJS.ProcessEnv = process.env): RecentItem[] {
  const ui = readConfig(env).ui as { recents?: Record<string, RecentItem[]> } | undefined
  return ui?.recents?.[server] ?? []
}

export function addRecent(server: string, item: Omit<RecentItem, 'at'>, cap = 30, env: NodeJS.ProcessEnv = process.env): void {
  const config = readConfig(env)
  const ui = (config.ui ?? {}) as { recents?: Record<string, RecentItem[]> }
  const list = (ui.recents?.[server] ?? []).filter((r) => !(r.kind === item.kind && r.table === item.table && r.key === item.key && r.name === item.name))
  list.unshift({ ...item, at: new Date().toISOString() })
  config.ui = { ...config.ui, recents: { ...(ui.recents ?? {}), [server]: list.slice(0, cap) } } as never
  writeConfig(config, env)
}

interface LockSettings { pinHash?: string; pinSalt?: string; idleMinutes?: number }

function lockSettings(env: NodeJS.ProcessEnv): LockSettings {
  return ((readConfig(env).ui as { lock?: LockSettings } | undefined)?.lock) ?? {}
}

function writeLock(lock: LockSettings, env: NodeJS.ProcessEnv): void {
  const config = readConfig(env)
  config.ui = { ...config.ui, lock } as never
  writeConfig(config, env)
}

/** Hashes a PIN with a salt (scrypt); the same PIN and salt give the same hash. */
export function hashPin(pin: string, salt: string): string {
  return scryptSync(pin, salt, 32).toString('hex')
}

export function hasPin(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(lockSettings(env).pinHash)
}

/** Sets the screen-lock PIN (4 or more characters); only a salted hash is stored. */
export function setPin(pin: string, env: NodeJS.ProcessEnv = process.env): void {
  if (pin.length < 4) throw new Error('A PIN needs at least 4 characters')
  const salt = randomBytes(16).toString('hex')
  writeLock({ ...lockSettings(env), pinSalt: salt, pinHash: hashPin(pin, salt) }, env)
}

export function verifyPin(pin: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const lock = lockSettings(env)
  if (!lock.pinHash || !lock.pinSalt) return true
  const a = Buffer.from(hashPin(pin, lock.pinSalt), 'hex')
  const b = Buffer.from(lock.pinHash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Removes the PIN after checking the current one; false when it did not match. */
export function removePin(current: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!verifyPin(current, env)) return false
  const { pinHash: _h, pinSalt: _s, ...rest } = lockSettings(env)
  writeLock(rest, env)
  return true
}

/** Minutes of no input before the screen saver starts (0 or undefined: never). */
export function readIdleMinutes(env: NodeJS.ProcessEnv = process.env): number {
  return Number(lockSettings(env).idleMinutes ?? 0)
}

export function writeIdleMinutes(minutes: number, env: NodeJS.ProcessEnv = process.env): void {
  writeLock({ ...lockSettings(env), idleMinutes: Math.max(0, Math.floor(minutes)) }, env)
}

/** How long to wait after the n-th wrong PIN (grows: 0.5 s, 1 s, 2 s … capped at 30 s). */
export function pinDelayMillis(failures: number): number {
  return failures <= 0 ? 0 : Math.min(30_000, 500 * 2 ** (failures - 1))
}

/** A table variant chosen earlier, remembered per server and table (as the web keeps it for the session). */
export interface RememberedVariant { id: string; type: string; name?: string }

/** The variant last chosen for a table on a server, if any (kept in the config file's ui section). */
export function readRememberedVariant(server: string, table: string, env: NodeJS.ProcessEnv = process.env): RememberedVariant | undefined {
  const ui = readConfig(env).ui as { variants?: Record<string, Record<string, RememberedVariant>> } | undefined
  return ui?.variants?.[server]?.[table]
}

/** Remembers (or with undefined, forgets) the variant chosen for a table on a server. */
export function rememberVariant(server: string, table: string, variant: RememberedVariant | undefined, env: NodeJS.ProcessEnv = process.env): void {
  const config = readConfig(env)
  const ui = (config.ui ?? {}) as { variants?: Record<string, Record<string, RememberedVariant>> }
  const forServer = { ...(ui.variants?.[server] ?? {}) }
  if (variant) forServer[table] = { id: variant.id, type: variant.type, ...(variant.name ? { name: variant.name } : {}) }
  else delete forServer[table]
  config.ui = { ...config.ui, variants: { ...(ui.variants ?? {}), [server]: forServer } } as never
  writeConfig(config, env)
}
