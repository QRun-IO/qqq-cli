/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import { checkCapture } from '../scripts/overflow-check'
import { MessageOverlay, wrap } from '../src/overlays/basic'
import { Frame, KeyLines, Line } from '../src/overlays/frame'
import { VIEW_SETTINGS_KEYS, type GridViewSettingsOverlay } from '../src/overlays/view-settings'
import type { TableScreen } from '../src/screens/table'
import { cellWidth, fitKeyLine, fitSegments, hintLine, pad, trunc } from '../src/util/text'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined

/** The TUI at 80x24 (it starts wider: the start-up wait looks for the Apps tree, hidden below 100 columns). */
async function at80(): Promise<Harness> {
  const harness = await startTui(120, 30)
  harness.setup.resize(80, 24)
  await press(harness, () => undefined)
  return harness
}
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

test('trunc and pad measure terminal cells: wide characters never push past the width', () => {
  expect(trunc('abcdef', 4)).toBe('abc…')
  expect(trunc('abc', 4)).toBe('abc')
  expect(trunc('abc', 1)).toBe('…')
  expect(trunc('abc', 0)).toBe('')
  expect(cellWidth('日本語')).toBe(6)
  expect(cellWidth(trunc('日本語テキスト', 5))).toBeLessThanOrEqual(5)
  expect(trunc('日本語テキスト', 5)).toBe('日本…')
  expect(cellWidth(pad('日本語', 10))).toBe(10)
  expect(cellWidth(pad('日本語テキストです', 10))).toBe(10)
  expect(trunc('two\nlines', 20)).toBe('two lines')
})

test('fitSegments cuts the segment that crosses the edge and drops the rest', () => {
  const segs = fitSegments([{ text: 'abc', fg: 'a' }, { text: 'defgh', fg: 'b' }, { text: 'ij', fg: 'c' }], 6)
  expect(segs.map((s) => s.text)).toEqual(['abc', 'de…'])
  expect(segs[1]!.fg).toBe('b')
})

test('fitKeyLine wraps at " · " only, never inside a token, and fits the line count', () => {
  const lines = fitKeyLine(VIEW_SETTINGS_KEYS, 72, 3)
  expect(lines.length).toBeLessThanOrEqual(3)
  for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(72)
  const kept = lines.join(' · ').split(' · ')
  for (const token of kept) expect(VIEW_SETTINGS_KEYS.map((k) => k.text)).toContain(token)
  // at 80 columns nothing has to go
  expect(kept.length).toBe(VIEW_SETTINGS_KEYS.length)
})

test('fitKeyLine drops the least important tokens first when three lines are not enough', () => {
  const lines = fitKeyLine(VIEW_SETTINGS_KEYS, 30, 3)
  expect(lines.length).toBe(3)
  const kept = lines.join(' · ').split(' · ')
  for (const essential of ['Space on/off', 'Enter saves for this table', 'Esc cancels']) expect(kept).toContain(essential)
  expect(kept).not.toContain('* changed from the default')
  for (const l of lines) expect(cellWidth(l)).toBeLessThanOrEqual(30)
})

test('fitKeyLine cuts a single token wider than the line with an ellipsis', () => {
  expect(fitKeyLine(['a very long token indeed'], 10, 1)).toEqual(['a very lo…'])
})

test('hintLine keeps Esc, Enter and Ctrl+S tokens and drops whole tokens from the end', () => {
  const line = hintLine('Ctrl+S save · Esc cancel · Tab ↓ next · ↑ previous · Enter or typing opens a picker · * required', 40)
  expect(cellWidth(line)).toBe(40)
  expect(line).toContain('Ctrl+S save')
  expect(line).toContain('Esc cancel')
  expect(line).not.toContain('…')
})

test('wrap breaks a word longer than the width instead of losing its end', () => {
  expect(wrap('see com.example.VeryLongClassName now', 10)).toEqual(['see', 'com.exampl', 'e.VeryLong', 'ClassName', 'now'])
})

test('a Frame clips what it holds: Line defaults to the inner width and cuts with an ellipsis', async () => {
  const s = await testRender(
    <Frame title={'A title much longer than the frame is wide'} width={30} height={6} screenWidth={40} screenHeight={10}>
      <Line text={'x'.repeat(100)} />
      <Line text="short" width={200} bg="#ff0000" />
      <KeyLines tokens={['Space on/off', 'Enter saves', 'Esc cancels', 'r reset']} />
    </Frame>, { width: 40, height: 10 })
  try {
    await s.renderOnce()
    const frame = s.captureCharFrame()
    expect(checkCapture(frame, 40, 10)).toEqual([])
    expect(frame).toContain('x'.repeat(27) + '…║')
    expect(frame).toContain('Space on/off · Enter saves')
  } finally {
    s.renderer.destroy()
  }
})

test('a Frame wider or taller than the screen is held inside it', async () => {
  const s = await testRender(<Frame title="Big" width={200} height={50} screenWidth={30} screenHeight={8}><Line text="hello" /></Frame>, { width: 30, height: 8 })
  try {
    await s.renderOnce()
    expect(checkCapture(s.captureCharFrame(), 30, 8)).toEqual([])
  } finally {
    s.renderer.destroy()
  }
})

test('the overflow checker finds text that broke a border, and accepts dialogs drawn over panes', () => {
  const clean = ['┌──────┐', '│ ok   │', '└──────┘'].join('\n')
  expect(checkCapture(clean, 8, 3)).toEqual([])
  const broken = ['┌──────┐', '│ overflow', '└──────┘'].join('\n')
  expect(checkCapture(broken, 10, 3).join('\n')).toContain('right border')
  const wide = ['┌──────┐ ', '│ ok   │ ', '└──────┘ ', 'x'.repeat(12)].join('\n')
  expect(checkCapture(wide, 10, 4).join('\n')).toContain('wider than 10')
  const covered = ['┌──────────┐', '│ ╔════╗   │', '│ ║ hi ║xxxx', '│ ╚════╝   │', '└──────────┘'].join('\n')
  expect(checkCapture(covered, 12, 5).join('\n')).toContain('right border')
  const overlay = ['┌────────┐', '│  ╔═════════╗', '│  ║ dialog  ║', '└──╚═════════╝'].join('\n')
  expect(checkCapture(overlay, 14, 4)).toEqual([])
})

test('error dialogs wrap long messages inside their border at 80 columns', async () => {
  h = await at80()
  h.store.open(new MessageOverlay(h.store, `Cannot invoke "java.lang.Integer.intValue()" because the return value of "com.kingsrook.qqq.backend.core.model.actions.processes.RunBackendStepInput.getValueInteger(java.lang.String)" is null`, 'error'))
  const f = await waitFor(h, (x) => x.includes('Error'))
  expect(checkCapture(f, 80, 24)).toEqual([])
  expect(f).toContain('is null')
})

test('view settings: the value cell holds only the value, the help line explains the selected row', async () => {
  h = await at80()
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('records'))
  const grid = h.store.screen as TableScreen
  const o = grid.viewSettings() as GridViewSettingsOverlay
  h.store.open(o)
  o.row = o.order.length + 1
  const f = await press(h, () => undefined)
  expect(checkCapture(f, 80, 24)).toEqual([])
  expect(f).toMatch(/Pinned columns +0 +║/)
  expect(f).toContain('columns that stay left while scrolling · +/- changes')
  expect(f).not.toContain('stay left while scrolling;')
  // the key lines break between tokens only
  for (const line of f.split('\n').filter((l) => l.includes('Esc cancels') || l.includes('Space on/off'))) expect(line).not.toMatch(/…║/)
  // +/- change the pinned count on its row
  await press(h, () => h!.setup.mockInput.typeText('+'))
  expect(o.view.pinned).toBe(1)
  await press(h, () => h!.setup.mockInput.typeText('-'))
  expect(o.view.pinned).toBe(0)
})

test('a saved column width wider than the grid is held to the grid, so the heading still shows', async () => {
  h = await at80()
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('records'))
  const grid = h.store.screen as TableScreen
  grid.view = { ...grid.view, widths: { id: 120 } }
  const f = await waitFor(h, (x) => x.includes(' Id'))
  expect(checkCapture(f, 80, 24)).toEqual([])
})

test('V on the grid shows the whole value of the cell under the cursor', async () => {
  h = await at80()
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('records'))
  const grid = h.store.screen as TableScreen
  grid.colCursor = 1
  await press(h, () => h!.setup.mockInput.typeText('V'))
  const f = await waitFor(h, (x) => x.includes('First Name') && x.includes('any key closes'))
  expect(checkCapture(f, 80, 24)).toEqual([])
})

test('record view at 80: the key line drops whole keys, V shows the whole value of the field row', async () => {
  h = await at80()
  await command(h, 'table get person 1')
  let f = await waitFor(h, (x) => x.includes('Esc back'))
  expect(checkCapture(f, 80, 24)).toEqual([])
  const hint = f.split('\n').find((l) => l.includes('Esc back'))!
  expect(hint).not.toContain('…')
  await press(h, () => h!.setup.mockInput.typeText('V'))
  f = await waitFor(h, (x) => x.includes('any key closes'))
  expect(checkCapture(f, 80, 24)).toEqual([])
})
