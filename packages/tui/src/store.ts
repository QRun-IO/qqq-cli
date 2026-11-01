/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The application state and the one place keys are dispatched. React components only draw what is
 * here; key handlers read and change it directly (no closures over render-time state), then ask for
 * a repaint. Order of dispatch: the lock screen, the top overlay, the global function keys, the
 * focused pane (sidebar or screen), then the global fallbacks (Esc back, Tab, `:`).
 */

import { openRealtimeStream } from '@qrun-io/qqq-ui-api-client'
import { History, MetaDataIndex, addRecent, currentCredential, readIdleMinutes, type MetaDataDocument, type RecentItem } from '@qrun-io/qqq-core'
import { TUI_CHANNEL, TuiClient, type VersionInfo } from './client'
import { charOf, isPrintable, type Key } from './keys'
import { ChoiceOverlay, ConfirmOverlay, CliCommandOverlay, MessageOverlay } from './overlays/basic'
import { Extensions } from './extensions'
import { PrintTracker, printScreen } from './printing'
import { collaborationPresence, presenceSource, setPresenceSource } from './presence'
import { realtimeEvents } from './saver/model'
import { setAscii, setTheme, theme } from './theme'
import type { FKeyLabels, Overlay, Screen } from './types'
import { errorText } from './util/text'
import { SQL_EXTENSION, hideRunnerApps } from './sql/apps'

export interface Settings {
  theme: string
  ascii: boolean
  linear: boolean
  mouse: boolean
  /** Single-key shortcuts (s, v, n, e …); the server's keyboard.singleKeyShortcuts preference turns them off. */
  singleKeys: boolean
  /** Copy CLI equivalents to the clipboard automatically (ui.copyCliCommands; default off). */
  copyCli?: boolean
}

export interface Status {
  server: string
  profile: string
  /** The profile's short name (2 to 6 characters) for the footer and the Home header. */
  short?: string
  user: string
  /** The id saved records carry for their owner (email, id reference, user name or subject). */
  userId?: string
  auth: string
  apiVersion: string
  pingMs: number | null
  stream: 'off' | 'connecting' | 'connected' | 'reconnecting' | 'n/a'
  lastEvent: string
  jobs: string
  /** Print jobs being followed (`print 1/2 RECEIVED`), when any. */
  print?: string
  build: string
  clock: string
  alerts?: number
}

export interface Target {
  name: string
  server: string
}

export interface StoreOptions {
  settings: Settings
  /** Ends the program (renderer.destroy). */
  quit: () => void
  build?: string
  target?: Target
  /** Starts the ping, clock and realtime timers (off in tests). */
  timers?: boolean
}

type Listener = () => void

export class AppStore {
  routes: Screen[] = []
  overlays: Overlay[] = []
  /** Help-authoring mode (:helpkeys): F1 shows every help slot's key. */
  helpKeys = false
  focus: 'content' | 'sidebar' = 'content'
  width = 120
  height = 40
  client?: TuiClient
  meta?: MetaDataDocument
  /** The search index over the metadata, built once per metadata document. */
  index?: MetaDataIndex
  version?: VersionInfo
  extensions = new Extensions()
  target?: Target
  settings: Settings
  status: Status
  /** Print jobs queued from this session, followed until they end. */
  readonly printTracker: PrintTracker
  /** The screen as drawn, as text (set by main.tsx from the renderer; tests set the test frame). */
  captureScreen?: () => string
  flashText?: { text: string; kind: 'info' | 'error'; at: number }
  /** The screen saver or lock, when shown. */
  lock?: Overlay
  readonly history = new History('commands')
  readonly filterHistory = new History('filters')
  lastMenuSection = 0
  lastInput = Date.now()
  sidebarFactory?: (store: AppStore) => SidebarLike
  /** The next connect fetches the metadata again instead of using the cache (a server switch). */
  refreshMetaOnConnect = false
  /** How to sign in again (profile switch, sign out); set by main. */
  signInDeps?: import('./screens/signin').SignInDeps
  /** Opens text in $EDITOR and returns the edited text (set by main; suspends the renderer). */
  editExternal: (text: string) => Promise<string> = async () => { throw new Error('no external editor in this session') }
  /** Copies text to the clipboard (set by main); returns how it was copied, or undefined when there is no clipboard. */
  copyText: (text: string) => string | undefined = () => undefined
  sidebar?: SidebarLike
  private listeners = new Set<Listener>()
  private timers: Array<ReturnType<typeof setInterval>> = []
  private streamAbort?: AbortController
  private readonly quitImpl: () => void
  private paintQueued = false

  constructor(options: StoreOptions) {
    this.settings = options.settings
    this.quitImpl = options.quit
    this.target = options.target
    setTheme(options.settings.theme)
    setAscii(options.settings.ascii)
    this.status = {
      server: options.target?.server ?? '', profile: options.target?.name ?? '', user: '', auth: '', apiVersion: '…', pingMs: null,
      stream: 'off', lastEvent: 'no events yet', jobs: 'n/a', build: options.build ?? 'dev', clock: clock(),
    }
    this.printTracker = new PrintTracker(this, 1000, Boolean(options.timers))
    if (options.timers) this.startClock()
  }

  private clockTimer?: ReturnType<typeof setInterval>

  /** The footer clock and the idle check; started again by `connect` after a server switch disposed it. */
  private startClock(): void {
    if (this.clockTimer) return
    this.clockTimer = setInterval(() => {
      this.status.clock = clock()
      this.checkIdle()
      this.bump()
    }, 1000)
    this.timers.push(this.clockTimer)
  }

  // ---- rendering ----

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Asks for a repaint (coalesced). */
  bump(): void {
    if (this.paintQueued) return
    this.paintQueued = true
    queueMicrotask(() => {
      this.paintQueued = false
      this.syncPresence()
      for (const l of this.listeners) l()
    })
  }

  get screen(): Screen | undefined {
    return this.routes[this.routes.length - 1]
  }

  get singleKeys(): boolean {
    return this.settings.singleKeys
  }

  get showSidebar(): boolean {
    return !this.settings.linear && this.width >= 100 && Boolean(this.meta) && Boolean(this.sidebar)
  }

  // ---- navigation ----

  /** Replaces the metadata and rebuilds the search index (once per document). */
  setMeta(meta: MetaDataDocument): void {
    this.meta = hideRunnerApps(meta, this.extensions.has(SQL_EXTENSION))
    this.index = new MetaDataIndex(meta)
  }

  /** Dialogs that belong to the screen they were opened on (the F9 menu) close when navigation happens. */
  private closeNavOverlays(): void {
    this.overlays = this.overlays.filter((o) => !(o as { closesOnNavigate?: boolean }).closesOnNavigate)
  }

  push(screen: Screen): void {
    this.closeNavOverlays()
    this.routes.push(screen)
    this.focus = 'content'
    this.bump()
  }

  /** Tells the presence source which scope is on top (called on every repaint; cheap when unchanged). */
  private syncPresence(): void {
    const scope = this.lock ? undefined : this.screen?.presenceScope?.()
    presenceSource().enter?.(scope)
  }

  /** Replaces the top screen (a form that saved becomes the record). */
  replace(screen: Screen): void {
    this.closeNavOverlays()
    const old = this.routes.pop()
    old?.dispose?.()
    this.routes.push(screen)
    this.bump()
  }

  /** Back one screen; the screen below resumes with its state intact. */
  back(): void {
    this.closeNavOverlays()
    if (this.routes.length <= 1) {
      if (!this.settings.linear && this.sidebar && this.showSidebar) this.focus = 'sidebar'
      this.bump()
      return
    }
    const old = this.routes.pop()
    old?.dispose?.()
    this.screen?.resume?.()
    this.bump()
  }

  /** Back to the first screen (home). */
  home(): void {
    this.closeNavOverlays()
    while (this.routes.length > 1) this.routes.pop()?.dispose?.()
    this.screen?.resume?.()
    this.bump()
  }

  // ---- overlays and messages ----

  open(overlay: Overlay): void {
    this.overlays.push(overlay)
    this.bump()
  }

  closeOverlay(overlay?: Overlay): void {
    if (!overlay) this.overlays.pop()
    else this.overlays = this.overlays.filter((o) => o !== overlay)
    this.bump()
  }

  /** The CLI equivalent dialog; copies at once when the preference is on. */
  showCli(command: string): void {
    this.open(new CliCommandOverlay(this, command))
  }

  message(text: string, kind: 'info' | 'error' = 'info', title?: string): void {
    this.open(new MessageOverlay(this, text, kind, title))
  }

  /** A short note in the status area that fades on its own. */
  flash(text: string, kind: 'info' | 'error' = 'info'): void {
    this.flashText = { text, kind, at: Date.now() }
    this.bump()
    setTimeout(() => {
      if (this.flashText && Date.now() - this.flashText.at >= 3900) {
        this.flashText = undefined
        this.bump()
      }
    }, 4000)
  }

  confirm(text: string, onYes: () => void, onNo?: () => void): void {
    this.open(new ConfirmOverlay(this, text, onYes, onNo))
  }

  /**
   * The server answered 401 mid-use: the sign-in screen opens on top of the current screens and,
   * once signed in again, the screen that was open refreshes (nothing typed in a form is lost).
   */
  sessionExpired(): void {
    if (!this.target || !this.signInDeps || this.routes.some((r) => r.kind === 'signin')) return
    const target = this.target
    const deps = this.signInDeps
    void import('./screens/signin').then(({ SignInScreen }) => {
      if (this.routes.some((r) => r.kind === 'signin')) return
      this.push(new SignInScreen(this, deps, target, 'your session expired: sign in again to continue where you were', true))
    })
  }

  error(error: unknown): void {
    this.message(errorText(error), 'error')
  }

  /** Runs async work; failures become an error message instead of an unhandled rejection. */
  run<T>(work: Promise<T>, onDone?: (value: T) => void): void {
    work.then((value) => {
      onDone?.(value)
      this.bump()
    }).catch((e) => this.error(e))
  }

  // ---- keys ----

  handleKey(raw: Key): void {
    this.lastInput = Date.now()
    // Ctrl+F / Ctrl+B page forward and back everywhere: no terminal or tmux intercepts them
    let key: Key = raw.ctrl && (raw.name === 'f' || raw.name === 'b') ? { name: raw.name === 'f' ? 'pagedown' : 'pageup', sequence: '' } : raw
    // F-key fallbacks for terminals that take the F-keys: Esc then a digit (arrives as Alt+digit) or Ctrl+digit; 0 is F10
    const digit = /^[0-9]$/.test(raw.name) ? raw.name : /^[0-9]$/.test(raw.sequence?.slice(-1) ?? '') && raw.meta ? raw.sequence.slice(-1) : undefined
    if (digit !== undefined && (raw.meta || raw.ctrl)) key = { name: `f${digit === '0' ? 10 : digit}`, sequence: '' }
    try {
      this.dispatch(key)
    } catch (e) {
      this.error(e)
    }
    this.bump()
  }

  /** Bracketed paste: to the top dialog, else the screen, when it takes text. */
  handlePaste(text: string): void {
    this.lastInput = Date.now()
    const top = (this.lock ?? this.overlays[this.overlays.length - 1]) as { paste?: (t: string) => void } | undefined
    const target = top ?? (this.screen as { paste?: (t: string) => void } | undefined)
    try {
      target?.paste?.(text)
    } catch (e) {
      this.error(e)
    }
    this.bump()
  }

  private dispatch(key: Key): void {
    if (this.lock) {
      this.lock.onKey(key)
      return
    }
    const top = this.overlays[this.overlays.length - 1]
    if (top) {
      top.onKey(key)
      return
    }
    const screen = this.screen
    if (this.focus === 'content' && screen?.claimsKey?.(key) && screen.onKey(key)) return
    // Ctrl+P prints what you see on every screen; Print Screen too when the terminal passes it on
    // (kitty keyboard protocol); F8 prints where the screen has no Delete for it
    if ((key.ctrl && key.name === 'p') || key.name === 'printscreen' || (key.name === 'f8' && this.fkeys().find((k) => k.n === 8)?.label === 'Print')) return printScreen(this)
    if (key.name === 'f1') return this.commands().help()
    if (this.backslash && charOf(key) === '?') {
      this.backslash = false
      return this.commands().help()
    }
    if (key.name === 'f2') return this.commands().search()
    if (key.ctrl && key.name === 'k') return this.commands().palette()
    if (key.name === 'f9') return this.commands().menu()
    if (key.ctrl && key.name === 'o') return this.commands().servers()
    if (key.name === 'f10') return this.requestQuit()
    if (this.focus === 'sidebar' && this.sidebar && this.showSidebar) {
      if (this.sidebar.onKey(key)) return
    } else if (screen?.onKey(key)) {
      return
    }
    const typing = screen?.capturesText?.() ?? false
    switch (key.name) {
      case 'escape':
        if (this.focus === 'sidebar') this.focus = 'content'
        else this.back()
        return
      case 'tab':
        if (this.showSidebar) this.focus = this.focus === 'sidebar' ? 'content' : 'sidebar'
        return
      case 'f5':
        screen?.refresh?.()
        return
      case 'f3': case 'f4': case 'f6': case 'f7': case 'f8':
        this.flash(`${key.name.toUpperCase()} does nothing on this screen`)
        return
      default:
        break
    }
    if (typing) return
    const ch = charOf(key)
    if (ch === ':') return this.commands().commandLine()
    if (ch === '?') return this.commands().help()
    if (ch === '/' || ch === '.' || ch === '\\') return this.pendingBackslash(ch)
    this.backslash = false
    if (this.singleKeys && ch === 'v') return this.commands().viewSettings()
  }

  private backslash = false
  /** `/` and `.` open the search; a backslash followed by `?` is an alias of `?` (the keyboard reference). */
  private pendingBackslash(ch: string): void {
    if (ch === '\\') {
      this.backslash = true
      return
    }
    this.backslash = false
    this.commands().palette()
  }

  /** The command layer (menu, palette, `:` line); set by commands.ts to avoid an import cycle. */
  commandsImpl?: (store: AppStore) => CommandsLike
  commands(): CommandsLike {
    return this.commandsImpl!(this)
  }

  // ---- quitting ----

  /** F10: a small dialog with Quit, Reset (home screen) and Cancel. */
  requestQuit(): void {
    this.open(new ChoiceOverlay<'quit' | 'reset' | 'cancel'>(this, 'Quit qqq?', [
      { label: 'Quit', value: 'quit', detail: 'end the program' },
      { label: 'Reset: go to the home screen', value: 'reset', detail: 'keeps the session' },
      { label: 'Cancel', value: 'cancel', detail: 'Esc' },
    ], (choice) => {
      if (choice === 'quit') this.guard('quit', () => this.quit())
      else if (choice === 'reset') this.reset()
    }, 'Enter chooses'))
  }

  /** Warns about unsaved forms or running processes before `then`. */
  private guard(what: 'quit' | 'reset', then: () => void): void {
    const dirty = this.routes.some((s) => s.dirty?.())
    const busy = this.routes.some((s) => s.busy?.())
    if (!dirty && !busy) return then()
    const warn = dirty ? 'A form has unsaved changes that will be lost.' : 'A process is still running; it continues on the server.'
    this.confirm(`${warn} ${what === 'quit' ? 'Quit' : 'Reset'} anyway?`, then)
  }

  /**
   * Reset: closes dialogs and every screen above Home (after the same warning), refreshes the
   * metadata, and returns to Home with the Apps tree focused. The session and profile stay.
   */
  reset(): void {
    this.guard('reset', () => {
      this.overlays = []
      while (this.routes.length > 1) this.routes.pop()?.dispose?.()
      const done = () => {
        this.sidebar = this.sidebarFactory?.(this) ?? this.sidebar
        this.screen?.resume?.()
        this.focus = this.showSidebar ? 'sidebar' : 'content'
        this.flash('reset: home screen, metadata refreshed')
        this.bump()
      }
      if (!this.client) return done()
      this.client.clearCaches()
      this.client.metaData(true).then((m) => this.setMeta(m)).catch((e) => this.error(e)).finally(done)
    })
  }

  quit(): void {
    this.dispose()
    this.quitImpl()
  }

  dispose(): void {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
    this.clockTimer = undefined
    this.streamAbort?.abort()
    this.printTracker.dispose()
    for (const s of this.routes) s.dispose?.()
  }

  // ---- connection ----

  /** Called after a sign-in: loads version and metadata, starts ping, jobs and the realtime stream. */
  async connect(client: TuiClient, options: { timers?: boolean } = {}): Promise<void> {
    this.client = client
    this.status.server = client.server
    const refresh = this.refreshMetaOnConnect
    this.refreshMetaOnConnect = false
    const [version, meta] = await Promise.all([client.version(), client.metaData(refresh)])
    this.version = version
    this.extensions.load(version)
    this.setMeta(meta)
    setPresenceSource(collaborationPresence(this.extensions.registry, client, this.status.user))
    this.status.apiVersion = version.apiVersion
    this.sidebar = this.sidebarFactory?.(this)
    if (options.timers) {
      this.startClock()
      const ping = () => client.ping().then((ms) => { this.status.pingMs = ms }).catch(() => { this.status.pingMs = null }).finally(() => this.bump())
      ping()
      this.timers.push(setInterval(ping, 5000))
      this.loadJobs()
      this.timers.push(setInterval(() => this.loadJobs(), 15000))
      this.startStream()
    }
    this.bump()
  }

  private loadJobs(): void {
    const client = this.client
    if (!client) return
    if (!(this.version?.features ?? []).includes('durableJobs')) {
      this.status.jobs = 'n/a'
      return
    }
    client.data<{ activeCount?: number; jobs?: unknown[] }>('listJobs', { query: { scope: 'mine', state: 'active' } })
      .then((r) => { this.status.jobs = String(r.activeCount ?? r.jobs?.length ?? 0) })
      .catch(() => { this.status.jobs = 'n/a' })
      .finally(() => this.bump())
  }

  /** The realtime stream: state in the footer, last event, reconnect with backoff, heartbeat timeout. */
  private startStream(): void {
    if (!(this.version?.features ?? []).includes('realtime') || !this.client || !this.target) {
      this.status.stream = 'n/a'
      return
    }
    const abort = new AbortController()
    this.streamAbort = abort
    const target = this.target
    let delay = 1000
    const loop = async () => {
      while (!abort.signal.aborted) {
        this.status.stream = this.status.stream === 'off' ? 'connecting' : 'reconnecting'
        this.bump()
        try {
          const credential = await currentCredential({ store: storeFor(), target, clientChannel: TUI_CHANNEL })
          let heartbeat = 30_000
          let last = Date.now()
          const watchdog = setInterval(() => { if (Date.now() - last > heartbeat * 2) inner.abort() }, 5000)
          const inner = new AbortController()
          abort.signal.addEventListener('abort', () => inner.abort())
          try {
            for await (const message of openRealtimeStream({ baseUrl: target.server, clientChannel: TUI_CHANNEL, signal: inner.signal, headers: credential.cookie ? { Cookie: credential.cookie } : undefined, token: () => credential.bearer })) {
              last = Date.now()
              delay = 1000
              this.status.stream = 'connected'
              if (message.event === 'hello') heartbeat = Number((message.data as { heartbeatSeconds?: number })?.heartbeatSeconds ?? 30) * 1000
              else {
                this.status.lastEvent = `${message.event} @ ${clock()}`
                realtimeEvents.note()
              }
              this.onRealtime?.(message.event, message.data)
              this.bump()
            }
          } finally {
            clearInterval(watchdog)
          }
        } catch {
          // reconnect below
        }
        if (abort.signal.aborted) return
        this.status.stream = 'reconnecting'
        this.bump()
        await new Promise((r) => setTimeout(r, delay))
        delay = Math.min(30_000, delay * 2)
      }
    }
    void loop()
  }

  /** Realtime events for the presence and extension hooks. */
  onRealtime?: (event: string, data: unknown) => void

  // ---- misc ----

  remember(item: Omit<RecentItem, 'at'>): void {
    if (!this.client) return
    try {
      addRecent(this.client.server, item)
    } catch {
      // not critical
    }
  }

  setTheme(name: string): void {
    this.settings.theme = setTheme(name).name
    this.bump()
  }

  /** Presses a key as if typed (the mouse layer: a click does what its key does). */
  readonly pressKey = (key: Key): void => this.handleKey(key)

  /** Turns mouse tracking on or off in the terminal (set by main: the renderer's useMouse). */
  applyMouse: (on: boolean) => void = () => undefined

  setMouse(on: boolean): void {
    this.settings.mouse = on
    this.applyMouse(on)
    this.bump()
  }

  setAscii(ascii: boolean): void {
    this.settings.ascii = ascii
    setAscii(ascii)
    this.bump()
  }

  resize(width: number, height: number): void {
    this.width = width
    this.height = height
    if (!this.showSidebar && this.focus === 'sidebar') this.focus = 'content'
    this.bump()
  }

  /** The function-key bar for the current context. */
  fkeys(): Array<{ n: number; label: string | null; global: string }> {
    const defaults: Record<number, string> = { 1: 'Help', 2: 'Search', 3: 'View', 4: 'Edit', 5: 'Refresh', 6: 'Filter', 7: 'New', 8: 'Delete', 9: 'Menu', 10: 'Quit' }
    const overrides: FKeyLabels = this.screen?.fkeys?.() ?? { 3: null, 4: null, 6: null, 7: null, 8: null }
    return Object.entries(defaults).map(([n, label]) => {
      const k = Number(n)
      const shown = k in overrides ? overrides[k]! : label
      // F8 prints on screens that have no Delete for it
      return { n: k, label: k === 8 && shown === null ? 'Print' : shown, global: label }
    })
  }

  themeTokens() {
    return theme()
  }

  private checkIdle(): void {
    if (this.lock || !this.client) return
    let minutes = 0
    try {
      minutes = readIdleMinutes()
    } catch {
      minutes = 0
    }
    if (minutes > 0 && Date.now() - this.lastInput > minutes * 60_000) this.commands().lock()
  }
}

/** What the store needs from the sidebar (screens/sidebar.tsx). */
export interface SidebarLike {
  onKey(key: Key): boolean
  render(width: number, height: number, focused: boolean): import('react').ReactNode
}

/** What the store needs from the command layer (commands.ts). */
export interface CommandsLike {
  help(): void
  palette(initial?: string): void
  /** F2: the Search screen. */
  search(initial?: string): void
  menu(): void
  /** The Servers dialog (Ctrl+O). */
  servers(): void
  commandLine(initial?: string): void
  viewSettings(): void
  lock(): void
  run(line: string): Promise<void>
}

let secretStoreFactory: () => import('@qrun-io/qqq-core').SecretStore = () => { throw new Error('no secret store') }
export function setSecretStoreFactory(factory: () => import('@qrun-io/qqq-core').SecretStore): void {
  secretStoreFactory = factory
}
function storeFor() {
  return secretStoreFactory()
}

export function clock(): string {
  return new Date().toLocaleTimeString('en-GB')
}
