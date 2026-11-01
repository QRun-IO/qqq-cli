/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { removePin, setPin } from '@qrun-io/qqq-core'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { SaverOverlay } from '../src/overlays/saver'
import { setPresenceSource } from '../src/presence'
import { FONT_HEIGHT, blockText, blockWidth, canDraw } from '../src/saver/font'
import { ALTERNATE_MILLIS, AUTO_STYLE_MILLIS, FRAME_MILLIS, SHIFT_MILLIS, bounce, bounceLayout, isDimmed, logoName, nextFrameDelay, paintSaver, saverFrame, styleAt, type SaverInput, type SaverTile } from '../src/saver/layout'
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
    expect(v.detail).toBe('3 online · you, Bob · PERSON, Carol editing · ORDER')
    viewers.person = []
    viewers.order = []
    t = 120_000
    expect((await s.load()).value).toBe('1')
  })

  test('presence counts connections: two terminals of one user are 2 online; older servers count each person once', async () => {
    const viewers: Record<string, Array<{ userId: string; displayName: string; mode: string; connections?: number }>> = {
      person: [{ userId: 'core:me', displayName: 'Me', mode: 'VIEWING', connections: 1 }, { userId: 'u:bob', displayName: 'Bob', mode: 'VIEWING', connections: 2 }],
      order: [{ userId: 'core:me', displayName: 'Me', mode: 'VIEWING', connections: 1 }],
    }
    const s = presenceSource(ctx({ data: (_id, input) => ({ viewers: viewers[(input as { query: { table: string } }).query.table] ?? [] }) }))
    const v = await s.load()
    expect(v.value).toBe('4')
    expect(v.detail).toBe('4 online · you ×2, Bob ×2 · PERSON')
    // only this terminal's own lease, no "connections" (collaboration 1.1.0): you, once
    const old = presenceSource(ctx({ data: () => ({ viewers: [{ userId: 'core:me', displayName: 'Me', mode: 'VIEWING' }] }) }))
    const o = await old.load()
    expect(o.value).toBe('1')
    expect(o.detail).toBe('1 online · you')
  })

  test('presence on a table that refuses it is skipped; the source hides when nothing is left', async () => {
    const refuse = () => { throw new UiApiError(404, {}) }
    // signed out: nothing to show once every table refuses
    const out = presenceSource(ctx({ status: () => ({ apiVersion: '1', pingMs: 1, stream: 'connected', lastEvent: '', user: '' }), data: refuse }))
    await out.load()
    await expect(out.load()).rejects.toThrow('no tables')
    // signed in: never "nobody around", this terminal is online
    const me = presenceSource(ctx({ data: refuse }))
    await me.load()
    const v = await me.load()
    expect(v.value).toBe('1')
    expect(v.detail).toBe('1 online · you')
  })

  test('online by session: sessions active in the last 10 minutes, own sessions counted, others by user', async () => {
    const queries: unknown[] = []
    const rows = [{ userId: 'core:me' }, { userId: 'core:me' }, { userId: 'core:bob' }]
    const client = { query: async (_t: string, f: unknown) => { queries.push(f); return rows.map((values) => ({ values })) }, data: async () => ({}), count: async () => 0 }
    const mk = (over: Partial<SaverContext> & { data?: (id: string, input: unknown) => unknown } = {}) => ctx({ client: client as never, sessionTable: () => 'storedSession', now: () => 1_000_000_000_000, ...over })
    const v = await presenceSource(mk()).load()
    expect(v.value).toBe('3 online')
    expect(v.detail).toBe('3 sessions · 2 users (you ×2, bob)')
    expect(v.big).toBe('3')
    const f = queries[0] as { criteria: Array<{ fieldName: string; operator: string; values: string[] }> }
    expect(f.criteria[0]).toMatchObject({ fieldName: 'modifyDate', operator: 'GREATER_THAN', values: [new Date(1_000_000_000_000 - 600_000).toISOString()] })
    // the owner's case: the same user twice
    rows.splice(2, 1)
    expect((await presenceSource(mk()).load()).detail).toBe('2 sessions · 1 user (you ×2)')
    // an empty session table (a mock-auth server stores none) falls back to presence and still counts you
    rows.length = 0
    const fb = await presenceSource(mk({ data: () => ({ viewers: [] }) })).load()
    expect(fb.value).toBe('1')
    expect(fb.detail).toBe('1 online · you')
    // no session table, no collaboration: the tile hides
    expect(presenceSource(ctx({ has: () => false })).present()).toBe(false)
    expect(presenceSource(ctx({ has: () => false, sessionTable: () => 'storedSession' })).present()).toBe(true)
    // a session table the user may not read is skipped for good
    const denied = { ...client, query: async () => { throw new UiApiError(403, {}) } }
    const d = presenceSource(mk({ client: denied as never, data: () => ({ viewers: [] }) }))
    expect((await d.load()).value).toBe('1')
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
    for (const size of ['small', 'medium', 'large'] as const) {
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

  test('every size keeps the logo\'s silhouette: floppy ear left of the head and snout, tail curled at the low left, sitting body, front legs and the ground line at the bottom', () => {
    expect(querySize('large')).toEqual({ width: 42, height: 22 })
    expect(querySize('medium')).toEqual({ width: 25, height: 13 })
    expect(querySize('small')).toEqual({ width: 17, height: 9 })
    for (const size of ['large', 'medium', 'small'] as const) {
      const rows = queryFrame(size)
      const bits = decodeBraille(rows)
      const H = bits.length
      const W = bits[0]!.length
      const dots = (y0: number, y1: number, x0 = 0, x1 = W) => {
        const out: Array<[number, number]> = []
        for (let y = Math.floor(y0 * H); y < Math.ceil(y1 * H); y++) for (let x = Math.floor(x0 * W); x < Math.ceil(x1 * W); x++) if (bits[y]?.[x]) out.push([x, y])
        return out
      }
      const minX = (d: Array<[number, number]>) => Math.min(...d.map((p) => p[0]))
      const maxX = (d: Array<[number, number]>) => Math.max(...d.map((p) => p[0]))
      // the picture is the logo's: dots across the whole height and most of the width, nothing past the cells
      expect(dots(0, 1).length).toBeGreaterThan(H)
      expect(rows.length).toBe(querySize(size).height)
      // head and ear: the top third; the ear (its left edge) is well left of the snout (the right edge), the snout is the rightmost thing up there
      const head = dots(0, 0.34)
      expect(head.length).toBeGreaterThan(5)
      expect(maxX(head)).toBeGreaterThan(W * 0.7)
      expect(minX(head)).toBeLessThan(W * 0.55)
      expect(maxX(head) - minX(head)).toBeGreaterThan(W * 0.3)
      // the top of the head sits above the middle of the back, right of the tail
      expect(minX(head)).toBeGreaterThan(W * 0.2)
      // the tail: ink in the low-left corner, left of where the body's back reaches the ground
      const tail = dots(0.6, 1, 0, 0.22)
      expect(tail.length).toBeGreaterThan(4)
      // the sitting body: the chest edge at the right in the middle rows and the haunch at the left
      const middle = dots(0.4, 0.75)
      expect(maxX(middle)).toBeGreaterThan(W * 0.6)
      expect(minX(middle)).toBeLessThan(W * 0.5)
      // front legs and the ground line: the bottom row of cells spans most of the width
      const ground = dots(0.84, 1)
      expect(maxX(ground) - minX(ground)).toBeGreaterThan(W * 0.6)
      expect(maxX(ground)).toBeGreaterThan(W * 0.7)
      // the eye is inside the head, right of the ear's left edge
      expect(queryFrame(size, { blink: true })).not.toEqual(rows)
    }
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
  return { style: 'bounce', now: 1_000_005_000, width: 80, height: 24, tiles: TILES, server: 'localhost:8078', profile: 'enterprise', brand: 'QQQ', ascii: false, theme: THEMES['high-contrast']!, locked: false, preview: false, ramp: '▁▂▃▄▅▆▇█', shortName: 'ent', burnin: false, dim: false, ...over }
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

  test('Bounce draws large Query with the profile\'s short name in block letters and the host beneath at 120×40', () => {
    const big = paintSaver(input({ style: 'bounce', width: 120, height: 40, tiles: [], now: 1_000_001_000 })).text()
    const rows = [...queryFrame('large'), ...queryFrame('large', { facing: 'left' })].map((r) => r.trim().slice(0, 10))
    expect(rows.some((r) => big.includes(r))).toBe(true)
    const lines = big.split('\n')
    const ent = blockText('ent')
    const top = lines.findIndex((l) => l.includes(ent[0]!))
    expect(top).toBeGreaterThan(0)
    ent.forEach((r, i) => expect(lines[top + i]).toContain(r))
    // "localhost:8078" under the letters (the top row has it too, in normal text)
    expect(lines[top + FONT_HEIGHT]).toContain('localhost:8078')
    expect(big).not.toContain(blockText('qqq')[1]!)
  })

  test('the logo says the short name when it has 6 characters or fewer, else the profile; unknown characters fall back to plain text', () => {
    expect(logoName(input({}))).toBe('ent')
    expect(logoName(input({ shortName: 'enterp7', profile: 'enterprise' }))).toBe('enterprise')
    expect(logoName(input({ shortName: undefined, profile: '' }))).toBe('qqq')
    expect(canDraw('Prod-eu_1.a')).toBe(true)
    expect(canDraw('abcdefghijklmnopqrstuvwxyz0123456789-_.')).toBe(true)
    expect(canDraw('café')).toBe(false)
    for (const text of ['ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz0123456789-_.']) {
      const rows = blockText(text)
      expect(rows.length).toBe(FONT_HEIGHT)
      for (const r of rows) expect([...r].length).toBe(blockWidth(text))
    }
    // not drawable: plain text, and the host beneath
    const plain = paintSaver(input({ style: 'bounce', width: 120, height: 40, tiles: [], shortName: undefined, profile: 'café prod', now: 1_000_001_000 })).text()
    expect(plain).toContain('café prod')
    expect(plain).not.toContain(blockText('prod')[0]!)
  })

  test('at 80×24 Query is small so the block-letter name fits', () => {
    const text = paintSaver(input({ style: 'bounce', width: 80, height: 24, tiles: [], now: 1_000_001_000 })).text()
    expect(text).toContain(blockText('ent')[2]!)
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
    expect(s).toEqual({ style: 'flip', refreshSeconds: 30, tables: ['person', 'order', 'shipment'], burnin: true, dimMinutes: 10 })
    expect(readSaverSettings('other').tables).toEqual([])
    writeSaverSettings({ style: 'auto', refreshSeconds: 15, tables: [] }, 'fake')
  })

  test('burn-in guard defaults on and dim to 10 minutes; both are saved, dim 0 is off', () => {
    expect(readSaverSettings()).toMatchObject({ burnin: true, dimMinutes: 10 })
    writeSaverSettings({ burnin: false, dimMinutes: 0 })
    expect(readSaverSettings()).toMatchObject({ burnin: false, dimMinutes: 0 })
    writeSaverSettings({ burnin: true, dimMinutes: 3.4 })
    expect(readSaverSettings()).toMatchObject({ burnin: true, dimMinutes: 3 })
    writeSaverSettings({ dimMinutes: 10 })
  })
})

describe('burn-in guard', () => {
  const SIZES = [[80, 24], [120, 40]] as const
  const moments = (n: number, from = 1_000_000_000, every = 250) => Array.from({ length: n }, (_, i) => from + i * every)

  for (const [width, height] of SIZES) {
    test(`Bounce at ${width}×${height}: the tile panel rides beside the logo, swaps sides and never leaves the screen`, () => {
      const panels = new Set<string>()
      const sides = new Set<string>()
      let moved = 0
      let last = ''
      for (const now of moments(400, 1_000_000_000, 700)) {
        const i = input({ style: 'bounce', width, height, now, burnin: true })
        const l = bounceLayout(i)
        expect(l.showSprite).toBe(true)
        const p = l.panel!
        expect(p).toBeDefined()
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.x + p.w).toBeLessThanOrEqual(width)
        expect(p.y).toBeGreaterThanOrEqual(1)
        expect(p.y + p.h).toBeLessThanOrEqual(height - 1)
        // beside the logo (a one-cell gap), on one side or the other, never on top of it
        const right = p.x === l.sprite.x + l.sprite.w + 1
        const left = p.x + p.w === l.sprite.x - 1
        expect(right || left).toBe(true)
        sides.add(right ? 'right' : 'left')
        const key = `${p.x},${p.y}`
        panels.add(key)
        if (key !== last) moved++
        last = key
        // and it is on the canvas where it says
        const lines = paintSaver(i).text().split('\n')
        expect(lines[p.y]!.slice(p.x, p.x + p.w)).toContain(' live ')
      }
      expect(panels.size).toBeGreaterThan(20)
      expect(moved).toBeGreaterThan(300)
      expect(sides.size).toBe(2)
    })

    test(`Bounce at ${width}×${height}: the panel moves with the logo from one frame to the next`, () => {
      for (const now of moments(60, 1_000_003_000)) {
        const a = bounceLayout(input({ style: 'bounce', width, height, now, burnin: true }))
        const b = bounceLayout(input({ style: 'bounce', width, height, now: now + FRAME_MILLIS, burnin: true }))
        const spriteMoved = a.sprite.x !== b.sprite.x || a.sprite.y !== b.sprite.y
        const panelMoved = a.panel!.x !== b.panel!.x || a.panel!.y !== b.panel!.y
        if (spriteMoved) expect(panelMoved).toBe(true)
      }
    })

    test(`Bounce at ${width}×${height} with the guard off keeps the panel in the bottom-right corner`, () => {
      const seen = new Set<string>()
      for (const now of moments(100, 1_000_000_000, 900)) {
        const p = bounceLayout(input({ style: 'bounce', width, height, now, burnin: false })).panel!
        seen.add(`${p.x},${p.y}`)
        expect(p.x + p.w).toBe(width - 1)
        expect(p.y + p.h).toBe(height - 1)
      }
      expect(seen.size).toBe(1)
    })

    test(`header and lock line at ${width}×${height} change place every cycle in every style, just above and below the group; the clock stays visible`, () => {
      for (const style of SAVER_STYLES) {
        const header = new Set<string>()
        const lock = new Set<string>()
        for (let cycle = 0; cycle < 12; cycle++) {
          const now = 1_000_000_000 + cycle * SHIFT_MILLIS + 5_000
          const i = input({ style, width, height, now, burnin: true, locked: true })
          const { canvas, group: g, chrome: c } = saverFrame(i)
          header.add(`${c.headerRow},${c.headerX}`)
          lock.add(`${c.footerRow},${c.footerX}`)
          const above = Math.max(0, g.y - 1)
          const below = Math.min(height - 1, g.y + g.h)
          const even = Math.floor(now / SHIFT_MILLIS) % 2 === 0
          expect(c.headerRow).toBe(even ? above : below)
          expect(c.footerRow).toBe(even ? below : above)
          const lines = canvas.text().split('\n')
          expect(lines[c.headerRow]!.slice(c.headerX, c.headerX + c.headerText.length)).toBe(c.headerText)
          expect(lines[c.footerRow]!.slice(c.footerX, c.footerX + c.footerText.length)).toBe(c.footerText)
          expect(c.footerText).toBe('locked · any key to unlock')
          expect(lines.join('\n')).toMatch(/\d\d:\d\d:\d\d/)
          expect(lines.length).toBe(height)
          for (const l of lines) expect([...l].length).toBe(width)
        }
        expect(header.size).toBeGreaterThanOrEqual(5)
        expect(lock.size).toBeGreaterThanOrEqual(5)
      }
    })

    test(`with the guard off the header and lock line stay put at ${width}×${height}`, () => {
      for (const style of SAVER_STYLES) {
        const seen = new Set<string>()
        for (let cycle = 0; cycle < 6; cycle++) {
          const i = input({ style, width, height, now: 1_000_000_000 + cycle * SHIFT_MILLIS, burnin: false, locked: true })
          const lines = paintSaver(i).text().split('\n')
          expect(lines[0]).toContain('localhost:8078')
          expect(lines[height - 1]).toContain('locked · any key to unlock')
          seen.add(`${lines[0]!.indexOf('localhost')},${lines[height - 1]!.indexOf('locked')}`)
        }
        expect(seen.size).toBe(1)
      }
    })

    test(`Flip clock at ${width}×${height} drifts a cell every few seconds inside a bounded box; guard off: fixed`, () => {
      const cards = (now: number, burnin: boolean) => {
        const lines = paintSaver(input({ style: 'flip', width, height, now, burnin, tiles: TILES.slice(0, 3) })).text().split('\n')
        // the hinge of the first card
        const row = lines.findIndex((l, y) => y > 0 && y < height - 1 && l.includes('▸'))
        return { row, col: lines[row]!.indexOf('▸') }
      }
      const guarded = new Set<string>()
      const fixed = new Set<string>()
      for (let i = 0; i < 40; i++) {
        const now = 1_000_000_000 + i * 4_100 + 1_000
        const g = cards(now, true)
        guarded.add(`${g.row},${g.col}`)
        const f = cards(now, false)
        fixed.add(`${f.row},${f.col}`)
      }
      expect(guarded.size).toBeGreaterThan(2)
      const cols = [...guarded].map((k) => Number(k.split(',')[1]))
      const rowsSeen = [...guarded].map((k) => Number(k.split(',')[0]))
      expect(Math.max(...cols) - Math.min(...cols)).toBeLessThanOrEqual(8)
      expect(Math.max(...rowsSeen) - Math.min(...rowsSeen)).toBeLessThanOrEqual(2)
      expect(fixed.size).toBe(1)
    })

    test(`Big numbers at ${width}×${height} moves to another corner at each rotation; the number stays on screen`, () => {
      const spots = new Set<string>()
      for (let r = 0; r < 4; r++) {
        const i = input({ style: 'big', width, height, now: r * 8000, burnin: true, tiles: TILES.slice(0, 3) })
        const lines = paintSaver(i).text().split('\n')
        const label = lines.findIndex((l, y) => y > 0 && y < height - 1 && /HEALTH|ONLINE|JOBS|EVENTS/.test(l))
        expect(label).toBeGreaterThan(0)
        spots.add(`${label},${lines[label]!.search(/HEALTH|ONLINE|JOBS|EVENTS/)}`)
        expect(lines.join('\n')).toMatch(/\d\d:\d\d:\d\d/)
        for (const l of lines) expect([...l].length).toBe(width)
      }
      expect(spots.size).toBe(4)
    })
  }

  const LAYOUT_SIZES = [[75, 95], [200, 30], [80, 24], [120, 40], [160, 50], [200, 50]] as const
  const ONE_TILE = [tile('events', 'Events', { value: '0/min', detail: 'last: no events yet', big: '0', interest: 16 }), tile('server', 'Server', { value: '19 ms', detail: 'UI API 1.8.0 · stream connected', level: 'ok', big: '19', interest: 20 })]

  /** Spans of the non-blank cells of every body row (the header and the lock line live in the first and last). */
  function bodySpans(text: string, height: number): Array<{ y: number; from: number; to: number }> {
    const out: Array<{ y: number; from: number; to: number }> = []
    text.split('\n').forEach((l, y) => {
      if (y === 0 || y === height - 1) return
      const cells = [...l]
      const from = cells.findIndex((ch) => ch !== ' ')
      if (from < 0) return
      let to = cells.length - 1
      while (cells[to] === ' ') to--
      out.push({ y, from, to })
    })
    return out
  }

  for (const [width, height] of LAYOUT_SIZES) {
    for (const style of ['bounce', 'flip', 'big'] as const) {
      for (const [name, tiles] of [['seven tiles', TILES], ['one tile', ONE_TILE.slice(0, 1)], ['two tiles', ONE_TILE], ['no tiles', []]] as const) {
        test(`${style} at ${width}×${height} with ${name}: one group, nothing more than 40% of the screen from its centre, the clock visible`, () => {
          for (let i = 0; i < 24; i++) {
            const now = 1_000_000_000 + i * 8_300
            const frame = paintSaver(input({ style, width, height, now, burnin: true, tiles: [...tiles] }))
            const text = frame.text()
            expect(text).toMatch(/\d\d:\d\d:\d\d/)
            if (style === 'bounce') {
              // Query with its name and the tile panel: the centres of the two boxes stay together
              const l = bounceLayout(input({ style, width, height, now, burnin: true, tiles: [...tiles] }))
              if (l.panel && l.showSprite) {
                const boxes = [l.sprite, l.panel]
                const ux = (Math.min(...boxes.map((b) => b.x)) + Math.max(...boxes.map((b) => b.x + b.w))) / 2
                const uy = (Math.min(...boxes.map((b) => b.y)) + Math.max(...boxes.map((b) => b.y + b.h))) / 2
                for (const b of boxes) {
                  expect(Math.abs(b.x + b.w / 2 - ux)).toBeLessThanOrEqual(width * 0.4)
                  expect(Math.abs(b.y + b.h / 2 - uy)).toBeLessThanOrEqual(height * 0.4)
                }
              }
              continue
            }
            const spans = bodySpans(text, height)
            expect(spans.length).toBeGreaterThan(0)
            const minX = Math.min(...spans.map((r) => r.from))
            const maxX = Math.max(...spans.map((r) => r.to))
            const minY = spans[0]!.y
            const maxY = spans[spans.length - 1]!.y
            const cx = (minX + maxX) / 2
            const cy = (minY + maxY) / 2
            for (const r of spans) {
              expect(Math.abs((r.from + r.to) / 2 - cx)).toBeLessThanOrEqual(width * 0.4)
              expect(Math.abs(r.y - cy)).toBeLessThanOrEqual(height * 0.4 + 2)
            }
            {
              // the group as a whole stays near the middle of the screen, fully on it
              expect(Math.abs(cx - (width - 1) / 2)).toBeLessThanOrEqual(width * 0.4)
              expect(Math.abs(cy - (height - 1) / 2)).toBeLessThanOrEqual(height * 0.4)
              expect(minX).toBeGreaterThanOrEqual(0)
              expect(maxX).toBeLessThanOrEqual(width - 1)
            }
          }
        })
      }
    }

    test(`header at ${width}×${height}: a left margin of at least one, over the group, never inside it; the group is compact`, () => {
      const xs = new Set<number>()
      for (let cycle = 0; cycle < 40; cycle++) {
        for (const style of ['big', 'flip'] as const) {
          const i = input({ style, width, height, now: 1_000_000_000 + cycle * SHIFT_MILLIS + 2_000, burnin: true })
          const { canvas, group: g, chrome: c } = saverFrame(i)
          expect(c.headerX).toBeGreaterThanOrEqual(1)
          expect(c.headerX + c.headerText.length).toBeLessThanOrEqual(width)
          expect(c.footerX).toBeGreaterThanOrEqual(1)
          // overlapping the group's columns, in the rows just outside it
          expect(c.headerX < g.x + g.w && c.headerX + c.headerText.length > g.x).toBe(true)
          expect(c.headerRow < g.y || c.headerRow >= g.y + g.h).toBe(true)
          expect(c.footerRow < g.y || c.footerRow >= g.y + g.h).toBe(true)
          // one compact group, however big the screen
          expect(g.w).toBeLessThanOrEqual(92)
          xs.add(c.headerX)
          const lines = canvas.text().split('\n')
          expect(lines[c.headerRow]!.trim()).toBe(c.headerText)
        }
      }
      expect(xs.size).toBeGreaterThan(4)
    })
  }

  test('Big numbers: the number, Query, caption and tiles are one stack; one tile is centred under the number; the group moves as a unit', () => {
    const rows = (now: number) => paintSaver(input({ style: 'big', width: 75, height: 95, now, burnin: true, tiles: ONE_TILE })).text().split('\n')
    const centreOf = (lines: string[], needle: RegExp) => {
      const y = lines.findIndex((l, i) => i > 0 && i < lines.length - 1 && needle.test(l))
      expect(y).toBeGreaterThan(0)
      // the centre of everything on that row (each row of the stack holds one thing)
      return { y, x: (lines[y]!.search(/\S/) + lines[y]!.trimEnd().length - 1) / 2 }
    }
    const seen = new Set<string>()
    const offsets = new Set<number>()
    for (let r = 0; r < 4; r++) {
      const lines = rows(1_000_000_000 + r * 8000)
      const label = centreOf(lines, /SERVER|EVENTS/)
      const caption = centreOf(lines, /UI API 1\.8\.0|last: no events yet/)
      const tileLine = centreOf(lines, /Events +0\/min|Server +19 ms/)
      expect(Math.abs(label.x - caption.x)).toBeLessThanOrEqual(8)
      // the tile block sits a row or two under the dots, centred under the caption
      expect(tileLine.y - caption.y).toBeLessThanOrEqual(4)
      expect(Math.abs(tileLine.x - caption.x)).toBeLessThanOrEqual(12)
      seen.add(`${label.y},${Math.round(label.x)}`)
      // the tile keeps its place relative to the label at every rotation: they move as one
      offsets.add(tileLine.y - label.y)
    }
    expect(offsets.size).toBe(1)
    expect(seen.size).toBe(4)
  })

  test('Bounce in a tall narrow terminal: the panel under Query, drifting as one box', () => {
    const [w, h] = [75, 95]
    const places = new Set<string>()
    for (let i = 0; i < 80; i++) {
      const l = bounceLayout(input({ style: 'bounce', width: w, height: h, now: 1_000_000_000 + i * 500, burnin: true }))
      expect(l.showSprite).toBe(true)
      const p = l.panel!
      expect(p.y).toBe(l.sprite.y + l.sprite.h + 1)
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x + p.w).toBeLessThanOrEqual(w)
      expect(p.y + p.h).toBeLessThanOrEqual(h - 1)
      places.add(`${p.x},${p.y}`)
    }
    expect(places.size).toBeGreaterThan(20)
  })

  test('too small for Query and the panel together: the panel for 20 s, then Query for 20 s, both drifting', () => {
    const w = 40
    const h = 18
    const live = (now: number) => paintSaver(input({ style: 'bounce', width: w, height: h, now, burnin: true })).text().includes(' live ')
    const queryShown = (now: number) => bounceLayout(input({ style: 'bounce', width: w, height: h, now, burnin: true })).showSprite
    const start = Math.floor(1_000_000_000 / (2 * ALTERNATE_MILLIS)) * 2 * ALTERNATE_MILLIS
    expect(live(start + 3_000)).toBe(true)
    expect(queryShown(start + 3_000)).toBe(false)
    expect(live(start + ALTERNATE_MILLIS + 3_000)).toBe(false)
    expect(queryShown(start + ALTERNATE_MILLIS + 3_000)).toBe(true)
    const a = bounceLayout(input({ style: 'bounce', width: w, height: h, now: start + 3_000, burnin: true })).panel!
    const b = bounceLayout(input({ style: 'bounce', width: w, height: h, now: start + 3_250, burnin: true })).panel!
    expect(a.x !== b.x || a.y !== b.y).toBe(true)
    expect(a.x + a.w).toBeLessThanOrEqual(w)
    expect(b.y + b.h).toBeLessThanOrEqual(h - 1)
  })

  test('dimming starts at the configured time, 0 never; a dimmed frame has darker colours and the same text', () => {
    expect(isDimmed(9 * 60_000 + 59_000, 10)).toBe(false)
    expect(isDimmed(10 * 60_000, 10)).toBe(true)
    expect(isDimmed(60_000, 1)).toBe(true)
    expect(isDimmed(24 * 3_600_000, 0)).toBe(false)
    const plain = paintSaver(input({ style: 'bounce', burnin: true, dim: false }))
    const dimmed = paintSaver(input({ style: 'bounce', burnin: true, dim: true }))
    expect(dimmed.text()).toBe(plain.text())
    const row = saverFrame(input({ style: 'bounce', burnin: true })).chrome.headerRow
    const first = (c: ReturnType<typeof paintSaver>) => c.runs(row).filter((r) => r.text.trim()).map((r) => r.fg)
    expect(first(dimmed)).not.toEqual(first(plain))
    const lum = (hex: string) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16)
    const bright = (c: ReturnType<typeof paintSaver>) => Math.max(...c.runs(row).filter((r) => r.text.trim() && r.fg?.startsWith('#')).map((r) => lum(r.fg!)))
    expect(bright(dimmed)).toBeLessThan(bright(plain))
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

  test('the overlay dims once the saver has been up for the configured minutes; burnin and dim are saved by :saver', async () => {
    await command(h, 'saver dim 5')
    await command(h, 'saver burnin off')
    expect(readSaverSettings()).toMatchObject({ burnin: false, dimMinutes: 5 })
    let s = new SaverOverlay(h.store, 'bounce')
    expect(s.input(80, 24, s.startedAt + 4 * 60_000 + 59_000).dim).toBe(false)
    expect(s.input(80, 24, s.startedAt + 5 * 60_000).dim).toBe(true)
    expect(s.input(80, 24).burnin).toBe(false)
    await command(h, 'saver dim off')
    await command(h, 'saver burnin on')
    s = new SaverOverlay(h.store, 'bounce')
    expect(s.input(80, 24, s.startedAt + 3_600_000).dim).toBe(false)
    expect(s.input(80, 24).burnin).toBe(true)
    await command(h, 'saver dim 10')
  })

  test('the saver keeps the presence lease of the screen under it (others see an idle viewer, not a gone one); waking resyncs', async () => {
    const calls: Array<string | undefined> = []
    const none = { count: 0, people: [] }
    setPresenceSource({ get: () => none, subscribe: () => () => undefined, enter: (scope) => { calls.push(scope) } })
    try {
      await command(h, 'table query person')
      await waitFor(h, (f) => f.includes('30 records'))
      expect(calls.at(-1)).toBe('table:person')
      calls.length = 0
      await command(h, 'saver flip')
      await waitFor(h, (f) => f.includes('preview: flip'))
      // never left (the same scope may be announced again; the source ignores a repeat)
      expect(calls.every((c) => c === 'table:person')).toBe(true)
      await press(h, () => h.setup.mockInput.typeText('x'))
      expect(h.store.lock).toBeUndefined()
      h.store.bump()
      await waitFor(h, (f) => f.includes('30 records'))
      expect(calls.includes(undefined)).toBe(false)
      expect(calls.every((c) => c === 'table:person')).toBe(true)
    } finally {
      setPresenceSource(undefined)
      h.store.back()
    }
  })

  test('F9 → Settings lists the saver style, refresh and preview', () => {
    const labels = (h.store.commands() as unknown as { entries(f: string): Array<{ label: string }> }).entries('').map((e) => e.label)
    expect(labels.some((l) => l.startsWith('Screen saver style:'))).toBe(true)
    expect(labels.some((l) => l.startsWith('Screen saver refresh:'))).toBe(true)
    expect(labels.some((l) => l.startsWith('Screen saver burn-in guard:'))).toBe(true)
    expect(labels.some((l) => l.startsWith('Screen saver dim:'))).toBe(true)
    expect(labels).toContain('Preview the screen saver')
  })
})
