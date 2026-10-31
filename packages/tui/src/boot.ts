/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** Builds the store for a run: settings from options, config and environment; sign-in; the first route. */

import { readTheme, resolveProfile, writeTheme, defaultSecretStore, type SecretStore } from '@qrun-io/qqq-core'
import { installCommands } from './commands'
import { SignInScreen, type SignInDeps } from './screens/signin'
import { Sidebar } from './screens/sidebar'
import { AppStore, setSecretStoreFactory, type Target } from './store'
import { DEFAULT_THEME, THEMES } from './theme'

export interface CliArgs {
  profile?: string
  server?: string
  theme?: string
  ascii: boolean
  linear: boolean
  mouse: boolean
  route: string[]
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const out: CliArgs = { ascii: env.QQQ_UI_ASCII === '1', linear: env.QQQ_UI_LINEAR === '1', mouse: false, route: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') {
      out.route = argv.slice(i + 1)
      break
    }
    if (a === '--profile' || a === '-p') out.profile = argv[++i]
    else if (a === '--server' || a === '-s') out.server = argv[++i]
    else if (a === '--theme') out.theme = argv[++i]
    else if (a === '--ascii') out.ascii = true
    else if (a === '--linear') out.linear = true
    else if (a === '--mouse') out.mouse = true
    else out.route.push(a)
  }
  return out
}

export interface BootOptions {
  args: CliArgs
  quit: () => void
  build?: string
  secrets?: () => SecretStore
  fetch?: typeof fetch
  timers?: boolean
}

/** Creates the store and starts sign-in (or connects straight away with a stored sign-in). */
export function boot(options: BootOptions): AppStore {
  const { args } = options
  let target: Target | undefined
  let note: string | undefined
  try {
    const r = resolveProfile({ profile: args.profile, server: args.server })
    target = { name: r.name, server: r.server }
  } catch (e) {
    note = e instanceof Error ? e.message : String(e)
  }
  if (args.theme) {
    if (THEMES[args.theme]) writeTheme(args.theme)
    else note = `unknown theme "${args.theme}"; themes: ${Object.keys(THEMES).join(', ')}`
  }
  const theme = (args.theme && THEMES[args.theme] ? args.theme : undefined) ?? readTheme(target?.name) ?? DEFAULT_THEME
  const store = new AppStore({ settings: { theme, ascii: args.ascii, linear: args.linear, mouse: args.mouse, singleKeys: true }, quit: options.quit, build: options.build, target, timers: options.timers })
  let secrets: SecretStore | undefined
  const secretsFn = options.secrets ?? (() => (secrets ??= defaultSecretStore()))
  setSecretStoreFactory(secretsFn)
  installCommands(store)
  store.sidebarFactory = (s) => new Sidebar(s)
  const deps: SignInDeps = {
    secrets: secretsFn,
    fetch: options.fetch,
    timers: options.timers,
    afterConnect: (s) => {
      loadKeyboardPreference(s)
      if (args.route.length) {
        const route = args.route
        args.route = []
        void s.commands().run(route.join(' ').replace(/^(\S+ \S+ \S+ )(.+)$/, (m) => m) && routeLine(route))
      }
    },
  }
  store.signInDeps = deps
  const screen = new SignInScreen(store, deps, target, note)
  store.push(screen)
  if (target) screen.choose(target)
  return store
}

/** Re-quotes route arguments into one command line. */
function routeLine(route: string[]): string {
  return route.map((a) => (/^[A-Za-z0-9_./:=,@+-]+$/.test(a) ? a : `"${a.replace(/(["\\])/g, '\\$1')}"`)).join(' ')
}

/** The server's keyboard.singleKeyShortcuts preference turns single-key shortcuts off. */
function loadKeyboardPreference(store: AppStore): void {
  if (!(store.version?.features ?? []).includes('preferences')) return
  store.client?.data<{ values?: Record<string, unknown> }>('getPreferenceSection', { path: { sectionName: 'keyboard' } })
    .then((d) => {
      const v = d.values?.singleKeyShortcuts
      if (v === false || v === 'false') {
        store.settings.singleKeys = false
        store.bump()
      }
    })
    .catch(() => undefined)
}
