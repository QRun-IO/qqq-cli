/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { getDependencies, type FormSession, type PossibleValue } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { LineEditor } from '../line-editor'
import type { AppStore } from '../store'
import { theme } from '../theme'
import type { Overlay } from '../types'
import { errorText, pad } from '../util/text'
import { EditorLine, overlayId } from './basic'
import { Frame, Line } from './frame'

/**
 * A possible-value picker: searches the field's choices on the server as you type, honouring the
 * values of the fields it depends on (contingent fields narrow: country, then state, then city).
 */
export class PickerOverlay implements Overlay {
  readonly id = overlayId('picker')
  readonly search: LineEditor
  options: PossibleValue[] = []
  index = 0
  loading = false
  error?: string
  private timer?: ReturnType<typeof setTimeout>
  private generation = 0

  constructor(private store: AppStore, private session: FormSession, readonly field: string, private onPick: (option: PossibleValue | null) => void, initial = '') {
    this.search = new LineEditor(initial)
    this.fetch()
  }

  fetch(): void {
    const gen = ++this.generation
    this.loading = true
    this.session.options(this.field, this.search.value, 100).then((options) => {
      if (gen !== this.generation) return
      this.options = options
      this.index = Math.min(this.index, Math.max(0, options.length - 1))
      this.loading = false
      this.error = undefined
      this.store.bump()
    }).catch((e) => {
      if (gen !== this.generation) return
      this.loading = false
      this.error = errorText(e)
      this.store.bump()
    })
  }

  onKey(key: Key): void {
    if (key.name === 'escape') return this.store.closeOverlay(this)
    if (key.name === 'down') this.index = Math.min(this.options.length - 1, this.index + 1)
    else if (key.name === 'up') this.index = Math.max(0, this.index - 1)
    else if (key.name === 'pagedown') this.index = Math.min(this.options.length - 1, this.index + 10)
    else if (key.name === 'pageup') this.index = Math.max(0, this.index - 10)
    else if (key.name === 'return') {
      const o = this.options[this.index]
      if (!o) return
      this.store.closeOverlay(this)
      this.onPick(o)
    } else if (key.ctrl && key.name === 'd') {
      this.store.closeOverlay(this)
      this.onPick(null)
    } else if (this.search.handle(key)) {
      this.index = 0
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.fetch(), 150)
    }
  }

  render(sw: number, sh: number) {
    const t = theme()
    const f = this.session.fields[this.field]!
    const deps = getDependencies(f).filter((d) => this.session.values[d] !== undefined && this.session.values[d] !== null && this.session.values[d] !== '')
    const narrowed = deps.map((d) => `${this.session.fields[d]?.label ?? d} = ${this.session.displayValues[d] ?? String(this.session.values[d])}`).join(', ')
    const width = Math.min(sw - 4, 70)
    const rows = Math.max(4, Math.min(16, sh - 12))
    const top = Math.max(0, Math.min(this.index - Math.floor(rows / 2), this.options.length - rows))
    const shown = this.options.slice(top, top + rows)
    return (
      <Frame title={`Choose ${f.label}`} width={width} height={rows + 6} screenWidth={sw} screenHeight={sh}>
        <box paddingLeft={1}><EditorLine editor={this.search} width={width - 4} placeholder="type to search" /></box>
        <Line text={narrowed ? ` narrowed by ${narrowed}` : ''} width={width - 2} fg={t.dim} />
        {shown.map((o, i) => {
          const sel = top + i === this.index
          return <text key={String(o.id)} fg={sel ? t.selFg : t.fg} bg={sel ? t.selBg : undefined}>{pad(` ${o.label}`, width - 2)}</text>
        })}
        {Array.from({ length: rows - shown.length }, (_, i) => <Line key={`e${i}`} text={i === 0 && !shown.length ? (this.error ? ` ${this.error}` : this.loading ? ' searching…' : ' (no choices)') : ''} width={width - 2} fg={this.error ? t.err : t.dim} />)}
        <Line text={` ${this.options.length} shown · ↑↓ Enter picks · Ctrl+D clears · Esc`} width={width - 2} fg={t.dim} />
      </Frame>
    )
  }
}
