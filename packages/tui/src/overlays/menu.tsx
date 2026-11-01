/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The F9 menu in two levels, as a classic menu bar: level 1 lists the areas (Context, Go to, Work,
 * Connection, Settings, Help) with a count and a one-line summary; level 2 lists one area's entries
 * with their keys. Long groups inside an area (Recent, Apps, Favorites: more than 5) show their
 * first 5 and a "more…" row that opens the whole group (level 3). Two or more typed characters
 * search every entry of every area and show a flat list grouped by area; one character jumps (to
 * the area, or to the entry, starting with it). The entries themselves come from `entries()` in
 * commands.ts; this file only groups and draws them.
 */

import type { Key } from '../keys'
import { charOf } from '../keys'
import { LineEditor } from '../line-editor'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { MenuEntry, Overlay } from '../types'
import { fitKeyLine, pad, padLeft, trunc, type KeyToken } from '../util/text'
import { EditorLine, overlayId } from './basic'
import { Frame, Line } from './frame'
import { pickRow } from '../mouse/keys'
import { Zone } from '../mouse/zone'

export type Area = MenuEntry['section']
export const AREAS: Area[] = ['Context', 'Go to', 'Work', 'Connection', 'Settings', 'Help']

/** What each area holds, for level 1 (Context is described from the screen). */
const SUMMARY: Record<Area, string> = {
  Context: 'actions of this screen',
  'Go to': 'home, search (/), apps, recent records, favorites',
  Work: 'jobs, notifications, my work, extensions',
  Connection: 'servers (Ctrl+O), profile, stream, metadata, sign out',
  Settings: 'theme, view, shortcuts, layout, lock, PIN, folders, preferences',
  Help: 'keys, search help, check the terminal, about, quit',
}

/** A group with more entries than this shows that many and a "more…" row. */
export const GROUP_LIMIT = 5

/** The group of an entry inside its area: its own `group`, else Recent / Apps / Favorites by label. */
export function groupOf(e: MenuEntry): string | undefined {
  if (e.group) return e.group
  if (e.section !== 'Go to' || e.id?.startsWith('index:')) return undefined
  if (e.label.startsWith('Recent: ')) return 'Recent'
  if (e.label.startsWith('App: ')) return 'Apps'
  if (/^Favorites?\b/.test(e.label)) return 'Favorites'
  return undefined
}

export function matches(e: MenuEntry, needle: string): boolean {
  return !needle || `${e.section} ${groupOf(e) ?? ''} ${e.label} ${e.detail ?? ''} ${e.command ?? ''} ${e.key ?? ''}`.toLowerCase().includes(needle)
}

/** One drawn row: a heading, a runnable entry, or a row that opens an area or a group. */
export type MenuRow =
  | { kind: 'head'; text: string }
  | { kind: 'entry'; e: MenuEntry }
  | { kind: 'area'; area: Area; count: number; summary: string; e: MenuEntry }
  | { kind: 'more'; group: string; count: number; e: MenuEntry }

/** The rows of level 1: every area that has entries, with its count and summary. */
export function areaRows(all: MenuEntry[], contextSummary?: string, connectionSummary?: string): MenuRow[] {
  return AREAS.map((area) => ({ area, count: all.filter((e) => e.section === area).length }))
    .filter((a) => a.count > 0)
    .map(({ area, count }) => ({ kind: 'area' as const, area, count, summary: (area === 'Context' ? contextSummary : area === 'Connection' ? connectionSummary : undefined) || SUMMARY[area], e: { id: `area:${area}`, section: area, label: area } }))
}

/** The rows of level 2: the area's ungrouped entries, then each group (the first 5 and "more…" when longer). */
export function sectionRows(all: MenuEntry[], area: Area): MenuRow[] {
  const list = all.filter((e) => e.section === area)
  const rows: MenuRow[] = []
  const groups = new Map<string, MenuEntry[]>()
  for (const e of list) {
    const g = groupOf(e)
    if (!g) rows.push({ kind: 'entry', e })
    else groups.set(g, [...(groups.get(g) ?? []), e])
  }
  for (const [group, entries] of groups) {
    rows.push({ kind: 'head', text: entries.length > GROUP_LIMIT ? `${group} (${entries.length})` : group })
    for (const e of entries.slice(0, GROUP_LIMIT)) rows.push({ kind: 'entry', e })
    if (entries.length > GROUP_LIMIT) rows.push({ kind: 'more', group, count: entries.length, e: { id: `more:${area}:${group}`, section: area, label: `more… (all ${entries.length})` } })
  }
  return rows
}

/** The rows of level 3: every entry of one group. */
export function groupRows(all: MenuEntry[], area: Area, group: string): MenuRow[] {
  return all.filter((e) => e.section === area && groupOf(e) === group).map((e) => ({ kind: 'entry' as const, e }))
}

/** Search results: matching entries of every area, under an area heading. */
export function searchRows(all: MenuEntry[], text: string): MenuRow[] {
  const needle = text.toLowerCase()
  const rows: MenuRow[] = []
  for (const area of AREAS) {
    const hits = all.filter((e) => e.section === area && (matches(e, needle) || (area === 'Go to' && e.id?.startsWith('index:'))))
    if (!hits.length) continue
    rows.push({ kind: 'head', text: area })
    for (const e of hits) rows.push({ kind: 'entry', e })
  }
  return rows
}

/** Key hints in one line of `width` cells, dropping whole tokens with the highest `drop` first (util/text fitKeyLine). */
function hint(tokens: KeyToken[], width: number): string {
  return fitKeyLine(tokens, width, 1)[0] ?? ''
}

const CONTEXT_WORD: Record<string, string> = { record: 'this record', table: 'this grid', process: 'this process', form: 'this form', app: 'this app', home: 'the home screen' }

/** The F9 command center. A stack: an entry that opens a dialog leaves the menu underneath at the same
 * entry (refreshed when the dialog closes); entries that navigate close it. */
export class MenuOverlay implements Overlay {
  readonly id = overlayId('menu')
  readonly closesOnNavigate = true
  readonly filter = new LineEditor('')
  /** 1 areas, 2 one area, 3 one group of an area. */
  level: 1 | 2 | 3 = 1
  area: Area = 'Context'
  group?: string
  /** The selection among the selectable rows of the current view. */
  index = 0
  private scroll = 0
  private selectedId?: string
  private cache?: { key: string; all: MenuEntry[]; rows: MenuRow[] }
  /** Where level 2 and 3 were, to come back to the same row. */
  private back: Array<{ level: 1 | 2 | 3; area: Area; group?: string; id?: string }> = []

  constructor(private store: AppStore, private build: (filterText: string) => MenuEntry[], readonly summary = '') {
    const rows = areaRows(build(''))
    const last = AREAS[store.lastMenuSection] ?? 'Context'
    const at = rows.findIndex((r) => r.kind === 'area' && r.area === last)
    this.index = Math.max(0, at)
    this.area = rows[this.index]?.kind === 'area' ? (rows[this.index] as { area: Area }).area : 'Context'
  }

  static idOf(e: MenuEntry): string {
    return e.id ?? `${e.section}:${e.label}`
  }

  /** Two or more characters search; one jumps. */
  get searching(): boolean {
    return this.filter.value.trim().length >= 2
  }

  /** The rows of the current view. */
  rows(fresh = false): MenuRow[] {
    const key = `${this.searching ? this.filter.value : ''}|${this.level}|${this.area}|${this.group ?? ''}`
    if (!fresh && this.cache?.key === key) return this.cache.rows
    const all = this.build(this.searching ? this.filter.value : '')
    const rows = this.searching ? searchRows(all, this.filter.value.trim())
      : this.level === 1 ? areaRows(all, this.contextSummary(all), this.connectionSummary())
        : this.level === 2 ? sectionRows(all, this.area)
          : groupRows(all, this.area, this.group ?? '')
    this.cache = { key, all, rows }
    if (this.selectedId) {
      const at = selectable(rows).findIndex((r) => MenuOverlay.idOf(r.e) === this.selectedId)
      if (at >= 0) this.index = at
    }
    return rows
  }

  /** Every entry behind the current view (for counts). */
  private allEntries(): MenuEntry[] {
    this.rows()
    return this.cache!.all
  }

  /** The selectable entries of the current view, in order (`index` points into it). */
  visible(fresh = false): MenuEntry[] {
    return selectable(this.rows(fresh)).map((r) => r.e)
  }

  /** Connection on level 1: the server in use (short name and host) before what the area holds. */
  private connectionSummary(): string {
    const st = this.store.status
    const host = st.server.replace(/^https?:\/\//, '')
    return host ? `${st.short || st.profile} ${host} · servers (Ctrl+O), profile, stream, sign out` : SUMMARY.Connection
  }

  private contextSummary(all: MenuEntry[]): string {
    const kind = this.store.screen?.kind ?? ''
    const labels = all.filter((e) => e.section === 'Context' && e.command !== 'back').map((e) => e.label.replace(/^[^\p{L}\p{N}]+/u, '').replace(/…$/, ''))
    const word = CONTEXT_WORD[kind] ?? 'this screen'
    return labels.length ? `${word}: ${labels.slice(0, 4).join(', ')}${labels.length > 4 ? ', …' : ''}` : `${word}: back`
  }

  private open(level: 1 | 2 | 3, area: Area, group?: string): void {
    const current = this.visible()[this.index]
    if (level > this.level) this.back.push({ level: this.level, area: this.area, group: this.group, id: current ? MenuOverlay.idOf(current) : undefined })
    this.level = level
    this.area = area
    this.group = group
    this.index = 0
    this.scroll = 0
    this.selectedId = undefined
    this.cache = undefined
  }

  private up(): void {
    const prev = this.back.pop()
    if (!prev) {
      this.level = 1
      this.selectedId = `area:${this.area}`
    } else {
      this.level = prev.level
      this.area = prev.area
      this.group = prev.group
      this.selectedId = prev.id
    }
    this.cache = undefined
    this.rows()
  }

  private toLevel1(): void {
    const area = this.area
    this.back = []
    this.level = 1
    this.group = undefined
    this.selectedId = `area:${area}`
    this.cache = undefined
    this.rows()
  }

  /**
   * One typed character: the first area (level 1) or entry (levels 2, 3) starting with it; the same
   * character again (`again`) moves on to the next one, so `c` is Context and `c` `c` Connection.
   */
  private jump(ch: string, again = false): void {
    const list = this.visible()
    const c = ch.toLowerCase()
    const from = again ? this.index : -1
    for (let k = 1; k <= list.length; k++) {
      const i = (from + k + list.length) % list.length
      if (list[i]!.label.toLowerCase().startsWith(c)) {
        this.index = i
        this.selectedId = MenuOverlay.idOf(list[i]!)
        return
      }
    }
  }

  private runSelected(): void {
    const list = this.visible()
    const e = list[this.index]
    if (!e) return
    const row = selectable(this.rows())[this.index]!
    if (row.kind === 'area') {
      this.filter.set('')
      return this.open(2, row.area)
    }
    if (row.kind === 'more') {
      this.filter.set('')
      return this.open(3, e.section, row.group)
    }
    if (e.disabled) return this.store.flash(`${e.label}: ${e.disabled}`)
    if (!e.run) return
    this.store.lastMenuSection = AREAS.indexOf(e.section)
    this.selectedId = MenuOverlay.idOf(e)
    const before = this.store.screen
    const depth = this.store.routes.length
    e.run()
    // navigation closes the menu (the store does it on push and back); otherwise it stays, refreshed
    if (this.store.screen !== before || this.store.routes.length !== depth) this.store.closeOverlay(this)
    this.cache = undefined
  }

  onKey(key: Key): void {
    const list = this.visible()
    const last = Math.max(0, list.length - 1)
    const single = this.filter.value.length === 1
    if (key.name === 'f9') return this.store.closeOverlay(this)
    if (key.ctrl && key.name === 'o') {
      this.store.closeOverlay(this)
      return this.store.commands().servers()
    }
    if (key.name === 'escape') {
      // Esc closes from a search (as it always did) and from level 1; from an area it goes back
      if (this.searching || this.level === 1) return this.store.closeOverlay(this)
      this.filter.set('')
      this.up()
    } else if (key.name === 'down' || key.name === 'up' || key.name === 'pagedown' || key.name === 'pageup' || ((key.name === 'home' || key.name === 'end') && !this.filter.value)) {
      const step = key.name === 'down' ? 1 : key.name === 'up' ? -1 : key.name === 'pagedown' ? 10 : key.name === 'pageup' ? -10 : key.name === 'home' ? -list.length : list.length
      this.index = Math.max(0, Math.min(last, this.index + step))
      if (single) this.filter.set('')
    } else if (key.name === 'return') {
      this.runSelected()
      return this.after()
    } else if (key.name === 'right' && !this.searching && (!this.filter.value || single)) {
      const row = selectable(this.rows())[this.index]
      if (row && (row.kind === 'area' || row.kind === 'more')) {
        this.runSelected()
        return this.after()
      }
    } else if (key.name === 'left' && !this.searching && (!this.filter.value || single)) {
      this.filter.set('')
      if (this.level > 1) this.up()
    } else if (key.name === 'tab' && !this.searching) {
      if (this.level === 1) this.index = (this.index + (key.shift ? last : 1)) % Math.max(1, list.length)
      else {
        const areas = areaRows(this.build('')).map((r) => (r as { area: Area }).area)
        const at = areas.indexOf(this.area)
        const next = areas[(at + (key.shift ? areas.length - 1 : 1)) % areas.length]
        if (next) {
          this.back = [{ level: 1, area: next, id: `area:${next}` }]
          this.level = 2
          this.area = next
          this.group = undefined
          this.index = 0
          this.scroll = 0
          this.selectedId = undefined
          this.cache = undefined
        }
      }
    } else if (key.name === 'tab' && this.searching) {
      // the first result of the next (Shift: previous) area
      const rows = this.rows()
      const sel = selectable(rows)
      const heads = rows.flatMap((r, i) => (r.kind === 'head' ? [i] : []))
      const cur = rows.indexOf(sel[this.index]!)
      const hi = Math.max(0, heads.filter((h) => h < cur).length - 1)
      const target = heads[(hi + (key.shift ? heads.length - 1 : 1)) % Math.max(1, heads.length)]
      const first = target === undefined ? undefined : rows[target + 1]
      if (first && first.kind !== 'head') this.index = sel.indexOf(first)
    } else {
      const before = this.filter.value
      const ch = charOf(key)
      // the same letter twice cycles the jump instead of searching for "cc"
      if (single && ch && ch.toLowerCase() === before.toLowerCase()) {
        this.jump(ch, true)
        return this.after()
      }
      if (!this.filter.handle(key)) return
      const now = this.filter.value
      if (now.length === 1 && before.length === 0 && ch) this.jump(ch)
      else if (now.trim().length >= 2 && before.trim().length < 2) {
        this.index = 0
        this.scroll = 0
        this.selectedId = undefined
      } else if (now.trim().length < 2 && before.trim().length >= 2) {
        this.filter.set('')
        this.toLevel1()
      } else if (this.searching) {
        this.index = 0
        this.selectedId = undefined
      }
      this.cache = undefined
    }
    this.after()
  }

  private after(): void {
    const now = this.visible()
    if (now[this.index]) this.selectedId = MenuOverlay.idOf(now[this.index]!)
  }

  paste(text: string): void {
    this.filter.insert(text.replace(/[\r\n]+/g, ' '))
    this.index = 0
    this.selectedId = undefined
    this.cache = undefined
  }

  render(sw: number, sh: number) {
    const t = theme()
    const g = glyphs()
    this.cache = undefined
    const width = Math.max(20, Math.min(sw - 2, 100))
    const height = Math.max(8, Math.min(sh - 2, 30))
    const inner = width - 2
    const rows = this.rows()
    const sel = selectable(rows)
    if (this.index >= sel.length) this.index = Math.max(0, sel.length - 1)
    const selected = sel[this.index]
    const listRows = height - 2 - 3
    const at = selected ? rows.indexOf(selected) : 0
    if (at < this.scroll) this.scroll = Math.max(0, at - (rows[at - 1]?.kind === 'head' ? 1 : 0))
    if (at >= this.scroll + listRows) this.scroll = at - listRows + 1
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - listRows)))
    const shown = rows.slice(this.scroll, this.scroll + listRows)
    const all = this.allEntries()
    const total = all.length
    const lines = shown.map((r, i) => {
      const row = this.drawRow(r, i, selected, inner)
      if (r.kind === 'head') return row
      // the mouse: a click selects the row, a double-click opens the area or runs the entry (Enter)
      const at = sel.indexOf(r)
      return <Zone key={i} {...pickRow(() => { this.index = at; this.after() }, () => this.onKey({ name: 'return', sequence: '' }))}><box flexShrink={0} height={1}>{row}</box></Zone>
    })
    while (lines.length < listRows) lines.push(<Line key={`pad${lines.length}`} text="" width={inner} />)
    return this.frame(sw, sh, width, height, inner, rows, sel, listRows, all, lines)
  }

  /** One row of the list. */
  private drawRow(r: MenuRow, i: number, selected: MenuRow | undefined, inner: number) {
    const t = theme()
    const g = glyphs()
    {
      const isSel = r === selected
      const fg = isSel ? t.selFg : t.fg
      const bg = isSel ? t.selBg : undefined
      if (r.kind === 'head') return <Line key={i} text={` ${r.text}`} width={inner} fg={t.acc} />
      if (r.kind === 'area') {
        const head = ` ${isSel ? g.pointer : ' '} ${pad(r.area, 11)}${padLeft(String(r.count), 4)}  `
        return (
          <text key={i} flexShrink={0} wrapMode="none">
            <span fg={fg} bg={bg}>{head}</span>
            <span fg={isSel ? t.selFg : t.dim} bg={bg}>{pad(`${r.summary} ${g.closed}`, Math.max(0, inner - head.length))}</span>
          </text>
        )
      }
      const ptr = ` ${isSel ? g.pointer : ' '} `
      if (r.kind === 'more') return <Line key={i} text={`${ptr}${r.e.label}  ${g.closed}`} width={inner} fg={isSel ? t.selFg : t.acc2} bg={bg} />
      const e = r.e
      const keyText = e.key ? ` ${e.key} ` : ''
      const detail = e.disabled ? ` (${e.disabled})` : e.detail ? ` ${e.detail}` : ''
      const room = Math.max(1, inner - 3 - keyText.length)
      return <Line key={i} text={pad(`${ptr}${trunc(e.label + detail, room)}`, inner - keyText.length) + keyText} width={inner} fg={isSel ? t.selFg : e.disabled ? t.dim : t.fg} bg={bg} />
    }
  }

  private frame(sw: number, sh: number, width: number, height: number, inner: number, rows: MenuRow[], sel: MenuRow[], listRows: number, all: MenuEntry[], lines: React.ReactNode[]) {
    const t = theme()
    const g = glyphs()
    const total = all.length
    const more = rows.length > listRows ? ` ${this.scroll > 0 ? g.up : ' '}${this.scroll + listRows < rows.length ? g.down : ' '}` : ''
    let crumb: string
    let keys: Array<{ text: string; drop?: number }>
    if (this.searching) {
      const areas = rows.filter((r) => r.kind === 'head').length
      crumb = ` Search: ${sel.length} ${sel.length === 1 ? 'match' : 'matches'} in ${areas} ${areas === 1 ? 'area' : 'areas'}`
      keys = [{ text: `${sel.length} of ${total} entries` }, { text: '↑↓', drop: 1 }, { text: 'Tab next area', drop: 3 }, { text: 'Enter runs' }, { text: 'Backspace clears', drop: 2 }, { text: 'Esc or F9 closes' }]
    } else if (this.level === 1) {
      crumb = ' Menu'
      keys = [{ text: `${total} entries` }, { text: 'type to search', drop: 1 }, { text: '↑↓ → Enter opens' }, { text: 'letter jumps', drop: 3 }, { text: 'Esc or F9 closes' }]
    } else if (this.level === 2) {
      const n = all.filter((e) => e.section === this.area).length
      crumb = ` Menu ${g.closed} ${this.area}`
      keys = [{ text: `${n} ${n === 1 ? 'entry' : 'entries'}` }, { text: '↑↓', drop: 2 }, { text: 'Enter runs' }, { text: '← or Esc back' }, { text: 'Tab next area', drop: 3 }, { text: 'type to search', drop: 4 }, { text: 'F9 closes', drop: 1 }]
    } else {
      crumb = ` Menu ${g.closed} ${this.area} ${g.closed} ${this.group}`
      keys = [{ text: `${sel.length} entries` }, { text: '↑↓', drop: 2 }, { text: 'Enter runs' }, { text: '← or Esc back' }, { text: 'F9 closes', drop: 1 }]
    }
    return (
      <Frame title="Menu  (F9)" width={width} height={height} screenWidth={sw} screenHeight={sh} top={1}>
        <box paddingLeft={1}><EditorLine editor={this.filter} width={inner - 2} placeholder={`type to search the menu · / searches ${this.summary || 'apps, tables, processes and records'}`} /></box>
        <Zone onClick={() => { if (!this.searching && this.level > 1) this.onKey({ name: 'left', sequence: '' }) }}><text flexShrink={0} wrapMode="none" fg={t.acc}>{pad(pad(crumb, inner - more.length) + more, inner)}</text></Zone>
        {lines}
        <Line text={` ${hint(keys, inner - 2)}`} width={inner} fg={t.dim} />
      </Frame>
    )
  }
}

function selectable(rows: MenuRow[]): Array<Exclude<MenuRow, { kind: 'head' }>> {
  return rows.filter((r): r is Exclude<MenuRow, { kind: 'head' }> => r.kind !== 'head')
}
