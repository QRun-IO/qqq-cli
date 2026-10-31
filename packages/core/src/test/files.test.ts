/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { UnsafeFileNameError, alternativeNames, safeFileName, saveDownload } from '../render/files.js'

test('server file names keep only their final component', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd')
  assert.equal(safeFileName('C:\\x\\y.txt'), 'y.txt')
  assert.equal(safeFileName('..\\..\\Windows\\win.ini'), 'win.ini')
  assert.equal(safeFileName('/abs/path/report q3.pdf'), 'report q3.pdf')
  assert.equal(safeFileName('plain.csv'), 'plain.csv')
})

test('empty, dot, dot-dot and control-character names are refused', () => {
  for (const bad of ['', '   ', '.', '..', 'a/..', 'dir/', 'evil\u0007.txt', 'line\nbreak', null, undefined]) {
    assert.throws(() => safeFileName(bad), UnsafeFileNameError, String(bad))
  }
})

test('a default name never overwrites: the next free name-N.ext is taken; a named path is overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-files-'))
  try {
    const path = join(dir, 'a.txt')
    writeFileSync(path, 'old')
    assert.equal(saveDownload(path, new TextEncoder().encode('new'), { explicit: false }), join(dir, 'a-1.txt'))
    assert.equal(saveDownload(path, new TextEncoder().encode('newer'), { explicit: false }), join(dir, 'a-2.txt'))
    assert.equal(readFileSync(path, 'utf8'), 'old')
    assert.equal(readFileSync(join(dir, 'a-1.txt'), 'utf8'), 'new')
    assert.equal(saveDownload(path, new TextEncoder().encode('replaced'), { explicit: true }), path)
    assert.equal(readFileSync(path, 'utf8'), 'replaced')
    assert.equal(saveDownload(join(dir, 'b'), new TextEncoder().encode('b'), { explicit: false }), join(dir, 'b'))
    assert.equal(saveDownload(join(dir, 'b'), new TextEncoder().encode('b'), { explicit: false }), join(dir, 'b-1'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('alternative names keep the extension', () => {
  const names = alternativeNames('report.q3.csv')
  assert.deepEqual([names.next().value, names.next().value, names.next().value], ['report.q3.csv', 'report.q3-1.csv', 'report.q3-2.csv'])
  const bare = alternativeNames('.env')
  assert.deepEqual([bare.next().value, bare.next().value], ['.env', '.env-1'])
})
