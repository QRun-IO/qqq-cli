/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The picker half of the date control: a month calendar popup anchored to the field (F2 or
 * Ctrl+Space), with a time row for DATE_TIME fields and the zone shown (local, what is sent, and
 * the server's declared zone when it has one). Keys: ←→ a day, ↑↓ a week, PgUp/PgDn a month,
 * Shift+PgUp/PgDn a year, Home/End first/last of the month, t today, n now; Tab moves to the hour,
 * minute (second, AM/PM) which take digits or ↑↓; Enter accepts, Esc cancels. Typing a digit on
 * the calendar hands it to typed entry (where the opener allows it). Also: the field line that
 * draws a DateEditor with its dim format hint, the small prompt the bulk editor uses, and the key
 * handler forms share.
 */

import {
  addDays, addMonths, canonicalOf, daysInMonth, defaultTimeZone, formatDatePart, localToUtc, MONTH_NAMES, monthGrid, nowIn, weekdayHeadings, zoneLabel,
  type DateKind, type ResolvedDateSettings, type WallDate,
} from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { charOf } from '../keys'
import type { AppStore } from '../store'
import { isAscii, theme } from '../theme'
import type { Overlay } from '../types'
import { overlayId } from '../overlays/basic'
import { Frame, Line } from '../overlays/frame'
import { center, pad, trunc } from '../util/text'
import { DateEditor } from './date-editor'
import { dateSettingsFor, serverZoneOf } from './date-settings'

type Part = 'date' | 'hour' | 'minute' | 'second' | 'ampm'

export interface DatePickerOptions {
  title: string
  kind: DateKind
  settings: ResolvedDateSettings
  /** The date to start on (else now). */
  initial?: WallDate
  timeZone?: string
  withSeconds?: boolean
  /** The server's declared zone, shown beside the local one. */
  serverZone?: string
  /** The field's top-left cell on the screen: the popup opens below it (or above when it does not fit). */
  anchor?: { x: number; y: number }
  onAccept: (value: string, wall: WallDate) => void
  onCancel?: () => void
  /** A character typed on the calendar: hand it to typed entry (the picker closes). */
  onType?: (ch: string) => void
  /** `p`: the expression presets (filters). */
  onPresets?: () => void
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Joins key hints (or words, with a space separator) into lines no wider than `width`. */
export function wrapItems(items: string[], width: number, separator = ' · '): string[] {
  const lines: string[] = []
  let line = ''
  for (const item of items) {
    const next = line ? `${line}${separator}${item}` : item
    if (next.length > width && line) {
      lines.push(line)
      line = item
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

export class DatePickerOverlay implements Overlay {
  readonly id = overlayId('date')
  cursor: WallDate
  part: Part = 'date'
  /** Digits typed into the focused time part. */
  typed = ''
  readonly timeZone: string
  readonly withSeconds: boolean
  readonly today: WallDate

  constructor(private store: AppStore, readonly options: DatePickerOptions) {
    this.timeZone = options.timeZone ?? defaultTimeZone()
    this.today = nowIn(this.timeZone)
    this.withSeconds = options.withSeconds ?? false
    const start = options.initial ?? { ...this.today, second: 0 }
    this.cursor = options.kind === 'DATE' ? { ...start, hour: 0, minute: 0, second: 0 } : { ...start, second: this.withSeconds ? start.second : 0 }
  }

  /** The time parts in Tab order. */
  parts(): Part[] {
    if (this.options.kind === 'DATE') return ['date']
    return ['date', 'hour', 'minute', ...(this.withSeconds ? ['second' as const] : []), ...(this.options.settings.clock === '12h' ? ['ampm' as const] : [])]
  }

  value(): string {
    return canonicalOf(this.cursor, this.options.kind)
  }

  accept(): void {
    this.store.closeOverlay(this)
    this.options.onAccept(this.value(), { ...this.cursor })
  }

  cancel(): void {
    this.store.closeOverlay(this)
    this.options.onCancel?.()
  }

  movePart(delta: number): void {
    const parts = this.parts()
    this.part = parts[(parts.indexOf(this.part) + delta + parts.length) % parts.length]!
    this.typed = ''
  }

  /** ↑↓ on a time part (wrapping). */
  step(delta: number): void {
    const c = this.cursor
    const wrap = (v: number, n: number) => ((v % n) + n) % n
    if (this.part === 'hour') c.hour = wrap(c.hour + delta, 24)
    else if (this.part === 'minute') c.minute = wrap(c.minute + delta, 60)
    else if (this.part === 'second') c.second = wrap(c.second + delta, 60)
    else if (this.part === 'ampm') c.hour = (c.hour + 12) % 24
  }

  /** A digit typed into a time part: one digit sets it, a second completes it and moves on. */
  digit(d: string): void {
    const c = this.cursor
    const twelve = this.options.settings.clock === '12h'
    const max = this.part === 'hour' ? (twelve ? 12 : 23) : 59
    let text = this.typed + d
    if (Number(text) > max) text = d
    const n = Number(text)
    if (this.part === 'hour') c.hour = twelve ? (n === 12 || n === 0 ? 0 : n) + (c.hour >= 12 ? 12 : 0) : n
    else if (this.part === 'minute') c.minute = n
    else if (this.part === 'second') c.second = n
    this.typed = text
    if (text.length === 2 || Number(text) * 10 > max) {
      const parts = this.parts()
      const next = parts.indexOf(this.part) + 1
      if (next < parts.length) this.movePart(1)
      else this.typed = ''
    }
  }

  onKey(key: Key): void {
    const ch = charOf(key)
    if (key.name === 'escape') return this.cancel()
    if (key.name === 'return') return this.accept()
    if (key.name === 'tab') return this.movePart(key.shift ? -1 : 1)
    const c = this.cursor
    if (this.part !== 'date') {
      if (key.name === 'up' || key.name === 'down') {
        this.typed = ''
        return this.step(key.name === 'up' ? 1 : -1)
      }
      if (key.name === 'left' || key.name === 'right') return this.movePart(key.name === 'left' ? -1 : 1)
      if (/^\d$/.test(ch) && this.part !== 'ampm') return this.digit(ch)
      if (this.options.settings.clock === '12h' && /^[ap]$/i.test(ch)) {
        c.hour = (c.hour % 12) + (ch.toLowerCase() === 'p' ? 12 : 0)
        return
      }
      if (ch === 'n') {
        const now = nowIn(this.timeZone)
        Object.assign(c, { hour: now.hour, minute: now.minute, second: this.withSeconds ? now.second : 0 })
        return
      }
      return
    }
    const set = (w: WallDate) => { this.cursor = { ...w, hour: c.hour, minute: c.minute, second: c.second } }
    switch (key.name) {
      case 'left': return set(addDays(c, -1))
      case 'right': return set(addDays(c, 1))
      case 'up': return set(addDays(c, -7))
      case 'down': return set(addDays(c, 7))
      case 'pageup': return set(addMonths(c, key.shift ? -12 : -1))
      case 'pagedown': return set(addMonths(c, key.shift ? 12 : 1))
      case 'home': return set({ ...c, day: 1 })
      case 'end': return set({ ...c, day: daysInMonth(c.year, c.month) })
      default: break
    }
    if (ch === 't') return set(this.today)
    if (ch === 'n') {
      const now = nowIn(this.timeZone)
      this.cursor = this.options.kind === 'DATE' ? { ...now, hour: 0, minute: 0, second: 0 } : { ...now, second: this.withSeconds ? now.second : 0 }
      return
    }
    if (ch === 'p' && this.options.onPresets) {
      this.store.closeOverlay(this)
      return this.options.onPresets()
    }
    if (ch && ch !== ' ' && this.options.onType) {
      this.store.closeOverlay(this)
      return this.options.onType(ch)
    }
  }

  /** The key hints for the focused part. */
  keyItems(): string[] {
    const arrows = isAscii() ? 'arrows' : '←→↑↓'
    if (this.part !== 'date') return [`${isAscii() ? 'up/down' : '↑↓'} or digits`, `${isAscii() ? 'left/right' : '←→'} part`, ...(this.options.settings.clock === '12h' ? ['a/p'] : []), 'n now', 'Tab next', 'Enter ok', 'Esc cancel']
    return [
      `${arrows} day`, 'PgUp/PgDn month', 'S+PgUp/PgDn year', 'Home/End', 't today',
      ...(this.options.kind === 'DATE_TIME' ? ['Tab time'] : []),
      ...(this.options.onPresets ? ['p presets'] : []),
      ...(this.options.onType ? ['digits type'] : []),
      'Enter ok', 'Esc cancel',
    ]
  }

  render(sw: number, sh: number) {
    const t = theme()
    const s = this.options.settings
    const c = this.cursor
    const dt = this.options.kind === 'DATE_TIME'
    const width = Math.max(28, Math.min(sw, dt ? 42 : 32))
    const inner = width - 2
    const lines: Array<{ key: string; node: React.ReactNode }> = []
    const line = (key: string, text: string, fg?: string, bold?: boolean) => lines.push({ key, node: <Line key={key} text={text} width={inner} fg={fg ?? t.fg} bold={bold} /> })
    const [prev, next] = isAscii() ? ['<', '>'] : ['◂', '▸']
    line('month', center(`${prev}  ${MONTH_NAMES[c.month - 1]} ${c.year}  ${next}`, inner), t.acc, true)
    const wk = s.weekNumbers ? 'Wk ' : ''
    const gridWidth = wk.length + 21
    const lead = ' '.repeat(Math.max(0, Math.floor((inner - gridWidth) / 2)))
    line('head', `${lead}${wk}${weekdayHeadings(s.weekStart).map((d) => ` ${d}`).join('')}`, t.dim)
    const dateFocused = this.part === 'date'
    for (const [r, week] of monthGrid(c.year, c.month, s.weekStart).entries()) {
      const cells = week.days.map((d, i) => {
        const sel = d.year === c.year && d.month === c.month && d.day === c.day
        const today = d.year === this.today.year && d.month === this.today.month && d.day === this.today.day
        const fg = sel ? t.selFg : today ? t.acc2 : d.inMonth ? t.fg : t.dim
        const bg = sel ? (dateFocused ? t.selBg : t.selInactiveBg) : undefined
        // today: its own colour, and a * in ASCII mode where colour may not show
        const text = `${today && !sel && isAscii() ? '*' : ' '}${String(d.day).padStart(2, ' ')}`
        return <span key={i} fg={fg} bg={bg}>{today ? <strong>{text}</strong> : text}</span>
      })
      const used = lead.length + gridWidth
      lines.push({
        key: `w${r}`,
        node: (
          <text key={`w${r}`} flexShrink={0} wrapMode="none" fg={t.fg}>
            <span fg={t.dim}>{lead}{s.weekNumbers ? String(week.week).padStart(2, ' ') + ' ' : ''}</span>
            {cells}
            <span>{' '.repeat(Math.max(0, inner - used))}</span>
          </text>
        ),
      })
    }
    if (dt) {
      const twelve = s.clock === '12h'
      const segs: Array<[Part | 'sep', string]> = []
      const h = twelve ? c.hour % 12 || 12 : c.hour
      segs.push(['hour', pad2(h)], ['sep', ':'], ['minute', pad2(c.minute)])
      if (this.withSeconds) segs.push(['sep', ':'], ['second', pad2(c.second)])
      if (twelve) segs.push(['sep', ' '], ['ampm', c.hour < 12 ? 'AM' : 'PM'])
      const clock = twelve ? '12-hour' : '24-hour'
      const used = 6 + segs.reduce((n, [, v]) => n + v.length, 0)
      lines.push({
        key: 'time',
        node: (
          <text key="time" flexShrink={0} wrapMode="none" fg={t.fg}>
            <span fg={t.acc}>{' Time '}</span>
            {segs.map(([part, text], i) => <span key={i} fg={part === this.part ? t.selFg : t.inputFg} bg={part === this.part ? t.selBg : part === 'sep' ? undefined : t.inputBg}>{text}</span>)}
            <span fg={t.dim}>{pad(`  ${clock}`, Math.max(0, inner - used))}</span>
          </text>
        ),
      })
      const local = this.timeZone
      line('local', trunc(` Local ${local} (${zoneLabel(c, local)})`, inner), t.dim)
      const sent = localToUtc(canonicalOf(c, 'DATE_TIME'), { timeZone: local })
      line('sent', trunc(` Sends ${sent} (UTC)`, inner), t.dim)
      const server = this.options.serverZone
      if (server && server !== local) line('server', trunc(` Server ${server} (${zoneLabel(c, server)})`, inner), t.dim)
    } else {
      line('picked', trunc(` ${formatDatePart(c, s.order)}`, inner), t.dim)
    }
    const hints = wrapItems(this.keyItems(), inner - 1)
    hints.forEach((h, i) => line(`k${i}`, ` ${h}`, t.dim))
    const height = lines.length + 2
    let left: number | undefined
    let top: number | undefined
    const a = this.options.anchor
    if (a) {
      left = Math.max(0, Math.min(a.x, sw - width))
      top = a.y + 1 + height <= sh ? a.y + 1 : Math.max(0, a.y - height)
    }
    // Frame centres in screenWidth; a screenWidth of 2·left+width puts it at `left`
    return (
      <Frame title={this.options.title} width={width} height={height} screenWidth={left === undefined ? sw : left * 2 + width} screenHeight={sh} {...(top === undefined ? {} : { top })}>
        {lines.map((l) => l.node)}
      </Frame>
    )
  }
}

/** Draws a DateEditor: the text with the cursor, and the dim format hint on the right when it fits. */
export function DateFieldLine(props: { editor: DateEditor; width: number; focused?: boolean }) {
  const t = theme()
  const ed = props.editor
  const w = Math.max(1, props.width)
  const hint = props.focused !== false || !ed.value ? ed.hint() : ''
  const showHint = hint && ed.value.length + hint.length + 2 <= w
  const textWidth = showHint ? w - hint.length - 1 : w
  const anchor = (node: unknown) => { if (node) ed.anchorNode = node as { x: number; y: number } }
  if (props.focused === false) {
    return (
      <text ref={anchor} flexShrink={0} wrapMode="none" fg={t.inputFg} bg={t.inputBg}>
        {pad(ed.value, textWidth)}{showHint ? <span fg={t.dim}>{` ${hint}`}</span> : null}
      </text>
    )
  }
  const v = ed.view(textWidth - 1)
  const rest = textWidth - v.before.length - 1 - v.after.length
  return (
    <text ref={anchor} flexShrink={0} wrapMode="none" bg={t.inputBg}>
      <span fg={t.inputFg} bg={t.inputBg}>{v.before}</span>
      <span fg={t.inputBg} bg={t.inputFg}>{v.at}</span>
      <span fg={t.inputFg} bg={t.inputBg}>{v.after + ' '.repeat(Math.max(0, rest))}</span>
      {showHint ? <span fg={t.dim} bg={t.inputBg}>{` ${hint}`}</span> : null}
    </text>
  )
}

/** Whether a key opens the picker: F2, or Ctrl+Space (which terminals send as NUL). */
export function opensPicker(key: Key): boolean {
  return key.name === 'f2' || (key.ctrl === true && (key.name === 'space' || key.sequence === ' ')) || key.sequence === '\u0000'
}

/** The anchor of a drawn editor (its renderable's screen cell), when it has been drawn. */
function anchorOf(editor: DateEditor): { x: number; y: number } | undefined {
  const n = editor.anchorNode
  return n && Number.isFinite(n.x) && Number.isFinite(n.y) ? { x: n.x, y: n.y } : undefined
}

/** Opens the picker for a date editor; an accepted date replaces its text, then `onChange` runs. */
export function openPickerFor(store: AppStore, editor: DateEditor, title: string, onChange: () => void): void {
  store.open(new DatePickerOverlay(store, {
    title, kind: editor.kind, settings: editor.options.settings, timeZone: editor.timeZone, withSeconds: editor.withSeconds, serverZone: serverZoneOf(store),
    ...(editor.wall() ? { initial: editor.wall()! } : {}),
    ...(anchorOf(editor) ? { anchor: anchorOf(editor)! } : {}),
    onAccept: (value) => {
      editor.set(value)
      onChange()
      store.bump()
    },
    onType: (ch) => {
      editor.set('')
      editor.insert(ch)
      store.bump()
    },
  }))
}

/**
 * The date keys of a form field: F2 / Ctrl+Space open the picker, and so does Enter on an empty
 * field when the settings say so. Returns whether the key was used.
 */
export function handleDateFieldKey(store: AppStore, editor: DateEditor, key: Key, title: string, onChange: () => void): boolean {
  if (opensPicker(key) || (key.name === 'return' && !editor.value && editor.options.settings.pickerOnEnter)) {
    openPickerFor(store, editor, title, onChange)
    return true
  }
  return false
}

/** The editor for a form field of type DATE or DATE_TIME (other types: undefined). */
export function dateEditorFor(store: Pick<AppStore, 'target'>, field: { type: string; isRequired?: boolean; validation?: { required?: boolean } }, stored: unknown): DateEditor | undefined {
  if (field.type !== 'DATE' && field.type !== 'DATE_TIME') return undefined
  return new DateEditor(stored, { kind: field.type, settings: dateSettingsFor(store), nullable: !(field.isRequired || field.validation?.required) })
}

/** The hint under a focused date field. */
export function dateFieldHelp(editor: DateEditor): string {
  return `F2/Ctrl+Space calendar · t today${editor.kind === 'DATE_TIME' ? ' · n now' : ''}${editor.options.nullable ? ' · Backspace clears' : ''}`
}

/**
 * A one-line date prompt (the bulk editor's value for a date field): typed entry with the format
 * hint, the picker on F2 / Ctrl+Space, the reason under the line when the text is not a date.
 */
export class DatePromptOverlay implements Overlay {
  readonly id = overlayId('date-prompt')
  readonly editor: DateEditor
  error?: string

  /** A DATE_TIME goes out as the UTC instant (as forms send it) when `utc` is set. */
  private readonly utc: boolean

  constructor(private store: AppStore, readonly title: string, kind: DateKind, stored: unknown, private onSubmit: (value: string | null) => void, options: { nullable?: boolean; utc?: boolean } = {}) {
    this.editor = new DateEditor(stored, { kind, settings: dateSettingsFor(store), nullable: options.nullable ?? true })
    this.utc = Boolean(options.utc)
  }

  paste(text: string): void {
    this.editor.insert(text)
  }

  onKey(key: Key): void {
    if (key.name === 'escape') return this.store.closeOverlay(this)
    if (opensPicker(key)) return openPickerFor(this.store, this.editor, this.title, () => { this.error = undefined })
    if (key.name === 'return') {
      const r = this.editor.resolve()
      if (!r.ok) {
        this.error = r.reason
        return
      }
      this.store.closeOverlay(this)
      this.onSubmit(r.value !== null && this.utc && this.editor.kind === 'DATE_TIME' ? localToUtc(r.value, { timeZone: this.editor.timeZone }) : r.value)
      return
    }
    if (this.editor.handle(key)) this.error = undefined
  }

  render(sw: number, sh: number) {
    const t = theme()
    const width = Math.min(sw - 4, 80)
    // the reason in full: words wrapped onto as many lines as it takes
    const message = wrapItems(this.error ? `! ${this.error}`.split(' ') : ['empty clears the field'], width - 4, ' ')
    const keys = wrapItems(['Enter set', ...dateFieldHelp(this.editor).split(' · '), 'Esc cancel'], width - 4)
    return (
      <Frame title={this.title} width={width} height={3 + message.length + keys.length} screenWidth={sw} screenHeight={sh}>
        <box paddingLeft={1}><DateFieldLine editor={this.editor} width={width - 4} /></box>
        {message.map((m, i) => <Line key={`m${i}`} text={` ${m}`} width={width - 2} fg={this.error ? t.err : t.dim} />)}
        {keys.map((k, i) => <Line key={`k${i}`} text={` ${k}`} width={width - 2} fg={t.dim} />)}
      </Frame>
    )
  }
}
