/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { AUTH_MODES, PROFILE_NAME, configDir, descriptionOf, editProfile, probeServer, readConfig, readFilePreferences, readTheme, removeProfile, setDefaultProfile, shortNameOf, shortNameProblem, upsertProfile, writeFilePreferences, writeTheme, type AuthMode, type Profile } from '@qrun-io/qqq-core'
import { UsageError, type Context } from '../context.js'
import { getLogin, removeLogin, secretStoreKind } from '../session.js'

export function registerConfig(program: Command, ctx: () => Context): void {
  const config = program.command('config').description('Profiles and local settings.')

  config.command('show').description('Where settings live and which profile is in use.').action(async () => {
    const c = ctx()
    const cfg = readConfig()
    const t = c.target
    const login = await getLogin(t)
    c.print({ data: { configDir: configDir(), secretStore: secretStoreKind(), profile: t.name, chosenBy: t.source, server: t.server, signedIn: login ? (login.kind === 'session' ? `${login.authType.toLowerCase()} session` : 'oauth2') : 'no', defaultProfile: cfg.defaultProfile ?? '', profiles: Object.keys(cfg.profiles).length } })
  })

  /**
   * Local settings, kept in the `ui` section of config.json through the kernel helpers the TUI
   * uses: the file preferences (files/navigator.ts) and the theme (session/profiles.ts).
   */
  const SETTINGS: Record<string, { help: string; get: () => unknown; set: (value: string | undefined, profile?: string) => unknown }> = {
    'download-dir': { help: 'where downloads go without --out / --out-dir (created when missing)', get: () => readFilePreferences().downloadDir, set: (v) => writeFilePreferences({ downloadDir: v === undefined ? undefined : absolute(v) }).downloadDir },
    'upload-dir': { help: 'where the TUI\'s upload chooser starts', get: () => readFilePreferences().uploadDir, set: (v) => writeFilePreferences({ uploadDir: v === undefined ? undefined : absolute(v) }).uploadDir },
    'download-mode': {
      help: 'the TUI: ask (a save dialog each time) or silent (straight to the download directory)',
      get: () => readFilePreferences().downloadMode,
      set: (v) => {
        if (v !== undefined && v !== 'ask' && v !== 'silent') throw new UsageError('download-mode takes ask or silent')
        return writeFilePreferences({ downloadMode: v }).downloadMode
      },
    },
    theme: {
      help: 'the TUI theme (--profile to set it for one profile; qqq ui lists the themes)',
      get: () => readTheme(selectedProfile()),
      set: (v, profile) => {
        writeTheme(v, { profile })
        return v
      },
    },
  }
  const absolute = (path: string) => resolve(path.replace(/^~(?=$|[\\/])/, homedir()))
  const selectedProfile = () => (program.opts() as { profile?: string }).profile ?? process.env.QQQ_PROFILE
  const setting = (name: string) => {
    const s = SETTINGS[name]
    if (!s) throw new UsageError(`No setting "${name}"; settings: ${Object.keys(SETTINGS).join(', ')}`)
    return s
  }

  config.command('get [setting]')
    .description(`A local setting (${Object.keys(SETTINGS).join(', ')}), or all of them.`)
    .action((name: string | undefined) => {
      const c = ctx()
      if (name) {
        const value = setting(name).get()
        c.print({ data: value ?? null, rows: [{ setting: name, value: value ?? '' }], columns: ['setting', 'value'] })
        return
      }
      const all = Object.fromEntries(Object.entries(SETTINGS).map(([n, s]) => [n, s.get() ?? null]))
      c.print({ data: all, rows: Object.entries(SETTINGS).map(([n, s]) => ({ setting: n, value: s.get() ?? '', meaning: s.help })), columns: ['setting', 'value', 'meaning'] })
    })

  config.command('set <setting> <value>')
    .description('Change a local setting (the ui section of config.json, shared with the TUI); an empty value removes it.')
    .action((name: string, raw: string) => {
      const c = ctx()
      const value = setting(name).set(raw === '' ? undefined : raw, name === 'theme' ? (program.opts() as { profile?: string }).profile : undefined)
      c.note(value === undefined ? `Removed ${name}.` : `${name}: ${String(value)}`)
    })

  registerProfileCommands(config.command('profile').description('Named servers: list, add, edit, use, remove (also `qqq profile`).'), ctx)
}

/**
 * The profile verbs, registered twice: `qqq profile …` and `qqq config profile …` (1.0.0-rc.1).
 * They read and write the same config.json as the TUI's Servers dialog (Ctrl+O), field for field:
 * name, short name, description, server, sign-in mode; `use` is the dialog's `*` (default).
 */
export function registerProfileCommands(profile: Command, ctx: () => Context): void {
  const authMode = (v: string | undefined): AuthMode | undefined => {
    if (v === undefined) return undefined
    if (!AUTH_MODES.includes(v as AuthMode)) throw new UsageError(`--auth-mode takes ${AUTH_MODES.join(', ')}`)
    return v as AuthMode
  }
  const short = (v: string | undefined): string | undefined => {
    if (v === undefined || v === '') return v
    const problem = shortNameProblem(v)
    if (problem) throw new UsageError(`--short: ${problem}`)
    return v
  }
  const origin = (server: string): string => {
    try {
      return new URL(server).origin
    } catch {
      throw new UsageError(`Not a URL: ${server}`)
    }
  }
  const check = async (c: Context, server: string) => {
    const p = await probeServer(server)
    if (!p.reachable) throw new UsageError(`${server} did not answer as a QQQ server (${p.error}); leave out --check to save it anyway.`)
    c.note(`${server}: UI API ${p.apiVersion}${p.authType ? `, ${p.authType} authentication` : ''}.`)
  }

  profile.command('list').description('The profiles: name, short name, server, default, sign-in, last used, description.')
    .option('--probe', 'ask each server for its UI API version (2.5 s timeout)')
    .action(async (options: { probe?: boolean }) => {
      const c = ctx()
      const cfg = readConfig()
      const entries = Object.entries(cfg.profiles)
      const probes = options.probe ? await Promise.all(entries.map(([, p]) => probeServer(p.server))) : []
      const rows = []
      for (const [i, [name, p]] of entries.entries()) {
        const login = await getLogin({ name, server: p.server, source: 'option' })
        const probe = probes[i]
        rows.push({
          name, short: shortNameOf(name, p), server: p.server, default: cfg.defaultProfile === name ? '*' : '',
          signedIn: login ? (login.kind === 'session' ? 'session' : 'oauth2') : '', authMode: p.authMode ?? 'auto', user: p.user ?? '', lastUsed: p.lastUsedAt ?? '',
          ...(probe ? { status: probe.reachable ? `UI API ${probe.apiVersion}` : `unreachable: ${probe.error}`, auth: probe.authType ?? '' } : {}),
          description: descriptionOf(p), note: p.note ?? '',
        })
      }
      c.print({ data: rows, columns: ['name', 'short', 'server', 'default', 'signedIn', ...(options.probe ? ['status', 'auth'] : []), 'lastUsed', 'description'] })
    })

  profile.command('add <name> <server>').description('Add a profile for a server, or update it (sign in with `qqq login --profile <name>`).')
    .option('--default', 'make it the default')
    .option('--short <text>', 'a short name of 2 to 6 characters (footer, Home header); default: from the name')
    .option('--description <text>', 'what the server is')
    .option('--auth-mode <mode>', `how to sign in to an OAuth2 server: ${AUTH_MODES.join(', ')} (default auto: ask)`)
    .option('--note <text>', 'a note (1.0.0-rc.1; shown when there is no description)')
    .option('--check', 'refuse unless the server answers /qqq/v1/version')
    .action(async (name: string, server: string, options: { default?: boolean; short?: string; description?: string; authMode?: string; note?: string; check?: boolean }) => {
      const c = ctx()
      if (!PROFILE_NAME.test(name)) throw new UsageError('Profile names are letters, digits, dots, dashes and underscores.')
      const o = origin(server)
      const fields: Profile = { server: o, note: options.note, short: short(options.short) || undefined, description: options.description, authMode: authMode(options.authMode) }
      if (options.check) await check(c, o)
      upsertProfile(name, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as unknown as Profile, { makeDefault: options.default })
      c.note(`Profile "${name}" (${shortNameOf(name, readConfig().profiles[name])}) -> ${o}${options.default ? ' (default)' : ''}.`)
    })

  profile.command('edit <name>').description('Change a profile: server, short name, description, sign-in mode, or its name (an empty value removes a field).')
    .option('--server <url>', 'a new server address (sign in again afterwards)')
    .option('--short <text>', 'a short name of 2 to 6 characters; empty: back to the default')
    .option('--description <text>', 'what the server is; empty removes it')
    .option('--auth-mode <mode>', `${AUTH_MODES.join(', ')}`)
    .option('--note <text>', 'the 1.0.0-rc.1 note; empty removes it')
    .option('--rename <new-name>', 'give the profile a new name (sign in again afterwards)')
    .option('--check', 'refuse unless the (new) server answers /qqq/v1/version')
    .action(async (name: string, options: { server?: string; short?: string; description?: string; authMode?: string; note?: string; rename?: string; check?: boolean }) => {
      const c = ctx()
      const current = readConfig().profiles[name]
      if (!current) throw new UsageError(`No profile "${name}".`)
      const changes: Partial<Profile> = {}
      const clear: Array<keyof Profile> = []
      if (options.server !== undefined) changes.server = origin(options.server)
      for (const [key, value] of [['short', short(options.short)], ['description', options.description], ['note', options.note]] as const) {
        if (value === undefined) continue
        if (value === '') clear.push(key)
        else changes[key] = value
      }
      if (options.authMode !== undefined) changes.authMode = authMode(options.authMode)
      if (options.check) await check(c, changes.server ?? current.server)
      try {
        editProfile(name, changes, { rename: options.rename, clear })
      } catch (e) {
        throw new UsageError(e instanceof Error ? e.message : String(e))
      }
      const now = options.rename ?? name
      const p = readConfig().profiles[now]!
      c.note(`Profile "${now}" (${shortNameOf(now, p)}) -> ${p.server}${descriptionOf(p) ? ` · ${descriptionOf(p)}` : ''}.`)
    })

  profile.command('use <name>').description('Make a profile the default (the Servers dialog\'s *).').action((name: string) => {
    const c = ctx()
    if (!readConfig().profiles[name]) throw new UsageError(`No profile "${name}".`)
    setDefaultProfile(name)
    c.note(`Default profile: ${name}.`)
  })

  profile.command('remove <name>').description('Remove a profile and its stored sign-in.').action(async (name: string) => {
    const c = ctx()
    const cfg = readConfig()
    const p = cfg.profiles[name]
    if (!p) throw new UsageError(`No profile "${name}".`)
    await removeLogin({ name, server: p.server, source: 'option' })
    removeProfile(name)
    c.note(`Removed profile "${name}".`)
  })
}
