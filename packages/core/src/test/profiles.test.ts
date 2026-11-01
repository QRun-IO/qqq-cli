/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FileStore, SecretFileError, defaultSecretStore } from '../session/keyring.js'
import { readFilePreferences, writeFilePreferences } from '../files/navigator.js'
import { probeServer } from '../session/probe.js'
import { ConfigFileError, DEFAULT_CHILD_ROWS, defaultShortName, descriptionOf, editProfile, profileNameForServer, readChildRows, readConfig, readTheme, removeProfile, resolveProfile, setDefaultProfile, shortNameOf, shortNameProblem, touchProfile, upsertProfile, writeTheme } from '../session/profiles.js'

test('profiles resolve from --profile, QQQ_PROFILE, --server, then the default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-cfg-'))
  const env = { QQQ_CONFIG_DIR: dir }
  try {
    assert.throws(() => resolveProfile({}, env), /No server/)
    upsertProfile('sample', { server: 'http://localhost:8077' }, {}, env)
    assert.deepEqual(resolveProfile({}, env), { name: 'sample', server: 'http://localhost:8077', source: 'default' })
    upsertProfile('prod', { server: 'https://app.example.com' }, {}, env)
    assert.equal(resolveProfile({}, env).name, 'sample')
    assert.equal(resolveProfile({ profile: 'prod' }, env).server, 'https://app.example.com')
    assert.equal(resolveProfile({}, { ...env, QQQ_PROFILE: 'prod' }).source, 'env')
    assert.deepEqual(resolveProfile({ server: 'https://app.example.com/x' }, env), { name: 'prod', server: 'https://app.example.com', source: 'server' })
    assert.equal(resolveProfile({ server: 'https://other.example.com:8443/' }, env).name, 'other.example.com-8443')
    assert.throws(() => resolveProfile({ profile: 'nope' }, env), /No profile "nope"/)
    assert.deepEqual(resolveProfile({ profile: 'new', server: 'https://n.example.com/' }, env), { name: 'new', server: 'https://n.example.com', source: 'option' })
    // an existing profile given another server says where it points now (login asks before moving it)
    assert.deepEqual(resolveProfile({ server: 'https://moved.example.com' }, { ...env, QQQ_PROFILE: 'prod' }), { name: 'prod', server: 'https://moved.example.com', source: 'env', movedFrom: 'https://app.example.com' })
    assert.equal(resolveProfile({ profile: 'prod', server: 'https://app.example.com/x' }, env).movedFrom, undefined)
    upsertProfile('prod', { server: 'https://app.example.com' }, { makeDefault: true }, env)
    assert.equal(readConfig(env).defaultProfile, 'prod')
    assert.equal(removeProfile('prod', env), true)
    assert.equal(readConfig(env).defaultProfile, 'sample')
    assert.equal(profileNameForServer('http://localhost:8077'), 'localhost-8077')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the file secret store round-trips and QQQ_KEYRING=file forces it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-sec-'))
  try {
    const store = new FileStore(join(dir, 'secrets.json'))
    assert.equal(await store.get('a'), undefined)
    await store.set('a', 's3cret')
    assert.equal(await store.get('a'), 's3cret')
    assert.equal(await store.delete('a'), true)
    assert.equal(await store.delete('a'), false)
    assert.equal(defaultSecretStore({ QQQ_KEYRING: 'file' }).kind, 'file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt config.json is refused, never overwritten with an empty profile list', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-cfg-'))
  const env = { QQQ_CONFIG_DIR: dir }
  try {
    writeFileSync(join(dir, 'config.json'), '{"profiles": {"prod": {"server": "https://prod.example"}}')
    assert.throws(() => readConfig(env), ConfigFileError)
    assert.throws(() => upsertProfile('new', { server: 'http://localhost:1' }, {}, env), ConfigFileError)
    assert.match(readFileSync(join(dir, 'config.json'), 'utf8'), /prod\.example/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the ui section (files, theme) survives profile writes, and unknown sections are kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-cfg-'))
  const env = { QQQ_CONFIG_DIR: dir }
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ profiles: {}, future: { keep: true } }))
    writeFilePreferences({ downloadDir: '/tmp/dl' }, env)
    writeTheme('midnight', {}, env)
    upsertProfile('sample', { server: 'http://localhost:8077' }, {}, env)
    assert.deepEqual(readFilePreferences(env), { downloadDir: '/tmp/dl' })
    assert.equal(readTheme('sample', env), 'midnight')
    writeFilePreferences({ downloadDir: undefined, uploadDir: '/tmp/up' }, env)
    assert.deepEqual(readFilePreferences(env), { uploadDir: '/tmp/up' })
    assert.equal(readConfig(env).defaultProfile, 'sample')
    assert.deepEqual(readConfig(env).future, { keep: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt secrets file is refused, so one sign-in never wipes the others', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-sec-'))
  try {
    const file = join(dir, 'secrets.json')
    writeFileSync(file, '{"a@x": "one", ')
    const store = new FileStore(file)
    await assert.rejects(store.set('b@y', 'two'), SecretFileError)
    assert.equal(readFileSync(file, 'utf8'), '{"a@x": "one", ')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('record child-list rows: the profile, else the global ui setting, else 5; bad values fall back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-cfg-'))
  const env = { QQQ_CONFIG_DIR: dir }
  try {
    upsertProfile('sample', { server: 'http://localhost:8077' }, {}, env)
    assert.equal(readChildRows('sample', env), DEFAULT_CHILD_ROWS)
    const config = readConfig(env)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...config, ui: { childRows: 8 } }))
    assert.equal(readChildRows('sample', env), 8)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...config, ui: { childRows: 8 }, profiles: { sample: { ...config.profiles.sample, ui: { childRows: 3 } } } }))
    assert.equal(readChildRows('sample', env), 3)
    assert.equal(readChildRows(undefined, env), 8)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ ...config, ui: { childRows: 0 } }))
    assert.equal(readChildRows(undefined, env), DEFAULT_CHILD_ROWS)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a 1.0.0-rc.1 config.json loads and keeps every field; short name, description, edit, rename, default and touch are additive', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-cfg-'))
  const env = { QQQ_CONFIG_DIR: dir }
  try {
    // as 1.0.0-rc.1 wrote it: server, note, createdAt, per-profile ui, plus global ui sections
    const rc1 = { defaultProfile: 'sample', profiles: { sample: { server: 'http://localhost:8077', createdAt: '2026-10-31T22:24:56.276Z' }, enterprise: { server: 'http://localhost:8078', note: 'big', createdAt: '2026-11-01T10:53:34.789Z', ui: { theme: 'light' } } }, ui: { theme: 'dark', recents: { x: [] } }, futureSection: { kept: true } }
    writeFileSync(join(dir, 'config.json'), JSON.stringify(rc1))
    const loaded = readConfig(env)
    assert.deepEqual(loaded.profiles, rc1.profiles)
    assert.equal(resolveProfile({ profile: 'enterprise' }, env).server, 'http://localhost:8078')
    assert.equal(shortNameOf('sample', loaded.profiles.sample), 'sample')
    assert.equal(shortNameOf('enterprise', loaded.profiles.enterprise), 'ent')
    assert.equal(descriptionOf(loaded.profiles.enterprise), 'big')
    assert.equal(defaultShortName('acme-prod-eu'), 'ape')
    assert.equal(defaultShortName('prod'), 'prod')
    assert.equal(shortNameProblem('x'), 'a short name has 2 to 6 characters')
    assert.equal(shortNameProblem('a b'), 'a short name is letters, digits, dots, dashes and underscores')
    assert.equal(shortNameProblem('ent'), undefined)
    editProfile('enterprise', { short: 'ENT', description: 'Enterprise demo', authMode: 'device' }, {}, env)
    touchProfile('enterprise', { user: 'Admin' }, env)
    let c = readConfig(env)
    assert.equal(c.profiles.enterprise!.short, 'ENT')
    assert.equal(descriptionOf(c.profiles.enterprise), 'Enterprise demo')
    assert.equal(c.profiles.enterprise!.note, 'big')
    assert.equal(c.profiles.enterprise!.user, 'Admin')
    assert.ok(c.profiles.enterprise!.lastUsedAt)
    assert.deepEqual(c.profiles.enterprise!.ui, { theme: 'light' })
    assert.deepEqual(c.futureSection, { kept: true })
    assert.equal(c.defaultProfile, 'sample')
    // rename keeps the place in the file and moves the default along
    setDefaultProfile('enterprise', env)
    editProfile('enterprise', {}, { rename: 'ent2', clear: ['short'] }, env)
    c = readConfig(env)
    assert.deepEqual(Object.keys(c.profiles), ['sample', 'ent2'])
    assert.equal(c.defaultProfile, 'ent2')
    assert.equal(c.profiles.ent2!.short, undefined)
    assert.throws(() => editProfile('ent2', {}, { rename: 'sample' }, env), /exists already/)
    assert.throws(() => editProfile('nope', {}, {}, env), /No profile/)
    assert.throws(() => setDefaultProfile('nope', env), /No profile/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeServer: version and authentication type, HTTP errors, not a QQQ server, a timeout', async () => {
  const answer = (routes: Record<string, unknown>) => (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    const body = routes[path]
    if (body === undefined) return new Response('nope', { status: 404 })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  const ok = await probeServer('http://a.test/', { fetch: answer({ '/qqq/v1/version': { apiVersion: '1.9.0' }, '/qqq/v1/metaData/authentication': { type: 'MOCK' } }) })
  assert.equal(ok.reachable, true)
  assert.equal(ok.apiVersion, '1.9.0')
  assert.equal(ok.authType, 'MOCK')
  const noAuth = await probeServer('http://a.test', { fetch: answer({ '/qqq/v1/version': { apiVersion: '1.8.0' } }) })
  assert.deepEqual([noAuth.reachable, noAuth.authType], [true, undefined])
  assert.match((await probeServer('http://a.test', { fetch: answer({}) })).error!, /HTTP 404/)
  assert.match((await probeServer('http://a.test', { fetch: answer({ '/qqq/v1/version': { hello: 1 } }) })).error!, /not a QQQ UI API server/)
  const hang = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))) as typeof fetch
  const slow = await probeServer('http://a.test', { fetch: hang, timeoutMs: 50 })
  assert.equal(slow.reachable, false)
  assert.match(slow.error!, /no answer in 0\.1 s/)
})
