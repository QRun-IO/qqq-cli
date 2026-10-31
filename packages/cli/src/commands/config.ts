/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { configDir, readConfig, readFilePreferences, readTheme, removeProfile, upsertProfile, writeFilePreferences, writeTheme } from '@qrun-io/qqq-core'
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

  const profile = config.command('profile').description('Named servers: list, add, use, remove.')
  profile.command('list').description('The profiles.').action(async () => {
    const c = ctx()
    const cfg = readConfig()
    const rows = []
    for (const [name, p] of Object.entries(cfg.profiles)) {
      const login = await getLogin({ name, server: p.server, source: 'option' })
      rows.push({ name, server: p.server, default: cfg.defaultProfile === name ? '*' : '', signedIn: login ? (login.kind === 'session' ? 'session' : 'oauth2') : '', note: p.note ?? '' })
    }
    c.print({ data: rows, columns: ['name', 'server', 'default', 'signedIn', 'note'] })
  })
  profile.command('add <name> <server>').description('Add or rename a profile for a server (sign in with `qqq login --profile <name>`).').option('--default', 'make it the default').option('--note <text>', 'a note').action((name: string, server: string, options: { default?: boolean; note?: string }) => {
    const c = ctx()
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new UsageError('Profile names are letters, digits, dots, dashes and underscores.')
    const origin = new URL(server).origin
    upsertProfile(name, { server: origin, note: options.note }, { makeDefault: options.default })
    c.note(`Profile "${name}" -> ${origin}${options.default ? ' (default)' : ''}.`)
  })
  profile.command('use <name>').description('Make a profile the default.').action((name: string) => {
    const c = ctx()
    const cfg = readConfig()
    if (!cfg.profiles[name]) throw new UsageError(`No profile "${name}".`)
    upsertProfile(name, cfg.profiles[name]!, { makeDefault: true })
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
