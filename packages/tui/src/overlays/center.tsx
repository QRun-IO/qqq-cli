/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The F9 command center, the F2 palette, the F1 help, the `:` command line and the screen lock. */

import { hasPin, pinDelayMillis, verifyPin, type History } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { LineEditor } from '../line-editor'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { MenuEntry, Overlay } from '../types'
import { center, errorText, pad, trunc } from '../util/text'
import { EditorLine, overlayId, wrap } from './basic'
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

export interface PaletteItem {
  label: string
  kind: string
  context?: string
  run: () => void
}

/**
 * The palette (F2, /, ., Ctrl+K): jump to anything by label. Search-first: with no text it shows
 * recents and commands; typed text searches the kernel metadata index (a page at a time, "more…"
 * on scrolling) and, when the server can, records.
 */
export class PaletteOverlay implements Overlay {
  readonly id = overlayId('palette')
  readonly input = new LineEditor('')
  index = 0
  records: PaletteItem[] = []
  searching = false
  pages = 1
  private timer?: ReturnType<typeof setTimeout>
  private generation = 0

  constructor(private store: AppStore, readonly idle: PaletteItem[], readonly searchIndex: (text: string, limit: number) => { items: PaletteItem[]; total: number }, readonly searchRecords?: (text: string) => Promise<PaletteItem[]>, readonly summary = '') {}

  list(): { items: PaletteItem[]; total: number } {
    const text = this.input.value.trim()
    if (!text) return { items: this.idle, total: this.idle.length }
    const needle = text.toLowerCase()
    const r = this.searchIndex(text, 50 * this.pages)
    const commands = this.idle.filter((i) => i.kind === 'command' && i.label.toLowerCase().includes(needle)).slice(0, 10)
    return { items: [...r.items, ...commands, ...this.records], total: r.total + commands.length + this.records.length }
  }

  onKey(key: Key): void {
    const { items } = this.list()
    if (key.name === 'escape') return this.store.closeOverlay(this)
    if (key.name === 'down') this.index = Math.min(items.length - 1, this.index + 1)
    else if (key.name === 'up') this.index = Math.max(0, this.index - 1)
    else if (key.name === 'pagedown') this.index = Math.min(items.length - 1, this.index + 10)
    else if (key.name === 'pageup') this.index = Math.max(0, this.index - 10)
    else if (key.name === 'return') {
      const it = items[this.index]
      if (!it) return
      this.store.closeOverlay(this)
      it.run()
    } else if (this.input.handle(key)) {
      this.index = 0
      this.pages = 1
      this.records = []
      clearTimeout(this.timer)
      const text = this.input.value.trim()
      if (this.searchRecords && text.length >= 2) {
        this.timer = setTimeout(() => {
          const gen = ++this.generation
          this.searching = true
          this.searchRecords!(text).then((r) => { if (gen === this.generation) this.records = r }).catch(() => undefined).finally(() => { this.searching = false; this.store.bump() })
        }, 250)
      }
    }
    // scrolling to the end of a page reveals the next page
    if (this.index >= items.length - 1 && this.list().total > items.length) this.pages++
  }

  render(sw: number, sh: number) {
    const t = theme()
    const width = Math.min(sw - 4, 110)
    const inner = width - 2
    const { items, total } = this.list()
    const rows = Math.max(5, Math.min(20, sh - 10))
    const top = Math.max(0, Math.min(this.index - Math.floor(rows / 2), items.length - rows))
    const typed = Boolean(this.input.value.trim())
    const more = total > items.length ? ` · ${total - items.length} more (scroll)` : ''
    const footer = !typed ? `recents and commands · ${this.summary} · type to search` : `${total} matches${more}${this.searchRecords ? (this.searching ? ' · searching records…' : ' · records searched by the server') : ' · no record search on this server'}`
    return (
      <Frame title="Go to  (F2  /  .  Ctrl+K)" width={width} height={rows + 5} screenWidth={sw} screenHeight={sh} top={2}>
        <box paddingLeft={1}><EditorLine editor={this.input} width={inner - 2} placeholder="a table, process, app, report, recent record, command, or text to find records" /></box>
        {items.slice(top, top + rows).map((it, i) => {
          const sel = top + i === this.index
          return <text flexShrink={0} wrapMode="none" key={i} fg={sel ? t.selFg : t.fg} bg={sel ? t.selBg : undefined}>{pad(` ${pad(it.label, 38)} ${pad(it.kind, 10)} ${it.context ?? ''}`, inner)}</text>
        })}
        {Array.from({ length: Math.max(0, rows - Math.min(rows, items.length - top)) }, (_, i) => <Line key={`e${i}`} text={i === 0 && !items.length ? (typed ? ' (nothing matches)' : ' (no recents yet; type to search)') : ''} width={inner} fg={t.dim} />)}
        <Line text="" width={inner} />
        <Line text={` ${footer}`} width={inner} fg={t.dim} />
      </Frame>
    )
  }
}

/** The F1 / ? help: keys for this screen, what can be done here, the topic's help text, and help search. */
export class HelpOverlay implements Overlay {
  readonly id = overlayId('help')
  readonly input = new LineEditor('')
  top = 0
  results: Array<{ label: string; detail: string; run?: () => void }> = []
  index = 0
  private timer?: ReturnType<typeof setTimeout>

  constructor(private store: AppStore, readonly keys: Array<[string, string]>, readonly actions: MenuEntry[], readonly topicHelp: string[], readonly search: (q: string) => Promise<Array<{ label: string; detail: string; run?: () => void }>>) {}

  onKey(key: Key): void {
    if (key.name === 'escape' || key.name === 'f1') return this.store.closeOverlay(this)
    if (this.input.value && this.results.length) {
      if (key.name === 'down') return void (this.index = Math.min(this.results.length - 1, this.index + 1))
      if (key.name === 'up') return void (this.index = Math.max(0, this.index - 1))
      if (key.name === 'return') {
        const r = this.results[this.index]
        if (r?.run) {
          this.store.closeOverlay(this)
          r.run()
        }
        return
      }
    }
    if (key.name === 'down') this.top++
    else if (key.name === 'up') this.top = Math.max(0, this.top - 1)
    else if (key.name === 'pagedown') this.top += 10
    else if (key.name === 'pageup') this.top = Math.max(0, this.top - 10)
    else if (key.name === 'return' && !this.input.value) {
      const a = this.actions.find((e) => e.run && !e.disabled)
      void a
    } else if (this.input.handle(key)) {
      this.index = 0
      clearTimeout(this.timer)
      const q = this.input.value.trim()
      if (!q) {
        this.results = []
        return
      }
      this.timer = setTimeout(() => {
        this.search(q).then((r) => { this.results = r }).catch((e) => { this.results = [{ label: errorText(e), detail: '' }] }).finally(() => this.store.bump())
      }, 250)
    }
  }

  render(sw: number, sh: number) {
    const t = theme()
    const width = Math.min(sw - 4, 110)
    const inner = width - 2
    const height = Math.min(sh - 2, 40)
    const body: Array<{ text: string; fg?: string; bg?: string }> = []
    if (this.input.value) {
      body.push({ text: ` Help search: ${this.results.length} results (Enter opens)`, fg: t.acc })
      this.results.forEach((r, i) => body.push({ text: `   ${pad(r.label, 40)} ${r.detail}`, fg: i === this.index ? t.selFg : t.fg, bg: i === this.index ? t.selBg : undefined }))
    } else {
      body.push({ text: ' Keys', fg: t.acc })
      const half = Math.ceil(this.keys.length / 2)
      for (let i = 0; i < half; i++) {
        const a = this.keys[i]!
        const b = this.keys[i + half]
        body.push({ text: `   ${pad(a[0], 14)}${pad(a[1], Math.floor(inner / 2) - 17)}${b ? `${pad(b[0], 14)}${b[1]}` : ''}` })
      }
      if (this.topicHelp.length) {
        body.push({ text: '' })
        body.push({ text: ' About this screen', fg: t.acc })
        for (const p of this.topicHelp) for (const l of wrap(p, inner - 4)) body.push({ text: `   ${l}` })
      }
      if (this.actions.length) {
        body.push({ text: '' })
        body.push({ text: ' What you can do here (also in F9)', fg: t.acc })
        for (const a of this.actions) body.push({ text: `   ${pad(a.label, inner - 22)} ${a.key ?? ''}`, fg: a.disabled ? t.dim : t.fg })
      }
    }
    const rows = height - 5
    this.top = Math.min(this.top, Math.max(0, body.length - rows))
    const shown = body.slice(this.input.value ? 0 : this.top, (this.input.value ? 0 : this.top) + rows)
    return (
      <Frame title="Help  (F1  ?)" width={width} height={height} screenWidth={sw} screenHeight={sh} top={1}>
        <box paddingLeft={1}><EditorLine editor={this.input} width={inner - 2} placeholder="type to search the application's help" /></box>
        {shown.map((l, i) => <Line key={i} text={l.text} width={inner} fg={l.fg} bg={l.bg} />)}
        {Array.from({ length: Math.max(0, rows - shown.length) }, (_, i) => <Line key={`e${i}`} text="" width={inner} />)}
        <Line text="" width={inner} />
        <Line text=" ↑↓ PgUp PgDn scroll · type to search help · Esc or F1 closes" width={inner} fg={t.dim} />
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
