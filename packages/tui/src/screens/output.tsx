/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Key } from '../keys'
import { charOf } from '../keys'
import { structuredLines } from '../structured'
import type { AppStore } from '../store'
import { theme } from '../theme'
import type { FKeyLabels, MenuEntry, Screen } from '../types'
import { pad } from '../util/text'
import { Panel } from './list'

/** The output of a `:` command run through the CLI in-process (runCli), scrollable. */
export class OutputScreen implements Screen {
  readonly kind = 'output'
  readonly id: string
  lines: Array<{ text: string; err?: boolean }> = []
  top = 0
  height = 10
  code?: number
  running = true
  /** JSON output (an extension operation) drawn as key/value rows and sub-tables; J shows it raw. */
  structured?: { value: unknown; raw: string }
  showRaw = false
  private width = 100

  constructor(private store: AppStore, readonly command: string) {
    this.id = `output:${Date.now()}`
  }

  title(): string {
    return `: ${this.command}`
  }

  append(text: string, err = false): void {
    const parts = text.replace(/\r/g, '').split('\n')
    if (parts[parts.length - 1] === '') parts.pop()
    for (const p of parts) this.lines.push({ text: p, err })
    this.store.bump()
  }

  /** Shows JSON output structured (the raw text stays available with J). */
  setStructured(value: unknown, raw: string): void {
    this.structured = { value, raw }
    this.store.bump()
  }

  /** The lines on screen: the structured view, the raw JSON, or the command's text output. */
  shownLines(): Array<{ text: string; err?: boolean; fg?: string; bold?: boolean }> {
    if (!this.structured) return this.lines
    const body = this.showRaw ? JSON.stringify(this.structured.value, null, 2).split('\n').map((text) => ({ text })) : structuredLines(this.structured.value, this.width - 3)
    return [...body, ...this.lines.filter((l) => l.err)]
  }

  done(code: number): void {
    this.code = code
    this.running = false
    this.store.bump()
  }

  fkeys(): FKeyLabels {
    return { 3: null, 4: null, 6: null, 7: null, 8: null, 5: 'Re-run' }
  }

  refresh(): void {
    this.store.back()
    void this.store.commands().run(this.command)
  }

  onKey(raw: Key): boolean {
    const key: Key = raw.name === 'space' ? { name: raw.shift ? 'pageup' : 'pagedown', sequence: '' } : raw
    const max = Math.max(0, this.shownLines().length - this.height)
    if (this.structured && charOf(key) === 'J' && this.store.singleKeys) {
      this.showRaw = !this.showRaw
      this.top = 0
      return true
    }
    switch (key.name) {
      case 'down': this.top = Math.min(max, this.top + 1); return true
      case 'up': this.top = Math.max(0, this.top - 1); return true
      case 'pagedown': this.top = Math.min(max, this.top + this.height - 1); return true
      case 'pageup': this.top = Math.max(0, this.top - this.height + 1); return true
      case 'home': this.top = 0; return true
      case 'end': this.top = max; return true
      case 'right': case 'left': return true
      case 'return': this.store.back(); return true
      default: return false
    }
  }

  menu(): MenuEntry[] {
    return [
      ...(this.structured ? [{ section: 'Context' as const, label: this.showRaw ? 'Show as rows and tables' : 'Show the raw JSON', key: 'J', run: () => { this.showRaw = !this.showRaw; this.top = 0 } }] : []),
      { section: 'Context', label: 'Run the command again', key: 'F5', run: () => this.refresh() },
      { section: 'Context', label: 'Edit the command', run: () => this.store.commands().commandLine(this.command) },
    ]
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    this.height = height - 3
    this.width = width
    const all = this.shownLines()
    const shown = all.slice(this.top, this.top + this.height)
    const rows = shown.map((l, i) => <text flexShrink={0} wrapMode="none" key={i} fg={l.err ? t.err : l.fg ?? t.fg}>{l.bold ? <strong>{pad(l.text, width - 2)}</strong> : pad(l.text, width - 2)}</text>)
    while (rows.length < this.height) rows.push(<text flexShrink={0} wrapMode="none" key={`p${rows.length}`}>{pad('', width - 2)}</text>)
    const status = this.running ? 'running…' : `exit ${this.code}${this.code === 0 ? '' : ' (see the message above)'} · ${all.length} lines${this.structured ? ` · J ${this.showRaw ? 'rows and tables' : 'raw JSON'}` : ''} · ↑↓ PgUp PgDn scroll · F5 again · Enter or Esc closes`
    return (
      <Panel title={`qqq ${this.command}`} width={width} height={height} focused={focused}>
        {rows}
        <text flexShrink={0} wrapMode="none" fg={this.code ? t.err : t.dim}>{pad(` ${status}`, width - 2)}</text>
      </Panel>
    )
  }
}
