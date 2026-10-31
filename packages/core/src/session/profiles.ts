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
}

export interface Config {
  defaultProfile?: string
  profiles: Record<string, Profile>
  /** Local client settings shared by the CLI and the TUI (download and upload directories, …). */
  ui?: UiSettings
  /** Sections this version does not know are kept as they are. */
  [section: string]: unknown
}

/** The `ui` section of config.json. */
export interface UiSettings {
  /** Where downloaded files go when no --out / --out-dir is given (created when missing). */
  defaultDownloadDir?: string
  /** Where file pickers for uploads start. */
  defaultUploadDir?: string
  /** Whether a head asks before writing a download. */
  downloadPrompt?: boolean
  [key: string]: unknown
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

/** The local client settings (`ui` section). */
export function readUiSettings(env: NodeJS.ProcessEnv = process.env): UiSettings {
  const ui = readConfig(env).ui
  return ui && typeof ui === 'object' ? { ...ui } : {}
}

/** Merges settings into the `ui` section; an undefined value removes the key. */
export function writeUiSettings(settings: Partial<UiSettings>, env: NodeJS.ProcessEnv = process.env): UiSettings {
  const config = readConfig(env)
  const ui: UiSettings = { ...(config.ui ?? {}) }
  for (const [key, value] of Object.entries(settings)) {
    if (value === undefined) delete ui[key]
    else ui[key] = value
  }
  config.ui = ui
  writeConfig(config, env)
  return ui
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
