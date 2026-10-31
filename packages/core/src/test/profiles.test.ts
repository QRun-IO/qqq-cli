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
import { ConfigFileError, profileNameForServer, readConfig, readUiSettings, removeProfile, resolveProfile, upsertProfile, writeUiSettings } from '../session/profiles.js'

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

test('the ui section keeps local settings and survives profile writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-cfg-'))
  const env = { QQQ_CONFIG_DIR: dir }
  try {
    assert.deepEqual(readUiSettings(env), {})
    writeUiSettings({ defaultDownloadDir: '/tmp/dl' }, env)
    upsertProfile('sample', { server: 'http://localhost:8077' }, {}, env)
    assert.deepEqual(readUiSettings(env), { defaultDownloadDir: '/tmp/dl' })
    writeUiSettings({ defaultDownloadDir: undefined, defaultUploadDir: '/tmp/up' }, env)
    assert.deepEqual(readUiSettings(env), { defaultUploadDir: '/tmp/up' })
    assert.equal(readConfig(env).defaultProfile, 'sample')
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
