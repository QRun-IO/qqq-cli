/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { removePin, setPin } from '@qrun-io/qqq-core'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { SaverOverlay } from '../src/overlays/saver'
import { FONT_HEIGHT, blockText, blockWidth } from '../src/saver/font'
import { AUTO_STYLE_MILLIS, FRAME_MILLIS, bounce, nextFrameDelay, paintSaver, styleAt, type SaverInput, type SaverTile } from '../src/saver/layout'
import { EventRate, MAX_BACKOFF_MS, TileModel, isAbsent, sparkline, type TileSource, type TileValue } from '../src/saver/model'
import { decodeBraille, encodeBraille, mirrorAscii, queryFrame, queryPoseAt, querySize } from '../src/saver/query-art'
import { readSaverSettings, writeSaverSettings, SAVER_STYLES } from '../src/saver/settings'
import { compact, countJobs, esbSource, healthSource, jobsSource, presenceSource, type SaverContext } from '../src/saver/sources'
import { THEMES } from '../src/theme'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

isolate()

function source(id: string, load: () => Promise<TileValue>, extra: Partial<TileSource> = {}): TileSource {
  return { id, label: id, needs: 'core', present: () => true, load, ...extra }
}

describe('tile model', () => {
  test('a source whose extension is absent is not shown and never loaded', async () => {
    let calls = 0
    const model = new TileModel([source('a', async () => ({ value: '1' })), source('b', async () => { calls++; return { value: '2' } }, { present: () => false })], { intervalMs: 10_000, now: () => 0 })
    await model.refresh(0)
    expect(model.tiles().map((t) => t.id)).toEqual(['a'])
    expect(calls).toBe(0)
  })

  test('403, 404 and not-installed hide the tile for good', async () => {
    const model = new TileModel([
      source('forbidden', async () => { throw new UiApiError(403, { message: 'no' }) }),
      source('missing', async () => { throw new UiApiError(404, { message: 'no route' }) }),
      source('ok', async () => ({ value: 'fine' })),
    ], { intervalMs: 10_000, now: () => 0 })
    await model.refresh(0)
    expect(model.tiles().map((t) => t.id)).toEqual(['ok'])
    expect(model.isHidden('forbidden')).toBe(true)
    expect(isAbsent(new UiApiError(500, {}))).toBe(false)
  })

  test('loading shows no value; a failure with no value is an error; after a value it is kept as stale', async () => {
    let fail = true
    let t = 0
    const model = new TileModel([source('x', async () => { if (fail) throw new UiApiError(500, { message: 'boom' }); return { value: '7' } })], { intervalMs: 10_000, now: () => t })
    expect(model.tile('x')!.status).toBe('loading')
    await model.refresh(t)
    expect(model.tile('x')!.status).toBe('error')
    expect(model.tile('x')!.value).toBeUndefined()
    fail = false
    t = 20_000
    await model.refresh(t)
    expect(model.tile('x')!.status).toBe('ok')
    expect(model.tile('x')!.value?.value).toBe('7')
    fail = true
    t = 30_000
    await model.refresh(t)
    const s = model.tile('x')!
    expect(s.status).toBe('stale')
    expect(s.value?.value).toBe('7')
    expect(model.isStale(s, t)).toBe(true)
  })

  test('failures back off (interval × 2^n, capped) and a source is not asked again before it is due', async () => {
    let calls = 0
    const model = new TileModel([source('x', async () => { calls++; throw new Error('down') })], { intervalMs: 10_000, now: () => 0 })
    await model.refresh(0)
    expect(model.tile('x')!.nextAt).toBe(20_000)
    await model.refresh(19_999)
    expect(calls).toBe(1)
    await model.refresh(20_000)
    expect(calls).toBe(2)
    expect(model.tile('x')!.nextAt).toBe(20_000 + 40_000)
    expect(model.backoff(20)).toBe(MAX_BACKOFF_MS)
  })

  test('local sources are read on every refresh; a value three intervals old counts as stale', async () => {
    let n = 0
    let t = 0
    const model = new TileModel([source('local', async () => ({ value: String(++n) }), { local: true }), source('remote', async () => ({ value: 'r' }))], { intervalMs: 10_000, now: () => t })
    await model.refresh(0)
    await model.refresh(1000)
    expect(model.tile('local')!.value?.value).toBe('2')
    t = 0
    const remote = model.tile('remote')!
    expect(model.isStale(remote, 25_000)).toBe(false)
    expect(model.isStale(remote, 31_000)).toBe(true)
  })
})

describe('event rate', () => {
  test('events in the last minute and per-minute buckets', () => {
    const r = new EventRate()
    const now = 10 * 60_000
    for (const t of [now - 5_000, now - 30_000, now - 59_000, now - 61_000, now - 125_000]) r.note(t)
    expect(r.perMinute(now)).toBe(3)
    const b = r.buckets(now, 3)
    expect(b).toEqual([1, 1, 3])
    expect(sparkline([0, 2, 4], '▁▂▃▄▅▆▇█')).toBe('▁▅█')
    expect(sparkline([0, 0], ' .:-=+*#')).toBe('  ')
  })
})

function ctx(over: Partial<SaverContext> & { data?: (id: string, input: unknown) => unknown } = {}): SaverContext {
  const data = over.data ?? (() => ({}))
  return {
    client: { data: async (id: string, input: unknown) => data(id, input), count: async () => 0 } as never,
    has: () => true, features: ['durableJobs', 'realtime'],
    status: () => ({ apiVersion: '1.9.0', pingMs: 3, stream: 'connected', lastEvent: 'x', user: 'Me', userId: 'core:me' }),
    events: new EventRate(), presenceTables: () => ['person', 'order'], favouriteTables: [], tableLabel: (n) => n.toUpperCase(), intervalMs: () => 10_000,
    ...over,
  }
}

describe('sources', () => {
  test('presence: everyone across the sampled tables (this user only from another session); people not seen again age out', async () => {
    let t = 0
    const viewers: Record<string, Array<{ userId: string; displayName: string; mode: string }>> = {
      person: [{ userId: 'core:me', displayName: 'Me', mode: 'VIEWING' }, { userId: 'u:bob', displayName: 'Bob', mode: 'VIEWING' }],
      order: [{ userId: 'u:carol', displayName: 'Carol', mode: 'EDITING' }],
    }
    const s = presenceSource(ctx({ now: () => t, data: (_id, input) => ({ viewers: viewers[(input as { query: { table: string } }).query.table] ?? [] }) }))
    const v = await s.load()
    expect(v.value).toBe('3')
    expect(v.detail).toMatch(/^Bob · PERSON, Carol editing · ORDER, you elsewhere · PERSON$/)
    viewers.person = []
    viewers.order = []
    t = 120_000
    expect((await s.load()).value).toBe('0')
  })

  test('presence on a table that refuses it is skipped; the source hides when nothing is left', async () => {
    const s = presenceSource(ctx({ data: () => { throw new UiApiError(404, {}) } }))
    await s.load()
    await expect(s.load()).rejects.toThrow('no tables')
  })

  test('jobs: counts by status, falls back to my jobs on 403', async () => {
    expect(countJobs([{ status: 'RUNNING' }, { status: 'QUEUED' }, { status: 'FAILED' }, { status: 'COMPLETE' }, { status: 'running' }])).toEqual({ running: 2, queued: 1, failed: 1 })
    const scopes: string[] = []
    const s = jobsSource(ctx({ data: (_id, input) => {
      const scope = (input as { query: { scope: string } }).query.scope
      scopes.push(scope)
      if (scope === 'all') throw new UiApiError(403, {})
      return { jobs: [{ status: 'RUNNING' }, { status: 'FAILED' }] }
    } }))
    const v = await s.load()
    expect(scopes).toEqual(['all', 'mine'])
    expect(v.value).toBe('1 running')
    expect(v.level).toBe('warn')
    expect(v.detail).toContain('(yours)')
  })

  test('health and ESB read their summaries', async () => {
    const h = await healthSource(ctx({ data: () => ({ status: 'DOWN', counts: { up: 16, degraded: 1, down: 2, unknown: 2 } }) })).load()
    expect(h).toMatchObject({ value: 'DOWN', level: 'err', big: '16/21' })
    const e = await esbSource(ctx({ data: () => ({ providers: [{ connected: true }], destinations: [{ queueInfo: { messageCount: 4 }, counters: { deadLettered: 2, inFlight: 1 } }, { queueInfo: null, counters: {} }] }) })).load()
    expect(e.value).toBe('4 queued')
    expect(e.detail).toContain('2 dead letters')
    expect(e.level).toBe('warn')
    expect(compact(1234)).toBe('1234')
    expect(compact(12_345)).toBe('12.3k')
    expect(compact(3_400_000)).toBe('3.4M')
  })
})

describe('Query', () => {
  test('both sizes have their documented size; braille round-trips; mirrored and blinking frames differ', () => {
    for (const size of ['small', 'large'] as const) {
      const { width, height } = querySize(size)
      const frame = queryFrame(size)
      expect(frame.length).toBe(height)
      for (const r of frame) expect([...r].length).toBe(width)
      expect(encodeBraille(decodeBraille(frame))).toEqual(frame)
      expect(queryFrame(size, { blink: true })).not.toEqual(frame)
      expect(queryFrame(size, { wag: true })).not.toEqual(frame)
      expect(queryFrame(size, { facing: 'left' })).not.toEqual(frame)
      for (const ascii of [queryFrame(size, {}, true), queryFrame(size, { facing: 'left', blink: true }, true)]) {
        expect(ascii.length).toBe(height)
        for (const r of ascii) expect(r).toMatch(/^[\x20-\x7e]*$/)
      }
    }
    expect(mirrorAscii("(/`")).toBe("'\\)")
  })

  test('poses: blinks, acts every ten seconds, faces the way he drifts', () => {
    expect(queryPoseAt(0).blink).toBe(true)
    expect(queryPoseAt(1000).blink).toBe(false)
    expect(queryPoseAt(9500).action).toBe(true)
    expect(queryPoseAt(9500).dy).toBe(-1)
    expect(queryPoseAt(5000, { dx: -1 }).facing).toBe('left')
    expect(queryPoseAt(5000, { dx: 1, dy: 1 }).glance).toBe(1)
  })
})

function tile(id: string, label: string, value?: TileValue, status: 'ok' | 'stale' | 'loading' | 'error' = 'ok'): SaverTile {
  return { state: { id, label, needs: 'x', status, value, failures: 0, nextAt: 0 }, stale: status === 'stale' }
}

const TILES: SaverTile[] = [
  tile('people', 'Online', { value: '2', detail: 'Bob · Person, Carol editing · Order with a very long table label that must be cut', big: '2', interest: 52 }),
  tile('jobs', 'Jobs', { value: '1 running', detail: '0 queued · 3 failed recently', level: 'warn', big: '1', interest: 25 }),
  tile('health', 'Health', { value: 'DOWN', detail: '16 up · 1 degraded · 2 down', level: 'err', big: '16/21', interest: 58 }),
  tile('db', 'Database', undefined, 'loading'),
  tile('esb', 'ESB', { value: '0 queued', detail: '0 dead letters', big: '0' }, 'stale'),
  tile('events', 'Events', { value: '4/min', spark: [0, 1, 3, 2, 4], big: '4', interest: 16 }),
  tile('server', 'Server', { value: '3 ms', detail: 'UI API 1.9.0', level: 'ok', big: '3', interest: 1 }),
]

function input(over: Partial<SaverInput>): SaverInput {
  return { style: 'bounce', now: 1_000_005_000, width: 80, height: 24, tiles: TILES, server: 'localhost:8078', profile: 'enterprise', brand: 'QQQ', ascii: false, theme: THEMES['high-contrast']!, locked: false, preview: false, ramp: '▁▂▃▄▅▆▇█', ...over }
}

describe('layout', () => {
  for (const [width, height] of [[80, 24], [120, 40]] as const) {
    for (const style of SAVER_STYLES) {
      test(`${style} at ${width}×${height}: everything inside the screen, clock, server and profile on top`, () => {
        // several moments: the sprite at different places, mid-flip, the hop
        for (const now of [1_000_000_000, 1_000_009_500, 1_000_020_100, 1_000_047_250, 1_000_133_000]) {
          const c = paintSaver(input({ style, width, height, now }))
          const lines = c.text().split('\n')
          expect(lines.length).toBe(height)
          for (const l of lines) expect([...l].length).toBe(width)
          expect(lines[0]).toContain('localhost:8078')
          expect(lines[0]).toContain('enterprise')
          expect(lines[0]).toMatch(/\d\d:\d\d:\d\d/)
          expect(lines[height - 1]).toContain('any key returns')
        }
      })
    }
    test(`tiles at ${width}×${height}: labels shown, loading as …, stale marked`, () => {
      const text = paintSaver(input({ style: 'flip', width, height })).text()
      for (const label of ['Online', 'Jobs', 'Health', 'Database', 'ESB', 'Events', 'Server']) expect(text).toContain(label)
      expect(text).toMatch(/Database +…/)
      expect(text).toContain('(stale)')
    })
  }

  test('Bounce draws large Query with the qqq logo at 120×40 and large Query at 80×24', () => {
    const big = paintSaver(input({ style: 'bounce', width: 120, height: 40, tiles: [], now: 1_000_001_000 })).text()
    const rows = [...queryFrame('large'), ...queryFrame('large', { facing: 'left' })].map((r) => r.trim().slice(0, 10))
    expect(rows.some((r) => big.includes(r))).toBe(true)
    expect(big).toContain(blockText('qqq')[1]!)
    const small = paintSaver(input({ style: 'bounce', width: 80, height: 24, tiles: [], now: 1_000_001_000 })).text()
    expect(small).toContain('q q q')
  })

  test('Big numbers shows the most interesting tile in block digits, then rotates', () => {
    const first = paintSaver(input({ style: 'big', now: 0 })).text()
    expect(first).toContain('HEALTH')
    expect(first).toContain(blockText('16/21')[0]!)
    expect(paintSaver(input({ style: 'big', now: 8000 })).text()).toContain('ONLINE')
  })

  test('the PIN prompt sits over the saver; the ASCII glyph set draws no braille or blocks', () => {
    const locked = paintSaver(input({ locked: true, pin: { length: 3, message: '' } })).text()
    expect(locked).toContain('PIN: •••')
    expect(locked).toContain('locked')
    for (const style of SAVER_STYLES) {
      const text = paintSaver(input({ style, ascii: true, ramp: ' .:-=+*#', now: 1_000_009_500 })).text()
      expect(text).not.toMatch(/[\u2800-\u28ff█▸◂╭╮╰╯─│]/)
    }
  })

  test('frame rate: at most 4 fps, about 1 fps when nothing moves; auto cycles styles', () => {
    expect(nextFrameDelay('bounce', 1234)).toBe(FRAME_MILLIS)
    expect(nextFrameDelay('flip', 1_000_020_100)).toBe(FRAME_MILLIS)
    const idle = nextFrameDelay('flip', 2_500)
    expect(idle).toBeGreaterThan(FRAME_MILLIS)
    expect(idle).toBeLessThanOrEqual(1000)
    expect(styleAt('auto', 0)).toBe('bounce')
    expect(styleAt('auto', AUTO_STYLE_MILLIS)).toBe('starfield')
    expect(styleAt('flip', AUTO_STYLE_MILLIS)).toBe('flip')
    expect(bounce(7, 5)).toBe(3)
    expect(blockWidth('12')).toBe(9)
    expect(blockText('1').length).toBe(FONT_HEIGHT)
  })
})

describe('settings', () => {
  test('style and refresh saved globally, tables per profile, interval clamped to 10–30 s', () => {
    writeSaverSettings({ style: 'flip', refreshSeconds: 99 })
    writeSaverSettings({ tables: ['person', 'order', 'shipment', 'extra'] }, 'fake')
    const s = readSaverSettings('fake')
    expect(s).toEqual({ style: 'flip', refreshSeconds: 30, tables: ['person', 'order', 'shipment'] })
    expect(readSaverSettings('other').tables).toEqual([])
    writeSaverSettings({ style: 'auto', refreshSeconds: 15, tables: [] }, 'fake')
  })
})

describe('in the TUI', () => {
  let h: Harness
  beforeAll(async () => {
    h = await startTui(100, 30)
  })
  afterAll(() => {
    h.setup.renderer.destroy()
  })

  test(':saver <style> previews it; any key returns', async () => {
    await command(h, 'saver flip')
    expect(h.store.lock).toBeInstanceOf(SaverOverlay)
    const frame = await waitFor(h, (f) => f.includes('preview: flip'))
    expect(frame).toContain('Server')
    await press(h, () => h.setup.mockInput.typeText('x'))
    expect(h.store.lock).toBeUndefined()
  })

  test('the lock with a PIN: any key shows the prompt over the saver, Esc goes back, the PIN unlocks', async () => {
    setPin('2468')
    try {
      h.store.commands().lock()
      await waitFor(h, (f) => f.includes('locked · any key to unlock'))
      let frame = await press(h, () => h.setup.mockInput.typeText('a'))
      expect(frame).toContain('Unlock')
      frame = await press(h, () => h.setup.mockInput.pressEscape())
      expect(frame).not.toContain('PIN:')
      expect(h.store.lock).toBeInstanceOf(SaverOverlay)
      await press(h, () => h.setup.mockInput.typeText('a'))
      await press(h, () => h.setup.mockInput.typeText('2468'))
      await press(h, () => h.setup.mockInput.pressEnter())
      expect(h.store.lock).toBeUndefined()
    } finally {
      removePin('2468')
    }
  })

  test('F9 → Settings lists the saver style, refresh and preview', () => {
    const labels = (h.store.commands() as unknown as { entries(f: string): Array<{ label: string }> }).entries('').map((e) => e.label)
    expect(labels.some((l) => l.startsWith('Screen saver style:'))).toBe(true)
    expect(labels.some((l) => l.startsWith('Screen saver refresh:'))).toBe(true)
    expect(labels).toContain('Preview the screen saver')
  })
})
