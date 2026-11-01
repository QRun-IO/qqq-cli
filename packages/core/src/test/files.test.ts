/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { UnsafeFileNameError, alternativeNames, exportFileName, fileStamp, safeFileName, saveDownload, stampFileName } from '../render/files.js'

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

const NOW = new Date(2026, 10, 1, 10, 23, 16)
const NOW_STAMP = '_2026-11-01_102316'

test('exportFileName stamps the local date and time before the extension', () => {
  assert.equal(exportFileName('person', 'csv', NOW), `person${NOW_STAMP}.csv`)
  assert.equal(exportFileName('person', '.xlsx', NOW), `person${NOW_STAMP}.xlsx`)
  assert.equal(exportFileName('person', '', NOW), `person${NOW_STAMP}`)
  // 24-hour clock, zero padded, no colons
  assert.equal(fileStamp(new Date(2026, 0, 5, 7, 4, 9)), '_2026-01-05_070409')
  assert.equal(fileStamp(new Date(2026, 0, 5, 23, 59, 59)), '_2026-01-05_235959')
  assert.doesNotMatch(exportFileName('a', 'csv', NOW), /:/)
})

test('exportFileName uses local time, not UTC', () => {
  const local = new Date(2026, 5, 15, 0, 30, 0)
  assert.equal(fileStamp(local), '_2026-06-15_003000')
})

test('exportFileName sanitises the base like safeFileName and does not stamp twice', () => {
  assert.equal(exportFileName('../../etc/passwd', 'txt', NOW), `passwd${NOW_STAMP}.txt`)
  assert.throws(() => exportFileName('..', 'csv', NOW), UnsafeFileNameError)
  assert.equal(exportFileName('person.csv', 'csv', NOW), `person${NOW_STAMP}.csv`)
  assert.equal(exportFileName(`person${NOW_STAMP}`, 'csv', new Date(2030, 0, 1)), `person${NOW_STAMP}.csv`)
  assert.equal(exportFileName(`person${NOW_STAMP}.csv`, 'csv', new Date(2030, 0, 1)), `person${NOW_STAMP}.csv`)
  assert.equal(exportFileName('report.q3', 'pdf', NOW), `report.q3${NOW_STAMP}.pdf`)
})

test('stampFileName puts the stamp before the last extension and leaves a stamped name alone', () => {
  assert.equal(stampFileName('a.csv', NOW), `a${NOW_STAMP}.csv`)
  assert.equal(stampFileName('noext', NOW), `noext${NOW_STAMP}`)
  assert.equal(stampFileName('.env', NOW), `.env${NOW_STAMP}`)
  assert.equal(stampFileName(`a${NOW_STAMP}.csv`, NOW), `a${NOW_STAMP}.csv`)
})

test('a server-named download keeps its name; when taken the stamp goes before the extension', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-files-'))
  try {
    const path = join(dir, 'a.txt')
    const bytes = (s: string) => new TextEncoder().encode(s)
    assert.equal(saveDownload(path, bytes('old'), { explicit: false, now: NOW }), path)
    assert.equal(saveDownload(path, bytes('new'), { explicit: false, now: NOW }), join(dir, `a${NOW_STAMP}.txt`))
    // the same second again: the next free number after the stamp
    assert.equal(saveDownload(path, bytes('newer'), { explicit: false, now: NOW }), join(dir, `a${NOW_STAMP}-1.txt`))
    assert.equal(readFileSync(path, 'utf8'), 'old')
    assert.equal(readFileSync(join(dir, `a${NOW_STAMP}.txt`), 'utf8'), 'new')
    assert.equal(saveDownload(path, bytes('replaced'), { explicit: true }), path)
    assert.equal(readFileSync(path, 'utf8'), 'replaced')
    assert.equal(saveDownload(join(dir, 'b'), bytes('b'), { explicit: false, now: NOW }), join(dir, 'b'))
    assert.equal(saveDownload(join(dir, 'b'), bytes('b'), { explicit: false, now: NOW }), join(dir, `b${NOW_STAMP}`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('alternative names keep the extension', () => {
  const names = alternativeNames('report.q3.csv', NOW)
  assert.deepEqual([names.next().value, names.next().value, names.next().value], ['report.q3.csv', `report.q3${NOW_STAMP}.csv`, `report.q3${NOW_STAMP}-1.csv`])
})
