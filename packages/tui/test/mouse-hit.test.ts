/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The hit-testing model and the dispatcher, without a renderer. */

import { describe, expect, test } from 'bun:test'
import { MouseDispatcher, type RawMouse } from '../src/mouse/dispatch'
import { boundaryAt, columnAt, columnStarts, fkeyAt, moved, resizedWidth, rowAt, tabAt, tokenAt, treeHit } from '../src/mouse/hit'
import { pickRow, wheelAsKeys } from '../src/mouse/keys'
import { LOCK_LAYER, hitTest, type Zone, type ZoneEvent, type ZoneHandlers } from '../src/mouse/registry'

describe('F-key bar', () => {
  test('120 columns: 12 cells a key, F10 takes the rest', () => {
    expect(fkeyAt(0, 120)).toBe(1)
    expect(fkeyAt(11, 120)).toBe(1)
    expect(fkeyAt(12, 120)).toBe(2)
    expect(fkeyAt(107, 120)).toBe(9)
    expect(fkeyAt(108, 120)).toBe(10)
    expect(fkeyAt(119, 120)).toBe(10)
    expect(fkeyAt(120, 120)).toBeUndefined()
    expect(fkeyAt(-1, 120)).toBeUndefined()
  })
  test('narrow terminals keep 7 cells a key; keys past the edge are not hit', () => {
    expect(fkeyAt(6, 60)).toBe(1)
    expect(fkeyAt(7, 60)).toBe(2)
    expect(fkeyAt(59, 60)).toBe(9)
  })
})

describe('grid', () => {
  const cols = [{ width: 4 }, { width: 10 }, { width: 6 }]
  test('columns start after the two-cell mark, one space apart', () => {
    expect(columnStarts(cols)).toEqual([2, 7, 18])
  })
  test('the cell under x: the column or the space after it; nothing in the mark or past the end', () => {
    expect(columnAt(0, cols)).toBeUndefined()
    expect(columnAt(1, cols)).toBeUndefined()
    expect(columnAt(2, cols)).toBe(0)
    expect(columnAt(6, cols)).toBe(0)
    expect(columnAt(7, cols)).toBe(1)
    expect(columnAt(17, cols)).toBe(1)
    expect(columnAt(18, cols)).toBe(2)
    expect(columnAt(24, cols)).toBe(2)
    expect(columnAt(25, cols)).toBeUndefined()
  })
  test('a column edge is its last cell or the separator after it', () => {
    expect(boundaryAt(5, cols)).toBe(0)
    expect(boundaryAt(6, cols)).toBe(0)
    expect(boundaryAt(4, cols)).toBeUndefined()
    expect(boundaryAt(17, cols)).toBe(1)
    expect(boundaryAt(10, cols)).toBeUndefined()
  })
  test('resizing stays within 3 to 120 cells; moving a column keeps the others in order', () => {
    expect(resizedWidth(10, 5)).toBe(15)
    expect(resizedWidth(10, -20)).toBe(3)
    expect(resizedWidth(118, 9)).toBe(120)
    expect(moved(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd'])
    expect(moved(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moved(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
  })
  test('rows from the top of the window, also two lines a row (comfortable density)', () => {
    expect(rowAt(0, 10, 30)).toBe(10)
    expect(rowAt(4, 10, 30)).toBe(14)
    expect(rowAt(25, 10, 30)).toBeUndefined()
    expect(rowAt(5, 0, 30, 2)).toBe(2)
    expect(rowAt(-1, 0, 30)).toBeUndefined()
  })
})

describe('tree, tabs, buttons', () => {
  test('the expand glyph sits at the depth; elsewhere the line is the node', () => {
    expect(treeHit(0, 0, true)).toBe('toggle')
    expect(treeHit(1, 0, true)).toBe('toggle')
    expect(treeHit(2, 0, true)).toBe('node')
    expect(treeHit(2, 2, true)).toBe('toggle')
    expect(treeHit(0, 0, false)).toBe('node')
  })
  test('tabs and tokens', () => {
    expect(tabAt(0, ['1 Security', '2 Events'], 2, 1)).toBeUndefined()
    expect(tabAt(1, ['1 Security', '2 Events'], 2, 1)).toBe(0)
    expect(tabAt(13, ['1 Security', '2 Events'], 2, 1)).toBe(1)
    const line = ' [ Yes ]  [ No ]  y/N'
    expect(tokenAt(line, 1, ['[ Yes ]', '[ No ]'])).toBe('[ Yes ]')
    expect(tokenAt(line, 8, ['[ Yes ]', '[ No ]'])).toBeUndefined()
    expect(tokenAt(line, 10, ['[ Yes ]', '[ No ]'])).toBe('[ No ]')
  })
})

describe('registry', () => {
  const zone = (layer: number, depth: number, rect: { x: number; y: number; width: number; height: number }, extra: Partial<Zone> = {}): Zone & { name?: string } => ({ layer, depth, rect: () => rect, handlers: () => ({}), ...extra })
  test('innermost first; only the live layer (and global zones below the lock screen)', () => {
    const pane = { ...zone(0, 0, { x: 0, y: 1, width: 100, height: 30 }), name: 'pane' }
    const row = { ...zone(0, 1, { x: 1, y: 5, width: 98, height: 1 }), name: 'row' }
    const bar = { ...zone(0, 0, { x: 0, y: 39, width: 100, height: 1 }, { global: true }), name: 'bar' }
    const dialog = { ...zone(1, 0, { x: 20, y: 5, width: 40, height: 10 }), name: 'dialog' }
    const zones = [pane, row, bar, dialog]
    expect(hitTest(zones, 10, 5, 0).map((z) => z.name)).toEqual(['row', 'pane'])
    // a dialog open: the screen under it and beside it is dead
    expect(hitTest(zones, 10, 5, 1).map((z) => z.name)).toEqual([])
    expect(hitTest(zones, 25, 5, 1).map((z) => z.name)).toEqual(['dialog'])
    expect(hitTest(zones, 5, 39, 1).map((z) => z.name)).toEqual(['bar'])
    expect(hitTest(zones, 5, 39, LOCK_LAYER).map((z) => z.name)).toEqual([])
  })
})

describe('dispatcher', () => {
  function setup() {
    let now = 1000
    let layer = 0
    const log: string[] = []
    const d = new MouseDispatcher({ layer: () => layer, enabled: () => true, after: () => undefined, error: (e) => { throw e } }, () => now)
    const add = (name: string, depth: number, rect: { x: number; y: number; width: number; height: number }, handlers: ZoneHandlers, at = 0) => d.registry.add({ layer: at, depth, rect: () => rect, handlers: () => handlers })
    const rec = (name: string) => (e: ZoneEvent) => { log.push(`${name} ${e.x},${e.y}${e.direction ? ` ${e.direction}` : ''}`) }
    const ev = (type: string, x: number, y: number, extra: Partial<RawMouse> = {}): RawMouse => ({ type, button: 0, x, y, ...extra })
    return { d, add, rec, ev, log, tick: (ms: number) => { now += ms }, setLayer: (n: number) => { layer = n } }
  }

  test('click in local coordinates; a second press on the same cell within 400 ms is a double-click', () => {
    const s = setup()
    s.add('row', 1, { x: 10, y: 5, width: 20, height: 1 }, { onClick: s.rec('click'), onDouble: s.rec('double') })
    s.d.handle(s.ev('down', 12, 5))
    s.tick(100)
    s.d.handle(s.ev('down', 12, 5))
    s.tick(100)
    s.d.handle(s.ev('down', 12, 5)) // a third press starts over
    s.tick(500)
    s.d.handle(s.ev('down', 13, 5))
    s.tick(500)
    s.d.handle(s.ev('down', 13, 5)) // too slow
    expect(s.log).toEqual(['click 2,0', 'double 2,0', 'click 2,0', 'click 3,0', 'click 3,0'])
  })

  test('a handler that returns false bubbles to the enclosing zone; a double-click with no double action is a click', () => {
    const s = setup()
    s.add('pane', 0, { x: 0, y: 0, width: 80, height: 24 }, { onClick: s.rec('pane'), onRight: s.rec('pane-right') })
    s.add('row', 1, { x: 0, y: 3, width: 80, height: 1 }, { ...pickRow(() => s.log.push('select')) })
    s.d.handle(s.ev('down', 4, 3))
    s.d.handle(s.ev('down', 4, 3, { button: 2 }))
    expect(s.log).toEqual(['select', 'pane 4,3', 'select', 'pane-right 4,3'])
  })

  test('the wheel: 3 lines, Shift turns it sideways; wheel keys only where they apply', () => {
    const s = setup()
    const pressed: string[] = []
    s.add('pane', 0, { x: 0, y: 0, width: 80, height: 24 }, { onWheel: (e) => wheelAsKeys(e, (k) => pressed.push(k.name)) })
    s.add('grid', 1, { x: 0, y: 2, width: 80, height: 10 }, { onWheel: (e) => (e.direction === 'left' || e.direction === 'right' ? void s.log.push(`side ${e.direction}`) : false) })
    s.d.handle(s.ev('scroll', 5, 5, { scroll: { direction: 'down' } }))
    s.d.handle(s.ev('scroll', 5, 5, { scroll: { direction: 'up' }, modifiers: { shift: true } }))
    s.d.handle(s.ev('scroll', 5, 20, { scroll: { direction: 'right' } }))
    expect(pressed).toEqual(['down', 'down', 'down'])
    expect(s.log).toEqual(['side left'])
  })

  test('a drag stays with the zone it started in, also outside it, and ends with a drop', () => {
    const s = setup()
    s.add('header', 1, { x: 0, y: 2, width: 40, height: 1 }, { onClick: s.rec('click'), onDrag: (e) => { s.log.push(`drag ${e.startX}->${e.x}`) }, onDrop: (e) => { s.log.push(`drop ${e.x},${e.y}`) } })
    s.d.handle(s.ev('down', 10, 2))
    s.d.handle(s.ev('drag', 12, 2))
    s.d.handle(s.ev('drag', 50, 7))
    s.d.handle(s.ev('up', 50, 7))
    s.d.handle(s.ev('up', 50, 7)) // a stray release does nothing
    expect(s.log).toEqual(['click 10,0', 'drag 10->12', 'drag 10->50', 'drop 50,5'])
  })

  test('with a dialog open, clicks beside it reach nothing; hover and the middle button are ignored; off means off', () => {
    const s = setup()
    s.add('pane', 0, { x: 0, y: 0, width: 80, height: 24 }, { onClick: s.rec('pane') })
    s.add('dialog', 0, { x: 20, y: 5, width: 40, height: 10 }, { onClick: s.rec('dialog') }, 1)
    s.setLayer(1)
    expect(s.d.handle(s.ev('down', 2, 2))).toBe(false)
    expect(s.d.handle(s.ev('down', 25, 6))).toBe(true)
    expect(s.d.handle(s.ev('move', 25, 6))).toBe(false)
    expect(s.d.handle(s.ev('down', 25, 6, { button: 1 }))).toBe(false)
    expect(s.log).toEqual(['dialog 5,1'])
    const off = new MouseDispatcher({ layer: () => 0, enabled: () => false, after: () => undefined, error: () => undefined })
    off.registry.add({ layer: 0, depth: 0, rect: () => ({ x: 0, y: 0, width: 9, height: 9 }), handlers: () => ({ onClick: () => { throw new Error('should not run') } }) })
    expect(off.handle({ type: 'down', button: 0, x: 1, y: 1 })).toBe(false)
  })
})

test('a press no zone takes goes to the host (the lock screen wakes); the wheel and releases do not', () => {
  const seen: string[] = []
  const d = new MouseDispatcher({ layer: () => LOCK_LAYER, enabled: () => true, after: () => undefined, error: () => undefined, unhandled: (raw) => { seen.push(raw.type); return true } })
  expect(d.handle({ type: 'down', button: 0, x: 3, y: 3 })).toBe(true)
  expect(d.handle({ type: 'scroll', button: 0, x: 3, y: 3, scroll: { direction: 'down' } })).toBe(false)
  expect(d.handle({ type: 'up', button: 0, x: 3, y: 3 })).toBe(false)
  expect(seen).toEqual(['down'])
})
