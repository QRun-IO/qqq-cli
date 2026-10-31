/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { UnsafeFileNameError, safeFileName, saveDownload } from '../render/files.js'

test('server file names keep only their final component', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd')
  assert.equal(safeFileName('C:\\x\\y.txt'), 'y.txt')
  assert.equal(safeFileName('/abs/path/report q3.pdf'), 'report q3.pdf')
  assert.equal(safeFileName('plain.csv'), 'plain.csv')
})

test('empty, dot, dot-dot and control-character names are refused', () => {
  for (const bad of ['', '   ', '.', '..', 'a/..', 'dir/', 'evil\u0007.txt', 'line\nbreak', null, undefined]) {
    assert.throws(() => safeFileName(bad), UnsafeFileNameError, String(bad))
  }
})

test('a default name never overwrites; a named path may', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-files-'))
  try {
    const path = join(dir, 'a.txt')
    writeFileSync(path, 'old')
    assert.throws(() => saveDownload(path, new TextEncoder().encode('new'), { explicit: false }), /already exists/)
    assert.equal(readFileSync(path, 'utf8'), 'old')
    saveDownload(path, new TextEncoder().encode('new'), { explicit: true })
    assert.equal(readFileSync(path, 'utf8'), 'new')
    saveDownload(join(dir, 'b.txt'), new TextEncoder().encode('b'), { explicit: false })
    assert.equal(readFileSync(join(dir, 'b.txt'), 'utf8'), 'b')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
