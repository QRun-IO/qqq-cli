/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import { configDir, readConfig, removeProfile, upsertProfile } from '@qrun-io/qqq-core'
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
