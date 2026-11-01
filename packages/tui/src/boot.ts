/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** Builds the store for a run: settings from options, config and environment; sign-in; the first route. */

import { probeServer, readConfig, readTheme, writeTheme, defaultSecretStore, type SecretStore } from '@qrun-io/qqq-core'
import { PICK_HINT, SPLASH_MIN_MS, planBoot, splashEnabled, type BootPlan } from './boot-plan'
import { installCommands } from './commands'
import { readMouse } from './mouse/settings'
import { readFKeyBar } from './keys/shift-bank'
import { ProfileFormOverlay, ServersOverlay } from './overlays/servers'
import { ServersModel } from './servers'
import { SignInScreen, type SignInDeps } from './screens/signin'
import { SplashScreen } from './screens/splash'
import { Sidebar } from './screens/sidebar'
import { AppStore, setSecretStoreFactory, type Target } from './store'
import { DEFAULT_THEME, THEMES } from './theme'

export interface CliArgs {
  profile?: string
  server?: string
  theme?: string
  ascii: boolean
  linear: boolean
  /** --mouse / --no-mouse for this run; unset: the saved Mouse setting (on by default). */
  mouse?: boolean
  /** --splash / --no-splash for this run; unset: the Splash setting (ui.splash, on by default). */
  splash?: boolean
  check: 'startup' | 'full' | 'off'
  route: string[]
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  const out: CliArgs = { ascii: env.QQQ_UI_ASCII === '1', linear: env.QQQ_UI_LINEAR === '1', check: 'startup', route: [] }
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
    else if (a === '--no-mouse') out.mouse = false
    else if (a === '--splash') out.splash = true
    else if (a === '--no-splash') out.splash = false
    else if (a === '--check') out.check = 'full'
    else if (a === '--no-check') out.check = 'off'
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
  /** Shows the splash; unset: --no-splash, QQQ_UI_NO_SPLASH=1 and the Splash setting decide. */
  splash?: boolean
  /** The splash's minimum display time; unset: 600 ms with timers (a real run), else none. */
  splashMinMs?: number
  /** Prints a line once the terminal is restored (the picker closed without a choice). */
  hint?: (text: string) => void
}

/**
 * Creates the store and starts the boot: the splash (unless switched off), then the profile named
 * or the only one; with several the Servers picker, with none the add form (boot-plan.ts).
 */
export function boot(options: BootOptions): AppStore {
  const { args } = options
  const plan: BootPlan = planBoot(args)
  const target: Target | undefined = plan.kind === 'connect' ? plan.target : undefined
  let note = plan.kind === 'connect' ? undefined : plan.note
  if (args.theme) {
    if (THEMES[args.theme]) writeTheme(args.theme)
    else note = `unknown theme "${args.theme}"; themes: ${Object.keys(THEMES).join(', ')}`
  }
  const theme = (args.theme && THEMES[args.theme] ? args.theme : undefined) ?? readTheme(target?.name) ?? DEFAULT_THEME
  const store = new AppStore({ settings: { theme, ascii: args.ascii, linear: args.linear, mouse: args.mouse ?? readMouse(), singleKeys: true, copyCli: readConfig().ui?.copyCliCommands === true, fkeyBar: readFKeyBar() }, quit: options.quit, build: options.build, target, timers: options.timers })
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
  const exit = (hint: string) => {
    store.quit()
    if (hint) options.hint?.(hint)
  }
  if (options.splash ?? splashEnabled(args)) {
    const splash = new SplashScreen(store, { plan, deps, exit, minMs: options.splashMinMs ?? (options.timers ? SPLASH_MIN_MS : 0), animate: Boolean(options.timers) })
    store.push(splash)
    splash.start()
    return store
  }
  // --no-splash: the sign-in screen, with the same first step
  const screen = new SignInScreen(store, deps, target, note)
  store.push(screen)
  if (target) screen.choose(target)
  else {
    const model = new ServersModel({ secrets: secretsFn, probe: (server) => probeServer(server, { fetch: options.fetch }), onChange: () => store.bump() })
    if (plan.kind === 'pick') store.open(new ServersOverlay(store, (row) => screen.choose({ name: row.name, server: row.server }), model, { title: 'Connect to a server', enterLabel: 'Enter connects', escLabel: 'Esc quits', select: plan.select, onEscape: () => exit(PICK_HINT) }))
    else store.open(new ProfileFormOverlay(store, model, undefined, (name) => {
      const p = readConfig().profiles[name]
      screen.build()
      if (p) screen.choose({ name, server: p.server })
    }))
  }
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
