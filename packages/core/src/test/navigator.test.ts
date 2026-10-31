/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { completePath, createFolder, expandPath, formatSize, listDirectory, readFilePreferences, startDirForSave, writeFilePreferences } from '../files/navigator.js'

test('listings put directories first and hide dot files unless asked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-nav-'))
  try {
    mkdirSync(join(dir, 'zeta'))
    writeFileSync(join(dir, 'Alpha.csv'), 'a,b\n')
    writeFileSync(join(dir, '.secret'), 'x')
    mkdirSync(join(dir, 'beta'))
    assert.deepEqual(listDirectory(dir).map((e) => e.name), ['beta', 'zeta', 'Alpha.csv'])
    assert.ok(listDirectory(dir, { hidden: true }).some((e) => e.name === '.secret'))
    assert.equal(listDirectory(dir).find((e) => e.name === 'Alpha.csv')!.size, 4)
    assert.deepEqual(completePath('be', { cwd: dir }), { text: 'beta/', candidates: ['beta/'] })
    writeFileSync(join(dir, 'beta', 'report-1.xlsx'), '')
    writeFileSync(join(dir, 'beta', 'report-2.xlsx'), '')
    assert.deepEqual(completePath('beta/re', { cwd: dir }), { text: 'beta/report-', candidates: ['report-1.xlsx', 'report-2.xlsx'] })
    assert.deepEqual(completePath('nothing', { cwd: dir }).candidates, [])
    assert.equal(createFolder(dir, 'new'), join(dir, 'new'))
    assert.throws(() => createFolder(dir, 'a/b'), /slash/)
    assert.equal(expandPath('~'), homedir())
    assert.equal(expandPath('x', dir), join(dir, 'x'))
    assert.deepEqual([formatSize(512), formatSize(1536), formatSize(5 * 1024 * 1024)], ['512 B', '1.5 KB', '5.0 MB'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('file preferences persist in the config file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-fp-'))
  const env = { QQQ_CONFIG_DIR: dir }
  try {
    writeFilePreferences({ downloadDir: dir, downloadMode: 'silent' }, env)
    assert.deepEqual(readFilePreferences(env), { downloadDir: dir, downloadMode: 'silent' })
    writeFilePreferences({ downloadMode: undefined }, env)
    assert.deepEqual(readFilePreferences(env), { downloadDir: dir })
    assert.equal(startDirForSave({ downloadDir: dir }), dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
