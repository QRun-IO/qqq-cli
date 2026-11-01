/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Ctrl+R on the `:` line: reverse search through the history, as bash does. Typing narrows to
 * lines containing the text (any case); Ctrl+R again (or ↑) goes to the next older match, ↓ back to
 * a newer one; Enter runs the match; Esc, ← → or Tab put it on the line to edit; Ctrl+G cancels.
 * The lines are the `:` commands and CLI commands of the activity log (this profile, newest
 * first), then the `:` line's own history.
 */

import { readActivity, type History } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { LineEditor } from '../line-editor'

export type SearchResult = 'run' | 'edit' | 'cancel' | undefined

export class ReverseSearch {
  readonly editor = new LineEditor('')
  /** Which match is shown: 0 is the newest. */
  index = 0

  constructor(private readonly lines: () => string[]) {}

  matches(): string[] {
    const needle = this.editor.value.toLowerCase()
    return this.lines().filter((l) => l.toLowerCase().includes(needle))
  }

  current(): string | undefined {
    return this.matches()[this.index]
  }

  /** Handles a key: `run` / `edit` take `current()`, `cancel` leaves the line as it was. */
  handle(key: Key): SearchResult {
    if (key.ctrl && key.name === 'g') return 'cancel'
    if (key.name === 'return') return this.current() !== undefined ? 'run' : 'cancel'
    if (key.name === 'escape' || key.name === 'left' || key.name === 'right' || key.name === 'tab') return this.current() !== undefined ? 'edit' : 'cancel'
    if ((key.ctrl && key.name === 'r') || key.name === 'up') {
      if (this.index < this.matches().length - 1) this.index++
      return undefined
    }
    if (key.name === 'down') {
      if (this.index > 0) this.index--
      return undefined
    }
    const before = this.editor.value
    this.editor.handle(key)
    if (this.editor.value !== before) this.index = 0
    return undefined
  }

  /** The search line as bash shows it: `(reverse-i-search 2/5)'tab': table query person`. */
  prompt(): string {
    const all = this.matches()
    const hit = all[this.index]
    return `(reverse-i-search${all.length > 1 ? ` ${this.index + 1}/${all.length}` : ''})'${this.editor.value}': ${hit ?? '(no match)'}`
  }
}

/**
 * The lines Ctrl+R searches, newest first and without repeats: the activity log's commands of the
 * profile (`qqq ` and `:` taken off, entries with redacted secrets left out), then the `:` history.
 */
export function searchLines(profile: string | undefined, history?: History): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (line: string | undefined) => {
    const text = line?.trim()
    if (!text || seen.has(text)) return
    seen.add(text)
    out.push(text)
  }
  try {
    const entries = profile ? readActivity({ profile }) : []
    for (let i = entries.length - 1; i >= 0; i--) {
      const command = entries[i]!.command
      if (!command || command.includes('***')) continue
      // the profile and server are this session's: their options are left out
      add(command.replace(/^(qqq\s+|:)/, '').replace(/(^|\s)(--server|--profile|-p)(=|\s+)("[^"]*"|\S+)/g, '').trim())
    }
  } catch {
    // no log: the : history alone
  }
  for (const line of history?.entries() ?? []) add(line)
  return out
}
