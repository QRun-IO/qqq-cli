/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Key } from '../keys'
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

  onKey(key: Key): boolean {
    const max = Math.max(0, this.lines.length - this.height)
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
      { section: 'Context', label: 'Run the command again', key: 'F5', run: () => this.refresh() },
      { section: 'Context', label: 'Edit the command', run: () => this.store.commands().commandLine(this.command) },
    ]
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    this.height = height - 3
    const shown = this.lines.slice(this.top, this.top + this.height)
    const rows = shown.map((l, i) => <text key={i} fg={l.err ? t.err : t.fg}>{pad(l.text, width - 2)}</text>)
    while (rows.length < this.height) rows.push(<text key={`p${rows.length}`}>{pad('', width - 2)}</text>)
    const status = this.running ? 'running…' : `exit ${this.code}${this.code === 0 ? '' : ' (see the message above)'} · ${this.lines.length} lines · ↑↓ PgUp PgDn scroll · F5 again · Enter or Esc closes`
    return (
      <Panel title={`qqq ${this.command}`} width={width} height={height} focused={focused}>
        {rows}
        <text fg={this.code ? t.err : t.dim}>{pad(` ${status}`, width - 2)}</text>
      </Panel>
    )
  }
}
