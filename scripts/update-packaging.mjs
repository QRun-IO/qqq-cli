#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Fills the version and sha256 values of the packaging files (docs/packaging/homebrew-tap/Formula/qqq.rb for Homebrew,
 * docs/packaging/qqq.json for Scoop) from packages/cli/package.json and a release's SHA256SUMS.
 * The release workflow (.gitea/workflows/release.yaml) runs it on the SHA256SUMS of the binaries uploaded to
 * the Gitea release, never on a local rebuild: the commit is stamped into each binary, so every build has
 * different checksums.
 *
 * Refuses to write anything (exit 1, both files untouched) when a sum is missing, is not 64 lowercase hex digits,
 * is all zeros, or when a placeholder in the files is left unfilled.
 *
 * Usage: node scripts/update-packaging.mjs [dist/SHA256SUMS]
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HEX64 = /^[0-9a-f]{64}$/
/** Release downloads on Gitea: <RELEASES>/v<version>/<file> (the release tag is v<CLI version>). */
export const RELEASES = 'https://git.kof22.com/QRun-IO/qqq-cli/releases/download'
const root = resolve(import.meta.dirname, '..')
const FORMULA_SUMS = /(url "[^"]*\/(qqq-[a-z0-9-]+)"\n\s*sha256 ")([0-9a-f]{64})"/g

/** Parses `shasum -a 256` output (`<hash>  <file>`, `*` before the name tolerated) into a Map of file to hash. */
export function parseSums(text) {
  const sums = new Map()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const match = line.match(/^(\S+)\s+\*?(\S+)$/)
    if (!match) throw new Error(`unparseable SHA256SUMS line: ${JSON.stringify(line)}`)
    sums.set(match[2], match[1].toLowerCase())
  }
  return sums
}

function sumFor(sums, file) {
  const hash = sums.get(file)
  if (hash === undefined) throw new Error(`SHA256SUMS has no ${file}`)
  if (!HEX64.test(hash)) throw new Error(`SHA256SUMS has a malformed sum for ${file}: ${JSON.stringify(hash)}`)
  if (/^0+$/.test(hash)) throw new Error(`SHA256SUMS has an all-zero sum for ${file}`)
  return hash
}

/** Returns the new text of both packaging files; throws, leaving the caller nothing to write, on any problem. */
export function updatePackaging({ version, sums, formula, manifest }) {
  let formulaCount = 0
  const newFormula = formula
    .replace(/^(\s*version ")[^"]+"/m, `$1${version}"`)
    .replace(FORMULA_SUMS, (_, head, file) => {
      formulaCount++
      return `${head}${sumFor(sums, file)}"`
    })
  if (formulaCount === 0) throw new Error('the formula has no url/sha256 pairs to fill')
  const left = newFormula.match(/sha256 "(?![0-9a-f]{64}")[^"]*"/g)
  if (left || /sha256 "0{64}"/.test(newFormula)) throw new Error(`the formula still has unfilled sha256 values: ${left ?? 'zeros'}`)

  const parsed = JSON.parse(manifest)
  parsed.version = version
  parsed.architecture['64bit'].url = `${RELEASES}/v${version}/qqq-windows-x64.exe`
  parsed.architecture['64bit'].hash = sumFor(sums, 'qqq-windows-x64.exe')
  return { formula: newFormula, manifest: JSON.stringify(parsed, null, 4) + '\n', formulaCount }
}

function main() {
  const sumsPath = resolve(process.argv[2] ?? join(root, 'dist/SHA256SUMS'))
  const version = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version
  const formulaPath = join(root, 'docs/packaging/homebrew-tap/Formula/qqq.rb')
  const manifestPath = join(root, 'docs/packaging/qqq.json')
  try {
    const out = updatePackaging({
      version,
      sums: parseSums(readFileSync(sumsPath, 'utf8')),
      formula: readFileSync(formulaPath, 'utf8'),
      manifest: readFileSync(manifestPath, 'utf8'),
    })
    writeFileSync(formulaPath, out.formula)
    writeFileSync(manifestPath, out.manifest)
    console.log(`docs/packaging/homebrew-tap/Formula/qqq.rb (${out.formulaCount} sums) and docs/packaging/qqq.json now name ${version} with the sums from ${sumsPath}`)
  } catch (error) {
    console.error(`update-packaging: ${error.message}; nothing was written`)
    process.exit(1)
  }
}

// Run only as a script, not when the tests import it (realpath: argv[1] may go through a symlink such as macOS /var).
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(import.meta.filename)) main()
