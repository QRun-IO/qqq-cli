/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { expect, test } from 'bun:test'
import { PANEL_WIDTH, fitStrip, panelRows, panelShown, segmentAt, stripLine, stripSegments, type CollabState } from '../src/screens/record-collab'
import { cellWidth } from '../src/util/text'

const alone: CollabState = { tags: [], summary: { comments: 0, attachments: 0, tasks: 0, following: false, latest: [], followers: [] }, everyone: [{ name: 'Admin', self: true }] }
const busy: CollabState = {
  tags: [{ name: 'rush', label: 'rush' }, { name: 'vip', label: 'vip' }],
  summary: { comments: 2, attachments: 1, tasks: 1, following: true, latest: [{ author: 'Pat', at: '2026-11-01T10:00:00Z', text: 'first note\nsecond line' }, { author: 'Lee', at: '2026-11-01T09:00:00Z', text: 'an older comment that is much longer than the panel is wide' }], nextDue: '2026-11-03T00:00:00Z', followers: ['Admin', 'Pat'] },
  everyone: [{ name: 'Admin', self: true, mode: 'VIEWING' }, { name: 'Pat Smith', mode: 'EDITING', fieldName: 'email' }],
}
const text = (state: CollabState, width: number, panel = false) => stripLine(fitStrip(stripSegments(state, panel), width), width)

test('strip without other viewers: tags, counts, timeline, follow state and "(you)", one line', () => {
  expect(text(alone, 200).trimEnd()).toBe(' Tags: none (t) · 0 comments (C) · 0 files (P) · 0 tasks (K) · timeline (T) · not following (W) · viewing: Admin (you)')
  // still loading: ellipses, nothing missing
  expect(text({}, 200).trimEnd()).toBe(' Tags: … (t) · … comments (C) · … files (P) · … tasks (K) · timeline (T) · following … (W) · viewing: …')
})

test('strip with others: their names and state replace "(you)"; tags with values are listed', () => {
  const line = text(busy, 200)
  expect(line).toContain('Tags: rush, vip (t) · 2 comments (C) · 1 file (P) · 1 task (K) · timeline (T) · following (W) · viewing: Pat Smith (editing email)')
  expect(line).not.toContain('(you)')
  const three = { ...busy, everyone: [...busy.everyone!, { name: 'Lee' }, { name: 'Kim' }] }
  expect(text(three, 200)).toContain('viewing: Pat Smith (editing email), Lee (viewing) +1')
})

test('strip fits its width: segments drop whole (timeline, follow, files and tasks first), the viewers and tags last', () => {
  for (const width of [200, 120, 100, 80, 60, 40, 20]) {
    const line = text(busy, width)
    expect(cellWidth(line)).toBe(width)
  }
  expect(text(busy, 100)).not.toContain('timeline')
  const narrow = text(busy, 80)
  expect(narrow).toContain('Tags: rush, vip (t)')
  expect(narrow).toContain('viewing: Pat Smith')
  expect(narrow).not.toContain('file')
  // the last one standing is the viewers
  expect(text(busy, 40).trim()).toStartWith('viewing: Pat Smith')
})

test('strip segments are click zones: the cell under the pointer gives the key', () => {
  const placed = fitStrip(stripSegments(alone, false), 200)
  const line = stripLine(placed, 200)
  for (const [needle, key] of [['Tags', 't'], ['comments', 'C'], ['files', 'P'], ['tasks', 'K'], ['timeline', 'T'], ['following', 'W'], ['Admin', 'viewing']] as const) expect(segmentAt(placed, line.indexOf(needle))?.key).toBe(key)
  expect(segmentAt(placed, line.indexOf(' · ') + 1)).toBeUndefined()
})

test('with the panel the strip is the keys only (the same keys)', () => {
  expect(text(busy, 120, true).trimEnd()).toBe(' t tags · C comments · P files · K tasks · T timeline · W stop following')
  expect(stripSegments(busy, true).map((s) => s.key)).toEqual(['t', 'C', 'P', 'K', 'T', 'W'])
  expect(stripSegments(busy, false).map((s) => s.key)).toEqual(['t', 'C', 'P', 'K', 'T', 'W', 'viewing'])
})

test('panel: auto from 140 terminal columns, on/off, never without the extension or when the record would get under 60 cells', () => {
  expect(panelShown(undefined, 140, 112, true)).toBe(true)
  expect(panelShown('auto', 139, 111, true)).toBe(false)
  expect(panelShown('auto', 200, 168, false)).toBe(false)
  expect(panelShown('off', 200, 168, true)).toBe(false)
  expect(panelShown('on', 120, 98, true)).toBe(true)
  expect(panelShown('on', 80, 80, true)).toBe(false)
})

test('panel rows: tags, latest two comments, tasks with the next due, files, followers, viewing now (others first, with state); clipped to width and height', () => {
  const rows = panelRows(busy, PANEL_WIDTH - 1, 40, Date.parse('2026-11-01T12:00:00Z'))
  const lines = rows.map((r) => r.text.trimEnd())
  expect(lines).toEqual([
    ' Collaboration',
    ' Tags (t)',
    '   rush, vip',
    ' Comments 2 (C)',
    '   Pat · 2 h ago',
    '   first note second line',
    '   Lee · 3 h ago',
    '   an older comment that is much l…',
    ' Tasks 1 open (K)',
    '   next due 3 Nov',
    ' Files 1 (P)',
    ' Followers 2 (W)',
    '   Admin, Pat',
    '   you follow it',
    ' Timeline (T)',
    ' Viewing now',
    '   Pat Smith · editing email',
    '   Admin (you) · viewing',
  ])
  for (const r of rows) expect(cellWidth(r.text)).toBe(PANEL_WIDTH - 1)
  expect(rows.find((r) => r.text.includes('Pat Smith'))?.tone).toBe('accent')
  expect(rows.filter((r) => r.key === 'C').length).toBe(5)
  expect(panelRows(busy, PANEL_WIDTH - 1, 5)).toHaveLength(5)
})
