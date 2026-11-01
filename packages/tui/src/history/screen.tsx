/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The History screen (`:history`, F9 → Work → History): everything done on this profile with the
 * CLI and the TUI (the activity log), newest at the bottom with the cursor there, as `qqq history`
 * lists it. Typing filters; Enter does the entry again (a `:` command, or opens the record, the
 * table with its filter, the process); `y` copies the CLI equivalent; `c` or F8 clears (asks).
 */

import { REDACTED, absoluteTime, clearActivity, isMutatingCommand, readActivity, relativeTime, splitCommandLine, type ActivityEntry } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { openApp, openProcess, openRecord } from '../nav'
import { ListModel, Panel, type Row } from '../screens/list'
import type { AppStore } from '../store'
import { theme } from '../theme'
import type { FKeyLabels, MenuEntry, Screen } from '../types'
import { hintLine, pad, padLeft, trunc } from '../util/text'

/** One entry as a list line: number, time, client, (kind on wide screens), summary; cut to the width. */
export function historyLine(e: ActivityEntry, width: number, options: { absolute?: boolean; now?: Date; numberWidth?: number } = {}): string {
  const nw = options.numberWidth ?? String(e.n).length
  const time = options.absolute ? absoluteTime(e.at) : relativeTime(e.at, options.now)
  const tw = options.absolute ? 19 : 8
  const wide = width >= 100
  const head = ` ${padLeft(String(e.n), nw)}  ${pad(time, tw)}  ${pad(e.client, 3)}  ${wide ? `${pad(e.kind, 7)}  ` : ''}`
  const summary = e.summary + (e.exit ? `  [exit ${e.exit}]` : '')
  return pad(trunc(head + summary, width), width)
}

/** Whether an entry matches the typed filter (summary, command, kind or client; any case). */
export function matchesFilter(e: ActivityEntry, text: string): boolean {
  const needle = text.trim().toLowerCase()
  if (!needle) return true
  const hay = `${e.summary}\n${e.command ?? ''}\n${e.kind}\n${e.client}`.toLowerCase()
  return needle.split(/\s+/).every((w) => hay.includes(w))
}

export class HistoryScreen implements Screen {
  readonly kind = 'history'
  readonly id = `history:${Date.now()}`
  readonly list = new ListModel()
  entries: ActivityEntry[] = []
  filter = ''
  /** `/` typed: the next keys are filter text even when they are y or c. */
  typing = false
  absolute = false
  error?: string

  constructor(private store: AppStore) {
    this.load()
  }

  title(): string {
    return 'History'
  }

  private profile(): string {
    return this.store.target?.name ?? this.store.status.profile
  }

  /** Reads the log again (on open, F5, and when the screen is on top again). */
  load(): void {
    try {
      this.entries = readActivity({ profile: this.profile() })
      this.error = undefined
    } catch (e) {
      this.entries = []
      this.error = e instanceof Error ? e.message : String(e)
    }
    this.rebuild(true)
  }

  /** The matching entries as rows; `bottom` puts the cursor on the newest. */
  private rebuild(bottom = false): void {
    const t = theme()
    const shown = this.entries.filter((e) => matchesFilter(e, this.filter))
    const rows: Row[] = shown.map((e) => ({ text: '', key: `h:${e.n}`, action: () => this.activate(e), entry: e } as Row & { entry: ActivityEntry }))
    if (!rows.length) rows.push({ text: this.error ? this.error : this.filter ? `(nothing matches "${this.filter}")` : '(no history yet: what you do in the CLI and here is listed)', fg: this.error ? t.err : t.dim })
    this.list.setRows(rows)
    if (bottom || !this.list.current?.action) this.list.cursor = Math.max(0, rows.length - 1)
  }

  private get current(): ActivityEntry | undefined {
    return (this.list.current as (Row & { entry?: ActivityEntry }) | undefined)?.entry
  }

  refresh(): void {
    this.load()
    this.store.flash(`${this.entries.length} history entr${this.entries.length === 1 ? 'y' : 'ies'}`)
  }

  resume(): void {
    this.load()
  }

  capturesText(): boolean {
    return this.typing || this.filter.length > 0
  }

  fkeys(): FKeyLabels {
    return { 3: null, 4: null, 6: null, 7: null, 8: 'Clear' }
  }

  helpKeys(): Array<[string, string]> {
    return [['type', 'filter the history'], ['Enter', 'do it again: run the command, open the record, table or process'], ['y', 'copy the CLI equivalent'], ['c / F8', 'clear the history (asks)'], ['/', 'filter text starting with y or c'], ['t', 'relative or absolute times'], ['Esc', 'clear the filter, then back']]
  }

  menu(): MenuEntry[] {
    const e = this.current
    return [
      ...(e?.command ? [{ section: 'Context' as const, label: 'Do it again', key: 'Enter', detail: e.command, run: () => this.activate(e) }, { section: 'Context' as const, label: 'Copy the CLI equivalent', key: 'y', run: () => this.copy(e) }] : []),
      { section: 'Context', label: 'Clear the history…', key: 'c', run: () => this.clear() },
      { section: 'Context', label: this.absolute ? 'Relative times' : 'Absolute times', key: 't', run: () => { this.absolute = !this.absolute; this.store.bump() } },
    ]
  }

  cliEquivalent(): string {
    return 'history'
  }

  /** Does the entry again. */
  activate(e: ActivityEntry): void {
    const s = this.store
    const target = e.target
    if (target?.type === 'record' && target.key !== undefined) return openRecord(s, target.name, target.key)
    if (target?.type === 'app') return openApp(s, target.name)
    if (target?.type === 'process' && e.kind === 'open') return openProcess(s, target.name)
    const command = e.command
    if (!command) return s.flash('this entry has nothing to do again')
    if (command.includes(REDACTED)) return s.flash('this command had a secret that was not logged; type it again', 'error')
    const line = command.replace(/^(qqq\s+|:)/, '')
    const run = () => void s.commands().run(line)
    if (command.startsWith('qqq ') && isMutatingCommand(splitCommandLine(line))) return s.confirm(`Run again: ${command}? It changes data.`, run)
    run()
  }

  copy(e: ActivityEntry | undefined): void {
    if (!e?.command) return this.store.flash('this entry has no command')
    const how = this.store.copyText(e.command)
    if (how) this.store.flash(`copied (${how}): ${e.command}`)
    else this.store.showCli(e.command)
  }

  clear(): void {
    const s = this.store
    const n = this.entries.length
    if (!n) return s.flash('the history is empty')
    s.confirm(`Clear ${n} history entr${n === 1 ? 'y' : 'ies'} of profile ${this.profile()}?`, () => {
      try {
        clearActivity({ profile: this.profile() })
        s.flash(`cleared ${n} entr${n === 1 ? 'y' : 'ies'}`)
      } catch (err) {
        s.flash(err instanceof Error ? err.message : String(err), 'error')
      }
      this.load()
    })
  }

  private setFilter(text: string): void {
    this.filter = text
    if (!text) this.typing = false
    this.rebuild(true)
  }

  onKey(key: Key): boolean {
    if (key.name === 'escape' && (this.filter || this.typing)) {
      this.setFilter('')
      return true
    }
    if (key.name === 'backspace') {
      if (this.filter) this.setFilter(this.filter.slice(0, -1))
      else this.typing = false
      return true
    }
    if (key.name === 'f8') {
      this.clear()
      return true
    }
    if (key.ctrl && key.name === 'y') {
      this.copy(this.current)
      return true
    }
    if (key.ctrl && key.name === 'u') {
      this.setFilter('')
      return true
    }
    if (key.name === 'space' && !this.filter && !this.typing) return this.list.onKey(key)
    if (this.list.onKey(key)) return true
    const ch = charOf(key) || (key.name === 'space' ? ' ' : '')
    if (!ch) return false
    if (!this.filter && !this.typing) {
      // an empty filter: single keys act (`:` and `?` stay global)
      if (ch === ':' || ch === '?') return false
      if (ch === 'y') { this.copy(this.current); return true }
      if (ch === 'c') { this.clear(); return true }
      if (ch === 't') { this.absolute = !this.absolute; return true }
      if (ch === '/') { this.typing = true; return true }
    }
    this.setFilter(this.filter + ch)
    return true
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    const inner = Math.max(1, width - 2)
    const shown = this.list.rows.filter((r) => r.action).length
    const nw = String(this.entries[this.entries.length - 1]?.n ?? 1).length
    const now = new Date()
    for (const r of this.list.rows as Array<Row & { entry?: ActivityEntry }>) if (r.entry) r.text = historyLine(r.entry, inner, { absolute: this.absolute, now, numberWidth: nw })
    const filterLine = this.filter || this.typing
      ? ` filter: ${this.filter}_  (${shown} of ${this.entries.length})`
      : ` ${this.entries.length} entr${this.entries.length === 1 ? 'y' : 'ies'} · profile ${this.profile()} · type to filter`
    const current = this.current
    const hint = this.filter || this.typing
      ? 'Enter does it again · ↑↓ choose · Ctrl+Y copies · Backspace · Esc clears the filter'
      : 'Enter does it again · y copies · c clears · t times · / filter · Esc back'
    const detail = current ? ` ${current.command ?? '(nothing to do again)'}${current.profile && current.server ? `   ${current.server.replace(/^https?:\/\//, '')}` : ''}${current.ms !== undefined ? ` · ${current.ms} ms` : ''}` : ''
    return (
      <Panel title={`History · ${this.profile()}`} width={width} height={height} focused={focused}>
        <text flexShrink={0} wrapMode="none" fg={this.filter || this.typing ? t.acc2 : t.dim}>{pad(trunc(filterLine, inner), inner)}</text>
        {this.list.view(inner, Math.max(1, height - 5), focused)}
        <text flexShrink={0} wrapMode="none" fg={t.acc}>{pad(trunc(detail, inner), inner)}</text>
        <text flexShrink={0} wrapMode="none" fg={t.dim}>{hintLine(hint, inner)}</text>
      </Panel>
    )
  }
}

/** Opens the History screen (or comes back to it when it is on top). */
export function openHistory(store: AppStore): void {
  if (store.screen?.kind === 'history') return (store.screen as HistoryScreen).load()
  store.push(new HistoryScreen(store))
}
