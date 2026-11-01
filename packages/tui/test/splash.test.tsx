/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The start-up splash and profile picker: the boot plan, the picker (preselect, Enter, Esc), the add form, timing, ASCII, failures. */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import { readConfig, writeConfig, type Config } from '@qrun-io/qqq-core'
import { App } from '../src/app'
import { boot, parseArgs } from '../src/boot'
import { PICK_HINT, SPLASH_MIN_MS, lastUsedProfile, planBoot, readSplash, splashEnabled, splashWait, writeSplash } from '../src/boot-plan'
import { ProfileFormOverlay, ServersOverlay } from '../src/overlays/servers'
import { SplashScreen, splashLayout, splashText, versionLine, type SplashLayoutInput } from '../src/screens/splash'
import { fakeFetch, type FakeLog } from './fake-server'
import { command, isolate, press, sessionSecrets, waitFor, type Harness } from './helpers'
import { querySize } from '../src/saver/query-art'
import { setAscii } from '../src/theme'
import { cellWidth } from '../src/util/text'

let h: Harness | undefined
let exits: string[] = []
let quits = 0

beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
  exits = []
  quits = 0
  setAscii(false)
})

const hour = 3_600_000
function profiles(map: Record<string, { server: string; lastUsedAt?: string }>, defaultProfile?: string): void {
  writeConfig({ profiles: map, ...(defaultProfile ? { defaultProfile } : {}) } as Config)
}

function two(): void {
  profiles({
    alpha: { server: 'http://alpha.test', lastUsedAt: new Date(Date.now() - 5 * hour).toISOString() },
    beta: { server: 'http://beta.test', lastUsedAt: new Date(Date.now() - hour).toISOString() },
  }, 'alpha')
}

async function start(argv: string[], options: { width?: number; height?: number; minMs?: number; fetch?: typeof fetch; log?: FakeLog } = {}): Promise<Harness> {
  const log = options.log ?? { requests: [] }
  const store = boot({ args: parseArgs(argv, {}), quit: () => { quits++ }, build: 'test', secrets: sessionSecrets, fetch: options.fetch ?? fakeFetch(log), splashMinMs: options.minMs, hint: (t) => exits.push(t) })
  const setup = await testRender(<App store={store} />, { width: options.width ?? 120, height: options.height ?? 40 })
  const harness: Harness = { setup, store, log, frame: () => setup.captureCharFrame() }
  store.captureScreen = () => setup.captureCharFrame()
  return harness
}

test('the boot plan: a named profile or the only one connects; several ask (last used first); none adds', () => {
  const at = (n: number) => new Date(Date.now() - n * hour).toISOString()
  const several: Config = { profiles: { alpha: { server: 'http://a.test', lastUsedAt: at(5) }, beta: { server: 'http://b.test', lastUsedAt: at(1) }, gamma: { server: 'http://c.test' } }, defaultProfile: 'alpha' } as Config
  expect(planBoot({}, {}, several)).toEqual({ kind: 'pick', select: 'beta' })
  expect(planBoot({ profile: 'gamma' }, {}, several)).toEqual({ kind: 'connect', target: { name: 'gamma', server: 'http://c.test' } })
  expect(planBoot({}, { QQQ_PROFILE: 'alpha' }, several)).toEqual({ kind: 'connect', target: { name: 'alpha', server: 'http://a.test' } })
  expect(planBoot({ server: 'http://b.test/x' }, {}, several)).toEqual({ kind: 'connect', target: { name: 'beta', server: 'http://b.test' } })
  expect(planBoot({}, { QQQ_SERVER: 'http://new.test' }, several).kind).toBe('connect')
  const one: Config = { profiles: { solo: { server: 'http://solo.test' } } } as Config
  expect(planBoot({}, {}, one)).toEqual({ kind: 'connect', target: { name: 'solo', server: 'http://solo.test' } })
  expect(planBoot({}, {}, { profiles: {} } as Config)).toEqual({ kind: 'add' })
  // a name that does not exist: the picker (or the add form) with why
  const typo = planBoot({ profile: 'nope' }, {}, several)
  expect(typo.kind).toBe('pick')
  expect(typo.kind === 'pick' && typo.note).toMatch(/No profile "nope"/)
  expect(planBoot({ profile: 'nope' }, {}, { profiles: {} } as Config).kind).toBe('add')
  // never used: the default, else the first
  expect(lastUsedProfile({ profiles: { a: { server: 'x' }, b: { server: 'y' } }, defaultProfile: 'b' } as Config)).toBe('b')
  expect(lastUsedProfile({ profiles: { a: { server: 'x' }, b: { server: 'y' } } } as Config)).toBe('a')
})

test('the splash switch: --no-splash, --splash, QQQ_UI_NO_SPLASH and the ui.splash setting', () => {
  expect(parseArgs(['--no-splash']).splash).toBe(false)
  expect(parseArgs(['--splash']).splash).toBe(true)
  expect(parseArgs([]).splash).toBeUndefined()
  expect(splashEnabled({ splash: false })).toBe(false)
  expect(splashEnabled({}, { ...process.env, QQQ_UI_NO_SPLASH: '1' })).toBe(false)
  expect(readSplash()).toBe(true)
  writeSplash(false)
  expect(readConfig().ui).toMatchObject({ splash: 'off' })
  expect(splashEnabled({})).toBe(false)
  expect(splashEnabled({ splash: true })).toBe(true)
  writeSplash(true)
  expect(splashEnabled({})).toBe(true)
})

test('the minimum display time: never under 600 ms, nothing more once it has been up that long', async () => {
  expect(SPLASH_MIN_MS).toBe(600)
  expect(splashWait(1000, 1100)).toBe(500)
  expect(splashWait(1000, 1700)).toBe(0)
  profiles({ fake: { server: 'http://fake.test' } })
  const began = Date.now()
  h = await start(['--profile', 'fake'], { minMs: 600 })
  await waitFor(h, () => h!.store.screen?.kind === 'splash')
  await waitFor(h, () => h!.store.screen?.kind === 'home', 4000)
  expect(Date.now() - began).toBeGreaterThanOrEqual(600)
})

test('one profile: the splash shows Query, the wordmark, the version and the boot steps, then Home', async () => {
  profiles({ fake: { server: 'http://fake.test' } })
  h = await start([], { minMs: 400 })
  const f = await waitFor(h, (x) => x.includes('Terminal client for QQQ'))
  expect(h.store.screen?.kind).toBe('splash')
  expect(f).toContain(versionLine())
  expect(f).toMatch(/qqq \d+\.\d+\.\d+ · UI API client \d+\.\d+\.\d+/)
  expect(f).toContain('█')
  // no title bar, status line or key bar under the splash
  expect(f).not.toMatch(/10\s*Quit/)
  const steps = h.store.screen as SplashScreen
  await waitFor(h, () => /loaded metadata \(\d+ tables\)/.test(steps.status))
  await waitFor(h, (x) => h!.store.screen?.kind === 'home' && x.includes('Apps'), 4000)
  expect(h.store.overlays.length).toBe(0)
})

test('several profiles: the picker over the splash, the last used preselected; Enter connects to it', async () => {
  two()
  h = await start([], { width: 120, height: 40 })
  const f = await waitFor(h, (x) => x.includes('Connect to a server'))
  const picker = h.store.overlays.at(-1) as ServersOverlay
  expect(picker).toBeInstanceOf(ServersOverlay)
  expect(picker.selected()?.name).toBe('beta')
  expect(f).toContain('Enter connects')
  expect(f).toContain('Esc quits')
  // the splash header stays visible above the picker
  expect(f).toContain('Terminal client for QQQ')
  // probes fill in on their own (the picker does not wait for them)
  await waitFor(h, (x) => x.includes('UI API'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, () => h!.store.screen?.kind === 'home', 4000)
  expect(h.store.target?.name).toBe('beta')
})

test('several profiles: Esc on the picker quits with the --profile hint', async () => {
  two()
  h = await start([])
  await waitFor(h, (x) => x.includes('Connect to a server'))
  await press(h, () => h!.setup.mockInput.pressEscape())
  expect(quits).toBe(1)
  expect(exits).toEqual([PICK_HINT])
  expect(PICK_HINT).toContain('--profile')
})

test('--profile skips the picker even with several profiles', async () => {
  two()
  h = await start(['--profile', 'alpha'])
  await waitFor(h, () => h!.store.screen?.kind === 'home', 4000)
  expect(h.store.target?.name).toBe('alpha')
})

test('no profiles: the add form opens straight away; saving connects to the new profile', async () => {
  writeConfig({ profiles: {} } as Config)
  h = await start([])
  await waitFor(h, (x) => x.includes('Add a server profile'))
  const form = h.store.overlays.at(-1) as ProfileFormOverlay
  expect(form).toBeInstanceOf(ProfileFormOverlay)
  form.editors.name.set('local')
  form.editors.server.set('http://fake.test')
  await press(h, () => form.save(), 50)
  await waitFor(h, () => h!.store.screen?.kind === 'home', 4000)
  expect(h.store.target).toEqual({ name: 'local', server: 'http://fake.test' })
})

test('no profiles, add form closed: the splash says n adds one and Esc quits', async () => {
  writeConfig({ profiles: {} } as Config)
  h = await start([], { width: 80, height: 24 })
  await waitFor(h, (x) => x.includes('Add a server profile'))
  const f = await press(h, () => h!.setup.mockInput.pressEscape())
  expect(f).toContain('n adds a server profile')
  await press(h, () => h!.setup.mockInput.pressKey('n'))
  expect(h.store.overlays.at(-1)).toBeInstanceOf(ProfileFormOverlay)
  await press(h, () => h!.setup.mockInput.pressEscape())
  await press(h, () => h!.setup.mockInput.pressEscape())
  expect(quits).toBe(1)
})

test('--no-splash: the sign-in screen as before, then Home; with several profiles the picker opens over it', async () => {
  profiles({ fake: { server: 'http://fake.test' } })
  h = await start(['--no-splash'])
  expect(h.store.routes.some((r) => r.kind === 'splash')).toBe(false)
  await waitFor(h, () => h!.store.screen?.kind === 'home', 4000)
  h.store.dispose()
  h.setup.renderer.destroy()
  two()
  h = await start(['--no-splash'])
  await waitFor(h, (x) => x.includes('Connect to a server'))
  expect(h.store.screen?.kind).toBe('signin')
  expect((h.store.overlays.at(-1) as ServersOverlay).selected()?.name).toBe('beta')
})

test('a failure stays on the splash with retry and choose-another; c opens the picker, Esc goes back to it', async () => {
  profiles({ fake: { server: 'http://fake.test' }, other: { server: 'http://other.test' } })
  let down = true
  const ok = fakeFetch()
  const flaky = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (down) throw new Error('connection refused')
    return ok(input, init)
  }) as typeof fetch
  h = await start(['--profile', 'fake'], { width: 80, height: 24, fetch: flaky })
  let f = await waitFor(h, (x) => x.includes('Enter retries'))
  expect(f).toContain('connection refused')
  expect(f).toContain('c chooses another profile')
  await press(h, () => h!.setup.mockInput.pressKey('c'))
  f = await waitFor(h, (x) => x.includes('Connect to a server'))
  expect(f).toContain('Esc goes back')
  await press(h, () => h!.setup.mockInput.pressEscape())
  expect(quits).toBe(0)
  f = await waitFor(h, (x) => x.includes('Enter retries'))
  down = false
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, () => h!.store.screen?.kind === 'home', 4000)
})

test('any key stops the animation, not the boot', async () => {
  profiles({ fake: { server: 'http://fake.test' } })
  h = await start([], { minMs: 300 })
  const splash = h.store.screen as SplashScreen
  splash.animate = true
  await press(h, () => h!.setup.mockInput.pressKey('x'))
  expect(splash.animate).toBe(false)
  await waitFor(h, () => h!.store.screen?.kind === 'home', 4000)
})

function input(ascii: boolean, anchor: 'center' | 'top' = 'center'): SplashLayoutInput {
  return { ascii, pose: { blink: false, wag: false }, status: { text: 'connecting to localhost:8078…', tone: 'status' }, extra: [], keys: '', anchor }
}

test('the layout fits 80×24 (small Query beside the wordmark) and 120×40 (large Query); every line clipped', () => {
  for (const [w, hgt] of [[80, 24], [120, 40], [40, 12], [30, 8], [20, 5]] as const) {
    for (const ascii of [false, true]) {
      setAscii(ascii)
      const lines = splashLayout(w, hgt, input(ascii))
      expect(lines.length).toBeLessThanOrEqual(hgt)
      for (const l of lines) expect(cellWidth(l.map((s) => s.text).join(''))).toBeLessThanOrEqual(w)
    }
  }
  setAscii(false)
  const small = splashText(splashLayout(80, 24, input(false)))
  expect(small).toContain('Terminal client for QQQ')
  expect(small).toContain('connecting to localhost:8078…')
  const large = splashLayout(120, 40, input(false))
  expect(large.filter((l) => l.some((s) => s.tone === 'art')).length).toBe(querySize('large').height)
  const header = splashLayout(80, 24, input(false, 'top'))
  expect(splashText(header)).not.toContain('connecting')
  expect(header.length).toBeLessThanOrEqual(querySize('small').height + 2)
})

test('ASCII: no braille or block characters, the wordmark in #', () => {
  setAscii(true)
  for (const [w, hgt] of [[80, 24], [120, 40]] as const) {
    const text = splashText(splashLayout(w, hgt, input(true)))
    expect(text).not.toMatch(/[⠀-⣿█]/)
    expect(text).toContain('####')
    expect(text).toContain('Terminal client for QQQ')
    expect(text).toMatch(/^[\x20-\x7e\n]*$/)
    expect(text).toContain('qqq')
  }
})

test(':splash off and on save the setting (Settings > Splash on start)', async () => {
  profiles({ fake: { server: 'http://fake.test' } })
  h = await start([])
  await waitFor(h, () => h!.store.screen?.kind === 'home', 4000)
  await command(h, 'splash off')
  expect(readSplash()).toBe(false)
  expect(h.store.flashText?.text).toContain('splash off')
  await command(h, 'splash on')
  expect(readSplash()).toBe(true)
})
