/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * `qqq history`: every CLI invocation is recorded (argv as typed, redacted, exit code, duration),
 * listed with filters, re-run (asking for commands that change data), and cleared.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { runCli, sandbox, startFakeServer, type FakeServer } from './harness.js'

let server: FakeServer
let box: ReturnType<typeof sandbox>

before(async () => {
  server = await startFakeServer()
  box = sandbox()
})
after(async () => {
  await server.close()
  box.dispose()
})

function qqq(args: string[], env: Record<string, string> = {}) {
  return runCli(['--server', server.url, ...args], { QQQ_TOKEN: 'test-token', ...box.env, ...env })
}

interface Entry { n: number; client: string; kind: string; summary: string; command?: string; exit?: number; ms?: number; profile: string; server?: string; at: string }

async function list(args: string[] = []): Promise<Entry[]> {
  const r = await qqq(['history', '--format', 'json', '--limit', '0', ...args])
  assert.equal(r.code, 0, r.stderr)
  return JSON.parse(r.stdout) as Entry[]
}

test('invocations are recorded with exit code and duration; secrets are redacted; completion is not', async () => {
  assert.equal((await qqq(['table', 'get', 'person', '1', '-O', 'json'])).code, 0)
  assert.equal((await qqq(['table', 'query', 'person', '-w', 'password = hunter2', '-O', 'json'])).code !== null, true)
  await qqq(['__complete', '--', 'table', ''])
  assert.equal((await qqq(['table', 'get', 'nosuchtable', '1'])).code !== 0, true)
  await qqq(['api', 'GET', '/qqq/v1/metaData', '-H', 'Authorization: Bearer topsecret', '--token', 'abc123'])
  const entries = await list()
  assert.deepEqual(entries.map((e) => e.summary.replace(/ -O json$/, '')), [
    'qqq table get person 1',
    'qqq table query person -w "password = ***"',
    'qqq table get nosuchtable 1',
    'qqq api GET /qqq/v1/metaData -H "Authorization: ***" --token ***',
  ])
  const [get, query] = entries
  assert.equal(get!.client, 'cli')
  assert.equal(get!.kind, 'cli')
  assert.equal(query!.kind, 'query')
  assert.equal(get!.exit, 0)
  assert.ok(typeof get!.ms === 'number')
  assert.equal(get!.command, `qqq --server ${server.url} table get person 1 -O json`)
  assert.ok(entries[2]!.exit !== 0)
  assert.equal(get!.server, server.url)
  const files = readdirSync(join(box.env.QQQ_STATE_DIR!, 'activity'))
  assert.equal(files.length, 1)
  const raw = readFileSync(join(box.env.QQQ_STATE_DIR!, 'activity', files[0]!), 'utf8')
  assert.ok(!raw.includes('hunter2') && !raw.includes('topsecret') && !raw.includes('abc123'))
})

test('the listing: table with numbers, filters, --commands in full', async () => {
  const table = await qqq(['history', '-O', 'table', '--limit', '0'])
  assert.equal(table.code, 0, table.stderr)
  const lines = table.stdout.split('\n')
  assert.match(lines[0]!, /^#\s+Time\s+Client\s+Kind\s+Summary$/)
  assert.match(table.stdout, /\n1\s+(now|\d+s ago)\s+cli\s+cli\s+qqq table get person 1/)
  assert.match(table.stdout, /`qqq history rerun <#>` runs one again/)
  const kind = await list(['--kind', 'query'])
  assert.deepEqual(kind.map((e) => e.n), [2])
  const grep = await list(['--grep', 'NOSUCH'])
  assert.deepEqual(grep.map((e) => e.n), [3])
  const limited = await qqq(['history', '--format', 'json', '--limit', '2'])
  assert.equal((JSON.parse(limited.stdout) as Entry[]).length, 2)
  assert.deepEqual(await list(['--since', '2099-01-01']), [])
  const bad = await qqq(['history', '--since', 'soonish'])
  assert.equal(bad.code, 2)
  const badKind = await qqq(['history', '--kind', 'nope'])
  assert.equal(badKind.code, 2)
  const full = await qqq(['history', '-O', 'table', '--commands', '--absolute', '--limit', '0'])
  assert.match(full.stdout, /Command/)
  assert.ok(full.stdout.includes(`qqq --server ${server.url} table get person 1 -O json`), 'the command is not cut')
  assert.match(full.stdout, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
  const all = await qqq(['history', '--all-profiles', '--format', 'json', '--limit', '0'])
  assert.ok((JSON.parse(all.stdout) as Entry[]).every((e) => typeof e.profile === 'string'))
})

test('rerun runs a line again, refuses redacted secrets, and asks for commands that change data', async () => {
  const entries = await list()
  const get = entries.find((e) => e.summary.startsWith('qqq table get person 1'))!
  const again = await qqq(['history', 'rerun', String(get.n)])
  assert.equal(again.code, 0, again.stderr)
  assert.match(again.stderr, /table get person 1/)
  assert.match(again.stdout, /"firstName"/)
  // recorded as the command it ran, as a shell does
  const latest = (await list()).at(-1)!
  assert.equal(latest.summary, 'qqq table get person 1 -O json')
  const secret = entries.find((e) => e.summary.includes('***'))!
  const refused = await qqq(['history', 'rerun', String(secret.n)])
  assert.equal(refused.code, 2)
  assert.match(refused.stderr, /secret that was not logged/)
  const missing = await qqq(['history', 'rerun', '999'])
  assert.equal(missing.code, 2)
  // a delete: refused without a terminal unless --yes
  await qqq(['table', 'delete', 'pet', '7', '--yes', '-O', 'json'])
  const del = (await list()).at(-1)!
  assert.equal(del.kind, 'record')
  const noTty = await qqq(['history', 'rerun', String(del.n)])
  assert.equal(noTty.code, 2)
  assert.match(noTty.stderr, /changes data\. Pass --yes/)
})

test('clear asks, then empties the profile\'s history (and is not recorded itself)', async () => {
  const refused = await qqq(['history', 'clear'])
  assert.equal(refused.code, 2)
  assert.match(refused.stderr, /Clear \d+ history entries of profile .*Pass --yes/)
  const cleared = await qqq(['history', 'clear', '--yes'])
  assert.equal(cleared.code, 0, cleared.stderr)
  assert.match(cleared.stderr, /cleared \d+ entries/)
  assert.deepEqual(await list(), [])
  const off = await qqq(['apps', '-O', 'json'], { QQQ_HISTORY: 'off' })
  assert.equal(off.code, 0)
  // only the listing above is recorded; QQQ_HISTORY=off left out the apps run
  assert.deepEqual((await list()).map((e) => e.summary), ['qqq history --format json --limit 0'])
})
