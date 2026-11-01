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
  /** Free text from 1.0.0-rc.1 (`--note`); shown where `description` is when that is missing. */
  note?: string
  createdAt?: string
  /** 2 to 6 characters for compact places (the footer, the Home header); defaults to `defaultShortName`. */
  short?: string
  /** Free text: what the server is (shown in the Servers dialog and `qqq profile list`). */
  description?: string
  /** How to sign in to an OAuth2 server: ask (auto, the default), the browser (PKCE) or the device flow. */
  authMode?: AuthMode
  /** Who signed in last (display name), recorded when the TUI connects; no secret. */
  user?: string
  /** The last time the TUI connected with this profile (ISO time). */
  lastUsedAt?: string
  /** Display settings of the terminal UI for this profile only (override the global `ui`). */
  ui?: Pick<UiSettings, 'theme' | 'childRows'>
}

/** Sign-in preference of a profile; the server's authentication type decides the rest. */
export type AuthMode = 'auto' | 'browser' | 'device'
export const AUTH_MODES: AuthMode[] = ['auto', 'browser', 'device']

/** Local display settings of the terminal UI (not server preferences): theme and per-screen view settings. */
export interface UiSettings {
  theme?: string
  /** Record view: data rows of each child list (default 5); a table's view settings override it. */
  childRows?: number
  /** The terminal UI copies a CLI equivalent to the clipboard as soon as it shows it (default off). */
  copyCliCommands?: boolean
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
  /** Record view: data rows of each child list on this table (overrides the profile's `ui.childRows`). */
  childRows?: number
  /** App home: widget names in display order. */
  widgetOrder?: string[]
  [key: string]: unknown
}

export interface Config {
  defaultProfile?: string
  profiles: Record<string, Profile>
  /** Local client settings shared by the CLI and the TUI: theme, views, files (files/navigator.ts). */
  ui?: UiSettings
  /** Sections this version does not know are kept as they are. */
  [section: string]: unknown
}

/** config.json is not valid JSON: refused, so a write never replaces the profiles with nothing. */
export class ConfigFileError extends Error {}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.QQQ_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'qqq')
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const file = join(configDir(env), 'config.json')
  if (!existsSync(file)) return { profiles: {} }
  let parsed: Config
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as Config
  } catch (error) {
    throw new ConfigFileError(`${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}); fix or remove it (nothing was changed)`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new ConfigFileError(`${file} is not a JSON object; fix or remove it (nothing was changed)`)
  return { ...parsed, profiles: parsed.profiles ?? {} }
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
  /**
   * Set when an existing profile (from --profile or QQQ_PROFILE) was given a different --server:
   * the server the profile points at now. Saving a sign-in for this target would move the
   * profile, so `login` asks first.
   */
  movedFrom?: string
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
    if (p) {
      const server = options.server ? new URL(options.server).origin : p.server
      return { name: named, server, source: options.profile ? 'option' : 'env', ...(server !== p.server ? { movedFrom: p.server } : {}) }
    }
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

/** Profile names: letters, digits, dots, dashes and underscores, starting with a letter or digit. */
export const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The short name when none is saved: the name itself up to 6 characters; a longer name of several
 * parts (`acme-prod-eu`) gives its initials (`ape`), one long word its first 3 characters (`ent`).
 */
export function defaultShortName(name: string): string {
  if (name.length <= 6) return name
  const parts = name.split(/[-_.\s]+/).filter(Boolean)
  const initials = parts.map((p) => p[0]).join('').slice(0, 6)
  return parts.length >= 2 && initials.length >= 2 ? initials : name.slice(0, 3)
}

/** The short name shown for a profile: the saved one, else the default. */
export function shortNameOf(name: string, profile?: Profile): string {
  return profile?.short || defaultShortName(name)
}

/** The description shown for a profile: `description`, else the rc.1 `note`, else ''. */
export function descriptionOf(profile?: Profile): string {
  return profile?.description ?? profile?.note ?? ''
}

/** Why a short name is refused, or undefined when it is fine (2 to 6 letters, digits, dots, dashes, underscores). */
export function shortNameProblem(short: string): string | undefined {
  if (short.length < 2 || short.length > 6) return 'a short name has 2 to 6 characters'
  if (!/^[A-Za-z0-9._-]+$/.test(short)) return 'a short name is letters, digits, dots, dashes and underscores'
  return undefined
}

/** Makes a profile the default (it must exist). */
export function setDefaultProfile(name: string, env: NodeJS.ProcessEnv = process.env): Config {
  const config = readConfig(env)
  if (!config.profiles[name]) throw new Error(`No profile "${name}".`)
  config.defaultProfile = name
  writeConfig(config, env)
  return config
}

/**
 * Changes a profile in place: defined fields of `changes` replace, the fields named in `clear` are
 * removed, `rename` moves it to a new name (the default follows). Fields this version does not know stay.
 */
export function editProfile(name: string, changes: Partial<Profile>, options: { rename?: string; clear?: Array<keyof Profile> } = {}, env: NodeJS.ProcessEnv = process.env): Config {
  const config = readConfig(env)
  const current = config.profiles[name]
  if (!current) throw new Error(`No profile "${name}".`)
  const next: Profile = { ...current }
  for (const [k, v] of Object.entries(changes)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v
  for (const k of options.clear ?? []) delete next[k]
  const target = options.rename ?? name
  if (target !== name) {
    if (!PROFILE_NAME.test(target)) throw new Error('Profile names are letters, digits, dots, dashes and underscores.')
    if (config.profiles[target]) throw new Error(`A profile "${target}" exists already.`)
    // keep the order of the file: the renamed entry takes the old one's place
    config.profiles = Object.fromEntries(Object.entries(config.profiles).map(([k, p]) => (k === name ? [target, next] : [k, p])))
    if (config.defaultProfile === name) config.defaultProfile = target
  } else {
    config.profiles[name] = next
  }
  writeConfig(config, env)
  return config
}

/** Records a connection: last used now, and who signed in (no default change, nothing else touched). */
export function touchProfile(name: string, info: { user?: string } = {}, env: NodeJS.ProcessEnv = process.env): void {
  const config = readConfig(env)
  const p = config.profiles[name]
  if (!p) return
  p.lastUsedAt = new Date().toISOString()
  if (info.user) p.user = info.user
  writeConfig(config, env)
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

/** Data rows of a record-view child list when nothing is saved. */
export const DEFAULT_CHILD_ROWS = 5

/** Child-list rows of the record view: the profile's `ui.childRows`, else the global `ui.childRows`, else 5 (1 to 50). */
export function readChildRows(profile?: string, env: NodeJS.ProcessEnv = process.env): number {
  const config = readConfig(env)
  const n = Number((profile ? config.profiles[profile]?.ui?.childRows : undefined) ?? config.ui?.childRows ?? DEFAULT_CHILD_ROWS)
  return Number.isInteger(n) && n >= 1 && n <= 50 ? n : DEFAULT_CHILD_ROWS
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
