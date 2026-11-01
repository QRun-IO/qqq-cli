/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The two-level F9 menu and the Servers dialog (Ctrl+O): grouping, search, the profile model, switching. */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { KeyCodes } from '@opentui/core/testing'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRecent, readConfig, upsertProfile } from '@qrun-io/qqq-core'
import { AREAS, GROUP_LIMIT, type MenuOverlay, areaRows, groupOf, groupRows, searchRows, sectionRows } from '../src/overlays/menu'
import { ServersOverlay } from '../src/overlays/servers'
import { ServersModel, ago, inputProblem, statusText } from '../src/servers'
import type { MenuEntry } from '../src/types'
import { isolate, memorySecrets, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined

beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

const run = () => undefined
function catalog(recents = 8): MenuEntry[] {
  return [
    { section: 'Context', label: 'Edit', key: 'e', run },
    { section: 'Context', label: 'Back', key: 'Esc', command: 'back', run },
    { section: 'Go to', label: 'Reset: go to the home screen', key: 'F10', run },
    { section: 'Go to', label: 'Go to anything…', key: 'F2 / .', run },
    { section: 'Go to', label: 'App: People', run },
    ...Array.from({ length: recents }, (_, i) => ({ section: 'Go to' as const, label: `Recent: Person › P${i}`, run })),
    { section: 'Go to', label: 'Favorites', disabled: 'needs the collaboration extension' },
    { section: 'Work', label: 'Jobs', run },
    { section: 'Connection', label: 'Servers…', key: 'Ctrl+O', run },
    { section: 'Connection', label: 'Sign out', command: 'signout', run },
    { section: 'Settings', label: 'Theme: dark', run },
    { section: 'Help', label: 'Quit', key: 'F10', run },
  ]
}

test('level 1 lists the areas with counts; level 2 groups Recent, Apps and Favorites, long groups end in more…', () => {
  const all = catalog()
  const areas = areaRows(all, 'this record: Edit')
  expect(areas.map((r) => (r.kind === 'area' ? `${r.area} ${r.count}` : ''))).toEqual(['Context 2', 'Go to 12', 'Work 1', 'Connection 2', 'Settings 1', 'Help 1'])
  expect(areas[0]!.kind === 'area' && areas[0]!.summary).toBe('this record: Edit')
  expect(groupOf(all[5]!)).toBe('Recent')
  expect(groupOf({ section: 'Go to', label: 'App: X' })).toBe('Apps')
  expect(groupOf({ section: 'Go to', label: 'Table: X', id: 'index:table:x' })).toBeUndefined()
  expect(groupOf({ section: 'Work', label: 'Recent: not grouped outside Go to' })).toBeUndefined()
  expect(groupOf({ section: 'Work', label: 'Shared with me', group: 'Collaboration' })).toBe('Collaboration')
  const goTo = sectionRows(all, 'Go to')
  const text = goTo.map((r) => (r.kind === 'head' ? `# ${r.text}` : r.e.label))
  expect(text).toEqual(['Reset: go to the home screen', 'Go to anything…', '# Apps', 'App: People', '# Recent (8)', ...[0, 1, 2, 3, 4].map((i) => `Recent: Person › P${i}`), 'more… (all 8)', '# Favorites', 'Favorites'])
  expect(goTo.filter((r) => r.kind === 'entry' && groupOf(r.e) === 'Recent').length).toBe(GROUP_LIMIT)
  expect(groupRows(all, 'Go to', 'Recent').length).toBe(8)
  // five or fewer stay inline, without more…
  expect(sectionRows(catalog(5), 'Go to').some((r) => r.kind === 'more')).toBe(false)
})

test('search covers every entry of every area and groups the results by area', () => {
  const rows = searchRows(catalog(), 'e')
  const heads = rows.filter((r) => r.kind === 'head').map((r) => (r as { text: string }).text)
  // in area order, several areas at once
  expect(heads).toEqual(AREAS.filter((a) => heads.includes(a)))
  expect(heads.length).toBeGreaterThanOrEqual(4)
  const hits = searchRows(catalog(), 'sign out')
  expect(hits.map((r) => (r.kind === 'head' ? `# ${r.text}` : r.e.label))).toEqual(['# Connection', 'Sign out'])
  // keys and commands are searchable too
  expect(searchRows(catalog(), 'ctrl+o').filter((r) => r.kind === 'entry').map((r) => r.e.label)).toEqual(['Servers…'])
  expect(searchRows(catalog(), 'p3').filter((r) => r.kind === 'entry').map((r) => r.e.label)).toEqual(['Recent: Person › P3'])
})

test('F9: areas, a letter jumps, Enter and ← move between levels, typing searches, clearing returns to the areas', async () => {
  h = await startTui(120, 36)
  let f = await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F9))
  for (const a of AREAS) expect(f).toContain(a)
  expect(f).toContain('entries · ')
  const menu = h.store.overlays.at(-1) as MenuOverlay
  expect(menu.level).toBe(1)
  await press(h, () => h!.setup.mockInput.typeText('s'))
  expect(menu.visible()[menu.index]!.label).toBe('Settings')
  f = await press(h, () => h!.setup.mockInput.pressEnter())
  expect(menu.level).toBe(2)
  expect(f).toContain('Menu ▸ Settings')
  expect(f).toContain('Theme: ')
  expect(f).toContain('← or Esc back')
  // Tab: the next area at level 2
  f = await press(h, () => h!.setup.mockInput.pressTab())
  expect(f).toContain('Menu ▸ Help')
  f = await press(h, () => h!.setup.mockInput.pressArrow('left'))
  expect(menu.level).toBe(1)
  expect(menu.visible()[menu.index]!.label).toBe('Help')
  // a letter goes to the first area with it, wherever the cursor is
  await press(h, () => h!.setup.mockInput.pressArrow('up'))
  await press(h, () => h!.setup.mockInput.pressArrow('up'))
  expect(menu.visible()[menu.index]!.label).toBe('Connection')
  // c twice: Context, then Connection
  await press(h, () => h!.setup.mockInput.typeText('c'))
  expect(menu.visible()[menu.index]!.label).toBe('Context')
  await press(h, () => h!.setup.mockInput.typeText('c'))
  expect(menu.visible()[menu.index]!.label).toBe('Connection')
  f = await press(h, () => h!.setup.mockInput.pressArrow('right'))
  expect(f).toContain('Servers…')
  expect(f).toContain('Ctrl+O')
  await press(h, () => h!.setup.mockInput.pressEscape())
  expect(menu.level).toBe(1)
  f = await press(h, () => h!.setup.mockInput.typeText('sign'))
  expect(menu.searching).toBe(true)
  expect(f).toContain('Search: ')
  expect(f).toContain('Sign out')
  for (let i = 0; i < 4; i++) f = await press(h, () => h!.setup.mockInput.pressBackspace())
  expect(menu.searching).toBe(false)
  expect(menu.level).toBe(1)
  expect(f).toContain('Connection')
  // Esc at level 1 closes
  await press(h, () => h!.setup.mockInput.pressEscape())
  expect(h.store.overlays.length).toBe(0)
})

test('F9 fits 80×24 at every level: nothing outside the frame, the footer intact', async () => {
  h = await startTui(120, 36)
  h.setup.resize(80, 24)
  const inside = (f: string) => {
    const lines = f.split('\n')
    expect(lines.length).toBeLessThanOrEqual(25)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(80)
    const bottom = lines.findIndex((l) => l.includes('╚'))
    expect(bottom).toBeGreaterThan(0)
    expect(bottom).toBeLessThan(24)
  }
  let f = await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F9))
  inside(f)
  expect(f).toMatch(/\d+ entries · type to search · ↑↓ → Enter opens/)
  expect(f).toContain('Esc or F9 closes')
  await press(h, () => h!.setup.mockInput.typeText('g'))
  f = await press(h, () => h!.setup.mockInput.pressEnter())
  inside(f)
  expect(f).toContain('Search records (quick search)')
  expect(f).toContain('← or Esc back')
  f = await press(h, () => h!.setup.mockInput.typeText('theme'))
  inside(f)
  expect(f).toContain('Theme: ')
})


function freshConfig(): void {
  const config = readConfig()
  for (const name of Object.keys(config.profiles)) if (name !== 'fake') delete config.profiles[name]
  writeFileSync(join(process.env.QQQ_CONFIG_DIR!, 'config.json'), JSON.stringify({ ...config, defaultProfile: 'fake' }, null, 2))
}

test('a 1.0.0-rc.1 config.json loads: note shows as the description, short names default, nothing is rewritten', () => {
  const rc1 = {
    defaultProfile: 'sample',
    profiles: {
      sample: { server: 'http://localhost:8077', createdAt: '2026-10-31T22:24:56.276Z' },
      enterprise: { server: 'http://localhost:8078', note: 'the big one', createdAt: '2026-11-01T10:53:34.789Z', ui: { theme: 'light' } },
      'acme-prod-eu': { server: 'https://acme.example', createdAt: '2026-11-01T10:53:34.789Z' },
    },
    ui: { theme: 'dark', recents: { 'http://localhost:8077': [] } },
  }
  const dir = join(process.env.QQQ_CONFIG_DIR!, '..', 'rc1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), JSON.stringify(rc1))
  const saved = process.env.QQQ_CONFIG_DIR
  process.env.QQQ_CONFIG_DIR = dir
  try {
    const model = new ServersModel({ current: 'sample' })
    expect(model.rows.map((r) => [r.name, r.short, r.description, r.isDefault, r.isCurrent])).toEqual([
      ['sample', 'sample', '', true, true], ['enterprise', 'ent', 'the big one', false, false], ['acme-prod-eu', 'ape', '', false, false],
    ])
    expect(model.rows.every((r) => r.authMode === 'auto')).toBe(true)
    // a change keeps what this version does not show (createdAt, ui, recents)
    model.setDefault('enterprise')
    const after = readConfig()
    expect(after.defaultProfile).toBe('enterprise')
    expect(after.profiles.enterprise!.ui).toEqual({ theme: 'light' })
    expect((after.ui as { recents?: unknown }).recents).toEqual({ 'http://localhost:8077': [] })
    expect(after.profiles.sample!.createdAt).toBe('2026-10-31T22:24:56.276Z')
  } finally {
    process.env.QQQ_CONFIG_DIR = saved
  }
})

test('the Servers model: probe states, filter on name, short name, description and server', async () => {
  freshConfig()
  upsertProfile('sample', { server: 'http://localhost:8077', description: 'QQQ sample server' })
  upsertProfile('enterprise', { server: 'http://localhost:8078', short: 'ent', description: '22 apps' })
  upsertProfile('offline', { server: 'http://localhost:9' })
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let changes = 0
  const model = new ServersModel({
    current: 'fake',
    onChange: () => changes++,
    probe: async (server) => {
      await gate
      return server.endsWith(':9') ? { reachable: false, error: 'ECONNREFUSED' } : { reachable: true, apiVersion: server.endsWith('8078') ? '1.9.0' : '1.8.0', authType: 'MOCK' }
    },
  })
  expect(model.rows.map((r) => r.name)).toEqual(['fake', 'sample', 'enterprise', 'offline'])
  const probing = model.probeAll()
  expect(statusText(model.probes.get('http://localhost:8077'))).toBe('…')
  release()
  await probing
  expect(changes).toBeGreaterThanOrEqual(4)
  expect(statusText(model.probes.get('http://localhost:8077'))).toBe('UI API 1.8.0')
  expect(statusText(model.probes.get('http://localhost:8078'))).toBe('UI API 1.9.0')
  expect(statusText(model.probes.get('http://localhost:9'))).toBe('unreachable')
  expect(model.authText(model.rows.find((r) => r.name === 'sample')!)).toBe('mock')
  expect(model.visible('ENT').map((r) => r.name)).toEqual(['enterprise'])
  expect(model.visible('22 apps').map((r) => r.name)).toEqual(['enterprise'])
  expect(model.visible(':9').map((r) => r.name)).toEqual(['offline'])
  expect(model.visible('sample').map((r) => r.name)).toEqual(['sample'])
  expect(ago(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5 min ago')
  expect(ago(undefined)).toBe('')
})

test('the Servers model: add checks the form and the server, edit renames and keeps the sign-in, remove and default', async () => {
  freshConfig()
  const secrets = memorySecrets()
  await secrets().set('fake@http://fake.test', JSON.stringify({ kind: 'session', authType: 'MOCK', sessionUUID: 's', user: { name: 'Tester' }, createdAt: '' }))
  let reachable = true
  const model = new ServersModel({ current: 'fake', secrets, probe: async () => (reachable ? { reachable: true, apiVersion: '1.8.0' } : { reachable: false, error: 'no answer in 2.5 s' }) })
  const input = { name: 'staging', short: '', description: 'Staging', server: 'http://staging.test:8080/x', authMode: 'auto' as const }
  expect(inputProblem({ ...input, name: 'bad name' }, [])).toMatch(/letters, digits/)
  expect(inputProblem({ ...input, name: 'fake' }, ['fake'])).toMatch(/exists already/)
  expect(inputProblem({ ...input, short: 'x' }, [])).toMatch(/2 to 6/)
  expect(inputProblem({ ...input, server: 'localhost' }, [])).toMatch(/address/)
  expect(inputProblem(input, ['fake'])).toBeUndefined()
  reachable = false
  const refused = await model.check(input)
  expect(refused.ok).toBe(false)
  expect(!refused.ok && refused.unreachable).toBe(true)
  // saving anyway (the form's second Ctrl+S) skips the probe
  expect((await model.check(input, undefined, true)).ok).toBe(true)
  reachable = true
  const checked = await model.check(input)
  expect(checked.ok && checked.probe?.apiVersion).toBe('1.8.0')
  model.add(input)
  expect(readConfig().profiles.staging).toMatchObject({ server: 'http://staging.test:8080', description: 'Staging' })
  expect(readConfig().profiles.staging!.short).toBeUndefined()
  expect(model.rows.find((r) => r.name === 'staging')!.short).toBe('sta')
  // sign in to staging, then rename it: the sign-in follows
  await secrets().set('staging@http://staging.test:8080', JSON.stringify({ kind: 'session', authType: 'MOCK', sessionUUID: 't', user: { name: 'Stager' }, createdAt: '' }))
  const renamed = await model.edit('staging', { ...input, name: 'stage', short: 'stg', authMode: 'device' })
  expect(renamed).toBe('stage')
  expect(readConfig().profiles.staging).toBeUndefined()
  expect(readConfig().profiles.stage).toMatchObject({ short: 'stg', authMode: 'device', description: 'Staging' })
  expect(await secrets().get('stage@http://staging.test:8080')).toContain('Stager')
  expect(await secrets().get('staging@http://staging.test:8080')).toBeUndefined()
  // a new server drops the sign-in (it belonged to the old one); emptied fields are removed
  await model.edit('stage', { name: 'stage', short: '', description: '', server: 'http://other.test', authMode: 'auto' })
  expect(readConfig().profiles.stage).toMatchObject({ server: 'http://other.test' })
  expect(readConfig().profiles.stage!.short).toBeUndefined()
  expect(readConfig().profiles.stage!.description).toBeUndefined()
  expect(readConfig().profiles.stage!.authMode).toBeUndefined()
  expect(await secrets().get('stage@http://staging.test:8080')).toBeUndefined()
  await model.readSignIns()
  expect(model.rows.find((r) => r.name === 'fake')).toMatchObject({ user: 'Tester', signIn: 'mock session' })
  model.setDefault('stage')
  expect(readConfig().defaultProfile).toBe('stage')
  expect(model.rows.find((r) => r.name === 'stage')!.isDefault).toBe(true)
  await expect(model.remove('fake')).rejects.toThrow(/in use/)
  await model.remove('stage')
  expect(readConfig().profiles.stage).toBeUndefined()
  model.setDefault('fake')
})

test('Ctrl+O: the Servers dialog lists the profiles; Enter switches, Home opens on the other server, the footer shows its short name', async () => {
  freshConfig()
  upsertProfile('other', { server: 'http://other.test', short: 'oth', description: 'Another fake' })
  h = await startTui(120, 36, { auth: { type: 'MOCK', sessions: new Set() }, secrets: (() => { const s = memorySecrets(); const login = JSON.stringify({ kind: 'session', authType: 'MOCK', sessionUUID: 'x', user: { name: 'Tester' }, createdAt: '' }); void s().set('fake@http://fake.test', login); return s })() })
  let f = await press(h, () => h!.setup.mockInput.pressKey('o', { ctrl: true }))
  const dialog = h.store.overlays.at(-1) as ServersOverlay
  expect(dialog).toBeInstanceOf(ServersOverlay)
  f = await waitFor(h, (x) => x.includes('UI API 1.8.0') && x.includes('Another fake'))
  expect(f).toContain('Servers  (Ctrl+O)')
  expect(f).toContain('fake')
  expect(f).toContain('oth')
  expect(f).toContain('Enter switches')
  // typing filters on the description; n (a command key) does not
  await press(h, () => h!.setup.mockInput.typeText('/another'))
  expect(dialog.list().map((r) => r.name)).toEqual(['other'])
  await press(h, () => h!.setup.mockInput.pressEnter())
  // no stored sign-in for "other": the MOCK sign-in runs, then Home on the other server
  f = await waitFor(h, (x) => h!.store.screen?.kind === 'home' && h!.store.status.server === 'http://other.test' && x.includes('Ctrl+O switch'), 5000)
  expect(h.store.status.profile).toBe('other')
  expect(h.store.status.short).toBe('oth')
  expect(f).toContain('other.test · oth · mock session')
  expect(f).toContain('profile other (oth)')
  expect(readConfig().profiles.other!.lastUsedAt).toBeTruthy()
  // :servers opens it too, with the current profile marked
  await press(h, () => h!.setup.mockInput.typeText(':'))
  await press(h, () => h!.setup.mockInput.typeText('servers'))
  f = await press(h, () => h!.setup.mockInput.pressEnter())
  const again = h.store.overlays.at(-1) as ServersOverlay
  expect(again.selected()?.name).toBe('other')
  expect(again.selected()?.isCurrent).toBe(true)
}, 20_000)

test('the Servers dialog fits 80×24, and n opens the add form with every field', async () => {
  freshConfig()
  h = await startTui(120, 36)
  h.setup.resize(80, 24)
  await press(h, () => h!.setup.mockInput.pressKey('o', { ctrl: true }))
  let f = await waitFor(h, (x) => x.includes('UI API 1.8.0'))
  for (const l of f.split('\n')) expect(l.length).toBeLessThanOrEqual(80)
  expect(f).toContain('n add')
  f = await press(h, () => h!.setup.mockInput.typeText('n'))
  for (const label of ['Name', 'Short name', 'Description', 'Server', 'Sign-in', '[auto]']) expect(f).toContain(label)
  await press(h, () => h!.setup.mockInput.typeText('x y'))
  await press(h, () => h!.setup.mockInput.pressKey('s', { ctrl: true }))
  f = await waitFor(h, (x) => x.includes('letters, digits, dots'))
  await press(h, () => h!.setup.mockInput.pressEscape())
  expect(h.store.overlays.at(-1)).toBeInstanceOf(ServersOverlay)
})


test('Go to reaches the apps and the recent records as groups: the first five, then more… opens the whole list', async () => {
  freshConfig()
  // seven recent records on the fake server
  for (let i = 1; i <= 7; i++) addRecent('http://fake.test', { kind: 'record', table: 'person', key: String(i), label: `Person ${i}` })
  h = await startTui(120, 36)
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F9))
  const menu = h.store.overlays.at(-1) as MenuOverlay
  await press(h, () => h!.setup.mockInput.typeText('g'))
  let f = await press(h, () => h!.setup.mockInput.pressEnter())
  expect(f).toContain('Apps')
  expect(f).toContain('People')
  expect(f).toContain('Recent (7)')
  expect(f).toContain('more… (all 7)')
  expect(f).not.toContain('Person 2')
  const labels = menu.visible().map((e) => e.label)
  const more = labels.indexOf('more… (all 7)')
  expect(more).toBeGreaterThan(0)
  for (let i = 0; i < more; i++) await press(h, () => h!.setup.mockInput.pressArrow('down'))
  f = await press(h, () => h!.setup.mockInput.pressEnter())
  expect(menu.level).toBe(3)
  expect(f).toContain('Menu ▸ Go to ▸ Recent')
  for (let i = 1; i <= 7; i++) expect(f).toContain(`Person ${i}`)
  // Enter on a recent record opens it and closes the menu
  f = await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, () => h!.store.screen?.kind === 'record')
  expect(h.store.overlays.length).toBe(0)
  // and the search finds them by group name
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F9))
  f = await press(h, () => h!.setup.mockInput.typeText('recent'))
  expect(f).toContain('Person 1')
})
