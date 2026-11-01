/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The F9 command center, the / search, the F1 keyboard reference, the `:` command line and the screen lock. */

import { hasPin, pinDelayMillis, verifyPin, type History } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { LineEditor } from '../line-editor'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { MenuEntry, Overlay } from '../types'
import { center, errorText, pad, trunc } from '../util/text'
import { EditorLine, overlayId, wrap } from './basic'
import { HELP_POINTER, type KeyGroup } from '../help-keys'
import { paletteGroups, paletteRows, type PaletteGroup, type PaletteItem, type RecordState } from '../palette'
import { Frame, Line } from './frame'

const SECTIONS: MenuEntry['section'][] = ['Context', 'Go to', 'Work', 'Connection', 'Settings', 'Help']

function matches(e: MenuEntry, needle: string): boolean {
  return !needle || `${e.section} ${e.label} ${e.detail ?? ''} ${e.command ?? ''} ${e.key ?? ''}`.toLowerCase().includes(needle)
}

/** The F9 command center: every action by section, searchable, shortcuts beside entries. It is a
 * stack: an entry that opens a dialog leaves the menu underneath, and closing that dialog comes back
 * here at the same entry with its state refreshed; entries that navigate close it. */
export class MenuOverlay implements Overlay {
  readonly id = overlayId('menu')
  readonly closesOnNavigate = true
  readonly filter = new LineEditor('')
  index = 0
  private selectedId?: string
  private cache?: { text: string; list: MenuEntry[] }

  constructor(private store: AppStore, private build: (filterText: string) => MenuEntry[], readonly summary = '') {
    const section = SECTIONS[store.lastMenuSection] ?? 'Context'
    const first = this.visible().findIndex((e) => e.section === section)
    this.index = Math.max(0, first)
  }

  static idOf(e: MenuEntry): string {
    return e.id ?? `${e.section}:${e.label}`
  }

  /** The entries for the current search text, rebuilt on each repaint so states (theme, profile) are fresh. */
  visible(fresh = false): MenuEntry[] {
    if (!fresh && this.cache && this.cache.text === this.filter.value) return this.cache.list
    const needle = this.filter.value.toLowerCase()
    const list = this.build(this.filter.value).filter((e) => matches(e, needle) || (needle && e.section === 'Go to' && e.id?.startsWith('index:')))
    const ordered = SECTIONS.flatMap((s) => list.filter((e) => e.section === s))
    this.cache = { text: this.filter.value, list: ordered }
    if (this.selectedId) {
      const at = ordered.findIndex((e) => MenuOverlay.idOf(e) === this.selectedId)
      if (at >= 0) this.index = at
    }
    return ordered
  }

  onKey(key: Key): void {
    const list = this.visible()
    if (key.name === 'escape' || key.name === 'f9') return this.store.closeOverlay(this)
    if (key.name === 'down') this.index = Math.min(list.length - 1, this.index + 1)
    else if (key.name === 'up') this.index = Math.max(0, this.index - 1)
    else if (key.name === 'pagedown') this.index = Math.min(list.length - 1, this.index + 10)
    else if (key.name === 'pageup') this.index = Math.max(0, this.index - 10)
    else if (key.name === 'right' || key.name === 'tab' || key.name === 'left') {
      const cur = list[this.index]?.section
      const si = SECTIONS.indexOf(cur ?? 'Context')
      const dir = key.name === 'left' || key.shift ? -1 : 1
      for (let k = 1; k <= SECTIONS.length; k++) {
        const s = SECTIONS[(si + dir * k + SECTIONS.length * 2) % SECTIONS.length]
        const at = list.findIndex((e) => e.section === s)
        if (at >= 0) {
          this.index = at
          break
        }
      }
    } else if (key.name === 'return') {
      const e = list[this.index]
      if (!e) return
      if (e.disabled) return this.store.flash(`${e.label}: ${e.disabled}`)
      if (!e.run) return
      this.store.lastMenuSection = SECTIONS.indexOf(e.section)
      this.selectedId = MenuOverlay.idOf(e)
      const before = this.store.screen
      const depth = this.store.routes.length
      e.run()
      // navigation closes the menu (the store does it on push and back); otherwise it stays, refreshed
      if (this.store.screen !== before || this.store.routes.length !== depth) this.store.closeOverlay(this)
      this.cache = undefined
    } else if (this.filter.handle(key)) {
      this.index = 0
      this.selectedId = undefined
    }
    const now = this.visible()
    if (now[this.index]) this.selectedId = MenuOverlay.idOf(now[this.index]!)
  }

  render(sw: number, sh: number) {
    const t = theme()
    this.cache = undefined
    const width = Math.min(sw - 2, 180)
    const height = Math.min(sh - 2, 40)
    const inner = width - 2
    const list = this.visible()
    if (this.index >= list.length) this.index = Math.max(0, list.length - 1)
    const columns = this.filter.value ? 1 : width >= 160 ? 3 : width >= 110 ? 2 : 1
    const colWidth = Math.floor(inner / columns)
    const rows = height - 6
    const lines: Array<{ text: string; fg: string; bg?: string }[]> = Array.from({ length: columns }, () => [])
    type Item = { kind: 'h'; text: string } | { kind: 'e'; e: MenuEntry; i: number }
    const items: Item[] = []
    let last: string | undefined
    list.forEach((e, i) => {
      if (e.section !== last) {
        items.push({ kind: 'h', text: e.section })
        last = e.section
      }
      items.push({ kind: 'e', e, i })
    })
    // items flow down columns of `rows`; a window of `columns` columns follows the selection
    const selItem = Math.max(0, items.findIndex((it) => it.kind === 'e' && it.i === this.index))
    const selCol = Math.floor(selItem / rows)
    const firstCol = Math.max(0, selCol - columns + 1)
    items.forEach((it, k) => {
      const col = Math.floor(k / rows) - firstCol
      if (col < 0 || col >= columns) return
      if (it.kind === 'h') lines[col]!.push({ text: ` ${it.text}`, fg: t.acc })
      else {
        const sel = it.i === this.index
        const keyText = it.e.key ? ` ${it.e.key} ` : ''
        const detail = it.e.disabled ? ` (${it.e.disabled})` : it.e.detail ? ` ${it.e.detail}` : ''
        const room = colWidth - 3 - keyText.length
        const text = `   ${trunc(it.e.label + detail, room)}`
        lines[col]!.push({ text: pad(text, colWidth - keyText.length) + keyText, fg: sel ? t.selFg : it.e.disabled ? t.dim : t.fg, bg: sel ? t.selBg : undefined })
      }
    })
    const out: React.ReactNode[] = []
    for (let r = 0; r < rows; r++) {
      out.push(
        <text flexShrink={0} wrapMode="none" key={r}>
          {lines.map((col, c) => {
            const cellLine = col[r]
            return <span key={c} fg={cellLine?.fg ?? t.fg} bg={cellLine?.bg}>{pad(cellLine?.text ?? '', colWidth)}</span>
          })}
        </text>,
      )
    }
    return (
      <Frame title="Menu  (F9)" width={width} height={height} screenWidth={sw} screenHeight={sh} top={1}>
        <box paddingLeft={1}><EditorLine editor={this.filter} width={inner - 2} placeholder={`type to search every command${this.summary ? ` and ${this.summary}` : ''}`} /></box>
        <Line text="" width={inner} />
        {out}
        <Line text={` ${list.length} entries${this.summary && !this.filter.value ? ` · ${this.summary} · type to search` : ''} · ↑↓ ←→ Tab · Enter runs · Esc or F9 closes`} width={inner} fg={t.dim} />
      </Frame>
    )
  }
}

export type { PaletteItem } from '../palette'

export interface PaletteOptions {
  recents: PaletteItem[]
  commands: PaletteItem[]
  /** The metadata index (ranked), a page at a time. */
  searchIndex: (text: string, limit: number) => { items: PaletteItem[]; total: number }
  /** Record search (quick search, else the server's search); absent when the server has none. */
  searchRecords?: (text: string) => Promise<{ items: PaletteItem[]; none?: boolean }>
  /** The application's help search. */
  searchHelp?: (text: string) => Promise<PaletteItem[]>
  /** The quick search extension is installed. */
  quick: boolean
  summary?: string
  initial?: string
}

/**
 * The search (`/`, F2, `.`, Ctrl+K): one place for apps, tables, processes, widgets, reports,
 * records (quick search) and commands, grouped under headers with the best match first. With no
 * text it shows recents and commands. Records and help are searched by the server as you type
 * (debounced); Enter opens or runs the selected entry.
 */
export class PaletteOverlay implements Overlay {
  readonly id = overlayId('palette')
  readonly input: LineEditor
  /** Position among the selectable entries. */
  index = 0
  records: RecordState
  help: PaletteItem[] = []
  pages = 1
  private timer?: ReturnType<typeof setTimeout>
  private generation = 0

  constructor(private store: AppStore, readonly options: PaletteOptions) {
    this.input = new LineEditor(options.initial ?? '')
    this.records = { status: options.searchRecords ? 'idle' : 'absent', quick: options.quick, items: [] }
    if (options.initial) this.search()
  }

  /** The placeholder: what can be searched here. */
  placeholder(): string {
    return this.options.searchRecords
      ? `type to search apps, tables, processes, commands and records${this.options.quick ? ' (quick search)' : ''}`
      : 'type to search apps, tables, processes, widgets and commands'
  }

  groups(): { groups: PaletteGroup[]; total: number } {
    const text = this.input.value.trim()
    const index = text ? this.options.searchIndex(text, 50 * this.pages) : { items: [], total: 0 }
    const records: RecordState = !text ? { ...this.records, status: 'idle' } : this.records
    const groups = paletteGroups({ text, index: index.items, commands: this.options.commands, records, help: text ? this.help : [], recents: this.options.recents })
    return { groups, total: index.total }
  }

  private search(): void {
    clearTimeout(this.timer)
    this.help = []
    const text = this.input.value.trim()
    const records = this.options.searchRecords
    if (!records) this.records = { status: 'absent', quick: false, items: [] }
    else this.records = { status: text.replace(/^=/, '').length >= 2 ? 'searching' : 'idle', quick: this.options.quick, items: [] }
    if (text.replace(/^=/, '').length < 2) return
    const gen = ++this.generation
    this.timer = setTimeout(() => {
      if (records) {
        records(text).then((r) => {
          if (gen === this.generation) this.records = { status: r.none ? 'none' : 'done', quick: this.options.quick, items: r.items }
        }).catch((e) => {
          if (gen === this.generation) this.records = { status: 'error', quick: this.options.quick, items: [], error: errorText(e) }
        }).finally(() => this.store.bump())
      }
      this.options.searchHelp?.(text).then((h) => { if (gen === this.generation) this.help = h }).catch(() => undefined).finally(() => this.store.bump())
    }, 250)
  }

  onKey(key: Key): void {
    const { groups, total } = this.groups()
    const { rows, selectable } = paletteRows(groups)
    if (key.name === 'escape') return this.store.closeOverlay(this)
    if (key.name === 'down') this.index = Math.min(selectable.length - 1, this.index + 1)
    else if (key.name === 'up') this.index = Math.max(0, this.index - 1)
    else if (key.name === 'pagedown') this.index = Math.min(selectable.length - 1, this.index + 10)
    else if (key.name === 'pageup') this.index = Math.max(0, this.index - 10)
    else if (key.name === 'return') {
      const it = rows[selectable[this.index] ?? -1]?.item
      if (!it?.run) return
      this.store.closeOverlay(this)
      it.run()
      return
    } else if (this.input.handle(key)) {
      this.index = 0
      this.pages = 1
      this.search()
    }
    // scrolling to the end reveals the next page of metadata matches
    const indexCount = groups.filter((g) => !/^(Records|Commands|Help)/.test(g.title)).reduce((n, g) => n + g.items.length, 0)
    if (this.index >= selectable.length - 1 && total > indexCount) this.pages++
  }

  render(sw: number, sh: number) {
    const t = theme()
    const width = Math.min(sw - 4, 110)
    const inner = width - 2
    const { groups, total } = this.groups()
    const { rows: all, selectable } = paletteRows(groups)
    if (this.index >= selectable.length) this.index = Math.max(0, selectable.length - 1)
    const selRow = selectable[this.index] ?? -1
    const rows = Math.max(5, Math.min(22, sh - 10))
    const top = Math.max(0, Math.min(selRow - Math.floor(rows / 2), all.length - rows))
    const typed = Boolean(this.input.value.trim())
    const indexCount = groups.filter((g) => !/^(Records|Commands|Help)/.test(g.title)).reduce((n, g) => n + g.items.length, 0)
    const more = total > indexCount ? ` · ${total - indexCount} more (scroll)` : ''
    const footer = !typed
      ? `recent and commands${this.options.summary ? ` · ${this.options.summary}` : ''} · type to search`
      : `${selectable.length} matches${more} · ↑↓ · Enter opens or runs · Esc`
    return (
      <Frame title="Search  (/  F2  .  Ctrl+K)" width={width} height={rows + 5} screenWidth={sw} screenHeight={sh} top={2}>
        <box paddingLeft={1}><EditorLine editor={this.input} width={inner - 2} placeholder={this.placeholder()} /></box>
        {all.slice(top, top + rows).map((r, i) => {
          if (r.header) return <text flexShrink={0} wrapMode="none" key={i} fg={t.acc}><strong>{pad(` ${r.header}`, inner)}</strong></text>
          const it = r.item!
          const sel = top + i === selRow
          const note = !it.run
          return <text flexShrink={0} wrapMode="none" key={i} fg={sel ? t.selFg : note ? t.dim : t.fg} bg={sel ? t.selBg : undefined}>{pad(note ? `   ${it.label}` : `   ${pad(it.label, 40)} ${it.context ?? ''}`, inner)}</text>
        })}
        {Array.from({ length: Math.max(0, rows - Math.min(rows, all.length - top)) }, (_, i) => <Line key={`e${i}`} text={i === 0 && !all.length ? (typed ? ' (nothing matches)' : ' (no recents yet; type to search)') : ''} width={inner} fg={t.dim} />)}
        <Line text="" width={inner} />
        <Line text={` ${footer}`} width={inner} fg={t.dim} />
      </Frame>
    )
  }
}

/**
 * The F1 / ? keyboard reference: the keys of the screen on top grouped by what they do, the
 * screen's help text from the server, and one line pointing at search, the menu and the command
 * line. It lists no commands and no places to go (those live in / and F9).
 */
export class HelpOverlay implements Overlay {
  readonly id = overlayId('help')
  top = 0

  constructor(private store: AppStore, readonly groups: KeyGroup[], readonly topicHelp: string[], readonly pointer = HELP_POINTER) {}

  onKey(key: Key): void {
    if (key.name === 'escape' || key.name === 'f1' || charOf(key) === '?' || key.name === 'return') return this.store.closeOverlay(this)
    if (key.name === 'down') this.top++
    else if (key.name === 'up') this.top = Math.max(0, this.top - 1)
    else if (key.name === 'pagedown' || key.name === 'space') this.top += 10
    else if (key.name === 'pageup') this.top = Math.max(0, this.top - 10)
  }

  /** The body lines (keys in two columns per group, then the screen's help). */
  lines(inner: number): Array<{ text: string; fg?: string }> {
    const t = theme()
    const body: Array<{ text: string; fg?: string }> = []
    const half = Math.floor((inner - 3) / 2)
    for (const g of this.groups) {
      if (body.length) body.push({ text: '' })
      body.push({ text: ` ${g.title}`, fg: t.acc })
      const keyWidth = Math.min(22, Math.max(...g.keys.map(([k]) => k.length)) + 2)
      // two columns when every entry fits in half the width, else one per line (nothing is cut)
      const two = g.keys.every(([k, w]) => keyWidth + w.length + 2 <= half)
      if (!two) {
        for (const [k, w] of g.keys) body.push({ text: `   ${pad(k, keyWidth)}${w}` })
        continue
      }
      const n = Math.ceil(g.keys.length / 2)
      for (let i = 0; i < n; i++) {
        const a = g.keys[i]!
        const b = g.keys[i + n]
        body.push({ text: `   ${pad(a[0], keyWidth)}${pad(a[1], half - keyWidth)}${b ? `${pad(b[0], keyWidth)}${b[1]}` : ''}` })
      }
    }
    if (this.topicHelp.length) {
      body.push({ text: '' })
      body.push({ text: ' About this screen', fg: t.acc })
      for (const p of this.topicHelp) for (const l of wrap(p, inner - 4)) body.push({ text: `   ${l}` })
    }
    return body
  }

  render(sw: number, sh: number) {
    const t = theme()
    const width = Math.min(sw - 4, 120)
    const inner = width - 2
    const height = Math.min(sh - 2, 44)
    const body = this.lines(inner)
    const rows = height - 5
    this.top = Math.min(this.top, Math.max(0, body.length - rows))
    const shown = body.slice(this.top, this.top + rows)
    return (
      <Frame title="Keys  (F1  ?)" width={width} height={height} screenWidth={sw} screenHeight={sh} top={1}>
        {shown.map((l, i) => <Line key={i} text={trunc(l.text, inner)} width={inner} fg={l.fg} />)}
        {Array.from({ length: Math.max(0, rows - shown.length) }, (_, i) => <Line key={`e${i}`} text="" width={inner} />)}
        <Line text="" width={inner} />
        <Line text={` ${this.pointer}`} width={inner} fg={t.acc2} />
        <Line text=" ↑↓ PgUp PgDn scroll · Esc, F1 or ? closes" width={inner} fg={t.dim} />
      </Frame>
    )
  }
}

/** The `:` command line: the CLI grammar plus TUI commands, history (↑↓, Ctrl+R), Tab completion. */
export class CommandLineOverlay implements Overlay {
  readonly id = overlayId('cmdline')
  readonly editor: LineEditor
  historyIndex = -1
  candidates: string[] = []
  candidate = 0
  search?: LineEditor

  constructor(private store: AppStore, private history: History, private complete: (line: string, cursor: number) => { from: number; candidates: string[] }, private onRun: (line: string) => void, initial = '') {
    this.editor = new LineEditor(initial)
  }

  paste(text: string): void {
    this.editor.insert(text)
  }

  onKey(key: Key): void {
    if (this.search) {
      if (key.name === 'escape') {
        this.search = undefined
        return
      }
      if (key.name === 'return' || (key.ctrl && key.name === 'r')) {
        const hit = this.history.search(this.search.value)[0]
        if (hit) this.editor.set(hit)
        this.search = undefined
        return
      }
      this.search.handle(key)
      return
    }
    if (key.name === 'escape') return this.store.closeOverlay(this)
    if (key.ctrl && key.name === 'r') {
      this.search = new LineEditor('')
      return
    }
    if (key.name === 'return') {
      const line = this.editor.value.trim()
      this.store.closeOverlay(this)
      if (line) {
        this.history.add(line)
        this.onRun(line)
      }
      return
    }
    if (key.name === 'tab') {
      const r = this.complete(this.editor.value, this.editor.cursor)
      if (!r.candidates.length) return
      if (this.candidates.join('\u0000') === r.candidates.join('\u0000') && r.candidates.length > 1) this.candidate = (this.candidate + 1) % r.candidates.length
      else {
        this.candidates = r.candidates
        this.candidate = 0
      }
      const pick = r.candidates[this.candidate]!
      const before = this.editor.value.slice(0, r.from)
      const after = this.editor.value.slice(this.editor.cursor)
      this.editor.value = before + pick + (after.startsWith(' ') ? '' : ' ') + after
      this.editor.cursor = before.length + pick.length + 1
      if (r.candidates.length === 1) this.candidates = []
      return
    }
    if (key.name === 'up' || key.name === 'down') {
      const hist = this.history.entries()
      this.historyIndex = Math.max(-1, Math.min(hist.length - 1, this.historyIndex + (key.name === 'up' ? 1 : -1)))
      this.editor.set(this.historyIndex >= 0 ? hist[this.historyIndex]! : '')
      return
    }
    if (this.editor.handle(key)) this.candidates = []
  }

  render(sw: number, sh: number) {
    const t = theme()
    const width = Math.min(sw - 2, 140)
    const inner = width - 2
    const hint = this.search
      ? ` history search: ${this.search.value}_  → ${this.history.search(this.search.value)[0] ?? '(no match)'}`
      : this.candidates.length > 1 ? ` ${trunc(this.candidates.map((c, i) => (i === this.candidate ? `[${c}]` : c)).join('  '), inner - 2)}` : ' ↑↓ history · Ctrl+R search · Tab completes · Enter runs · Esc · e.g. table query person -w "lastName STARTS_WITH S" · theme light · lock · quit'
    return (
      <box position="absolute" left={Math.max(0, Math.floor((sw - width) / 2))} top={Math.max(0, sh - 6)} width={width} height={4} flexDirection="column" border borderStyle="single" borderColor={t.focusBorder} {...(glyphs().border ? { customBorderChars: glyphs().border } : {})} backgroundColor={t.overlayBg} title=" : command " zIndex={30}>
        <text flexShrink={0} wrapMode="none"><span fg={t.acc2}>{':'}</span></text>
        <box position="absolute" left={2} top={0}><EditorLine editor={this.editor} width={inner - 3} /></box>
        <Line text={hint} width={inner} fg={this.search ? t.acc2 : t.dim} />
      </box>
    )
  }
}

/** The screen saver and lock: a slowly moving clock on the theme's colors; a PIN when one is set. */
export class LockOverlay implements Overlay {
  readonly id = overlayId('lock')
  asking = false
  readonly pin = new LineEditor('', { masked: true })
  failures = 0
  waitUntil = 0
  message = ''
  started = Date.now()

  constructor(private store: AppStore) {}

  onKey(key: Key): void {
    if (!hasPin()) {
      this.store.lock = undefined
      return
    }
    if (!this.asking) {
      this.asking = true
      return
    }
    if (key.name === 'escape') {
      this.asking = false
      this.pin.set('')
      return
    }
    if (key.name === 'return') {
      if (Date.now() < this.waitUntil) {
        this.message = `wait ${Math.ceil((this.waitUntil - Date.now()) / 1000)} s`
        return
      }
      if (verifyPin(this.pin.value)) {
        this.store.lock = undefined
        return
      }
      this.failures++
      this.waitUntil = Date.now() + pinDelayMillis(this.failures)
      this.message = `wrong PIN (attempt ${this.failures}); wait ${(pinDelayMillis(this.failures) / 1000).toFixed(1)} s`
      this.pin.set('')
      return
    }
    this.pin.handle(key)
  }

  render(sw: number, sh: number) {
    const t = theme()
    const elapsed = Math.floor((Date.now() - this.started) / 4000)
    const brand = (this.store.meta?.branding as { appName?: string } | undefined)?.appName ?? 'QQQ'
    const lines = [brand, new Date().toLocaleTimeString('en-GB'), `${this.store.status.profile} · ${this.store.status.server.replace(/^https?:\/\//, '')}`, this.asking ? 'PIN:' : hasPin() ? 'locked · any key to unlock' : 'any key returns']
    const boxW = 44
    const maxX = Math.max(0, sw - boxW)
    const maxY = Math.max(0, sh - lines.length - 4)
    const bounce = (n: number, max: number) => (max === 0 ? 0 : Math.abs(((n % (2 * max)) + 2 * max) % (2 * max) - max))
    const x = bounce(elapsed * 3, maxX)
    const y = bounce(elapsed, maxY)
    const rows: React.ReactNode[] = []
    for (let r = 0; r < sh; r++) rows.push(<text flexShrink={0} wrapMode="none" key={r} bg={t.overlayBg}>{' '.repeat(sw)}</text>)
    return (
      <box position="absolute" left={0} top={0} width={sw} height={sh} zIndex={100} backgroundColor={t.overlayBg}>
        {rows}
        <box position="absolute" left={x} top={y} width={boxW} flexDirection="column">
          <text flexShrink={0} wrapMode="none" fg={t.acc}><strong>{center(lines[0]!, boxW)}</strong></text>
          <text flexShrink={0} wrapMode="none" fg={t.acc2}><strong>{center(lines[1]!, boxW)}</strong></text>
          <text flexShrink={0} wrapMode="none" fg={t.dim}>{center(lines[2]!, boxW)}</text>
          <text flexShrink={0} wrapMode="none" fg={t.fg}>{center(lines[3]!, boxW)}</text>
          {this.asking ? <box paddingLeft={12}><EditorLine editor={this.pin} width={20} /></box> : null}
          {this.message ? <text flexShrink={0} wrapMode="none" fg={t.err}>{center(this.message, boxW)}</text> : null}
        </box>
      </box>
    )
  }
}

export { charOf }
