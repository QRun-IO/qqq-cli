/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Named profiles: a server plus a stored identity, as `aws --profile`. The config file holds the
 * profiles and the default; secrets live in the keyring (see keyring.ts), keyed by profile.
 *
 *   ~/.config/qqq/config.json   (QQQ_CONFIG_DIR overrides; XDG_CONFIG_HOME honoured)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Profile {
  server: string
  note?: string
  createdAt?: string
  /** Display settings of the terminal UI for this profile only (override the global `ui`). */
  ui?: Pick<UiSettings, 'theme'>
}

/** Local display settings of the terminal UI (not server preferences): theme and per-screen view settings. */
export interface UiSettings {
  theme?: string
  /** Keyed by screen, e.g. `table:person`, `record:person`, `app:peopleApp`. */
  views?: Record<string, ViewSettings>
}

/** How one screen is shown: grid columns and widths, stripes, density; record columns; widget order. */
export interface ViewSettings {
  /** Visible grid columns, in order. */
  columns?: string[]
  /** Column widths in cells, by field name. */
  widths?: Record<string, number>
  /** How free width is used: fit columns to content, or fill the terminal width. */
  fit?: 'content' | 'fill'
  zebra?: boolean
  headerRule?: boolean
  density?: 'compact' | 'comfortable'
  /** Record view: one or two columns of fields, and the label width. */
  recordColumns?: 1 | 2
  labelWidth?: number
  /** App home: widget names in display order. */
  widgetOrder?: string[]
  [key: string]: unknown
}

export interface Config {
  defaultProfile?: string
  profiles: Record<string, Profile>
  ui?: UiSettings
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.QQQ_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'qqq')
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = join(configDir(env), 'config.json')
  if (!existsSync(file)) return { profiles: {} }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Config
    return { defaultProfile: parsed.defaultProfile, profiles: parsed.profiles ?? {}, ...(parsed.ui ? { ui: parsed.ui } : {}) }
  } catch {
    return { profiles: {} }
  }
}

export function writeConfig(config: Config, env: NodeJS.ProcessEnv = process.env): void {
  const dir = configDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
}

/** A profile name derived from a server origin, for sign-ins made with --server alone. */
export function profileNameForServer(server: string): string {
  const url = new URL(server)
  return url.host.replace(/[^A-Za-z0-9.-]+/g, '-')
}

export interface ResolvedProfile {
  name: string
  server: string
  /** How the profile was chosen, for messages. */
  source: 'option' | 'env' | 'server' | 'default'
}

/**
 * Which profile a command uses: --profile, else QQQ_PROFILE, else the profile of --server or
 * QQQ_SERVER (created on the fly, unnamed until `qqq config profile add` names it), else the
 * default profile.
 */
export function resolveProfile(options: { profile?: string; server?: string }, env: NodeJS.ProcessEnv = process.env, config: Config = readConfig(env)): ResolvedProfile {
  const named = options.profile ?? env.QQQ_PROFILE
  if (named) {
    const p = config.profiles[named]
    if (p) return { name: named, server: options.server ? new URL(options.server).origin : p.server, source: options.profile ? 'option' : 'env' }
    // a new name with a server: the profile is created when the sign-in is saved
    if (options.server) return { name: named, server: new URL(options.server).origin, source: 'option' }
    throw new Error(`No profile "${named}"; \`qqq config profile list\` shows them, \`qqq login --server URL --profile ${named}\` creates it.`)
  }
  const server = options.server ?? env.QQQ_SERVER
  if (server) {
    const origin = new URL(server).origin
    const existing = Object.entries(config.profiles).find(([, p]) => p.server === origin)
    return { name: existing ? existing[0] : profileNameForServer(origin), server: origin, source: 'server' }
  }
  if (config.defaultProfile && config.profiles[config.defaultProfile]) {
    return { name: config.defaultProfile, server: config.profiles[config.defaultProfile]!.server, source: 'default' }
  }
  throw new Error('No server: pass --server https://..., set QQQ_SERVER, or sign in with `qqq login --server URL` (which makes that the default profile).')
}

/** Adds or updates a profile; the first profile becomes the default. */
export function upsertProfile(name: string, profile: Profile, options: { makeDefault?: boolean } = {}, env: NodeJS.ProcessEnv = process.env): Config {
  const config = readConfig(env)
  config.profiles[name] = { ...config.profiles[name], ...profile, createdAt: config.profiles[name]?.createdAt ?? new Date().toISOString() }
  if (options.makeDefault || !config.defaultProfile) config.defaultProfile = name
  writeConfig(config, env)
  return config
}

export function removeProfile(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const config = readConfig(env)
  const had = name in config.profiles
  delete config.profiles[name]
  if (config.defaultProfile === name) config.defaultProfile = Object.keys(config.profiles)[0]
  writeConfig(config, env)
  return had
}

/** The terminal UI theme in effect: the profile's, else the global one, else undefined (the UI's default). */
export function readTheme(profile?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const config = readConfig(env)
  return (profile ? config.profiles[profile]?.ui?.theme : undefined) ?? config.ui?.theme
}

/** Saves the theme globally, or for one profile when `profile` is given. */
export function writeTheme(theme: string | undefined, options: { profile?: string } = {}, env: NodeJS.ProcessEnv = process.env): void {
  const config = readConfig(env)
  if (options.profile && config.profiles[options.profile]) {
    config.profiles[options.profile]!.ui = { ...config.profiles[options.profile]!.ui, theme }
  } else {
    config.ui = { ...config.ui, theme }
  }
  writeConfig(config, env)
}

/** The saved view settings of one screen (`table:person`), or an empty object. */
export function readViewSettings(key: string, env: NodeJS.ProcessEnv = process.env): ViewSettings {
  return { ...(readConfig(env).ui?.views?.[key] ?? {}) }
}

/** Saves the view settings of one screen, replacing what was saved; undefined removes them. */
export function writeViewSettings(key: string, view: ViewSettings | undefined, env: NodeJS.ProcessEnv = process.env): void {
  const config = readConfig(env)
  const views = { ...(config.ui?.views ?? {}) }
  if (view === undefined) delete views[key]
  else views[key] = view
  config.ui = { ...config.ui, views }
  writeConfig(config, env)
}
