/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * What `qqq ui` does first, decided from the options, the environment and config.json before
 * anything is drawn: connect to one profile, ask which profile (several saved, none named), or add
 * the first one (none saved). Also the Splash setting (`ui.splash`: on unless off) and its timing.
 */

import { readConfig, resolveProfile, writeConfig, type Config } from '@qrun-io/qqq-core'
import type { Target } from './store'

/** The splash stays up at least this long (ms) so it never just flashes. */
export const SPLASH_MIN_MS = 600

export type BootPlan =
  /** A profile was named (--profile, QQQ_PROFILE, --server, QQQ_SERVER) or only one exists. */
  | { kind: 'connect'; target: Target }
  /** Several profiles and none named: the Servers picker, `select` preselected (the last used). */
  | { kind: 'pick'; select?: string; note?: string }
  /** No profile at all: the add form. */
  | { kind: 'add'; note?: string }

/** Whether a profile was named for this run (an option or the environment). */
export function namedProfile(args: { profile?: string; server?: string }, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(args.profile || args.server || env.QQQ_PROFILE || env.QQQ_SERVER)
}

/** The most recently used profile (config lastUsedAt), else the default, else the first. */
export function lastUsedProfile(config: Config): string | undefined {
  const names = Object.keys(config.profiles)
  let best: string | undefined
  let bestAt = -Infinity
  for (const n of names) {
    const at = Date.parse(config.profiles[n]!.lastUsedAt ?? '')
    if (!Number.isNaN(at) && at > bestAt) {
      best = n
      bestAt = at
    }
  }
  return best ?? (config.defaultProfile && config.profiles[config.defaultProfile] ? config.defaultProfile : names[0])
}

/** Decides the first step of a run (pure: config and environment are passed in by tests). */
export function planBoot(args: { profile?: string; server?: string }, env: NodeJS.ProcessEnv = process.env, config: Config = readConfig(env)): BootPlan {
  const names = Object.keys(config.profiles)
  if (!namedProfile(args, env) && names.length === 1) return { kind: 'connect', target: { name: names[0]!, server: config.profiles[names[0]!]!.server } }
  if (namedProfile(args, env)) {
    try {
      const r = resolveProfile({ profile: args.profile, server: args.server }, env, config)
      return { kind: 'connect', target: { name: r.name, server: r.server } }
    } catch (e) {
      // a name that does not exist: choose from what there is (or add the first)
      const note = e instanceof Error ? e.message : String(e)
      return names.length ? { kind: 'pick', select: lastUsedProfile(config), note } : { kind: 'add', note }
    }
  }
  if (!names.length) return { kind: 'add' }
  return { kind: 'pick', select: lastUsedProfile(config) }
}

/** The Splash setting: on unless `ui.splash` is off (or false). */
export function readSplash(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const v = (readConfig(env).ui as { splash?: unknown } | undefined)?.splash
    return !(v === false || v === 'off')
  } catch {
    return true
  }
}

export function writeSplash(on: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const config = readConfig(env)
  config.ui = { ...config.ui, splash: on ? 'on' : 'off' } as never
  writeConfig(config, env)
}

/** Whether this run shows the splash: --no-splash (or QQQ_UI_NO_SPLASH=1) and the setting turn it off. */
export function splashEnabled(args: { splash?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (args.splash !== undefined) return args.splash
  if (env.QQQ_UI_NO_SPLASH === '1') return false
  return readSplash(env)
}

/** How long to wait before leaving the splash, given when it was shown. */
export function splashWait(shownAt: number, now: number, minMs = SPLASH_MIN_MS): number {
  return Math.max(0, shownAt + minMs - now)
}

/** The one line printed when the picker is closed without choosing. */
export const PICK_HINT = 'qqq ui: no profile chosen; --profile NAME (or QQQ_PROFILE) skips the picker'

/** Settings > Splash on start and `:splash on|off`: saved for the next start. */
export function setSplashSetting(store: { flash: (text: string) => void; error: (e: unknown) => void }, on: boolean): void {
  try {
    writeSplash(on)
  } catch (e) {
    store.error(e)
    return
  }
  store.flash(on ? 'splash on (saved): the next qqq ui starts on the splash' : 'splash off (saved): the next qqq ui starts without it (--splash shows it once)')
}
