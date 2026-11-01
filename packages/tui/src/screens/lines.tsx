/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Key } from '../keys'
import type { AppStore } from '../store'
import { theme } from '../theme'
import type { FKeyLabels, MenuEntry, Screen } from '../types'
import { errorText, hintLine } from '../util/text'
import { ListModel, Panel, type Row } from './list'

/**
 * A screen of rows loaded asynchronously (audits, developer data, APIs): the subclass builds rows,
 * selectable ones carry actions; PgUp/PgDn, Space and Ctrl+F/B page.
 */
export abstract class LinesScreen implements Screen {
  abstract readonly kind: string
  readonly id: string
  readonly list = new ListModel()
  loading = true
  error?: string
  /** Cells inside the panel at the last render (0 before the first). */
  protected width = 0

  constructor(protected store: AppStore, readonly heading: string) {
    this.id = `${heading}:${Date.now()}`
  }

  /** Loads and builds rows; failures show their message (the server's refusal text). */
  protected start(work: () => Promise<Row[]>): void {
    this.loading = true
    work().then((rows) => {
      this.list.setRows(rows.length ? rows : [{ text: '(nothing to show)', fg: theme().dim }])
      this.error = undefined
    }).catch((e) => {
      this.error = errorText(e)
      this.list.setRows([{ text: this.error, fg: theme().err }])
    }).finally(() => {
      this.loading = false
      this.store.bump()
    })
  }

  title(): string {
    return this.heading
  }

  fkeys(): FKeyLabels {
    return { 3: null, 4: null, 6: null, 7: null, 8: null }
  }

  onKey(key: Key): boolean {
    return this.list.onKey(key)
  }

  menu(): MenuEntry[] {
    return this.list.rows.filter((r) => r.action).slice(0, 30).map((r) => ({ section: 'Context' as const, label: r.text.trim(), run: r.action }))
  }

  hint(): string {
    return 'Enter opens · PgUp PgDn page · F5 refresh · Esc back'
  }

  /** Rebuilds rows that were wrapped to the old width (the screen was resized); a no-op by default. */
  protected rewrap(): void {}

  /** Width to wrap text rows to: the panel's inside, before the first render the terminal's. */
  protected wrapWidth(): number {
    return Math.max(20, (this.width || this.store.width) - 2)
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    if (width - 2 !== this.width) {
      this.width = width - 2
      if (!this.loading) this.rewrap()
    }
    if (this.loading && !this.list.rows.length) this.list.setRows([{ text: 'loading…', fg: t.dim }])
    return (
      <Panel title={this.heading} width={width} height={height} focused={focused}>
        {this.list.view(width - 2, height - 3, focused)}
        <text flexShrink={0} wrapMode="none" fg={t.dim}>{hintLine(this.hint(), width - 2)}</text>
      </Panel>
    )
  }
}
