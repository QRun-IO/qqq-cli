/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Key } from './keys'
import { isPrintable } from './keys'

/**
 * A one-line text editor driven by key events, not by OpenTUI's focused input: the value and the
 * cursor live in this object, so keys that arrive in one burst (paste, automation, a fast typist)
 * all land in the field that had focus when they were read, never in a stale one.
 */
export class LineEditor {
  value: string
  cursor: number
  masked: boolean

  /** What a pasted line break becomes (a space in text fields; ', ' where values are lists). */
  newline: string

  constructor(value = '', options: { masked?: boolean; newline?: string } = {}) {
    this.value = value
    this.cursor = value.length
    this.masked = Boolean(options.masked)
    this.newline = options.newline ?? ' '
  }

  set(value: string): void {
    this.value = value
    this.cursor = value.length
  }

  insert(text: string): void {
    const clean = text.replace(/\r\n|\r|\n/g, this.newline).replace(/\t/g, this.newline === ' ' ? ' ' : this.newline)
    this.value = this.value.slice(0, this.cursor) + clean + this.value.slice(this.cursor)
    this.cursor += clean.length
  }

  /** Handles an editing key; returns whether it was one. */
  handle(key: Key): boolean {
    if (key.ctrl && key.name === 'u') {
      this.value = this.value.slice(this.cursor)
      this.cursor = 0
      return true
    }
    if (key.ctrl && key.name === 'k') {
      this.value = this.value.slice(0, this.cursor)
      return true
    }
    if (key.ctrl && key.name === 'a') {
      this.cursor = 0
      return true
    }
    if (key.ctrl && key.name === 'e') {
      this.cursor = this.value.length
      return true
    }
    if (key.ctrl && key.name === 'w') {
      const before = this.value.slice(0, this.cursor).replace(/\S+\s*$/, '')
      this.value = before + this.value.slice(this.cursor)
      this.cursor = before.length
      return true
    }
    switch (key.name) {
      case 'backspace':
        if (this.cursor > 0) {
          this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor)
          this.cursor--
        }
        return true
      case 'delete':
        this.value = this.value.slice(0, this.cursor) + this.value.slice(this.cursor + 1)
        return true
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1)
        return true
      case 'right':
        this.cursor = Math.min(this.value.length, this.cursor + 1)
        return true
      case 'home':
        this.cursor = 0
        return true
      case 'end':
        this.cursor = this.value.length
        return true
      default:
        if (isPrintable(key)) {
          this.insert(key.sequence)
          return true
        }
        return false
    }
  }

  /** The visible window of the text for a width, with the cursor position inside it. */
  view(width: number): { before: string; at: string; after: string } {
    const shown = this.masked ? '•'.repeat(this.value.length) : this.value
    const start = Math.max(0, this.cursor - width + 1)
    const visible = shown.slice(start, start + width)
    const c = this.cursor - start
    return { before: visible.slice(0, c), at: visible[c] ?? ' ', after: visible.slice(c + 1) }
  }
}
