/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { activityFile, activityProfiles, appendActivity, clearActivity, cliKind, filterActivity, isMutatingCommand, isSecretName, joinCommandLine, localIsoTime, parseSince, readActivity, redactArgv, redactCommandLine, relativeTime } from '../session/activity-log.js'

function sandbox(): { env: NodeJS.ProcessEnv; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-activity-'))
  return { env: { QQQ_STATE_DIR: dir }, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

test('events are appended one JSON line each, per profile, with the local offset', () => {
  const box = sandbox()
  try {
    appendActivity({ profile: 'dev', server: 'http://localhost:8078', client: 'cli', kind: 'cli', summary: 'qqq apps', command: 'qqq apps', exit: 0, ms: 12 }, { env: box.env })
    appendActivity({ profile: 'dev', client: 'ui', kind: 'open', summary: 'Opened Person 3', command: 'qqq table get person 3', target: { type: 'record', name: 'person', key: '3' } }, { env: box.env })
    appendActivity({ profile: 'prod', client: 'ui', kind: 'auth', summary: 'Signed in' }, { env: box.env })
    const lines = readFileSync(activityFile('dev', box.env), 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0]!)
    assert.match(first.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/)
    assert.deepEqual({ ...first, at: undefined }, { at: undefined, profile: 'dev', server: 'http://localhost:8078', client: 'cli', kind: 'cli', summary: 'qqq apps', command: 'qqq apps', exit: 0, ms: 12 })
    const dev = readActivity({ profile: 'dev', env: box.env })
    assert.deepEqual(dev.map((e) => [e.n, e.summary]), [[1, 'qqq apps'], [2, 'Opened Person 3']])
    assert.deepEqual(dev[1]!.target, { type: 'record', name: 'person', key: '3' })
    assert.deepEqual(activityProfiles(box.env), ['dev', 'prod'])
    assert.deepEqual(readActivity({ allProfiles: true, env: box.env }).map((e) => e.profile), ['dev', 'dev', 'prod'])
    assert.equal(statSync(activityFile('dev', box.env)).mode & 0o777, 0o600)
  } finally {
    box.dispose()
  }
})

test('the file rotates to .1 once over the limit, and both are read back in order', () => {
  const box = sandbox()
  try {
    // each line is ~140 bytes: the limit of 250 rotates before the 3rd and the 5th line
    for (let i = 1; i <= 6; i++) appendActivity({ profile: 'p', client: 'cli', kind: 'cli', summary: `command ${i} ${'x'.repeat(40)}` }, { env: box.env, maxBytes: 250 })
    const file = activityFile('p', box.env)
    assert.ok(existsSync(`${file}.1`), 'rotated')
    assert.ok(statSync(file).size < 300)
    const all = readActivity({ profile: 'p', env: box.env })
    // 1 and 2 were rotated a second time and are gone; 3 and 4 are in .1, 5 and 6 in the file
    assert.deepEqual(all.map((e) => [e.n, e.summary.slice(0, 9)]), [[1, 'command 3'], [2, 'command 4'], [3, 'command 5'], [4, 'command 6']])
    assert.equal(clearActivity({ profile: 'p', env: box.env }), all.length)
    assert.ok(!existsSync(file) && !existsSync(`${file}.1`))
  } finally {
    box.dispose()
  }
})

test('a torn line is skipped; QQQ_HISTORY=off writes nothing', () => {
  const box = sandbox()
  try {
    appendActivity({ profile: 'p', client: 'cli', kind: 'cli', summary: 'one' }, { env: box.env })
    writeFileSync(activityFile('p', box.env), readFileSync(activityFile('p', box.env), 'utf8') + '{"at":"2026-11-01T1\n', { flag: 'w' })
    appendActivity({ profile: 'p', client: 'cli', kind: 'cli', summary: 'two' }, { env: box.env })
    assert.deepEqual(readActivity({ profile: 'p', env: box.env }).map((e) => e.summary), ['one', 'two'])
    appendActivity({ profile: 'p', client: 'cli', kind: 'cli', summary: 'three' }, { env: { ...box.env, QQQ_HISTORY: 'off' } })
    assert.equal(readActivity({ profile: 'p', env: box.env }).length, 2)
  } finally {
    box.dispose()
  }
})

test('secrets are never written: flags, pairs, headers, bearer tokens, filter criteria', () => {
  assert.ok(isSecretName('--token') && isSecretName('apiKey') && isSecretName('client_secret') && isSecretName('userPassword') && isSecretName('PIN') && isSecretName('X-Api-Key'))
  assert.ok(!isSecretName('shipping') && !isSecretName('--profile') && !isSecretName('lastName') && !isSecretName('keyField') && !isSecretName('opinion'))
  assert.deepEqual(redactArgv(['login', '--token', 'abc', '--password=hunter2', '--pin', '1234', '-p', 'dev']), ['login', '--token', '***', '--password=***', '--pin', '***', '-p', 'dev'])
  assert.deepEqual(redactArgv(['table', 'create', 'user', '--set', 'name=Ada', '--set', 'password=s3cret', '-s', 'apiKey=k']), ['table', 'create', 'user', '--set', 'name=Ada', '--set', 'password=***', '-s', 'apiKey=***'])
  assert.deepEqual(redactArgv(['api', 'GET', '/x', '-H', 'Authorization: Bearer eyJabc', '-H', 'Accept: text/plain']), ['api', 'GET', '/x', '-H', 'Authorization: ***', '-H', 'Accept: text/plain'])
  assert.deepEqual(redactArgv(['Bearer xyz', 'eyJhbGciOi.eyJzdWIi.sig']), ['Bearer ***', '***'])
  assert.deepEqual(redactArgv(['-w', 'password = hunter2', '-g', 'lastName = S AND apiToken EQUALS "x y"']), ['-w', 'password = ***', '-g', 'lastName = S AND apiToken EQUALS ***'])
  // the flag at the end, or followed by another flag, has no value to hide
  assert.deepEqual(redactArgv(['--token', '--json']), ['--token', '--json'])
  assert.equal(joinCommandLine(['table', 'query', 'person', '-w', 'lastName = S', '--token', 't']), 'table query person -w "lastName = S" --token ***')
  assert.equal(redactCommandLine('table query person -w "pin = 4321"'), 'table query person -w "pin = ***"')
  assert.equal(redactCommandLine('theme light'), 'theme light')
  const box = sandbox()
  try {
    appendActivity({ profile: 'p', client: 'ui', kind: 'command', summary: ':api GET /x -H "Authorization: Bearer abc"', command: 'qqq login --token abc' }, { env: box.env })
    const text = readFileSync(activityFile('p', box.env), 'utf8')
    assert.ok(!text.includes('abc'), text)
  } finally {
    box.dispose()
  }
})

test('listing filters: since, grep, kind or client, limit keeps the numbers', () => {
  const now = new Date('2026-11-01T12:00:00Z')
  const at = (minutesAgo: number) => localIsoTime(new Date(now.getTime() - minutesAgo * 60_000))
  const entries = [
    { n: 1, at: at(300), profile: 'p', client: 'cli' as const, kind: 'query' as const, summary: 'qqq table query person' },
    { n: 2, at: at(90), profile: 'p', client: 'ui' as const, kind: 'open' as const, summary: 'Opened Person 3', command: 'qqq table get person 3' },
    { n: 3, at: at(30), profile: 'p', client: 'ui' as const, kind: 'record' as const, summary: 'Deleted Pet 7' },
    { n: 4, at: at(1), profile: 'p', client: 'cli' as const, kind: 'process' as const, summary: 'qqq process run greet' },
  ]
  assert.deepEqual(filterActivity(entries, { since: parseSince('2h', now) }).map((e) => e.n), [2, 3, 4])
  assert.deepEqual(filterActivity(entries, { grep: 'PERSON' }).map((e) => e.n), [1, 2])
  assert.deepEqual(filterActivity(entries, { kind: ['ui'] }).map((e) => e.n), [2, 3])
  assert.deepEqual(filterActivity(entries, { kind: ['query,process'] }).map((e) => e.n), [1, 4])
  assert.deepEqual(filterActivity(entries, { limit: 2 }).map((e) => e.n), [3, 4])
  assert.deepEqual(filterActivity(entries, { limit: 0 }).map((e) => e.n), [1, 2, 3, 4])
  assert.equal(parseSince('2026-11-01').getDate(), 1)
  assert.throws(() => parseSince('yesterday-ish'), /--since/)
  assert.equal(relativeTime(at(0), now), 'now')
  assert.equal(relativeTime(at(30), now), '30m ago')
  assert.equal(relativeTime(at(300), now), '5h ago')
})

test('CLI kinds and which commands change data', () => {
  assert.equal(cliKind(['--server', 'http://x', 'table', 'query', 'person']), 'query')
  assert.equal(cliKind(['table', 'delete', 'person', '3']), 'record')
  assert.equal(cliKind(['-p', 'dev', 'process', 'run', 'greet']), 'process')
  assert.equal(cliKind(['table', 'export', 'person']), 'export')
  assert.equal(cliKind(['print', 'records', 'person']), 'print')
  assert.equal(cliKind(['login']), 'auth')
  assert.equal(cliKind(['apps']), 'cli')
  assert.ok(isMutatingCommand(['table', 'delete', 'person', '3']))
  assert.ok(isMutatingCommand(['process', 'run', 'greet']))
  assert.ok(isMutatingCommand(['api', 'createRecord', '-X', 'POST']))
  assert.ok(!isMutatingCommand(['table', 'query', 'person']))
  assert.ok(!isMutatingCommand(['--profile', 'dev', 'table', 'get', 'person', '3']))
  assert.ok(!isMutatingCommand(['api', 'GET', '/x']))
})
