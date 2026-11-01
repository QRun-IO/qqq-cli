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
import { COLLABORATION, QUICK_SEARCH, collabState, fakeExtensions, resetCollab } from './fake-collab'
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
  expect(await c.summary()).toEqual({ comments: 1, attachments: 1, tasks: 1, following: false })
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

test('record view with collaboration: the summary line, a/F9 entries, comments (add), follow, timeline, tasks, share preview', async () => {
  fakeExtensions.push(COLLABORATION)
  h = await startTui(130, 40)
  await command(h, 'table get person 1')
  let f = await waitFor(h, (x) => x.includes('Comments 1 (C) · Attachments 1 (P) · Tasks 1 (K) · Timeline (T) · not following (W)'))
  // presence: everyone on the record, this user marked; the title bar counts the others
  f = await waitFor(h, (x) => x.includes('Viewing now: Pat Smith, Tester (you) · 1 other'))
  expect(f).toContain('1 other viewing: Pat Smith')
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
  f = await waitFor(h, (x) => x.includes('· following (W)'))
  expect(collabState.following).toBe(true)
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

test('record view without the collaboration extension: no collaboration line; F9 says it needs the extension', async () => {
  h = await startTui(130, 40)
  await command(h, 'table get person 1')
  let f = await waitFor(h, (x) => x.includes('Identity'))
  expect(f).not.toContain('Comments ')
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
