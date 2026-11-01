/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KeyCodes } from '@opentui/core/testing'
import { ExtensionRegistry } from '@qrun-io/qqq-core'
import { TuiClient } from '../src/client'
import { RecordCollaboration } from '../src/collab'
import type { RecordScreen } from '../src/screens/record'
import { readViewSettings } from '@qrun-io/qqq-core'
import { COLLABORATION, QUICK_SEARCH, collabState, fakeExtensions, resetCollab } from './fake-collab'
import type { RecordViewSettingsOverlay } from '../src/overlays/record-view-settings'
import { fakeFetch } from './fake-server'
import { command, isolate, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
  fakeExtensions.length = 0
  resetCollab()
})

const key = (k: string) => press(h!, () => h!.setup.mockInput.pressKey(k))
const type = (t: string) => press(h!, () => h!.setup.mockInput.typeText(t))
const enter = () => press(h!, () => h!.setup.mockInput.pressEnter())
const escape = () => press(h!, () => h!.setup.mockInput.pressEscape())

function collabClient(): RecordCollaboration {
  const registry = ExtensionRegistry.fromVersion({ apiVersion: '1.8.0', extensions: [COLLABORATION] } as never)
  const client = new TuiClient({ server: 'http://fake.test', fetch: fakeFetch(), useCache: false })
  return new RecordCollaboration(registry, client, 'person', '1')
}

test('collaboration API: comments, follow, attachments (download from the server, upload as multipart), tasks, share preview', async () => {
  fakeExtensions.push(COLLABORATION)
  const c = collabClient()
  expect(c.available).toBe(true)
  expect(await c.summary()).toEqual({ comments: 1, attachments: 1, tasks: 1, following: false, latest: [{ author: 'Pat', at: '2026-11-01T10:00:00Z', text: 'first note' }], nextDue: undefined, followers: [] })
  await c.addComment('hello', 1)
  expect(collabState.comments[0]).toMatchObject({ body: 'hello', parentCommentId: 1 })
  expect((await c.toggleFollow(false)).following).toBe(true)
  expect((await c.toggleFollow(true)).following).toBe(false)
  const { bytes, url } = await c.download(7)
  expect(new TextDecoder().decode(bytes)).toBe('hello')
  expect(url).toBe('http://fake.test/qqq/v1/qbit/collaboration/files/7')
  const dir = mkdtempSync(join(tmpdir(), 'qqq-upload-'))
  writeFileSync(join(dir, 'report.txt'), 'abc')
  await c.upload(join(dir, 'report.txt'), 'the report')
  expect(collabState.uploads).toEqual([{ name: 'report.txt', size: 3, description: 'the report' }])
  await c.addTask('Follow up')
  await c.setTaskStatus(3, 'DONE')
  expect(collabState.tasks.map((t) => `${t.title}:${t.status}`)).toEqual(['Call back:DONE', 'Follow up:OPEN'])
  expect(await c.sharePreview(['u1', 'u2'])).toEqual([{ userId: 'u1', displayName: 'Pat Smith', canRead: true }, { userId: 'u2', displayName: 'u2', canRead: false }])
})

test('record view with collaboration: the bottom strip, a/F9 entries, comments (add), follow, timeline, tasks, share preview', async () => {
  fakeExtensions.push(COLLABORATION)
  h = await startTui(130, 40)
  await command(h, 'table get person 1')
  // a 102-cell pane: timeline and the follow state are dropped first, the viewers and tags kept
  let f = await waitFor(h, (x) => x.includes('Tags: none (t) · 1 comment (C) · 1 file (P) · 1 task (K) · viewing: Pat Smith (viewing)'))
  // presence: the others (and what they do) in the strip; the title bar counts them
  expect(f).toContain('1 other viewing: Pat Smith')
  // the strip is the line right above the key line, and nothing collaboration sits above the sections
  const lines = f.split('\n')
  const strip = lines.findIndex((l) => l.includes('Tags: none (t)'))
  expect(lines[strip + 1]).toContain('Esc back')
  expect(lines.slice(0, strip).some((l) => /Tags:|Viewing now|comment \(C\)/.test(l))).toBe(false)
  const screen = h.store.screen as RecordScreen
  expect(screen.list.current?.key).toStartWith('f:')
  await key('a')
  f = await waitFor(h, (x) => x.includes('Actions ·'))
  for (const label of ['Comments (1)', 'Add a comment', 'Follow this record', 'Attachments (1)', 'Upload an attachment', 'Timeline', 'Tasks (1 open)', 'Share preview', 'Viewing now']) expect(f).toContain(label)
  await escape()
  await key('C')
  f = await waitFor(h, (x) => x.includes('Comments · Person'))
  expect(f).toContain('Pat · ')
  expect(f).toContain('↳ Lee')
  await key('n')
  await type('looks good')
  await enter()
  f = await waitFor(h, (x) => x.includes('2 threads'))
  expect(f).toContain('Tester · ')
  expect(f).toContain('looks good')
  await escape()
  await key('W')
  await waitFor(h, () => collabState.following)
  expect((h.store.screen as RecordScreen).collabSummary?.following).toBe(true)
  await key('T')
  f = await waitFor(h, (x) => x.includes('Timeline · Person'))
  expect(f).toContain('Changed Email from "a" to "b"')
  await escape()
  await key('K')
  f = await waitFor(h, (x) => x.includes('Tasks · Person'))
  expect(f).toContain('[ ] Call back')
  await key('n')
  await type('Send quote')
  await enter()
  f = await waitFor(h, (x) => x.includes('Send quote'))
  await escape()
  await key('a')
  await type('Share preview')
  await enter()
  await waitFor(h, (x) => x.includes('Share First1 Odd with') || x.includes('with'))
  await enter()
  f = await waitFor(h, (x) => x.includes('Pat Smith') && x.includes('Enter toggles'))
  await enter()
  f = await waitFor(h, (x) => x.includes('[x] Pat Smith'))
  await escape()
  f = await waitFor(h, (x) => x.includes('Share preview ·'))
  expect(f).toContain('✓ can read')
  expect(f).toContain('Send the share to 1 person')
})

test('record view without the collaboration extension: no collaboration strip; F9 says it needs the extension', async () => {
  h = await startTui(130, 40)
  await command(h, 'table get person 1')
  let f = await waitFor(h, (x) => x.includes('Identity'))
  expect(f).not.toContain('comments (C)')
  expect(f).not.toContain('Tags:')
  await key('C')
  await key('a')
  f = await waitFor(h, (x) => x.includes('Actions ·'))
  expect(f).toContain('needs the collaboration extension')
})

test('/ search: the placeholder names quick search, "ada" shows a Records group with the record, Enter opens it', async () => {
  fakeExtensions.push(QUICK_SEARCH)
  h = await startTui(130, 40)
  let f = await key('/')
  expect(f).toContain('type to search apps, tables, processes, commands and records (quick search)')
  await type('ada')
  f = await waitFor(h, (x) => x.includes('Records · quick search: 1 match'))
  expect(f).toContain('Ada Lovelace')
  expect(f).toContain('Person #1')
  // the record is the best match, so its group comes first and Enter opens it
  await enter()
  await waitFor(h, (x) => h!.store.screen?.kind === 'record' && x.includes('First1'))
})

test('/ search without record search: one dimmed note to install quick search; :search <text> opens the search', async () => {
  h = await startTui(130, 40)
  let f = await key('/')
  expect(f).toContain('type to search apps, tables, processes, widgets and commands')
  await type('pers')
  f = await waitFor(h, (x) => x.includes('Tables'))
  expect(f.split('records: install the quick search extension').length - 1).toBe(1)
  await escape()
  await command(h, 'find pers')
  f = await waitFor(h, (x) => x.includes('Search  (/'))
  expect(f).toContain('pers')
  expect(f).toContain('Person')
})

test('? is a keyboard reference only: keys by group and the pointer line, no commands, no places, no menu entries', async () => {
  h = await startTui(130, 44)
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('First Name'))
  const f = await type('?')
  expect(f).toContain('Keys  (F1  ?)')
  for (const title of ['Anywhere', 'Move', 'Open and change', 'Find, sort and select']) expect(f).toContain(title)
  expect(f).toContain('F2 search records · / find anything · F9 menu · : command line')
  for (const notThere of ['What you can do here', 'Switch profile', 'App: People', 'Help search', 'type to search']) expect(f).not.toContain(notThere)
})

test('F9 keeps its sections but no longer lists apps, recents or metadata matches flat (apps and recents are Go to groups; places live in /)', async () => {
  h = await startTui(130, 44)
  await press(h, () => h!.setup.mockInput.pressKey(KeyCodes.F9))
  let f = await waitFor(h, (x) => x.includes('Menu  (F9)'))
  expect(f).not.toContain('App: People')
  await press(h, () => h!.setup.mockInput.typeText('g'))
  f = await press(h, () => h!.setup.mockInput.pressEnter())
  expect(f).toContain('Search records (quick search)')
  expect(f).not.toContain('App: People')
  expect(f).not.toContain('Table: ')
})

test('record view at 160 columns: the collaboration panel (tags, latest comments, followers, viewing now), keys-only strip, clicks press the keys', async () => {
  fakeExtensions.push(COLLABORATION)
  collabState.tags = [{ id: 1, name: 'rush', label: 'rush' }, { id: 2, name: 'vip', label: 'vip' }]
  h = await startTui(160, 40)
  await command(h, 'table get person 1')
  let f = await waitFor(h, (x) => x.includes('Comments 1 (C)') && x.includes('Pat Smith · viewing'))
  for (const text of ['Collaboration', 'Tags (t)', 'rush, vip', 'first note', 'Tasks 1 open (K)', 'Files 1 (P)', 'Followers 0 (W)', 'Viewing now', 'Tester (you) · viewing']) expect(f).toContain(text)
  // the strip is the keys only; the record's first field still has the cursor
  expect(f).toContain('t tags · C comments · P files · K tasks · T timeline · W follow')
  expect(f).not.toContain('not following (W)')
  const screen = h.store.screen as RecordScreen
  expect(screen.list.current?.key).toStartWith('f:')
  // a click on the strip's "C comments" opens the comments, on the panel's "Tags (t)" row the tags
  const at = (needle: string) => { const lines = h!.frame().split('\n'); const y = lines.findIndex((l) => l.includes(needle)); return { x: lines[y]!.indexOf(needle), y } }
  const c = at('C comments')
  await press(h, () => h!.setup.mockMouse.click(c.x + 1, c.y))
  f = await waitFor(h, (x) => x.includes('Comments · Person'))
  await escape()
  await waitFor(h, (x) => x.includes('Tags (t)'))
  const tags = at('Tags (t)')
  await press(h, () => h!.setup.mockMouse.click(tags.x + 1, tags.y))
  f = await waitFor(h, (x) => x.includes('rush') && h!.store.overlays.length > 0)
  await escape()
  // the keys are unchanged: P attachments, t tags
  await key('P')
  await waitFor(h, (x) => x.includes('Attachments · Person'))
  await escape()
  await waitFor(h, (x) => x.includes('Tags (t)'))
  await key('t')
  await waitFor(h, () => h!.store.overlays.length > 0)
  await escape()
  // the view setting (v): off hides the panel at 160 columns, the full strip comes back, and it is saved
  const settings = screen.viewSettings() as RecordViewSettingsOverlay
  h.store.open(settings)
  settings.row = settings.kinds().indexOf('collabPanel')
  await press(h, () => h!.setup.mockInput.typeText(' '))
  await press(h, () => h!.setup.mockInput.typeText(' '))
  await enter()
  f = await waitFor(h, (x) => x.includes('Tags: rush, vip (t) · 1 comment (C)') && !x.includes('Viewing now'))
  expect(readViewSettings('record:person').collabPanel).toBe('off')
  const again = screen.viewSettings() as RecordViewSettingsOverlay
  h.store.open(again)
  again.row = again.kinds().indexOf('collabPanel')
  await press(h, () => h!.setup.mockInput.typeText(' '))
  await enter()
  await waitFor(h, (x) => x.includes('Viewing now'))
  expect(readViewSettings('record:person').collabPanel).toBeUndefined()
})

test('record view without the collaboration extension: no strip, no panel, the cursor on the first field', async () => {
  h = await startTui(160, 40)
  await command(h, 'table get person 1')
  const f = await waitFor(h, (x) => x.includes('Esc back') && x.includes('First'))
  expect(f).not.toContain('Tags:')
  expect(f).not.toContain('Collaboration')
  expect((h.store.screen as RecordScreen).list.current?.key).toStartWith('f:')
})
