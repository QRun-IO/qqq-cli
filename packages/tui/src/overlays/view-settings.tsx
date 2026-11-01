/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { readViewSettings, writeViewSettings, type ViewSettings } from '@qrun-io/qqq-core'
import type { TableMetaData } from '../client'
import type { Key } from '../keys'
import { charOf } from '../keys'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { Overlay } from '../types'
import { KEY_SEP, fitKeyLine, pad, type KeyToken } from '../util/text'
import { ChoiceOverlay, EditorLine, PromptOverlay, overlayId } from './basic'
import { LineEditor } from '../line-editor'
import { defaultColumns } from '../screens/table'
import { Frame, Line } from './frame'
import { pickRow } from '../mouse/keys'
import { Zone } from '../mouse/zone'

/** Most columns that can be pinned on the left. */
const MAX_PINNED = 3

/** The dialog's key help; a higher `drop` goes first when the width cannot fit all of it in three lines. */
export const VIEW_SETTINGS_KEYS: KeyToken[] = [
  { text: 'Space on/off', drop: 0 },
  { text: 'Shift+↑↓ or +/- move', drop: 1 },
  { text: '←→ width', drop: 1 },
  { text: 'w width', drop: 3 },
  { text: 'a auto', drop: 3 },
  { text: '/ search', drop: 2 },
  { text: '* changed from the default', drop: 4 },
  { text: 'r reset to defaults', drop: 2 },
  { text: 'Enter saves for this table', drop: 0 },
  { text: 'Esc cancels', drop: 0 },
]

/**
 * How a grid is shown, saved per table in the local config file: which columns and in what order,
 * column widths, fit to content or fill the width, zebra stripes, the header rule, density.
 */
export class GridViewSettingsOverlay implements Overlay {
  readonly id = overlayId('view')
  view: ViewSettings
  order: string[]
  visible: Set<string>
  row = 0
  /** `/` searches the column list (Esc ends the search). */
  readonly search = new LineEditor('')
  searching = false
  readonly defaults: string[]

  constructor(private store: AppStore, readonly meta: TableMetaData, readonly key: string, current: string[], private onDone: () => void) {
    this.defaults = defaultColumns(meta)
    this.view = readViewSettings(key)
    const all = Object.values(meta.fields).filter((f) => !f.isHidden).map((f) => f.name)
    this.order = [...current, ...all.filter((n) => !current.includes(n))]
    this.visible = new Set(current)
  }

  /** The grid options below the columns: the value cell holds only the value, `help` explains the selected one. */
  options(): Array<{ label: string; value: string; help: string; toggle: () => void; step?: (delta: number) => void }> {
    const t = theme()
    const sort = this.view.sort as { field: string; asc: boolean } | undefined
    const pinned = Number(this.view.pinned ?? 0)
    return [
      { label: 'Sort', value: sort ? `${this.meta.fields[sort.field]?.label ?? sort.field} ${sort.asc ? 'ascending' : 'descending'}` : 'default order', help: 'the order rows load in · Space chooses the field and direction', toggle: () => this.chooseSort() },
      { label: 'Pinned columns', value: String(pinned), help: 'columns that stay left while scrolling · +/- changes', toggle: () => { this.view.pinned = (pinned + 1) % (MAX_PINNED + 1) }, step: (delta) => { this.view.pinned = Math.max(0, Math.min(MAX_PINNED, pinned + delta)) } },
      { label: 'Width use', value: this.view.fit === 'fill' ? 'fill' : 'fit to content', help: 'fit sizes columns to their values, fill stretches them to the width · Space toggles', toggle: () => { this.view.fit = this.view.fit === 'fill' ? 'content' : 'fill' } },
      { label: 'Zebra stripes', value: (this.view.zebra ?? t.zebraByDefault) ? 'on' : 'off', help: 'shades every other row · Space toggles', toggle: () => { this.view.zebra = !(this.view.zebra ?? t.zebraByDefault) } },
      { label: 'Header rule', value: (this.view.headerRule ?? true) ? 'on' : 'off', help: 'the line under the column headings · Space toggles', toggle: () => { this.view.headerRule = !(this.view.headerRule ?? true) } },
      { label: 'Density', value: this.view.density === 'comfortable' ? 'comfortable' : 'compact', help: 'comfortable puts a blank line between rows · Space toggles', toggle: () => { this.view.density = this.view.density === 'comfortable' ? 'compact' : 'comfortable' } },
    ]
  }

  /** The explanation for the selected row, shown above the key line. */
  rowHelp(): string {
    if (this.row < this.order.length) return 'Space shows or hides this column · Shift+↑↓ or +/- moves it · ←→ or w sets its width · a auto width'
    return this.options()[this.row - this.order.length]?.help ?? ''
  }

  chooseSort(): void {
    const fields = Object.values(this.meta.fields).filter((f) => !f.isHidden)
    this.store.open(new ChoiceOverlay(this.store, 'Sort by', [{ label: '(default order)', value: '' }, ...fields.map((f) => ({ label: f.label, value: f.name, detail: f.name }))], (field) => {
      if (!field) {
        delete this.view.sort
        return
      }
      this.store.open(new ChoiceOverlay(this.store, 'Direction', [{ label: 'Ascending', value: true }, { label: 'Descending', value: false }], (asc) => { this.view.sort = { field, asc } }))
    }))
  }

  save(): void {
    const columns = this.order.filter((n) => this.visible.has(n))
    writeViewSettings(this.key, { ...this.view, columns: columns.length ? columns : undefined })
    this.store.closeOverlay(this)
    this.onDone()
  }

  /** Column indexes shown for the search text (all when empty). */
  matching(): number[] {
    const needle = this.search.value.toLowerCase()
    return this.order.map((n, i) => ({ n, i })).filter(({ n }) => !needle || n.toLowerCase().includes(needle) || (this.meta.fields[n]?.label ?? '').toLowerCase().includes(needle)).map(({ i }) => i)
  }

  onKey(key: Key): void {
    if (this.searching) {
      if (key.name === 'escape' || key.name === 'return') {
        this.searching = false
        const first = this.matching()[0]
        if (first !== undefined) this.row = first
        return
      }
      if (this.search.handle(key)) {
        const first = this.matching()[0]
        if (first !== undefined) this.row = first
      }
      return
    }
    if (charOf(key) === '/') {
      this.searching = true
      return
    }
    const opts = this.options()
    const total = this.order.length + opts.length
    const ch = charOf(key)
    const onColumn = this.row < this.order.length
    const name = this.order[this.row]
    const move = (dir: number) => {
      const j = this.row + dir
      if (!onColumn || j < 0 || j >= this.order.length) return
      ;[this.order[this.row], this.order[j]] = [this.order[j]!, this.order[this.row]!]
      this.row = j
    }
    const width = (delta: number) => {
      if (!name) return
      const w = this.view.widths?.[name] ?? Math.max(this.meta.fields[name]!.label.length + 1, 8)
      this.view.widths = { ...(this.view.widths ?? {}), [name]: Math.max(3, Math.min(120, w + delta)) }
    }
    if (key.name === 'escape') return this.store.closeOverlay(this)
    if (key.name === 'return' || (key.ctrl && key.name === 's')) return this.save()
    if (key.shift && key.name === 'up') return move(-1)
    if (key.shift && key.name === 'down') return move(1)
    if (key.name === 'down') this.row = Math.min(total - 1, this.row + 1)
    else if (key.name === 'up') this.row = Math.max(0, this.row - 1)
    else if (key.name === 'pagedown') this.row = Math.min(total - 1, this.row + 10)
    else if (key.name === 'pageup') this.row = Math.max(0, this.row - 10)
    else if (key.name === 'space') {
      if (onColumn && name) {
        if (this.visible.has(name)) this.visible.delete(name)
        else this.visible.add(name)
      } else opts[this.row - this.order.length]?.toggle()
    } else if ((ch === '+' || ch === ']') && !onColumn) opts[this.row - this.order.length]?.step?.(1)
    else if ((ch === '-' || ch === '[') && !onColumn) opts[this.row - this.order.length]?.step?.(-1)
    else if (ch === '+' || ch === ']') move(1)
    else if (ch === '-' || ch === '[') move(-1)
    else if (ch === '>' || key.name === 'right') width(1)
    else if (ch === '<' || key.name === 'left') width(-1)
    else if (ch === 'a' && name) {
      const widths = { ...(this.view.widths ?? {}) }
      delete widths[name]
      this.view.widths = widths
    } else if (ch === 'w' && name) {
      this.store.open(new PromptOverlay(this.store, `Width of ${this.meta.fields[name]!.label}`, 'Cells (3 to 120); empty fits the column to its content.', (v) => {
        const widths = { ...(this.view.widths ?? {}) }
        if (!v.trim()) delete widths[name]
        else if (/^\d+$/.test(v.trim())) widths[name] = Math.max(3, Math.min(120, Number(v.trim())))
        this.view.widths = widths
      }, String(this.view.widths?.[name] ?? '')))
    } else if (ch === 'r') {
      this.view = {}
      this.visible = new Set(this.order.slice(0, 0))
      writeViewSettings(this.key, undefined)
      this.store.closeOverlay(this)
      this.onDone()
    }
  }

  render(sw: number, sh: number) {
    const t = theme()
    const g = glyphs()
    const width = Math.min(sw - 4, 80)
    const inner = width - 2
    const opts = this.options()
    const match = new Set(this.matching())
    const changed = (n: string, i: number) => this.visible.has(n) !== this.defaults.includes(n) || (this.visible.has(n) && this.defaults.indexOf(n) !== this.order.filter((x) => this.visible.has(x)).indexOf(n)) || Boolean(this.view.widths?.[n])
    const groupOf = (n: string) => (n.includes('.') ? (this.meta.fields[n]?.label.split(':')[0] ?? n.split('.')[0]!) : 'Fields')
    const items: Array<{ text: string; idx: number; heading?: boolean }> = []
    let lastGroup = ''
    this.order.forEach((n, i) => {
      if (!match.has(i)) return
      const group = groupOf(n)
      if (group !== lastGroup) {
        items.push({ text: `${group} (${this.order.filter((x) => groupOf(x) === group && this.visible.has(x)).length} of ${this.order.filter((x) => groupOf(x) === group).length} shown)`, idx: -1 - items.length, heading: true })
        lastGroup = group
      }
      items.push({ text: `${changed(n, i) ? '*' : ' '}${this.visible.has(n) ? g.check : g.uncheck} ${pad(this.meta.fields[n]!.label, 30)} ${this.view.widths?.[n] ? `width ${this.view.widths[n]}` : 'auto width'}`, idx: i })
    })
    items.push(
      ...opts.map((o, i) => ({ text: `    ${pad(o.label, 31)} ${o.value}`, idx: this.order.length + i })),
    )
    const keys = fitKeyLine(VIEW_SETTINGS_KEYS, inner - 2, 3)
    const searchLine = this.searching || this.search.value ? 1 : 0
    // border 2 + blank 1 + row help 1 + key lines + search line, and one screen row above and below
    const chrome = 4 + keys.length + searchLine
    const rows = Math.max(3, Math.min(items.length, sh - chrome - 4))
    const selAt = Math.max(0, items.findIndex((it) => it.idx === this.row))
    const top = Math.max(0, Math.min(selAt - Math.floor(rows / 2), items.length - rows))
    return (
      <Frame title={`View settings · ${this.meta.label} · ${this.visible.size} of ${this.order.length} columns shown`} width={width} height={rows + chrome} screenWidth={sw} screenHeight={sh}>
        {this.searching || this.search.value ? <box paddingLeft={1}><EditorLine editor={this.search} width={inner - 2} focused={this.searching} placeholder="search columns" /></box> : null}
        {items.slice(top, top + rows).map((it) => {
          const sel = it.idx === this.row
          if (it.heading) return <text flexShrink={0} wrapMode="none" key={it.idx} fg={t.acc}>{pad(` ${it.text}`, inner)}</text>
          const isOpt = it.idx >= this.order.length
          return <Zone key={it.idx} {...pickRow(() => { this.row = it.idx }, () => this.onKey({ name: 'space', sequence: ' ' }))}><text flexShrink={0} wrapMode="none" fg={sel ? t.selFg : isOpt ? t.acc : t.fg} bg={sel ? t.selBg : undefined}>{pad(` ${it.text}`, inner)}</text></Zone>
        })}
        <Line text="" width={inner} />
        <Line text={` ${fitKeyLine(this.rowHelp().split(KEY_SEP), inner - 2, 1)[0] ?? ''}`} width={inner} fg={t.acc} />
        {keys.map((k, i) => <Line key={`k${i}`} text={` ${k}`} width={inner} fg={t.dim} />)}
      </Frame>
    )
  }
}
