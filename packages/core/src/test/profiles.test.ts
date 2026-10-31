/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FileStore, defaultSecretStore } from '../session/keyring.js'
import { profileNameForServer, readConfig, removeProfile, resolveProfile, upsertProfile } from '../session/profiles.js'

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
