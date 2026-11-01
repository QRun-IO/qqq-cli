/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The typed half of the date control: a LineEditor whose text is the value in the profile's
 * display format. It is given and gives back the kernel's canonical values (`YYYY-MM-DD`, local
 * `YYYY-MM-DDTHH:MM:SS`); what is typed is read by the kernel's lenient parser (parseDateInput),
 * so `2026-3-5`, `3/5` (with a date order), `t`, `n` and `now(-7d)` all work, and a refusal comes
 * back with its reason. Backspace or Delete on a value that was not typed just now clears it, when
 * the field may be empty.
 */

import {
  defaultTimeZone, formatDateValue, formatHint, nowIn, parseCanonical, parseDateInput, zoneLabel,
  type DateKind, type DateParse, type ResolvedDateSettings, type WallDate,
} from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { LineEditor } from '../line-editor'

export interface DateEditorOptions {
  kind: DateKind
  settings: ResolvedDateSettings
  /** The field may be empty: Backspace on a whole value clears it. */
  nullable: boolean
  timeZone?: string
  /** Show and keep seconds (else they show when the value has them). */
  withSeconds?: boolean
  /** Relative forms: resolved to a date (forms) or kept as expressions (filters). */
  expressions?: 'resolve' | 'keep'
}

export class DateEditor extends LineEditor {
  /** The text is a whole value that was set, not typed (Backspace clears it). */
  pristine = true
  readonly withSeconds: boolean
  readonly timeZone: string
  /** Where the field was last drawn (an OpenTUI renderable), for anchoring the picker. */
  anchorNode?: { x: number; y: number }

  constructor(stored: unknown, readonly options: DateEditorOptions) {
    const timeZone = options.timeZone ?? defaultTimeZone()
    const wall = parseCanonical(stored, timeZone)
    const withSeconds = options.withSeconds ?? (options.kind === 'DATE_TIME' && Boolean(wall?.second))
    super(formatDateValue(stored, options.kind, options.settings, { timeZone, withSeconds }))
    this.withSeconds = withSeconds
    this.timeZone = timeZone
  }

  get kind(): DateKind {
    return this.options.kind
  }

  /** Sets a stored value (canonical, an instant, or other text, shown as it is). */
  override set(value: string): void {
    super.set(formatDateValue(value === '' ? null : value, this.options.kind, this.options.settings, { timeZone: this.timeZone, withSeconds: this.withSeconds }))
    this.pristine = true
  }

  /** Reads the text: no value, a canonical value, an expression (filters), or the reason it is not a date. */
  resolve(): DateParse {
    return parseDateInput(this.value, { kind: this.options.kind, settings: this.options.settings, timeZone: this.timeZone, expressions: this.options.expressions ?? 'resolve', withSeconds: this.withSeconds })
  }

  /** The stored form of the text ('' for none); the text itself when it is not a date. */
  storedText(): string {
    const r = this.resolve()
    return r.ok ? r.value ?? '' : this.value
  }

  /** The date the text names (for the picker to start on), if any. */
  wall(): WallDate | undefined {
    const r = this.resolve()
    return r.ok && 'wall' in r ? r.wall : undefined
  }

  /** The format hint: `YYYY-MM-DD`, `MM/DD/YYYY hh:mm AM CST`. */
  hint(): string {
    const format = formatHint(this.options.kind, this.options.settings, this.withSeconds)
    if (this.options.kind === 'DATE') return format
    const w = this.wall()
    const zone = zoneLabel(w ?? nowIn(this.timeZone), this.timeZone).split(',')[0]
    return `${format} ${zone}`
  }

  override handle(key: Key): boolean {
    if ((key.name === 'backspace' || key.name === 'delete') && this.pristine && this.value && this.options.nullable && !key.ctrl && !key.meta) {
      super.set('')
      this.pristine = false
      return true
    }
    const before = this.value
    const used = super.handle(key)
    if (used && this.value !== before) this.pristine = false
    return used
  }

  override insert(text: string): void {
    super.insert(text)
    this.pristine = false
  }
}

/** The text a field editor stands for: a date editor's stored form, else the text. */
export function storedTextOf(editor: LineEditor | undefined): string | undefined {
  if (!editor) return undefined
  return editor instanceof DateEditor ? editor.storedText() : editor.value
}

/**
 * The value to commit from a field editor: the typed text, or for a date editor its canonical
 * value ('' for none), after which the editor shows it in the display format; or the reason it is
 * not a date.
 */
export function committedText(editor: LineEditor): { text: string } | { error: string } {
  if (!(editor instanceof DateEditor)) return { text: editor.value }
  const r = editor.resolve()
  if (!r.ok) return { error: r.reason }
  if (r.value !== null && 'wall' in r) editor.set(r.value)
  return { text: r.value ?? '' }
}

/** Why the date editor's text cannot be committed, or undefined (not a date editor, or fine). */
export function dateProblem(editor: LineEditor | undefined): string | undefined {
  if (!(editor instanceof DateEditor)) return undefined
  const r = editor.resolve()
  return r.ok ? undefined : r.reason
}
