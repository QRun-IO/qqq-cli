/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { testRender } from '@opentui/react/test-utils'
import { KeyCodes } from '@opentui/core/testing'
import { writeFilePreferences } from '@qrun-io/qqq-core'
import { App } from '../src/app'
import { boot, parseArgs } from '../src/boot'
import { SqlRunnerScreen } from '../src/sql/screen'
import type { FakeLog } from './fake-server'
import { sqlFakeFetch, type SqlFakeState } from './fake-sql'
import { command, isolate, press, sessionSecrets, waitFor, type Harness } from './helpers'

let h: Harness | undefined
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

async function start(installed: boolean, width = 120, height = 36, state?: SqlFakeState): Promise<Harness> {
  const log: FakeLog = { requests: [] }
  const store = boot({ args: parseArgs(['--profile', 'fake']), quit: () => undefined, build: 'test', secrets: sessionSecrets, fetch: sqlFakeFetch(log, installed, state) })
  const setup = await testRender(<App store={store} />, { width, height })
  const harness: Harness = { setup, store, log, frame: () => setup.captureCharFrame() }
  await waitFor(harness, (f) => f.includes('Home') && harness.store.screen?.kind === 'home' && Boolean(harness.store.meta))
  return harness
}

const key = (k: keyof typeof KeyCodes | string, mods?: { ctrl?: boolean; shift?: boolean; meta?: boolean }) => press(h!, () => h!.setup.mockInput.pressKey(k as never, mods))
const type = (t: string) => press(h!, () => h!.setup.mockInput.typeText(t))
const paste = (t: string) => press(h!, () => h!.setup.mockInput.pasteBracketedText(t))
const runner = () => h!.store.screen as SqlRunnerScreen
/** No frame line is wider than the terminal (the clipping rule). */
const fits = (frame: string, width: number) => frame.split('\n').every((l) => [...l].length <= width)

test('without the sql-workbench extension: the Runner app is hidden, :sql says what is missing, no menu entry', async () => {
  h = await start(false)
  const apps = h.store.meta!.apps as Record<string, unknown>
  expect(apps.sqlWorkbenchRunner).toBeUndefined()
  expect(apps.sqlWorkbench).toBeDefined()
  expect(JSON.stringify(h.store.meta!.appTree)).not.toContain('sqlWorkbenchRunner')
  expect((h.store.meta!.widgets as Record<string, unknown>).sqlWorkbenchWidget).toBeUndefined()
  expect(h.store.commands() && (h.store.commandsImpl!(h.store) as unknown as { entries(t: string): Array<{ label: string }> }).entries('').some((e) => e.label === 'SQL Runner')).toBe(false)
  await command(h, 'sql')
  const f = await waitFor(h, (x) => x.includes('needs the sql-workbench extension'))
  expect(f).toContain('SQL Runner needs the sql-workbench')
  expect(h.store.screen?.kind).toBe('home')
  await command(h, 'app sqlWorkbenchRunner')
  await waitFor(h, (x) => x.includes('no app named "sqlWorkbenchRunner"'))
  expect(h.log.requests.some((r) => r.path.startsWith('/sql-workbench'))).toBe(false)
})

test('the Runner opens from its app, :sql, the palette and F9 › Work; SELECT 1 and a real table query with paging and sort', async () => {
  const state: SqlFakeState = { executions: [], notebooks: [], rowsCalls: [] }
  h = await start(true, 120, 36, state)
  // F9 › Work and the palette list it
  const entries = (h.store.commandsImpl!(h.store) as unknown as { entries(t: string): Array<{ label: string; section: string }> }).entries('')
  expect(entries.find((e) => e.label === 'SQL Runner')?.section).toBe('Work')
  // the search (F2 or /): the SQL Workbench widget hit opens the Runner (never `widget get`)
  await key('F2')
  await type('sql')
  let f = await waitFor(h, (x) => x.includes('SQL Runner') && x.includes('SQL Workbench'))
  await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => x.includes('SQL · cell 1/1 · h2') && x.includes('READ-ONLY'))
  expect(h.store.screen?.kind).toBe('sql')
  await key('ESCAPE')
  expect(h.store.screen?.kind).toBe('home')
  // the app tree: the Runner app opens the screen
  await command(h, 'app sqlWorkbenchRunner')
  await waitFor(h, () => h!.store.screen?.kind === 'sql')
  await key('ESCAPE')
  await command(h, 'sql')
  await waitFor(h, (x) => x.includes('Write SQL above'))
  await type('SELECT 1')
  await key('F5')
  f = await waitFor(h, (x) => x.includes('1 row · 2 ms · h2 · read-only · limit 10,000'))
  expect(state.executions.at(-1)).toMatchObject({ sql: 'SELECT 1' })
  // a real table: 250 rows, the first chunk with the execute, the rest paged from the server
  runner().focus = 'editor'
  runner().buffer.set('')
  await paste('SELECT ID, NAME, EMAIL\nFROM CUSTOMER')
  // Ctrl+J: what terminals without the kitty protocol can send for "run" (Ctrl+Enter arrives as Enter there)
  await key('j', { ctrl: true })
  f = await waitFor(h, (x) => x.includes('250 rows') && x.includes('Customer 001'))
  expect(f).toContain('NULL')
  expect(f).toMatch(/ID\s+NAME\s+EMAIL/)
  expect(runner().focus).toBe('results')
  for (let i = 0; i < 4; i++) await key('\x1b[6~')
  f = await waitFor(h, (x) => x.includes('row 69') && x.includes('Customer 085'))
  await key('END')
  f = await waitFor(h, (x) => x.includes('row 250') && x.includes('Customer 250') && !x.includes('loading…'))
  expect(state.rowsCalls.map((c) => c.offset)).toEqual(['200'])
  await key('HOME')
  // sort by NAME (server-side): descending puts NULL last
  await key('ARROW_RIGHT')
  await type('s')
  await type('s')
  f = await waitFor(h, (x) => x.includes('sort NAME desc') && x.includes('Customer 250'))
  expect(state.rowsCalls.at(-1)).toMatchObject({ sort: '1', dir: 'desc', offset: '0' })
  // V: the whole value
  await type('V')
  f = await waitFor(h, (x) => x.includes('NAME (VARCHAR), row 1'))
  await key('ESCAPE')
  // F1: the screen's keys first
  await key('F1')
  f = await waitFor(h, (x) => x.includes('run the statement under the cursor'))
  await key('ESCAPE')
})

test('errors inline with the position, EXPLAIN as a tree, completion, schema insert, history, notebooks, export, cells, at 80×24', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-sqlexp-'))
  writeFilePreferences({ downloadDir: dir, downloadMode: 'silent' })
  const state: SqlFakeState = { executions: [], notebooks: [], rowsCalls: [] }
  h = await start(true, 80, 24, state)
  await command(h, 'sql SELECT * FRM CUSTOMER')
  let f = await waitFor(h, (x) => x.includes('FAILED (SQLSTATE 42000) at line 1, col 10'))
  expect(fits(f, 80)).toBe(true)
  expect(runner().focus).toBe('editor')
  // a 400 from the classifier is shown the same way
  runner().buffer.set('SELEC 1')
  await key('F5')
  f = await waitFor(h, (x) => x.includes('Read-only sessions run exactly one'))
  // completion: the table, then its columns through the alias
  runner().buffer.set('SELECT * FROM CUST')
  await key('TAB')
  expect(runner().buffer.text).toBe('SELECT * FROM CUSTOMER')
  runner().buffer.set('SELECT c.NA FROM CUSTOMER c')
  runner().buffer.setOffset(11)
  await key('TAB')
  expect(runner().buffer.text).toBe('SELECT c.NAME FROM CUSTOMER c')
  // EXPLAIN: the plan as an indented tree with costs
  await key('F6')
  f = await waitFor(h, (x) => x.includes('Plan') && x.includes('▾ SELECT') && x.includes('Seq Scan CUSTOMER'))
  expect(f).toMatch(/Seq Scan CUSTOMER\s+cost 8 · rows 250/)
  expect(fits(f, 80)).toBe(true)
  await type('r')
  f = await waitFor(h, (x) => x.includes('FROM CUSTOMER') && x.includes('raw text'))
  // F3: the schema pane; filter, Enter on a column inserts it
  runner().focus = 'editor'
  runner().buffer.set('SELECT ')
  await key('F3')
  f = await waitFor(h, (x) => x.includes('Schema') && x.includes('ORDERS'))
  expect(fits(f, 80)).toBe(true)
  await type('STAT')
  await key('ARROW_DOWN')
  await key('ARROW_RIGHT')
  await key('ARROW_DOWN')
  await key('ARROW_DOWN')
  await key('ARROW_DOWN')
  await key('ARROW_DOWN')
  await press(h, () => h!.setup.mockInput.pressEnter())
  expect(runner().buffer.text).toBe('SELECT STATUS')
  expect(runner().focus).toBe('editor')
  // F7: history; Enter opens the SQL as a new cell
  await key('F7')
  f = await waitFor(h, (x) => x.includes('History') && x.includes('SELECT * FRM CUSTOMER'))
  expect(fits(f, 80)).toBe(true)
  await press(h, () => h!.setup.mockInput.pressEnter())
  expect(runner().notebook.cells.length).toBe(2)
  expect(runner().buffer.text).toBe('SELECT * FRM CUSTOMER')
  // F4: cells; add a markdown cell, rendered as text below
  await key('F4')
  f = await waitFor(h, (x) => x.includes('Cells of Untitled') && x.includes('SELECT STATUS'))
  expect(fits(f, 80)).toBe(true)
  await type('m')
  await paste('## Totals\n- per **customer**')
  f = await waitFor(h, (x) => x.includes('Notes (markdown)') && x.includes('• per customer'))
  // F2: save as a new notebook
  await key('F2')
  f = await waitFor(h, (x) => x.includes('Notebooks') && x.includes('[Mine]'))
  expect(fits(f, 80)).toBe(true)
  await type('a')
  await type('Smoke book')
  await press(h, () => h!.setup.mockInput.pressEnter())
  f = await waitFor(h, (x) => x.includes('saved as Smoke book'))
  expect(state.notebooks[0]).toMatchObject({ title: 'Smoke book' })
  expect((state.notebooks[0]!.cells as unknown[]).length).toBe(3)
  expect(runner().edited).toBe(false)
  expect(f).toContain('Smoke book')
  // run a real query, then export through the file flow (silent download)
  runner().goCell(0)
  runner().buffer.set('SELECT * FROM CUSTOMER')
  await key('F5')
  f = await waitFor(h, (x) => x.includes('250 rows'))
  expect(fits(f, 80)).toBe(true)
  expect(state.executions.at(-1)).toMatchObject({ sql: 'SELECT * FROM CUSTOMER' })
  await type('x')
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('Wrote'))
  const file = readdirSync(dir).find((n) => n.endsWith('.csv'))!
  expect(readFileSync(join(dir, file), 'utf8')).toContain('Customer 001')
  await key('ESCAPE')
  // chart view: text bars of the number column
  await type('c')
  f = await waitFor(h, (x) => x.includes('Chart') && x.includes('█'))
  expect(fits(f, 80)).toBe(true)
  // the save is a new version (PUT) once the notebook exists
  runner().focus = 'editor'
  await type(' ')
  await key('F2')
  await type('s')
  await waitFor(h, (x) => x.includes('saved Smoke book, version 2'))
  // leaving with unsaved changes asks first
  await type(' ')
  await key('ESCAPE')
  await waitFor(h, (x) => x.includes('Leave the SQL Runner?'))
  await type('n')
  expect(h.store.screen?.kind).toBe('sql')
})

test('parameters are asked for, bound as values and remembered; run all stops at a failing cell', async () => {
  const state: SqlFakeState = { executions: [], notebooks: [], rowsCalls: [] }
  h = await start(true, 100, 30, state)
  await command(h, 'sql')
  await waitFor(h, () => h!.store.screen?.kind === 'sql')
  await type('SELECT * FROM CUSTOMER WHERE ID > :minId')
  await key('F5')
  await waitFor(h, (x) => x.includes('Value for :minId'))
  await type('5')
  await press(h, () => h!.setup.mockInput.pressEnter())
  await waitFor(h, (x) => x.includes('250 rows'))
  expect(state.executions.at(-1)!.params).toEqual({ minId: '5' })
  runner().focus = 'editor'
  await key('F5')
  await waitFor(h, () => state.executions.length === 2)
  expect(state.executions.at(-1)!.params).toEqual({ minId: '5' })
  runner().addCell('SQL', 'SELECT * FRM X')
  runner().addCell('SQL', 'SELECT 1')
  runner().runAll()
  await waitFor(h, (x) => x.includes('run all stopped at cell 2 (1 ran)'))
  expect(runner().cellIndex).toBe(1)
  expect(state.executions.map((e) => e.sql)).toEqual(['SELECT * FROM CUSTOMER WHERE ID > :minId', 'SELECT * FROM CUSTOMER WHERE ID > :minId', 'SELECT * FROM CUSTOMER WHERE ID > :minId', 'SELECT * FRM X'])
})
