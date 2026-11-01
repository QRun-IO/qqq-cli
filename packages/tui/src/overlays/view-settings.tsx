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
import { pad } from '../util/text'
import { ChoiceOverlay, PromptOverlay, overlayId } from './basic'
import { Frame, Line } from './frame'

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

  constructor(private store: AppStore, readonly meta: TableMetaData, readonly key: string, current: string[], private onDone: () => void) {
    this.view = readViewSettings(key)
    const all = Object.values(meta.fields).filter((f) => !f.isHidden).map((f) => f.name)
    this.order = [...current, ...all.filter((n) => !current.includes(n))]
    this.visible = new Set(current)
  }

  options(): Array<{ label: string; value: string; toggle: () => void }> {
    const t = theme()
    const sort = this.view.sort as { field: string; asc: boolean } | undefined
    return [
      { label: 'Sort', value: sort ? `${this.meta.fields[sort.field]?.label ?? sort.field} ${sort.asc ? 'ascending' : 'descending'}` : 'default order', toggle: () => this.chooseSort() },
      { label: 'Width use', value: this.view.fit === 'fill' ? 'fill the terminal width' : 'fit to content', toggle: () => { this.view.fit = this.view.fit === 'fill' ? 'content' : 'fill' } },
      { label: 'Zebra stripes', value: (this.view.zebra ?? t.zebraByDefault) ? 'on' : 'off', toggle: () => { this.view.zebra = !(this.view.zebra ?? t.zebraByDefault) } },
      { label: 'Header rule', value: (this.view.headerRule ?? true) ? 'on' : 'off', toggle: () => { this.view.headerRule = !(this.view.headerRule ?? true) } },
      { label: 'Density', value: this.view.density === 'comfortable' ? 'comfortable (blank line between rows)' : 'compact', toggle: () => { this.view.density = this.view.density === 'comfortable' ? 'compact' : 'comfortable' } },
    ]
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

  onKey(key: Key): void {
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
    } else if (ch === '+' || ch === ']') move(1)
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
    const items = [
      ...this.order.map((n, i) => ({ text: `${this.visible.has(n) ? g.check : g.uncheck} ${pad(this.meta.fields[n]!.label, 28)} ${this.view.widths?.[n] ? `width ${this.view.widths[n]}` : 'auto width'}`, idx: i })),
      ...opts.map((o, i) => ({ text: `    ${pad(o.label, 28)} ${o.value}`, idx: this.order.length + i })),
    ]
    const rows = Math.max(5, Math.min(items.length, sh - 10))
    const top = Math.max(0, Math.min(this.row - Math.floor(rows / 2), items.length - rows))
    return (
      <Frame title={`View settings · ${this.meta.label}`} width={width} height={rows + 5} screenWidth={sw} screenHeight={sh}>
        {items.slice(top, top + rows).map((it) => {
          const sel = it.idx === this.row
          const isOpt = it.idx >= this.order.length
          return <text flexShrink={0} wrapMode="none" key={it.idx} fg={sel ? t.selFg : isOpt ? t.acc : t.fg} bg={sel ? t.selBg : undefined}>{pad(` ${it.text}`, inner)}</text>
        })}
        <Line text="" width={inner} />
        <Line text=" Space on/off (on Sort: choose) · Shift+↑↓ or +/- move · ←→ width · w width · a auto" width={inner} fg={t.dim} />
        <Line text=" r reset to defaults · Enter saves (kept for this table) · Esc cancels" width={inner} fg={t.dim} />
      </Frame>
    )
  }
}
