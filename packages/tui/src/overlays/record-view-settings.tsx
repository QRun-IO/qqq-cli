/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { readViewSettings, writeViewSettings, type ViewSettings } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { charOf } from '../keys'
import type { AppStore } from '../store'
import { theme } from '../theme'
import type { Overlay } from '../types'
import { KEY_SEP, fitKeyLine, pad, type KeyToken } from '../util/text'
import { overlayId } from './basic'
import { Frame, Line } from './frame'
import { pickRow } from '../mouse/keys'
import { Zone } from '../mouse/zone'

export const LABEL_WIDTH_RANGE = { min: 8, max: 60 }
export const CHILD_ROWS_RANGE = { min: 1, max: 50 }

/** The dialog's key help; a higher `drop` goes first when the width cannot fit all of it in three lines. */
export const RECORD_VIEW_SETTINGS_KEYS: KeyToken[] = [
  { text: 'Space or ←→ changes', drop: 0 },
  { text: 'digits type a number', drop: 1 },
  { text: '+/- step', drop: 1 },
  { text: 'Backspace default', drop: 2 },
  { text: '* changed from the default', drop: 3 },
  { text: 'r reset to defaults', drop: 2 },
  { text: 'Enter saves for this table', drop: 0 },
  { text: 'Esc cancels', drop: 0 },
]

type Kind = 'columns' | 'labelWidth' | 'childRows' | 'collabPanel' | 'reset'
const COLUMNS: Array<1 | 2 | undefined> = [undefined, 1, 2]
const PANELS: Array<'auto' | 'on' | 'off'> = ['auto', 'on', 'off']

/** Clamps a number into a range (rounded to a whole number). */
export function clampTo(n: number, range: { min: number; max: number }): number {
  return Math.max(range.min, Math.min(range.max, Math.round(n)))
}

/**
 * How a record is shown, saved per table (`record:<table>`): one or two columns of fields, the label width,
 * the rows of each child list and the collaboration panel. Numbers take typed digits and +/- steps.
 */
export class RecordViewSettingsOverlay implements Overlay {
  readonly id = overlayId('recordview')
  view: ViewSettings
  row = 0
  /** Digits typed into the selected number row, committed (clamped) when the row changes or the dialog saves. */
  typed: string | undefined

  /**
   * @param autoLabelWidth what the label width is when unset (stepping starts there)
   * @param defaultChildRows the profile's child list rows
   */
  constructor(private store: AppStore, readonly tableLabel: string, readonly key: string, private autoLabelWidth: number, readonly defaultChildRows: number, readonly collab: boolean, private onDone: () => void) {
    this.view = { ...readViewSettings(key) }
  }

  kinds(): Kind[] {
    return ['columns', 'labelWidth', 'childRows', ...(this.collab ? (['collabPanel'] as const) : []), 'reset']
  }

  kind(): Kind {
    return this.kinds()[this.row]!
  }

  /** What each row shows, whether it differs from the default, and what it does. */
  rows(): Array<{ kind: Kind; label: string; value: string; changed: boolean; help: string }> {
    const typedFor = (k: Kind) => (this.typed !== undefined && this.kind() === k ? `${this.typed}_` : undefined)
    const v = this.view
    const all = {
      columns: { label: 'Columns', value: v.recordColumns ? String(v.recordColumns) : 'auto', changed: v.recordColumns !== undefined, help: 'columns of fields · auto uses two when there is room · Space or ←→ changes' },
      labelWidth: { label: 'Label width', value: typedFor('labelWidth') ?? (v.labelWidth !== undefined ? String(v.labelWidth) : 'auto'), changed: v.labelWidth !== undefined, help: `cells for field labels (${LABEL_WIDTH_RANGE.min}-${LABEL_WIDTH_RANGE.max}) · type digits or +/- · Backspace for auto` },
      childRows: { label: 'Child list rows', value: typedFor('childRows') ?? (v.childRows !== undefined ? String(v.childRows) : `profile default (${this.defaultChildRows})`), changed: v.childRows !== undefined, help: `data rows in each child list (${CHILD_ROWS_RANGE.min}-${CHILD_ROWS_RANGE.max}) · type digits or +/- · Backspace for the profile default` },
      collabPanel: { label: 'Collaboration panel', value: v.collabPanel === 'on' || v.collabPanel === 'off' ? v.collabPanel : 'auto (140+ columns)', changed: v.collabPanel === 'on' || v.collabPanel === 'off', help: 'the side panel of tags, comments, tasks and who is here · Space or ←→ changes' },
      reset: { label: 'Reset to defaults', value: '', changed: false, help: 'clears every record view setting of this table · Space or r asks first' },
    }
    return this.kinds().map((kind) => ({ kind, ...all[kind] }))
  }

  /** Applies typed digits to the setting they belong to. */
  commit(): void {
    if (this.typed === undefined) return
    const k = this.kind()
    const text = this.typed
    this.typed = undefined
    if (text === '') return
    if (k === 'labelWidth') this.view.labelWidth = clampTo(Number(text), LABEL_WIDTH_RANGE)
    if (k === 'childRows') this.view.childRows = clampTo(Number(text), CHILD_ROWS_RANGE)
  }

  move(row: number): void {
    this.commit()
    this.row = Math.max(0, Math.min(this.kinds().length - 1, row))
  }

  /** Space and the arrows: cycle a choice, or step a number by one. */
  change(delta: number): void {
    this.commit()
    const k = this.kind()
    if (k === 'columns') this.view.recordColumns = cycle(COLUMNS, this.view.recordColumns, delta)
    else if (k === 'collabPanel') {
      const next = cycle(PANELS, this.view.collabPanel ?? 'auto', delta)
      if (next === 'auto') delete this.view.collabPanel
      else this.view.collabPanel = next
    } else if (k === 'labelWidth') this.view.labelWidth = clampTo((this.view.labelWidth ?? this.autoLabelWidth) + delta, LABEL_WIDTH_RANGE)
    else if (k === 'childRows') this.view.childRows = clampTo((this.view.childRows ?? this.defaultChildRows) + delta, CHILD_ROWS_RANGE)
    else if (k === 'reset' && delta) this.askReset()
  }

  askReset(): void {
    this.store.confirm(`Reset the record view settings of ${this.tableLabel}?`, () => {
      writeViewSettings(this.key, undefined)
      this.store.closeOverlay(this)
      this.onDone()
    })
  }

  save(): void {
    this.commit()
    writeViewSettings(this.key, { ...this.view })
    this.store.closeOverlay(this)
    this.onDone()
  }

  onKey(key: Key): void {
    const ch = charOf(key)
    const k = this.kind()
    const numeric = k === 'labelWidth' || k === 'childRows'
    if (key.name === 'escape') return this.store.closeOverlay(this)
    if (key.name === 'return' || (key.ctrl && key.name === 's')) return this.save()
    if (key.name === 'down') return this.move(this.row + 1)
    if (key.name === 'up') return this.move(this.row - 1)
    if (key.name === 'right' || key.name === 'space') return this.change(1)
    if (key.name === 'left') return this.change(-1)
    if (numeric && ch && /^[0-9]$/.test(ch)) {
      const next = (this.typed ?? '') + ch
      this.typed = next.replace(/^0+(?=\d)/, '').slice(0, 2)
    } else if (numeric && key.name === 'backspace') {
      if (this.typed) this.typed = this.typed.slice(0, -1)
      else {
        this.typed = undefined
        if (k === 'labelWidth') delete this.view.labelWidth
        else delete this.view.childRows
      }
    } else if (numeric && ch === '+') this.change(1)
    else if (numeric && ch === '-') this.change(-1)
    else if (ch === 'r') this.askReset()
  }

  render(sw: number, sh: number) {
    const t = theme()
    const width = Math.min(sw - 4, 72)
    const inner = width - 2
    const rows = this.rows()
    const keys = fitKeyLine(RECORD_VIEW_SETTINGS_KEYS, inner - 2, 3)
    // border 2 + blank 1 + help 1 + key lines
    const chrome = 4 + keys.length
    return (
      <Frame title={`Record view settings · ${this.tableLabel} · ${rows.length} of ${rows.length} settings`} width={width} height={rows.length + chrome} screenWidth={sw} screenHeight={sh}>
        {rows.map((r, i) => {
          const sel = i === this.row
          return <Zone key={r.kind} {...pickRow(() => { this.move(i) }, () => { this.move(i); this.change(1) })}><text flexShrink={0} wrapMode="none" fg={sel ? t.selFg : r.kind === 'reset' ? t.acc : t.fg} bg={sel ? t.selBg : undefined}>{pad(` ${r.changed ? '*' : ' '}${pad(r.label, 22)} ${r.value}`, inner)}</text></Zone>
        })}
        <Line text="" width={inner} />
        <Line text={` ${fitKeyLine((rows[this.row]?.help ?? '').split(KEY_SEP), inner - 2, 1)[0] ?? ''}`} width={inner} fg={t.acc} />
        {keys.map((line, i) => <Line key={`k${i}`} text={` ${line}`} width={inner} fg={t.dim} />)}
      </Frame>
    )
  }
}

function cycle<T>(list: T[], current: T, delta: number): T {
  const i = Math.max(0, list.indexOf(current))
  return list[(i + (delta < 0 ? -1 : 1) + list.length) % list.length]!
}
