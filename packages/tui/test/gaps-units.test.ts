/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { expect, test } from 'bun:test'
import { widgetToBlocks } from '@qrun-io/qqq-core'
import { destinationChoices, esbOverviewBlocks } from '../src/esb'
import { isShutdownNoise, quietShutdownNoise } from '../src/exit'
import { htmlBlocks, htmlRowBlocks } from '../src/html-rows'
import { iconGlyph } from '../src/icons'
import { TRUSTED_LINK, mutatingCommand, parseLink, runTrustedCommand } from '../src/links'
import { NO_QUICK_SEARCH, paletteGroups, paletteRows, recordItem, type PaletteItem } from '../src/palette'
import { HELP_POINTER, helpKeyGroups } from '../src/help-keys'
import { structuredLines } from '../src/structured'
import { structuredOutput } from '../src/commands'
import { summaryText, viewingText, commentLines, noteUploadFailure, uploadBlocked } from '../src/collab'
import { errorText } from '../src/util/text'
import { blockLines } from '../src/widgets'

const known = { tables: { jobs_job: {}, alerts_channel: {}, person: {} }, processes: { syncOrder: {} }, apps: { jobs: {}, alerts: {}, esb: {} } }

test('links: a jobs statistic link opens the filtered grid; records, processes and apps are checked against the metadata', () => {
  const href = '/jobs/jobs_job?filter=%7B%22criteria%22%3A%5B%7B%22fieldName%22%3A%22status%22%2C%22operator%22%3A%22IN%22%2C%22values%22%3A%5B%22RUNNING%22%5D%7D%5D%2C%22booleanOperator%22%3A%22AND%22%7D'
  expect(parseLink(href, known)).toEqual({ kind: 'table', table: 'jobs_job', filter: { criteria: [{ fieldName: 'status', operator: 'IN', values: ['RUNNING'] }], booleanOperator: 'AND' } })
  expect(parseLink('/app/alerts_channel', known)).toEqual({ kind: 'table', table: 'alerts_channel' })
  expect(parseLink('/app/person/42', known)).toEqual({ kind: 'record', table: 'person', primaryKey: '42' })
  expect(parseLink('/jobs/person/42/edit', known)).toEqual({ kind: 'record', table: 'person', primaryKey: '42' })
  expect(parseLink('/app/syncOrder', known)).toEqual({ kind: 'process', process: 'syncOrder' })
  expect(parseLink('/jobs', known)).toEqual({ kind: 'app', app: 'jobs' })
  // a filter that is not a QueryFilter is dropped, the grid still opens
  expect(parseLink('/jobs/jobs_job?filter=%7B%22x%22%3A1%7D', known)).toEqual({ kind: 'table', table: 'jobs_job' })
})

test('links from server content never run commands: `:` text, unknown tables, odd keys and other sites are inert notices', () => {
  expect(parseLink(':process run deleteEverything', known)).toEqual({ kind: 'notice', text: ':process run deleteEverything' })
  expect(parseLink(':table delete person 1', known).kind).toBe('notice')
  expect(parseLink('/app/no_such_table', known).kind).toBe('notice')
  expect(parseLink('/jobs/no_such_table/1', known).kind).toBe('notice')
  expect(parseLink('/nothing/known', known).kind).toBe('notice')
  expect(parseLink('/app/person/1%20--yes', known).kind).toBe('notice')
  expect(parseLink('/app/person/-rf', known).kind).toBe('notice')
  expect(parseLink('https://evil.example/x', known, 'http://srv')).toEqual({ kind: 'notice', text: 'https://evil.example/x' })
  expect(parseLink('javascript:alert(1)', known).kind).toBe('notice')
  expect(parseLink('esb:orderEvents', known).kind).toBe('notice')
  expect(parseLink('/app/esb', known, 'http://srv')).toEqual({ kind: 'notice', text: 'http://srv/app/esb' })
})

test('trusted links: only TUI-built (symbol-keyed) rows carry them; a server row with __href is a plain link; mutating commands confirm', () => {
  const serverRow = { kind: 'table' as const, columns: ['a'], headers: ['A'], rows: [{ a: 'x', __href: ':table delete person 1' }] }
  const line = blockLines([serverRow], 40).find((l) => l.text.startsWith('x'))!
  expect(line.trusted).toBeUndefined()
  expect(parseLink(line.href!, known).kind).toBe('notice')
  // JSON cannot carry the symbol key
  expect(JSON.parse(JSON.stringify({ [TRUSTED_LINK]: { kind: 'command', line: 'x' } }))).toEqual({})
  expect(mutatingCommand('esb table order')).toBe(false)
  expect(mutatingCommand('esb dead-letters syncOrder.orderEvents')).toBe(false)
  expect(mutatingCommand('process run x')).toBe(true)
  expect(mutatingCommand('table delete person 1')).toBe(true)
  expect(mutatingCommand('collab post-records-comments t 1')).toBe(true)
  const ran: string[] = []
  const confirms: string[] = []
  const flashes: string[] = []
  const store = { flash: (t: string) => flashes.push(t), confirm: (t: string, yes: () => void) => { confirms.push(t); yes() }, commands: () => ({ run: async (l: string) => { ran.push(l) } }) }
  runTrustedCommand(store as never, 'esb table order')
  expect(confirms).toEqual([])
  expect(flashes).toEqual(['running :esb table order'])
  runTrustedCommand(store as never, 'process run x')
  expect(confirms).toEqual(['Run :process run x?'])
  expect(ran).toEqual(['esb table order', 'process run x'])
})

test('jobs widget: statistics with a url show label and count only, and carry the link for Enter', () => {
  const blocks = widgetToBlocks({ type: 'multiStatistics', statisticsGroupData: [{ header: 'Now', statisticList: [{ label: 'Running', value: 0, url: '/jobs/jobs_job?filter=%7B%7D' }, { label: 'Completed', value: 3 }] }] })
  const lines = blockLines(blocks, 80)
  const running = lines.find((l) => l.text.startsWith('Running'))!
  expect(running.text.trim()).toBe('Running: 0')
  expect(running.href).toBe('/jobs/jobs_job?filter=%7B%7D')
  expect(lines.some((l) => l.text.includes('</jobs'))).toBe(false)
  expect(lines.find((l) => l.text.startsWith('Completed'))!.href).toBeUndefined()
})

const overview = {
  providers: [{ name: 'artemis', connected: true }],
  destinations: [{
    name: 'orderEvents', type: 'TOPIC', provider: 'artemis', counters: { published: 4, consumed: 3, failed: 1, deadLettered: 0, lastActivity: null },
    publishers: [{ kind: 'TABLE', name: 'order', events: ['INSERT', 'UPDATE'] }],
    triggers: [{ name: 'syncOrder.orderEvents', processName: 'syncOrder', processLabel: 'Sync Order' }],
  }],
}

test('ESB widget: the overview as a table of destinations (like :esb overview) whose rows open the destination', () => {
  const blocks = esbOverviewBlocks(overview)
  const lines = blockLines(blocks, 140)
  expect(lines[0]!.text).toContain('Destination')
  expect(lines[0]!.text).toContain('Triggers')
  const row = lines.find((l) => l.text.startsWith('orderEvents'))!
  expect(row.text).toMatch(/orderEvents\s+TOPIC\s+artemis\s+order\s+Sync Order\s+4\s+3\s+1\s+0/)
  expect(row.trusted).toEqual({ kind: 'esb', destination: 'orderEvents' })
  expect(row.href).toBeUndefined()
  expect(lines.at(-1)!.text).toContain('1 destination · artemis connected')
  expect(esbOverviewBlocks({ destinations: [], providers: [] })).toEqual([{ kind: 'text', text: 'No ESB destinations.' }])
  expect(destinationChoices(overview, 'orderEvents').map((c) => c.line)).toEqual(['esb table order', 'esb process syncOrder', 'esb messages orderEvents --trigger syncOrder.orderEvents', 'esb dead-letters syncOrder.orderEvents'])
  // names from the server are quoted into the command (one argument each)
  const odd = { destinations: [{ ...overview.destinations[0], name: 'a b', triggers: [{ name: 'x --yes', processName: 'p' }] }] }
  expect(destinationChoices(odd, 'a b').map((c) => c.line)).toContain('esb messages "a b" --trigger "x --yes"')
})

const ALERTS_SETUP = '<div style="opacity:.75">Everything Alerts needs is set up.</div>'
  + '<div><span><span><strong><a href="/app/alerts_channel">Channels</a></strong> <span style="color:#16a34a">Set up</span></span><span>1 channel: the bell and email only. &middot; Next: Optional: add Slack.</span></span></div>'
  + '<div><span><span><strong><a href="/app/alerts_type">Alert types</a></strong> <span>Set up</span></span><span>38 types declared by the installed qbits.</span></span></div>'
  + '<div><span><span><strong><a href="/app/alerts_group">Groups</a></strong> <span>Optional</span></span><span>4 groups, none with an owner team.</span></span></div>'

test('alerts setup widget: label, status and detail in aligned columns, the detail wrapping under itself', () => {
  expect(htmlBlocks(ALERTS_SETUP)[1]).toEqual({ cells: ['Channels', 'Set up', '1 channel: the bell and email only. · Next: Optional: add Slack.'], href: '/app/alerts_channel' })
  const blocks = htmlRowBlocks(ALERTS_SETUP)!
  expect(blocks[0]).toEqual({ kind: 'text', text: 'Everything Alerts needs is set up.' })
  const lines = blockLines(blocks, 60)
  const col = (line: string, word: string) => line.indexOf(word)
  const channels = lines.find((l) => l.text.startsWith('Channels'))!
  const groups = lines.find((l) => l.text.startsWith('Groups'))!
  expect(col(channels.text, 'Set up')).toBe(col(groups.text, 'Optional'))
  expect(col(channels.text, '1 channel')).toBe(col(groups.text, '4 groups'))
  expect(channels.href).toBe('/app/alerts_channel')
  // the long detail wraps under its own column
  const next = lines[lines.indexOf(channels) + 1]!
  expect(next.text.search(/\S/)).toBe(col(channels.text, '1 channel'))
  expect(lines.every((l) => l.text.length <= 60)).toBe(true)
  expect(htmlRowBlocks('<p>Just a paragraph</p><p>and another</p>')).toBeUndefined()
})

test('structured output: the kernel layout (key/value rows, sub-tables fitted to the width), list headings coloured', () => {
  const value = { items: Array.from({ length: 3 }, (_, i) => ({ id: i + 1, title: `Alert ${i + 1}`, owner: { name: 'Pat' } })), total: 3, limits: { maxRows: 10000, pageSize: 500 }, tags: ['a', 'b'] }
  const lines = structuredLines(value, 80)
  const text = lines.map((l) => l.text)
  expect(text).toContain('total            3')
  expect(text).toContain('limits.maxRows   10000')
  expect(text.some((l) => /^tags\s+a, b$/.test(l))).toBe(true)
  const heading = lines.find((l) => l.text === 'items (3)')!
  expect(heading.bold).toBe(true)
  expect(text.some((l) => /^id\s+title\s+owner\.name/.test(l))).toBe(true)
  expect(text.some((l) => /^1\s+Alert 1\s+Pat/.test(l))).toBe(true)
  expect(text.some((l) => l.includes('[{"id"'))).toBe(false)
  expect(lines.every((l) => l.text.length <= 80)).toBe(true)
})

test('structured output is used for extension operations and api, not for first-class commands or explicit formats', () => {
  const installed = ['alerts', 'collaboration', 'esb']
  expect(structuredOutput(['alerts', 'get-inbox'], installed)).toBe(true)
  expect(structuredOutput(['collab', 'get-records-tasks', 'customer', '1'], installed)).toBe(true)
  expect(structuredOutput(['api', 'getVersion'], installed)).toBe(true)
  expect(structuredOutput(['esb', 'overview'], installed)).toBe(false)
  expect(structuredOutput(['alerts', 'get-inbox', '-O', 'yaml'], installed)).toBe(false)
  expect(structuredOutput(['sql-workbench', 'get-capabilities'], installed)).toBe(false)
  expect(structuredOutput(['table', 'list'], installed)).toBe(false)
})

test('widget payloads without a block draw as rows (not "no terminal rendering yet")', () => {
  const lines = blockLines([{ kind: 'raw', type: 'NEW_THING', data: { type: 'NEW_THING', count: 3, rows: [{ a: 1, b: 'x' }] } }], 60).map((l) => l.text)
  expect(lines).toContain('count  3')
  expect(lines.some((l) => /^a\s+b/.test(l))).toBe(true)
  expect(lines.join('\n')).not.toContain('no terminal rendering')
})

test('app card icons: common Material names map to glyphs, ASCII under the ASCII setting, unknown names to nothing', () => {
  expect(iconGlyph('notifications_active', false)).toBe('⍾')
  expect(iconGlyph('notifications_active', true)).toBe('!')
  expect(iconGlyph('insights', false)).toBe('▟')
  expect(iconGlyph('storage', false)).toBe('⛁')
  expect(iconGlyph('person', false)).toBe('☺')
  expect(iconGlyph('admin_panel_settings', false)).toBe('⚙')
  expect(iconGlyph('settings_outlined', true)).toBe('*')
  expect(iconGlyph('no_such_icon', false)).toBeUndefined()
  expect(iconGlyph(undefined, false)).toBeUndefined()
  for (const name of ['admin_panel_settings', 'bug_report', 'campaign', 'emoji_people', 'folder_shared', 'help_outline', 'hub', 'insights', 'location_city', 'notifications_active', 'pending_actions', 'person', 'play_circle', 'search', 'stars', 'storage', 'storefront', 'terminal', 'verified_user', 'widgets']) {
    expect(iconGlyph(name, false)?.length).toBe(1)
  }
})

test('exit: the renderer\'s shutdown failures on a closed terminal are dropped; other errors still print', () => {
  const rawMode = Object.assign(new Error('setRawMode failed with errno: 2'), { name: 'SystemError' })
  expect(isShutdownNoise(['Error disabling raw mode:', rawMode])).toBe(true)
  expect(isShutdownNoise(['Native scene shutdown failed:', new Error('ot_session_post_stdout failed: OutputFailed')])).toBe(true)
  expect(isShutdownNoise([new Error('connection refused')])).toBe(false)
  const printed: unknown[][] = []
  const target = { error: (...a: unknown[]) => printed.push(a), warn: (...a: unknown[]) => printed.push(a) }
  const restore = quietShutdownNoise(target as unknown as Console)
  target.error('Error disabling raw mode:', rawMode)
  target.error('real problem')
  restore()
  expect(printed).toEqual([['real problem']])
})

const run = () => undefined
const item = (label: string, kind: string): PaletteItem => ({ label, kind, run })

test('palette: groups with headers, best match first, a Records group from quick search, the note when it is absent', () => {
  const index = [item('Adornment Lab', 'table'), item('Ada Reports', 'app'), item('Audit Table', 'table')]
  const commands = [item('Theme: dark', 'command'), item('Readable view', 'command')]
  const ada = item('Ada Lovelace', 'record')
  const groups = paletteGroups({ text: 'ada', index, commands, records: { status: 'done', quick: true, items: [ada] } })
  expect(groups.map((g) => g.title)).toEqual(['Apps', 'Records · quick search: 1 match', 'Tables', 'Commands'])
  expect(groups.find((g) => g.title === 'Commands')!.items.map((i) => i.label)).toEqual(['Readable view'])
  const { rows, selectable } = paletteRows(groups)
  expect(rows[0]).toEqual({ header: 'Apps' })
  expect(selectable.map((i) => rows[i]!.item!.label)).toEqual(['Ada Reports', 'Ada Lovelace', 'Adornment Lab', 'Audit Table', 'Readable view'])
  const absent = paletteGroups({ text: 'ada', index, commands, records: { status: 'absent', quick: false, items: [] } })
  const rec = absent.find((g) => g.title === 'Records')!
  expect(rec.items).toEqual([{ label: NO_QUICK_SEARCH, kind: 'note' }])
  expect(paletteRows(absent).rows.filter((r) => r.item?.label === NO_QUICK_SEARCH)).toHaveLength(1)
  expect(paletteGroups({ text: 'ada', index, commands, records: { status: 'searching', quick: true, items: [] } }).some((g) => g.title === 'Records · quick search: searching…')).toBe(true)
  expect(paletteGroups({ text: '', index, commands, records: { status: 'idle', quick: true, items: [] }, recents: [item('Ada', 'recent')] }).map((g) => g.title)).toEqual(['Recent', 'Commands'])
})

test('palette: a quick-search hit shows the record label (the highlighted name when the label is only the key) and the table', () => {
  const opened: string[] = []
  const hit = recordItem({ tableName: 'customer', tableLabel: 'Customer', recordId: '1', recordLabel: '1', highlights: [{ text: 'Ada Lovelace' }] }, () => undefined, (t, k) => opened.push(`${t}:${k}`))
  expect(hit).toMatchObject({ label: 'Ada Lovelace', kind: 'record', context: 'Customer #1' })
  hit.run!()
  expect(opened).toEqual(['customer:1'])
  expect(recordItem({ tableName: 'person', recordId: 5, recordLabel: 'Grace Hopper' }, (t) => (t === 'person' ? 'Person' : undefined), () => undefined)).toMatchObject({ label: 'Grace Hopper', context: 'Person #5' })
})

test('help: only keys grouped by what they do, the pointer line, no commands or places', () => {
  const groups = helpKeyGroups('table', true, [['S', 'Column statistics'], ['F4', 'Edit the record under the cursor']])
  expect(groups.map((g) => g.title)).toEqual(['Anywhere', 'Move', 'Open and change', 'Find, sort and select', 'On this screen'])
  const keys = groups.flatMap((g) => g.keys)
  // no command-line commands, menu entries or navigation targets
  expect(keys.some(([k]) => /^:\w/.test(k))).toBe(false)
  expect(keys.some(([, what]) => /^(App|Table|Process|Recent):|Switch profile|Sign out|Theme:/.test(what))).toBe(false)
  // F4 is listed above, so the screen's own F4 entry is not repeated
  expect(groups.at(-1)!.keys).toEqual([['S', 'Column statistics']])
  expect(HELP_POINTER).toContain('F2 search records')
  expect(HELP_POINTER).toContain('/ find anything')
  expect(HELP_POINTER).toContain('F9 menu')
  expect(helpKeyGroups('home', true)[0]!.keys.find(([k]) => k === 'F2')![1]).toContain(':search <text>')
  const noSingle = helpKeyGroups('record', false).flatMap((g) => g.keys)
  expect(noSingle.some(([k]) => k === 'a' || k === 'c' || k === 'v')).toBe(false)
  expect(helpKeyGroups('form', true).find((g) => g.title === 'Open and change')!.keys.map(([k]) => k)).toContain('Ctrl+S')
})

test('collaboration header: counts, follow state and who is viewing (this user marked)', () => {
  expect(summaryText({ comments: 2, attachments: 0, tasks: 1, following: true })).toBe('Comments 2 (C) · Attachments 0 (P) · Tasks 1 (K) · Timeline (T) · following (W)')
  expect(viewingText([{ name: 'Admin', self: true }])).toBe('Viewing now: Admin (you)')
  expect(viewingText([{ name: 'Tester', self: true }, { name: 'Pat Smith' }])).toBe('Viewing now: Tester (you), Pat Smith · 1 other')
  expect(viewingText(undefined)).toBe('Viewing now: …')
  expect(summaryText(undefined)).toBe('Comments … (C) · Attachments … (P) · Tasks … (K) · Timeline (T) · following … (W)')
  expect(commentLines({ authorDisplayName: 'Pat', body: 'hi @[Lee](user:7)', createdAt: undefined, replies: [{ authorDisplayName: 'Lee', body: 'ok' }] }, () => 'now')).toEqual(['Pat · now: hi @Lee', '    ↳ Lee · now: ok'])
})

test('uploads: the missing Object Storage QBit becomes one plain line, and uploads are then not offered on that server', () => {
  const server = 'http://no-storage.test'
  expect(uploadBlocked(server)).toBeUndefined()
  expect(noteUploadFailure(server, { status: 500, message: 'IllegalStateException (The Object Storage qbit is not installed)' })).toBe('This server cannot store attachments: the Object Storage QBit is not installed.')
  expect(uploadBlocked(server)).toBe('This server cannot store attachments: the Object Storage QBit is not installed.')
  expect(uploadBlocked('http://other.test')).toBeUndefined()
  expect(noteUploadFailure('http://x.test', { status: 400, message: 'file too big' })).toBeUndefined()
  expect(uploadBlocked('http://x.test')).toBeUndefined()
  expect(errorText(Object.assign(new Error('IllegalStateException (The Object Storage qbit is not installed)'), { status: 500 }))).toBe('This server cannot store attachments: the Object Storage QBit is not installed.')
})
