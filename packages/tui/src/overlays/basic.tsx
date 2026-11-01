/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Key } from '../keys'
import { charOf } from '../keys'
import { LineEditor } from '../line-editor'
import type { AppStore } from '../store'
import { theme } from '../theme'
import type { Overlay } from '../types'
import { pad, trunc } from '../util/text'
import { Frame, Line } from './frame'

let ids = 0
export function overlayId(kind: string): string {
  return `${kind}:${++ids}`
}

/** Wraps text into lines of a width. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/)) {
      if (!word) continue
      if ((line + ' ' + word).trim().length > width) {
        if (line) out.push(line)
        line = word.length > width ? word.slice(0, width) : word
      } else {
        line = (line + ' ' + word).trim()
      }
    }
    out.push(line)
  }
  return out
}

export class MessageOverlay implements Overlay {
  readonly id = overlayId('message')
  constructor(private store: AppStore, readonly text: string, readonly kind: 'info' | 'error' = 'info', readonly title?: string) {}
  onKey(): void {
    this.store.closeOverlay(this)
  }
  render(sw: number, sh: number) {
    const width = Math.min(sw - 4, Math.max(36, Math.min(100, this.text.length + 4)))
    const lines = wrap(this.text, width - 4).slice(0, sh - 8)
    return (
      <Frame title={this.title ?? (this.kind === 'error' ? 'Error' : 'Message')} width={width} height={lines.length + 4} screenWidth={sw} screenHeight={sh}>
        {lines.map((l, i) => <Line key={i} text={` ${l}`} width={width - 2} fg={this.kind === 'error' ? theme().err : theme().fg} />)}
        <Line text="" width={width - 2} />
        <Line text=" any key closes" width={width - 2} fg={theme().dim} />
      </Frame>
    )
  }
}

/** The "CLI equivalent" dialog: y, c or Enter copies the command; Esc closes without copying. */
export class CliCommandOverlay implements Overlay {
  readonly id = overlayId('cli')
  private note?: string
  constructor(private store: AppStore, readonly command: string) {
    if (store.settings.copyCli && this.copy()) this.note = 'copied to the clipboard'
  }
  private copy(): boolean {
    const how = this.store.copyText(this.command)
    if (!how) this.note = 'no clipboard here: select the text with Shift+drag'
    else this.note = `copied (${how})`
    return !!how
  }
  onKey(key: Key): void {
    const ch = charOf(key).toLowerCase()
    if (key.name !== 'escape' && !this.note && (ch === 'y' || ch === 'c' || key.name === 'return')) {
      this.copy()
      this.store.bump()
      return
    }
    this.store.closeOverlay(this)
  }
  render(sw: number, sh: number) {
    const width = Math.min(sw - 4, Math.max(54, Math.min(100, this.command.length + 4)))
    const lines = wrap(this.command, width - 4).slice(0, sh - 8)
    const footer = this.note ? ` ${this.note} · any key closes` : ' y copies · Shift+drag selects text · Esc closes'
    return (
      <Frame title="CLI equivalent" width={width} height={lines.length + 4} screenWidth={sw} screenHeight={sh}>
        {lines.map((l, i) => <Line key={i} text={` ${l}`} width={width - 2} fg={theme().fg} />)}
        <Line text="" width={width - 2} />
        <Line text={footer} width={width - 2} fg={theme().dim} />
      </Frame>
    )
  }
}

export class ConfirmOverlay implements Overlay {
  readonly id = overlayId('confirm')
  constructor(private store: AppStore, readonly text: string, private onYes: () => void, private onNo?: () => void, readonly defaultYes = false) {}
  onKey(key: Key): void {
    const ch = charOf(key).toLowerCase()
    if (ch === 'y' || (key.name === 'return' && this.defaultYes)) {
      this.store.closeOverlay(this)
      this.onYes()
    } else if (ch === 'n' || key.name === 'escape' || key.name === 'return') {
      this.store.closeOverlay(this)
      this.onNo?.()
    }
  }
  render(sw: number, sh: number) {
    const width = Math.min(sw - 4, Math.max(40, Math.min(96, this.text.length + 6)))
    const lines = wrap(this.text, width - 4)
    return (
      <Frame title="Confirm" width={width} height={lines.length + 4} screenWidth={sw} screenHeight={sh}>
        {lines.map((l, i) => <Line key={i} text={` ${l}`} width={width - 2} fg={theme().warn} />)}
        <Line text="" width={width - 2} />
        <Line text={this.defaultYes ? ' Y/n   y or Enter = yes, n or Esc = no' : ' y/N   y = yes, n, Esc or Enter = no'} width={width - 2} fg={theme().dim} />
      </Frame>
    )
  }
}

/** Draws a LineEditor with its cursor. */
export function EditorLine(props: { editor: LineEditor; width: number; focused?: boolean; placeholder?: string }) {
  const t = theme()
  const w = Math.max(1, props.width)
  if (!props.editor.value && props.placeholder && props.focused !== false) {
    return <text flexShrink={0} wrapMode="none" bg={t.inputBg}><span fg={t.inputBg} bg={t.inputFg}>{' '}</span><span fg={t.dim} bg={t.inputBg}>{pad(props.placeholder, w - 1)}</span></text>
  }
  const v = props.editor.view(w - 1)
  if (props.focused === false) return <text flexShrink={0} wrapMode="none" fg={t.inputFg} bg={t.inputBg}>{pad(props.editor.masked ? '•'.repeat(props.editor.value.length) : props.editor.value, w)}</text>
  const rest = w - v.before.length - 1 - v.after.length
  return (
    <text flexShrink={0} wrapMode="none" bg={t.inputBg}>
      <span fg={t.inputFg} bg={t.inputBg}>{v.before}</span>
      <span fg={t.inputBg} bg={t.inputFg}>{v.at}</span>
      <span fg={t.inputFg} bg={t.inputBg}>{v.after + ' '.repeat(Math.max(0, rest))}</span>
    </text>
  )
}

export class PromptOverlay implements Overlay {
  readonly id = overlayId('prompt')
  readonly editor: LineEditor
  private onCancel?: () => void
  constructor(private store: AppStore, readonly title: string, readonly hint: string, private onSubmit: (value: string) => void, initial = '', options: { masked?: boolean; newline?: string; onCancel?: () => void } = {}) {
    this.editor = new LineEditor(initial, options)
    this.onCancel = options.onCancel
  }
  paste(text: string): void {
    this.editor.insert(text)
  }
  onKey(key: Key): void {
    if (key.name === 'escape') {
      this.store.closeOverlay(this)
      this.onCancel?.()
    }
    else if (key.name === 'return') {
      this.store.closeOverlay(this)
      this.onSubmit(this.editor.value)
    } else this.editor.handle(key)
  }
  render(sw: number, sh: number) {
    const width = Math.min(sw - 4, 90)
    const hint = wrap(this.hint, width - 4)
    return (
      <Frame title={this.title} width={width} height={hint.length + 4} screenWidth={sw} screenHeight={sh}>
        <box paddingLeft={1}><EditorLine editor={this.editor} width={width - 4} /></box>
        <Line text="" width={width - 2} />
        {hint.map((l, i) => <Line key={i} text={` ${l}`} width={width - 2} fg={theme().dim} />)}
      </Frame>
    )
  }
}

export interface Choice<T> {
  label: string
  value: T
  detail?: string
  disabled?: string
}

/** A list to pick from, filtered as you type. */
export class ChoiceOverlay<T> implements Overlay {
  readonly id = overlayId('choice')
  readonly filter = new LineEditor('')
  index = 0
  constructor(private store: AppStore, readonly title: string, readonly choices: Choice<T>[], private onPick: (value: T) => void, readonly hint = '', initialIndex = 0, private onCancel?: () => void) {
    this.index = Math.max(0, initialIndex)
  }
  matches(): Choice<T>[] {
    const needle = this.filter.value.toLowerCase()
    return needle ? this.choices.filter((c) => c.label.toLowerCase().includes(needle) || String(c.detail ?? '').toLowerCase().includes(needle)) : this.choices
  }
  onKey(key: Key): void {
    const list = this.matches()
    if (key.name === 'escape') {
      this.store.closeOverlay(this)
      this.onCancel?.()
    } else if (key.name === 'down') this.index = Math.min(list.length - 1, this.index + 1)
    else if (key.name === 'up') this.index = Math.max(0, this.index - 1)
    else if (key.name === 'pagedown') this.index = Math.min(list.length - 1, this.index + 10)
    else if (key.name === 'pageup') this.index = Math.max(0, this.index - 10)
    else if (key.name === 'return') {
      const c = list[this.index]
      if (c && !c.disabled) {
        this.store.closeOverlay(this)
        this.onPick(c.value)
      } else if (c?.disabled) this.store.flash(c.disabled)
    } else if (this.filter.handle(key)) this.index = 0
  }
  render(sw: number, sh: number) {
    const t = theme()
    const list = this.matches()
    const width = Math.min(sw - 4, Math.max(40, Math.min(100, Math.max(...this.choices.map((c) => c.label.length + (c.detail ? c.detail.length + 4 : 0) + 6), this.title.length + 6))))
    const rows = Math.max(3, Math.min(list.length, sh - 10))
    const top = Math.max(0, Math.min(this.index - Math.floor(rows / 2), list.length - rows))
    const shown = list.slice(top, top + rows)
    return (
      <Frame title={this.title} width={width} height={rows + 5} screenWidth={sw} screenHeight={sh}>
        <box paddingLeft={1}><EditorLine editor={this.filter} width={width - 4} placeholder="type to filter" /></box>
        {shown.map((c, i) => {
          const sel = top + i === this.index
          const detail = c.disabled ?? c.detail ?? ''
          const labelWidth = width - 4 - (detail ? Math.min(detail.length, Math.floor(width / 2)) + 1 : 0)
          return <text flexShrink={0} wrapMode="none" key={i} fg={sel ? t.selFg : c.disabled ? t.dim : t.fg} bg={sel ? t.selBg : undefined}>{pad(` ${pad(c.label, labelWidth)}${detail ? ' ' + trunc(detail, width - 5 - labelWidth) : ''}`, width - 2)}</text>
        })}
        {Array.from({ length: rows - shown.length }, (_, i) => <Line key={`e${i}`} text={i === 0 && !shown.length ? ' (nothing matches)' : ''} width={width - 2} fg={t.dim} />)}
        <Line text={` ${list.length} of ${this.choices.length} · ↑↓ Enter · Esc${this.hint ? ' · ' + this.hint : ''}`} width={width - 2} fg={t.dim} />
      </Frame>
    )
  }
}
