/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** Tests for scripts/update-packaging.mjs. Run: node --test scripts/update-packaging.test.mjs */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { parseSums, updatePackaging } from './update-packaging.mjs'

const ZERO = '0'.repeat(64)
const h = (c) => c.repeat(64)
const FILES = ['qqq-darwin-arm64', 'qqq-darwin-x64', 'qqq-linux-arm64', 'qqq-linux-x64']
const sumsText = (omit = []) =>
  [...FILES, 'qqq-linux-x64-musl', 'qqq-windows-x64.exe'].filter((f) => !omit.includes(f)).map((f, i) => `${'abcdef0123456'[i].repeat(64)}  ${f}`).join('\n') + '\n'
const formula = `class Qqq < Formula
  version "0.0.0"
${FILES.map((f) => `  url "https://github.com/QRun-IO/qqq-cli/releases/download/cli-v#{version}/${f}"\n  sha256 "${ZERO}"`).join('\n')}
end
`
const manifest = JSON.stringify({ version: '0.0.0', architecture: { '64bit': { url: 'x', hash: ZERO } } }, null, 4) + '\n'

test('fills every sum from shasum output and never leaves zeros', () => {
  const out = updatePackaging({ version: '1.0.0', sums: parseSums(sumsText()), formula, manifest })
  assert.equal(out.formulaCount, 4)
  assert.ok(!out.formula.includes(ZERO) && !out.manifest.includes(ZERO))
  assert.match(out.formula, /version "1\.0\.0"/)
  assert.ok(out.formula.includes(`qqq-darwin-arm64"\n  sha256 "${h('a')}"`))
  assert.equal(JSON.parse(out.manifest).architecture['64bit'].hash, h('f'))
})

test('a missing target throws', () => {
  assert.throws(() => updatePackaging({ version: '1.0.0', sums: parseSums(sumsText(['qqq-linux-x64'])), formula, manifest }), /no qqq-linux-x64/)
  assert.throws(() => updatePackaging({ version: '1.0.0', sums: parseSums(sumsText(['qqq-windows-x64.exe'])), formula, manifest }), /no qqq-windows-x64\.exe/)
})

test('malformed, short, uppercase-free or zero sums throw', () => {
  for (const bad of ['abc', ZERO, 'g'.repeat(64)]) {
    const sums = parseSums(sumsText().replace(h('a'), bad))
    assert.throws(() => updatePackaging({ version: '1.0.0', sums, formula, manifest }), /malformed|all-zero/)
  }
  assert.throws(() => parseSums('only-one-column\n'), /unparseable/)
})

test('a formula with nothing to fill throws', () => {
  assert.throws(() => updatePackaging({ version: '1.0.0', sums: parseSums(sumsText()), formula: 'class Qqq < Formula\nend\n', manifest }), /no url\/sha256/)
})

test('the CLI exits 1 and writes nothing when a sum is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'update-packaging-'))
  mkdirSync(join(dir, 'scripts'))
  cpSync(join(import.meta.dirname, 'update-packaging.mjs'), join(dir, 'scripts/update-packaging.mjs'))
  mkdirSync(join(dir, 'packages/cli'), { recursive: true })
  writeFileSync(join(dir, 'packages/cli/package.json'), '{"version":"1.0.0"}')
  mkdirSync(join(dir, 'docs/packaging/homebrew-tap/Formula'), { recursive: true })
  writeFileSync(join(dir, 'docs/packaging/homebrew-tap/Formula/qqq.rb'), formula)
  writeFileSync(join(dir, 'docs/packaging/qqq.json'), manifest)
  writeFileSync(join(dir, 'SHA256SUMS'), sumsText(['qqq-linux-arm64']))
  const run = spawnSync(process.execPath, [join(dir, 'scripts/update-packaging.mjs'), join(dir, 'SHA256SUMS')], { encoding: 'utf8' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /nothing was written/)
  assert.equal(readFileSync(join(dir, 'docs/packaging/homebrew-tap/Formula/qqq.rb'), 'utf8'), formula)
  assert.equal(readFileSync(join(dir, 'docs/packaging/qqq.json'), 'utf8'), manifest)
  writeFileSync(join(dir, 'SHA256SUMS'), sumsText())
  const ok = spawnSync(process.execPath, [join(dir, 'scripts/update-packaging.mjs'), join(dir, 'SHA256SUMS')], { encoding: 'utf8' })
  assert.equal(ok.status, 0, ok.stderr)
  assert.ok(!readFileSync(join(dir, 'docs/packaging/qqq.json'), 'utf8').includes(ZERO))
})
