/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Where the record view shows collaboration (the collaboration extension): a strip of segments
 * directly above the key line (tags, counts, follow state, who is viewing; each segment is its key),
 * and on wide terminals a right-hand panel with the details, which shortens the strip to the keys.
 * Nothing here takes rows above the record's sections. Pure text, so it is tested without drawing.
 */

import type { TagEntry } from '@qrun-io/qqq-core'
import type { CollabSummary } from '../collab'
import { timesText, type PresencePerson } from '../presence'
import { ago } from '../servers'
import { KEY_SEP, cellWidth, pad, trunc } from '../util/text'

/** Cells of the panel, its one-cell rule on the left included. */
export const PANEL_WIDTH = 36
/** `auto` shows the panel from this terminal width. */
export const PANEL_AUTO_WIDTH = 140
/** `on` still leaves the record this many cells. */
const MIN_RECORD_WIDTH = 60

export type PanelSetting = 'auto' | 'on' | 'off'

export interface CollabState {
  tags?: TagEntry[]
  summary?: CollabSummary
  /** Everyone on the record as presence reports it (undefined while unknown). */
  everyone?: Array<PresencePerson & { self?: boolean }>
}

/** A piece of a strip segment; `em` pieces (counts, names, keys) are drawn in normal weight, the rest dim. */
export interface StripPart {
  text: string
  em?: boolean
}

/** One segment of the strip: what it shows, the key a click presses ('viewing': who is here), and when it is dropped (highest first). */
export interface StripSegment {
  key: string
  drop: number
  parts: StripPart[]
}

/** A fitted segment with its first cell on the line (after the one-cell indent). */
export interface PlacedSegment extends StripSegment {
  x: number
  width: number
}

export interface PanelRow {
  text: string
  tone: 'head' | 'fg' | 'dim' | 'accent'
  /** The key a click on the row presses ('collab': the collaboration list, 'viewing': who is here). */
  key?: string
}

/**
 * Whether the panel is drawn: `auto` on terminals of 140 columns or more, `on` whenever the record
 * keeps 60 cells beside it, never without the extension. `paneWidth` is the record pane (the sidebar
 * takes the rest of the terminal).
 */
export function panelShown(setting: PanelSetting | undefined, terminalWidth: number, paneWidth: number, extension: boolean): boolean {
  if (!extension || setting === 'off') return false
  const room = paneWidth - 2 - PANEL_WIDTH >= MIN_RECORD_WIDTH
  return setting === 'on' ? room : room && terminalWidth >= PANEL_AUTO_WIDTH
}

const segText = (s: StripSegment) => s.parts.map((p) => p.text).join('')

export function tagsText(tags: TagEntry[] | undefined): string {
  if (!tags) return '…'
  return tags.length ? tags.map((x) => x.label ?? x.name ?? '').join(', ') : 'none'
}

/** What a person is doing on the record: "editing email", "editing", "viewing". */
export function personState(p: Pick<PresencePerson, 'mode' | 'fieldName'>): string {
  return /edit/i.test(p.mode ?? '') ? `editing${p.fieldName ? ` ${p.fieldName}` : ''}` : 'viewing'
}

/** The others on the record (this user not counted). */
export function othersOf(state: CollabState): PresencePerson[] {
  return (state.everyone ?? []).filter((p) => !p.self)
}

function viewingParts(state: CollabState): StripPart[] {
  const everyone = state.everyone
  if (!everyone) return [{ text: 'viewing: ' }, { text: '…' }]
  const others = othersOf(state)
  // others (with what they do) take the place of "(you)": the strip is about who else is here
  if (others.length) {
    const named = others.slice(0, 2).map((p) => `${p.name}${timesText(p)} (${personState(p)})`).join(', ')
    return [{ text: 'viewing: ' }, { text: named + (others.length > 2 ? ` +${others.length - 2}` : ''), em: true }]
  }
  const self = everyone.find((p) => p.self)
  return [{ text: 'viewing: ' }, { text: self ? `${self.name}${timesText(self)}` : 'you', em: true }, ...(self ? [{ text: ' (you)' }] : [])]
}

const count = (n: number | undefined, one: string, many = `${one}s`): StripPart[] => [{ text: n === undefined ? '…' : String(n), em: true }, { text: ` ${n === 1 ? one : many}` }]

/**
 * The strip's segments. With the panel shown it is the keys only (the panel has the details);
 * otherwise tags, counts, follow state and who is viewing, the viewers and tags dropped last.
 */
export function stripSegments(state: CollabState, withPanel: boolean): StripSegment[] {
  const s = state.summary
  const following = s?.following
  if (withPanel) {
    const k = (key: string, label: string, drop: number): StripSegment => ({ key, drop, parts: [{ text: key, em: true }, { text: ` ${label}` }] })
    return [k('t', 'tags', 1), k('C', 'comments', 1), k('P', 'files', 1), k('K', 'tasks', 1), k('T', 'timeline', 2), k('W', following ? 'stop following' : 'follow', 2)]
  }
  const tags = tagsText(state.tags)
  return [
    { key: 't', drop: 1, parts: [{ text: 'Tags: ' }, { text: tags, em: Boolean(state.tags?.length) }, { text: ' (t)' }] },
    { key: 'C', drop: 2, parts: [...count(s?.comments, 'comment'), { text: ' (C)' }] },
    { key: 'P', drop: 3, parts: [...count(s?.attachments, 'file'), { text: ' (P)' }] },
    { key: 'K', drop: 3, parts: [...count(s?.tasks, 'task'), { text: ' (K)' }] },
    { key: 'T', drop: 5, parts: [{ text: 'timeline (T)' }] },
    { key: 'W', drop: 4, parts: [{ text: following === undefined ? 'following …' : following ? 'following' : 'not following' }, { text: ' (W)' }] },
    { key: 'viewing', drop: 0, parts: viewingParts(state) },
  ]
}

/**
 * Fits segments in `width` cells (one cell of indent): the highest `drop` goes first (the last of
 * equals first), as key lines do; a single segment still too wide is cut with an ellipsis.
 */
export function fitStrip(segments: StripSegment[], width: number): PlacedSegment[] {
  const room = Math.max(1, width - 2)
  const total = (list: StripSegment[]) => list.reduce((n, s, i) => n + cellWidth(segText(s)) + (i ? KEY_SEP.length : 0), 0)
  let kept = segments
  while (kept.length > 1 && total(kept) > room) {
    const victim = kept.reduce((worst, s) => (s.drop >= worst.drop ? s : worst))
    kept = kept.filter((s) => s !== victim)
  }
  const out: PlacedSegment[] = []
  let x = 1
  for (const seg of kept) {
    if (out.length) x += KEY_SEP.length
    let left = room - (x - 1)
    const parts: StripPart[] = []
    for (const p of seg.parts) {
      if (left <= 0) break
      const text = trunc(p.text, left)
      parts.push({ ...p, text })
      left -= cellWidth(text)
    }
    const w = cellWidth(parts.map((p) => p.text).join(''))
    out.push({ ...seg, parts, x, width: w })
    x += w
  }
  return out
}

/** The fitted strip as a plain line of exactly `width` cells (tests, captures). */
export function stripLine(placed: PlacedSegment[], width: number): string {
  return pad(` ${placed.map(segText).join(KEY_SEP)}`, width)
}

/** The segment under cell `x` of the strip, if any. */
export function segmentAt(placed: PlacedSegment[], x: number): PlacedSegment | undefined {
  return placed.find((s) => x >= s.x && x < s.x + s.width)
}

/** The panel's rows, each cut to `width` cells (one cell of indent), at most `height` of them. */
export function panelRows(state: CollabState, width: number, height: number, now = Date.now()): PanelRow[] {
  const s = state.summary
  const n = (v: number | undefined) => (v === undefined ? '…' : String(v))
  const rows: PanelRow[] = []
  const add = (text: string, tone: PanelRow['tone'], key?: string) => rows.push({ text: pad(` ${text}`, width), tone, ...(key ? { key } : {}) })
  add('Collaboration', 'head', 'collab')
  add('Tags (t)', 'head', 't')
  add(`  ${tagsText(state.tags)}`, state.tags?.length ? 'fg' : 'dim', 't')
  add(`Comments ${n(s?.comments)} (C)`, 'head', 'C')
  for (const c of s?.latest ?? []) {
    add(`  ${c.author}${c.at ? ` · ${ago(c.at, now)}` : ''}`, 'dim', 'C')
    add(`  ${trunc(c.text, width - 3)}`, 'fg', 'C')
  }
  add(`Tasks ${n(s?.tasks)} open (K)`, 'head', 'K')
  if (s?.nextDue) add(`  next due ${dueText(s.nextDue)}`, 'fg', 'K')
  add(`Files ${n(s?.attachments)} (P)`, 'head', 'P')
  const followers = s?.followers
  add(`Followers ${followers ? followers.length : '…'} (W)`, 'head', 'W')
  if (followers?.length) add(`  ${followers.slice(0, 3).join(', ')}${followers.length > 3 ? ` +${followers.length - 3}` : ''}`, 'fg', 'W')
  add(`  ${s?.following === undefined ? '…' : s.following ? 'you follow it' : 'you do not follow it'}`, 'dim', 'W')
  add('Timeline (T)', 'head', 'T')
  add('Viewing now', 'head', 'viewing')
  const everyone = state.everyone
  if (!everyone) add('  …', 'dim', 'viewing')
  else if (!everyone.length) add('  no one else', 'dim', 'viewing')
  // others first, with what they are doing; this user last
  const people: Array<PresencePerson & { self?: boolean }> = [...othersOf(state), ...(everyone ?? []).filter((x) => x.self)]
  for (const p of people) {
    add(`  ${p.name}${timesText(p)}${p.self ? ' (you)' : ''} · ${personState(p)}`, p.self ? 'fg' : 'accent', 'viewing')
    // with more than one terminal, what each does (this one first)
    const terminals = p.terminals && p.terminals.length > 1 ? [...p.terminals].sort((a, b) => Number(Boolean(b.self)) - Number(Boolean(a.self))) : []
    terminals.forEach((x, i) => add(`    ${x.self ? 'this terminal' : `#${i + 1}`} · ${personState(x)}${x.since ? ` · ${hhmm(x.since)}` : ''}`, 'dim', 'viewing'))
  }
  return rows.slice(0, Math.max(0, height))
}

/** A lease start as local "17:50". */
function hhmm(iso: string): string {
  const at = new Date(iso)
  return Number.isNaN(at.getTime()) ? iso : at.toTimeString().slice(0, 5)
}

/** A due date as "3 Nov" (and the year when it is not this one). */
function dueText(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const sameYear = at.getFullYear() === new Date().getFullYear()
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) })
}
