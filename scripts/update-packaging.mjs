#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Fills the version and sha256 values of the packaging drafts (docs/packaging/qqq.rb for Homebrew,
 * docs/packaging/qqq.json for Scoop) from packages/cli/package.json and a release's SHA256SUMS.
 * Run it on the binaries that were uploaded to the GitHub release, not on a local rebuild: the
 * commit is stamped into each binary, so every build has different checksums.
 *
 * Usage: node scripts/update-packaging.mjs [dist/SHA256SUMS]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const sumsPath = resolve(process.argv[2] ?? join(root, 'dist/SHA256SUMS'))
const version = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version
const sums = new Map(readFileSync(sumsPath, 'utf8').trim().split('\n').map((line) => line.split(/\s+/).reverse()))

function sum(file) {
  const hash = sums.get(file)
  if (!hash) {
    console.error(`update-packaging: ${sumsPath} has no ${file}`)
    process.exit(1)
  }
  return hash
}

const formulaPath = join(root, 'docs/packaging/qqq.rb')
let formula = readFileSync(formulaPath, 'utf8').replace(/^(\s*version ")[^"]+"/m, `$1${version}"`)
formula = formula.replace(/(url "[^"]*\/(qqq-[a-z0-9-]+)"\n\s*sha256 ")[0-9a-f]{64}"/g, (_, head, file) => `${head}${sum(file)}"`)
writeFileSync(formulaPath, formula)

const manifestPath = join(root, 'docs/packaging/qqq.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.version = version
manifest.architecture['64bit'].url = `https://github.com/QRun-IO/qqq-cli/releases/download/cli-v${version}/qqq-windows-x64.exe`
manifest.architecture['64bit'].hash = sum('qqq-windows-x64.exe')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 4) + '\n')

console.log(`docs/packaging/qqq.rb and qqq.json now name ${version} with the sums from ${sumsPath}`)
