/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The command layer: the `:` line (TUI commands, CLI commands that open screens, everything else
 * run in-process through the CLI's runCli), the F9 command center, the palette and the help.
 * Menu entries and `:` commands are the same actions.
 */

import { runCli } from '@qrun-io/qqq-cli/program'
import { THEMES } from './theme'
import { buildFilter, readFilePreferences, startDirForSave, startDirForUpload, writeFilePreferences, hasPin, readConfig, readRecents, removePin, setPin, writeIdleMinutes, writeTheme, readIdleMinutes, type QueryFilter } from '@qrun-io/qqq-core'
import type { AppTreeNode } from './client'
import { openApp, openForm, openProcess, openRecord, openTable } from './nav'
import { ChoiceOverlay, PromptOverlay } from './overlays/basic'
import { CommandLineOverlay, HelpOverlay, LockOverlay, MenuOverlay, PaletteOverlay, type PaletteItem } from './overlays/center'
import { chooseFolder } from './overlays/files-helpers'
import { OutputScreen } from './screens/output'
import { SignInScreen } from './screens/signin'
import type { AppStore, CommandsLike } from './store'
import type { MenuEntry } from './types'
import { errorText, shellSplit } from './util/text'

const NOUNS: Record<string, string[]> = {
  table: ['list', 'describe', 'query', 'count', 'get', 'create', 'update', 'delete', 'export'],
  process: ['list', 'describe', 'run'],
  widget: ['list', 'get'],
  report: ['run'],
  prefs: ['list', 'get', 'set', 'action'],
  job: ['list', 'get', 'cancel', 'retry'],
  config: ['show', 'profile'],
  cache: ['show', 'refresh', 'clear'],
  api: [],
  apps: [], whoami: [], search: [], 'help-search': [],
}

const TUI_COMMANDS = ['quit', 'home', 'back', 'help', 'menu', 'goto', 'view', 'theme', 'ascii', 'linear', 'shortcuts', 'lock', 'pin', 'idle', 'refresh', 'filter', 'export', 'jobs', 'profile', 'server', 'signout', 'connection', 'open', 'record', 'app']

/** Global keys for the help overlay. */
export const GLOBAL_KEYS: Array<[string, string]> = [
  ['F1  ?', 'help (this)'], ['F2  /  .', 'go to anything'], ['F3  Enter', 'view / open'], ['F4  e', 'edit'], ['F5  r', 'refresh'],
  ['F6  f', 'filter (grid)'], ['F7  n', 'new record'], ['F8  d', 'delete (asks)'], ['F9', 'menu: every command'], ['F10', 'quit (asks)'],
  ['Esc', 'back, cancel'], ['Tab', 'Apps tree / content'], ['↑↓ PgUp PgDn', 'move, page'], ['Ctrl+F Ctrl+B', 'page (always works)'], ['Space S+Space', 'page lists'], ['Home End', 'first, last'], ['← →', 'columns, tree'],
  ['s', 'sort by column'], ['Space (grid)', 'select row'], ['b', 'run a process on selection'], ['x', 'export'], ['g', 'go to by key'], ['v', 'view settings'],
  [']  [', 'next / previous record'], ['Ctrl+S', 'save a form'], [':', 'command line'], ['Ctrl+K', 'palette'], ['Ctrl+C', 'quit now'],
]

export class Commands implements CommandsLike {
  constructor(private store: AppStore) {}

  // ---- overlays ----

  help(): void {
    const s = this.store
    const screen = s.screen
    const topic = screen?.helpTopic?.()
    const topicHelp: string[] = []
    if (topic?.kind === 'table') {
      const meta = s.client && (s.client as unknown as { tableCache?: Map<string, unknown> })
      void meta
    }
    const actions = screen?.menu?.() ?? []
    const keys = GLOBAL_KEYS.filter(([k]) => s.singleKeys || !/^[a-z?/.\]]/.test(k.split(/\s+/).pop() ?? ''))
    const overlay = new HelpOverlay(s, keys, actions, topicHelp, async (q) => {
      const data = await s.client!.data<{ results?: Array<{ kind: string; label?: string; name: string; table?: string; key?: string }> }>('searchHelp', { query: { q, limit: '30' } })
      return (data.results ?? []).map((r) => ({
        label: r.label ?? r.name,
        detail: `${r.kind}${r.table ? ` · ${r.table}` : ''}`,
        run: r.kind === 'table' ? () => openTable(s, r.name) : r.table ? () => openTable(s, r.table!) : undefined,
      }))
    })
    s.open(overlay)
    if (topic?.kind === 'table' && s.client) {
      s.client.tableMeta(topic.name).then((m) => {
        for (const h of m.helpContents ?? []) if (h.contentAsText) topicHelp.push(h.contentAsText)
        for (const f of Object.values(m.fields)) for (const h of f.helpContents ?? []) if (h.contentAsText) topicHelp.push(`${f.label}: ${h.contentAsText}`)
        if (!topicHelp.length) topicHelp.push(`${m.label}: no help content on this server. Fields: ${Object.values(m.fields).map((f) => f.label).join(', ')}.`)
        s.bump()
      }).catch(() => undefined)
    }
  }

  palette(): void {
    const s = this.store
    const meta = s.meta
    const items: PaletteItem[] = []
    const walk = (nodes: AppTreeNode[], path: string[]) => {
      for (const n of nodes) {
        const context = path.join(' › ')
        if (n.type === 'TABLE') items.push({ label: n.label, kind: 'table', context, run: () => openTable(s, n.name) })
        else if (n.type === 'PROCESS') items.push({ label: n.label, kind: 'process', context, run: () => openProcess(s, n.name) })
        else if (n.type === 'APP') items.push({ label: n.label, kind: 'app', context, run: () => openApp(s, n.name) })
        else if (n.type === 'REPORT') items.push({ label: n.label, kind: 'report', context, run: () => this.commandLine(`report run ${n.name} --format csv`) })
        if (n.children) walk(n.children, [...path, n.label])
      }
    }
    walk((meta?.appTree ?? []) as AppTreeNode[], [])
    const listed = new Set(items.map((i) => `${i.kind}:${i.label}`))
    for (const t of Object.values(meta?.tables ?? {})) if (!t.isHidden && !listed.has(`table:${t.label}`)) items.push({ label: t.label, kind: 'table', context: t.name, run: () => openTable(s, t.name) })
    try {
      for (const r of s.client ? readRecents(s.client.server) : []) {
        if (r.kind === 'record' && r.table) items.push({ label: r.label, kind: 'recent', context: meta?.tables?.[r.table]?.label ?? r.table, run: () => openRecord(s, r.table!, r.key) })
      }
    } catch {
      // no recents
    }
    for (const e of this.entries()) if (e.run && !e.disabled && e.section !== 'Context' && !e.label.startsWith('Recent:') && !/^(Table|Process|App): /.test(e.label)) items.push({ label: e.label, kind: 'command', context: e.command ? `:${e.command}` : e.section, run: e.run })
    const features = s.version?.features ?? []
    const quick = s.extensions.has('qbit-quick-search') || s.extensions.has('quick-search')
    const search = quick || features.includes('recordSearch') ? async (text: string): Promise<PaletteItem[]> => {
      const data = await s.client!.data<{ results?: Array<{ tableName?: string; table?: string; primaryKey?: unknown; recordLabel?: string; label?: string }>; provider?: { status?: string; message?: string | null } }>('searchRecords', { json: { query: text, searchTerm: text, limit: 20 } })
      if (data.provider?.status === 'NONE') return [{ label: 'No record search on this server (search provider: none)', kind: 'note', context: 'navigation only', run: () => undefined }]
      return (data.results ?? []).map((r) => {
        const table = r.tableName ?? r.table ?? ''
        return { label: r.recordLabel ?? r.label ?? String(r.primaryKey), kind: 'record', context: meta?.tables?.[table]?.label ?? table, run: () => openRecord(s, table, String(r.primaryKey ?? '')) }
      })
    } : undefined
    s.open(new PaletteOverlay(s, items, search, quick ? 'quick-search extension' : search ? 'POST /search' : ''))
  }

  menu(): void {
    this.store.open(new MenuOverlay(this.store, this.entries()))
  }

  commandLine(initial?: string): void {
    const s = this.store
    s.open(new CommandLineOverlay(s, s.history, (line, cursor) => this.completeLine(line, cursor), (line) => void this.run(line), initial ?? this.lastFailed ?? ''))
    this.lastFailed = undefined
  }

  lastFailed?: string

  viewSettings(): void {
    const o = this.store.screen?.viewSettings?.()
    if (o) this.store.open(o)
    else this.store.flash('this screen has no view settings')
  }

  lock(): void {
    this.store.lock = new LockOverlay(this.store)
    this.store.bump()
  }

  // ---- completion for the : line ----

  completeLine(line: string, cursor: number): { from: number; candidates: string[] } {
    const before = line.slice(0, cursor)
    const words = shellSplit(before)
    const endsSpace = /\s$/.test(before) || before === ''
    const current = endsSpace ? '' : words.pop() ?? ''
    const from = cursor - current.length
    const pos = words.length
    const meta = this.store.meta
    const pick = (list: string[]) => ({ from, candidates: [...new Set(list)].filter((c) => c.toLowerCase().startsWith(current.toLowerCase())).sort() })
    if (pos === 0) return pick([...Object.keys(NOUNS), ...TUI_COMMANDS])
    const noun = words[0]!
    if (pos === 1 && NOUNS[noun]?.length) return pick(NOUNS[noun]!)
    if (noun === 'theme' && pos === 1) return pick(Object.keys(THEMES))
    if ((noun === 'table' && pos === 2) || (noun === 'open' && pos === 1) || (noun === 'record' && pos === 1)) return pick(Object.keys(meta?.tables ?? {}))
    if (noun === 'process' && pos === 2) return pick(Object.keys(meta?.processes ?? {}))
    if (noun === 'widget' && pos === 2) return pick(Object.keys(meta?.widgets ?? {}))
    if (noun === 'app' && pos === 1) return pick(Object.keys(meta?.apps ?? {}))
    if (noun === 'export' && pos === 1) return pick(['csv', 'xlsx', 'json', 'tsv'])
    if (noun === 'profile' && pos === 1) return pick(Object.keys(readConfig().profiles))
    if (noun === 'table' && words[1] === 'query') return pick(['-w', '-g', '--or', '-o', '--limit', '--fields', '--print-filter', '--count'])
    return { from, candidates: [] }
  }

  // ---- the : dispatcher ----

  async run(input: string): Promise<void> {
    const s = this.store
    const line = input.trim().replace(/^:/, '').replace(/^qqq\s+/, '')
    const argv = shellSplit(line)
    const [cmd, ...rest] = argv
    if (!cmd) return
    const fail = (text: string) => {
      this.lastFailed = line
      s.flash(text, 'error')
    }
    try {
      switch (cmd) {
        case 'quit': case 'q': case 'exit': return s.requestQuit()
        case 'home': return s.home()
        case 'back': return s.back()
        case 'help': return this.help()
        case 'menu': return this.menu()
        case 'goto': case 'palette': return this.palette()
        case 'view': return this.viewSettings()
        case 'lock': return this.lock()
        case 'refresh': return s.screen?.refresh?.()
        case 'theme': {
          const name = rest[0]
          if (!name || !THEMES[name]) return fail(`themes: ${Object.keys(THEMES).join(', ')}`)
          s.setTheme(name)
          writeTheme(name)
          return s.flash(`theme ${name} (saved)`)
        }
        case 'ascii': s.setAscii(rest[0] !== 'off'); return s.flash(`ASCII glyphs ${s.settings.ascii ? 'on' : 'off'}`)
        case 'linear': s.settings.linear = rest[0] !== 'off'; s.bump(); return s.flash(`linear layout ${s.settings.linear ? 'on' : 'off'}`)
        case 'shortcuts': return this.setShortcuts(rest[0] !== 'off')
        case 'idle': {
          const m = Number(rest[0])
          if (!Number.isFinite(m)) return fail('idle <minutes>: 0 turns the screen saver timeout off')
          writeIdleMinutes(m)
          return s.flash(m ? `screen saver after ${m} idle minutes` : 'idle screen saver off')
        }
        case 'pin': return rest[0] === 'remove' ? this.removePin() : this.setPin()
        case 'filter': {
          const screen = s.screen as { kind?: string; setFilter?: (f: QueryFilter) => void; filterDialog?: () => void; meta?: { fields: Record<string, unknown> } } | undefined
          if (screen?.kind !== 'table') return fail(':filter works on a table grid')
          if (!rest.length) return screen.filterDialog?.()
          if (rest[0] === 'clear') return screen.setFilter?.({ criteria: [], booleanOperator: 'AND' })
          return screen.setFilter?.(buildFilter({ group: [rest.join(' ')], knownFields: Object.keys(screen.meta?.fields ?? {}) }))
        }
        case 'export': {
          const screen = s.screen as { kind?: string; exportAs?: (f: string) => void } | undefined
          if (screen?.kind !== 'table') return fail(':export works on a table grid')
          return screen.exportAs?.(rest[0] ?? 'csv')
        }
        case 'jobs': return this.jobs()
        case 'profile': return rest[0] ? this.switchProfile(rest[0]) : this.chooseProfile()
        case 'server': return rest[0] ? this.switchServer(rest[0]) : fail('server <url>')
        case 'signout': return this.signOut()
        case 'connection': return this.connection()
        case 'open': return rest[0] ? openTable(s, rest[0]) : fail('open <table>')
        case 'app': return rest[0] ? openApp(s, rest[0]) : fail('app <name>')
        case 'record': return rest[0] && rest[1] ? openRecord(s, rest[0], rest[1]) : fail('record <table> <primaryKey>')
        case 'table':
          if (this.tableCommand(rest)) return
          break
        case 'process':
          if (rest[0] === 'run' && rest[1] && !rest.includes('--help')) {
            const opts = parseOptions(rest.slice(2))
            const values = Object.fromEntries((opts.v ?? []).map((p) => [p.split('=')[0]!, p.slice(p.indexOf('=') + 1)]))
            return openProcess(s, rest[1], { recordIds: opts.r?.[0]?.split(',').map((x) => x.trim()), values })
          }
          break
        case 'login': case 'logout': case 'ui':
          return fail(`${cmd} is not available inside the TUI; use the menu (Connection) instead`)
        default:
          break
      }
      await this.runCli(line, argv)
    } catch (e) {
      fail(errorText(e))
    }
  }

  /** `table query/get/create/update/delete` open screens; returns false for the rest (run by the CLI). */
  tableCommand(rest: string[]): boolean {
    const s = this.store
    const [verb, table, ...args] = rest
    if (!verb || !table || args.includes('--help') || args.includes('-h')) return false
    const opts = parseOptions(args)
    switch (verb) {
      case 'query': {
        if (opts['print-filter'] || opts.count || opts.output || opts.O || opts.json) return false
        const fields = Object.keys((s.meta?.tables?.[table] ? {} : {}))
        void fields
        const filter = buildFilter({ where: opts.w ?? opts.where, group: opts.g ?? opts.group, or: Boolean(opts.or), order: opts.o ?? opts.order })
        openTable(s, table, filter)
        return true
      }
      case 'get':
        if (!args[0]) return false
        openRecord(s, table, args[0])
        return true
      case 'create': {
        const initial = Object.fromEntries((opts.s ?? opts.set ?? []).map((p) => [p.split('=')[0]!, p.slice(p.indexOf('=') + 1)]))
        openForm(s, table, { mode: 'create', initial })
        return true
      }
      case 'update':
        if (!args[0]) return false
        openForm(s, table, { mode: 'edit', primaryKey: args[0] })
        return true
      case 'delete':
        if (!args[0]) return false
        s.confirm(`Delete ${s.meta?.tables?.[table]?.label ?? table} ${args[0]}?`, () => s.run(s.client!.remove(table, args[0]), () => s.flash(`deleted ${table} ${args[0]}`)))
        return true
      default:
        return false
    }
  }

  /** Runs a CLI command in-process and shows its output in a pane. */
  async runCli(line: string, argv: string[]): Promise<void> {
    const s = this.store
    const screen = new OutputScreen(s, line)
    s.push(screen)
    const globals = s.target ? ['--profile', s.target.name] : []
    const code = await runCli([...globals, ...argv], { stdout: (t) => screen.append(t), stderr: (t) => screen.append(t, true), isTTY: true })
    screen.done(code)
    if (code !== 0) this.lastFailed = line
  }

  // ---- settings and connection ----

  setShortcuts(on: boolean): void {
    const s = this.store
    s.settings.singleKeys = on
    s.bump()
    s.flash(`single-key shortcuts ${on ? 'on' : 'off'}`)
    if ((s.version?.features ?? []).includes('preferences')) {
      s.client?.call('updatePreferenceSection', { path: { sectionName: 'keyboard' }, json: { values: { singleKeyShortcuts: on } } }).catch(() => undefined)
    }
  }

  setPin(): void {
    const s = this.store
    const ask = () => s.open(new PromptOverlay(s, 'Set a screen-lock PIN', 'At least 4 characters. Only a salted hash is kept in ~/.config/qqq/config.json.', (pin) => {
      s.open(new PromptOverlay(s, 'Repeat the PIN', '', (again) => {
        if (pin !== again) return s.flash('the PINs differ; not set', 'error')
        try {
          setPin(pin)
          s.flash('PIN set; the screen lock asks for it')
        } catch (e) {
          s.flash(errorText(e), 'error')
        }
      }, '', { masked: true }))
    }, '', { masked: true }))
    if (hasPin()) s.confirm('A PIN is set. Replace it?', () => s.open(new PromptOverlay(s, 'Current PIN', '', (cur) => (removePin(cur) ? ask() : s.flash('wrong PIN', 'error')), '', { masked: true })))
    else ask()
  }

  removePin(): void {
    const s = this.store
    if (!hasPin()) return s.flash('no PIN is set')
    s.open(new PromptOverlay(s, 'Remove the PIN: current PIN', '', (cur) => s.flash(removePin(cur) ? 'PIN removed' : 'wrong PIN', removePin.length ? 'info' : 'info'), '', { masked: true }))
  }

  jobs(): void {
    const s = this.store
    if (!(s.version?.features ?? []).includes('durableJobs')) return s.message('This server lists no jobs operations (no durableJobs feature).', 'info', 'Jobs')
    s.run(s.client!.data<{ jobs?: Array<{ jobId?: string; id?: string; label?: string; state?: string; processName?: string }> }>('listJobs', { query: { scope: 'mine' } }), (data) => {
      const jobs = data.jobs ?? []
      if (!jobs.length) return s.message('No jobs.', 'info', 'Jobs')
      s.open(new ChoiceOverlay(s, 'Jobs', jobs.map((j) => ({ label: `${j.label ?? j.processName ?? j.jobId ?? j.id}`, value: String(j.jobId ?? j.id), detail: j.state })), (id) => this.run(`job get ${id}`)))
    })
  }

  chooseProfile(): void {
    const s = this.store
    const config = readConfig()
    s.open(new ChoiceOverlay(s, 'Switch profile', Object.entries(config.profiles).map(([n, p]) => ({ label: n, value: n, detail: p.server + (n === s.target?.name ? '  (current)' : '') })), (n) => this.switchProfile(n)))
  }

  switchProfile(name: string): void {
    const s = this.store
    const p = readConfig().profiles[name]
    if (!p) return s.flash(`no profile ${name}`, 'error')
    this.reconnect({ name, server: p.server })
  }

  switchServer(url: string): void {
    try {
      const origin = new URL(url).origin
      const existing = Object.entries(readConfig().profiles).find(([, p]) => p.server === origin)
      this.reconnect({ name: existing?.[0] ?? new URL(origin).host.replace(/[^A-Za-z0-9.-]+/g, '-'), server: origin })
    } catch {
      this.store.flash(`not a URL: ${url}`, 'error')
    }
  }

  reconnect(target: { name: string; server: string }): void {
    const s = this.store
    const deps = s.signInDeps
    if (!deps) return s.flash('cannot switch here', 'error')
    s.dispose()
    s.client = undefined
    s.meta = undefined
    s.sidebar = undefined
    while (s.routes.length) s.routes.pop()
    const screen = new SignInScreen(s, deps, target)
    s.push(screen)
    screen.choose(target)
  }

  signOut(): void {
    const s = this.store
    s.confirm(`Sign out of ${s.target?.server}?`, () => {
      const deps = s.signInDeps
      const target = s.target
      if (!deps || !target) return
      s.client?.call('logout').catch(() => undefined)
      import('@qrun-io/qqq-core').then(({ deleteLogin }) => deleteLogin(deps.secrets(), target)).finally(() => {
        s.dispose()
        s.client = undefined
        s.meta = undefined
        s.sidebar = undefined
        while (s.routes.length) s.routes.pop()
        s.push(new SignInScreen(s, deps, target, 'signed out'))
      })
    })
  }

  connectionText(): string {
    const s = this.store
    const v = s.version
    const age = s.client?.metaDataFetchedAt ? `${Math.round((Date.now() - s.client.metaDataFetchedAt) / 1000)} s ago` : 'unknown'
    return [
      `server       ${s.status.server}`,
      `profile      ${s.status.profile}`,
      `user         ${s.status.user || '(unknown)'} (${s.status.auth})`,
      `UI API       ${v?.apiVersion ?? '?'}`,
      `features     ${(v?.features ?? []).join(', ')}`,
      `extensions   ${s.extensions.all().map((e) => `${e.name} ${e.version}`).join(', ') || 'none'}`,
      `ping         ${s.status.pingMs === null ? '--' : `${s.status.pingMs.toFixed(0)} ms`}`,
      `stream       ${s.status.stream} · last event: ${s.status.lastEvent}`,
      `metadata     generation ${String(s.meta?.metaDataGeneration ?? '?')} · fetched ${age}`,
      `client       qqq ui ${s.status.build}`,
    ].join('\n')
  }

  connection(): void {
    this.store.message(this.connectionText(), 'info', 'Connection')
  }

  /** Every command-center entry for the current context. */
  entries(): MenuEntry[] {
    const s = this.store
    const meta = s.meta
    const out: MenuEntry[] = [...(s.screen?.menu?.() ?? [])]
    out.push({ section: 'Context', label: 'Back', key: 'Esc', command: 'back', run: () => s.back() })
    // Go to
    out.push({ section: 'Go to', label: 'Home', command: 'home', run: () => s.home() })
    out.push({ section: 'Go to', label: 'Go to anything…', key: 'F2 / .', command: 'goto', run: () => this.palette() })
    for (const n of (meta?.appTree ?? []) as AppTreeNode[]) if (n.type === 'APP') out.push({ section: 'Go to', label: `App: ${n.label}`, command: `app ${n.name}`, run: () => openApp(s, n.name) })
    for (const t of Object.values(meta?.tables ?? {}).filter((x) => !x.isHidden).sort((a, b) => a.label.localeCompare(b.label))) out.push({ section: 'Go to', label: `Table: ${t.label}`, command: `table query ${t.name}`, run: () => openTable(s, t.name) })
    for (const p of Object.values(meta?.processes ?? {}).filter((x) => !x.isHidden).sort((a, b) => a.label.localeCompare(b.label))) out.push({ section: 'Go to', label: `Process: ${p.label}`, command: `process run ${p.name}`, run: () => openProcess(s, p.name) })
    for (const r of Object.values((meta?.reports ?? {}) as Record<string, { name: string; label: string }>)) out.push({ section: 'Go to', label: `Report: ${r.label}`, command: `report run ${r.name}`, run: () => this.commandLine(`report run ${r.name} --format csv`) })
    for (const a of Object.values((meta?.apps ?? {}) as Record<string, { name: string; label: string; widgets?: string[] }>)) if (a.widgets?.length) out.push({ section: 'Go to', label: `Dashboard: ${a.label}`, detail: `${a.widgets.length} widgets`, run: () => openApp(s, a.name) })
    try {
      for (const r of s.client ? readRecents(s.client.server).slice(0, 10) : []) if (r.kind === 'record' && r.table) out.push({ section: 'Go to', label: `Recent: ${meta?.tables?.[r.table]?.label ?? r.table} › ${r.label}`, run: () => openRecord(s, r.table!, r.key) })
    } catch {
      // none
    }
    out.push({ section: 'Go to', label: 'Favorites', disabled: s.extensions.has('collaboration') ? undefined : 'needs the collaboration extension' })
    // Work
    out.push({ section: 'Work', label: 'Jobs', detail: `active ${s.status.jobs}`, command: 'jobs', disabled: (s.version?.features ?? []).includes('durableJobs') ? undefined : 'n/a: the server lists no jobs', run: () => this.jobs() })
    out.push({ section: 'Work', label: 'Notifications', disabled: s.extensions.has('alerts') ? undefined : 'needs the alerts extension' })
    out.push({ section: 'Work', label: 'My work', disabled: s.extensions.has('collaboration') ? undefined : 'needs the collaboration extension' })
    for (const e of s.extensions.all()) out.push({ section: 'Work', label: `Extension: ${e.name} ${e.version}`, detail: e.description, command: `api --list`, run: () => s.message(`${e.name} ${e.version}\n${e.description ?? ''}\nPath: ${e.pathPrefix ?? ''}\nIts panels are not drawn by this TUI yet; its operations are reachable with :api.`, 'info', 'Extension') })
    // Connection
    out.push({ section: 'Connection', label: `Server ${s.status.server}`, detail: `UI API ${s.status.apiVersion}`, command: 'connection', run: () => this.connection() })
    out.push({ section: 'Connection', label: `Profile ${s.status.profile}`, detail: s.status.user, run: () => this.connection() })
    out.push({ section: 'Connection', label: `Stream ${s.status.stream}`, detail: `ping ${s.status.pingMs === null ? '--' : s.status.pingMs.toFixed(0) + ' ms'}`, run: () => this.connection() })
    out.push({ section: 'Connection', label: 'Switch profile…', command: 'profile', run: () => this.chooseProfile() })
    out.push({ section: 'Connection', label: 'Connect to another server…', command: 'server <url>', run: () => s.open(new PromptOverlay(s, 'Connect to a server', 'The server URL.', (u) => this.switchServer(u.trim()), 'http://localhost:8077')) })
    out.push({ section: 'Connection', label: 'Refresh metadata', run: () => s.run(s.client!.metaData(true), (m) => { s.meta = m; s.client!.clearCaches(); s.flash('metadata refreshed') }) })
    out.push({ section: 'Connection', label: 'Copy connection details', run: () => s.message(this.connectionText(), 'info', 'Connection (select with the mouse to copy)') })
    out.push({ section: 'Connection', label: 'Sign out', command: 'signout', run: () => this.signOut() })
    // Settings
    for (const t of Object.values(THEMES)) out.push({ section: 'Settings', label: `Theme: ${t.label}`, detail: t.name === s.settings.theme ? 'current' : undefined, command: `theme ${t.name}`, run: () => { s.setTheme(t.name); writeTheme(t.name) } })
    out.push({ section: 'Settings', label: 'View settings for this screen', key: 'v', command: 'view', run: () => this.viewSettings() })
    out.push({ section: 'Settings', label: `Single-key shortcuts: ${s.settings.singleKeys ? 'on' : 'off'}`, command: `shortcuts ${s.settings.singleKeys ? 'off' : 'on'}`, run: () => this.setShortcuts(!s.settings.singleKeys) })
    out.push({ section: 'Settings', label: `Linear layout: ${s.settings.linear ? 'on' : 'off'}`, command: `linear ${s.settings.linear ? 'off' : 'on'}`, run: () => { s.settings.linear = !s.settings.linear; s.bump() } })
    out.push({ section: 'Settings', label: `ASCII glyphs: ${s.settings.ascii ? 'on' : 'off'}`, command: `ascii ${s.settings.ascii ? 'off' : 'on'}`, run: () => s.setAscii(!s.settings.ascii) })
    out.push({ section: 'Settings', label: 'Screen saver / lock', command: 'lock', run: () => this.lock() })
    let idle = 0
    try { idle = readIdleMinutes() } catch { idle = 0 }
    out.push({ section: 'Settings', label: `Idle timeout: ${idle ? `${idle} min` : 'off'}`, command: 'idle <minutes>', run: () => s.open(new PromptOverlay(s, 'Screen saver after idle minutes', '0 turns it off.', (v) => void this.run(`idle ${v}`), String(idle))) })
    out.push({ section: 'Settings', label: hasPin() ? 'Change PIN' : 'Set PIN', command: 'pin', run: () => this.setPin() })
    if (hasPin()) out.push({ section: 'Settings', label: 'Remove PIN', command: 'pin remove', run: () => this.removePin() })
    const fp = readFilePreferences()
    out.push({ section: 'Settings', label: `Download folder: ${fp.downloadDir ?? '(last used, else ~/Downloads)'}`, run: () => chooseFolder(s, 'Default download folder', startDirForSave(fp), (dir) => { writeFilePreferences({ downloadDir: dir }); s.flash(`downloads go to ${dir}`) }) })
    out.push({ section: 'Settings', label: `Downloads: ${fp.downloadMode === 'silent' ? 'save silently to the download folder' : 'ask every time'}`, run: () => { writeFilePreferences({ downloadMode: fp.downloadMode === 'silent' ? 'ask' : 'silent' }); s.flash('download mode changed') } })
    out.push({ section: 'Settings', label: `Upload folder: ${fp.uploadDir ?? '(last used, else the current folder)'}`, run: () => chooseFolder(s, 'Default upload folder', startDirForUpload(fp), (dir) => { writeFilePreferences({ uploadDir: dir }); s.flash(`uploads start in ${dir}`) }) })
    out.push({ section: 'Settings', label: 'Server preferences…', disabled: (s.version?.features ?? []).includes('preferences') ? undefined : 'the server has no preferences', run: () => this.prefs() })
    // Help
    out.push({ section: 'Help', label: 'Keyboard reference and help', key: 'F1 ?', command: 'help', run: () => this.help() })
    out.push({ section: 'Help', label: 'Search help…', run: () => this.help() })
    out.push({ section: 'Help', label: 'About', run: () => s.message(`qqq ui ${s.status.build}\nOpenTUI 0.8.1 (React) on Bun ${typeof Bun !== 'undefined' ? Bun.version : '?'}\nUI API ${s.status.apiVersion} at ${s.status.server}`, 'info', 'About') })
    out.push({ section: 'Help', label: 'Quit', key: 'F10', command: 'quit', run: () => s.requestQuit() })
    return out
  }

  prefs(): void {
    const s = this.store
    s.run(s.client!.data<{ sections?: Array<{ name: string; label: string; description?: string }> }>('listPreferenceSections'), (data) => {
      s.open(new ChoiceOverlay(s, 'Preferences', (data.sections ?? []).map((x) => ({ label: x.label, value: x.name, detail: x.description })), (name) => void this.run(`prefs get ${name}`)))
    })
  }
}

/** Parses `-w a -w b --or -o x` style options into lists (flags become ['true']). */
export function parseOptions(args: string[]): Record<string, string[] | undefined> {
  const out: Record<string, string[]> = {}
  const flags = new Set(['or', 'print-filter', 'count', 'all', 'json', 'yes', 'y'])
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const m = /^--?([A-Za-z][\w-]*)(?:=(.*))?$/.exec(a)
    if (!m) continue
    const name = m[1]!
    if (m[2] !== undefined) (out[name] ??= []).push(m[2])
    else if (flags.has(name) || i + 1 >= args.length || /^-/.test(args[i + 1]!)) (out[name] ??= []).push('true')
    else {
      // multi-value options (-w a b) take every following non-option argument
      const values: string[] = []
      while (i + 1 < args.length && !/^-[A-Za-z-]/.test(args[i + 1]!)) values.push(args[++i]!)
      ;(out[name] ??= []).push(...values)
    }
  }
  return out
}

export function installCommands(store: AppStore): void {
  const commands = new Commands(store)
  store.commandsImpl = () => commands
}
