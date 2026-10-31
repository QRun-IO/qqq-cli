#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Builds single-file executables of the qqq CLI with `bun build --compile`: one per target, written
 * to dist/qqq-<os>-<arch>[.exe] with a SHA256SUMS file beside them.
 *
 * The bundle is packages/cli/src/main.ts with the workspace packages (@qrun-io/qqq-ui-api-client and
 * @qrun-io/qqq-core, from their built dist) and every npm dependency inlined. The operations index
 * generated from the OpenAPI document (packages/core/src/api/operations.ts) is compiled in; this
 * script first checks that it lists exactly the operations of packages/ui-api-client/openapi/qqq-v1.json,
 * so a binary can never ship a stale index. The CLI version comes from packages/cli/package.json
 * (it must equal packages/cli/src/version.ts) and the git commit is stamped into `qqq --version`
 * through QQQ_BUILD_SHA and QQQ_BUILD_TARGET.
 *
 * x64 targets use Bun's baseline (pre-AVX2) runtime so the binaries also run on older CPUs and
 * under Rosetta 2 or QEMU emulation.
 *
 * Usage: node scripts/build-binaries.mjs [--targets darwin-arm64,linux-x64,...] [--host] [--musl]
 *                                       [--no-build] [--out dist]
 *   --targets   comma-separated subset of the default targets (and the musl ones)
 *   --host      only the target of this machine
 *   --musl      also build linux-x64-musl and linux-arm64-musl (best effort)
 *   --no-build  skip `npm run build` (the workspace packages must already be built)
 * Needs Bun 1.4 or later on the PATH; cross-compiling downloads each target's Bun runtime once.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const TARGETS = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64-baseline',
  'linux-x64': 'bun-linux-x64-baseline',
  'linux-arm64': 'bun-linux-arm64',
  'windows-x64': 'bun-windows-x64-baseline',
}
const MUSL_TARGETS = {
  'linux-x64-musl': 'bun-linux-x64-musl-baseline',
  'linux-arm64-musl': 'bun-linux-arm64-musl',
}

function parseArgs(argv) {
  const args = { targets: undefined, host: false, musl: false, build: true, out: 'dist' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--targets') args.targets = argv[++i].split(',').map((t) => t.trim()).filter(Boolean)
    else if (a === '--host') args.host = true
    else if (a === '--musl') args.musl = true
    else if (a === '--no-build') args.build = false
    else if (a === '--out') args.out = argv[++i]
    else if (a === '-h' || a === '--help') {
      console.log('Usage: node scripts/build-binaries.mjs [--targets a,b] [--host] [--musl] [--no-build] [--out dist]')
      process.exit(0)
    } else fail(`unknown option ${a}`)
  }
  return args
}

function fail(message) {
  console.error(`build-binaries: ${message}`)
  process.exit(1)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', ...options })
  if (result.error) fail(`${command}: ${result.error.message}`)
  if (result.status !== 0) fail(`${command} ${args.join(' ')} exited ${result.status}`)
}

function hostTarget() {
  const os = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
  const arch = { arm64: 'arm64', x64: 'x64' }[process.arch]
  if (!os || !arch) fail(`no target for this host (${process.platform}-${process.arch})`)
  return `${os}-${arch}`
}

/** The CLI version from package.json, checked against the constant compiled into the CLI. */
function cliVersion() {
  const version = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')).version
  const source = readFileSync(join(root, 'packages/cli/src/version.ts'), 'utf8')
  const constant = source.match(/export const CLI_VERSION = '([^']+)'/)?.[1]
  if (constant !== version) fail(`packages/cli/src/version.ts says ${constant}, packages/cli/package.json says ${version}`)
  return version
}

/** The commit being built, with -dirty when the tree has changes. */
function gitSha() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim()
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}

/** Fails unless the compiled-in operations index lists exactly the document's operations. */
function checkOperationsIndex() {
  const spec = JSON.parse(readFileSync(join(root, 'packages/ui-api-client/openapi/qqq-v1.json'), 'utf8'))
  const fromSpec = new Set()
  for (const item of Object.values(spec.paths ?? {})) {
    for (const op of Object.values(item)) if (op && typeof op === 'object' && op.operationId) fromSpec.add(op.operationId)
  }
  const index = readFileSync(join(root, 'packages/core/src/api/operations.ts'), 'utf8')
  const fromIndex = new Set([...index.matchAll(/\{"id":"([^"]+)"/g)].map((m) => m[1]))
  const missing = [...fromSpec].filter((id) => !fromIndex.has(id))
  const extra = [...fromIndex].filter((id) => !fromSpec.has(id))
  if (missing.length || extra.length) {
    fail(`operations index is stale (run npm run generate): missing ${missing.join(', ') || 'none'}; extra ${extra.join(', ') || 'none'}`)
  }
  return { operations: fromSpec.size, apiVersion: spec.info?.version }
}

function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const args = parseArgs(process.argv.slice(2))
const all = { ...TARGETS, ...MUSL_TARGETS }
let names = args.host ? [hostTarget()] : args.targets ?? Object.keys(TARGETS)
if (args.musl && !args.targets) names = [...names, ...Object.keys(MUSL_TARGETS)]
for (const name of names) if (!all[name]) fail(`unknown target ${name} (known: ${Object.keys(all).join(', ')})`)

const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' })
if (bun.status !== 0) fail('bun is not on the PATH (https://bun.sh); it is only needed to build binaries')
const version = cliVersion()
const sha = gitSha()
const spec = checkOperationsIndex()
console.log(`qqq ${version} (${sha}), bun ${bun.stdout.trim()}, UI API document ${spec.apiVersion} with ${spec.operations} operations`)

if (args.build) run('npm', ['run', 'build', '--silent'], { shell: process.platform === 'win32' })
for (const entry of ['packages/ui-api-client/dist/index.js', 'packages/core/dist/index.js']) {
  if (!existsSync(join(root, entry))) fail(`${entry} is missing; run npm run build`)
}

const outDir = resolve(root, args.out)
mkdirSync(outDir, { recursive: true })
const built = []
for (const name of names) {
  const file = `qqq-${name}${name.startsWith('windows') ? '.exe' : ''}`
  const outfile = join(outDir, file)
  const started = Date.now()
  run('bun', [
    'build', 'packages/cli/src/main.ts',
    '--compile', `--target=${all[name]}`, `--outfile=${outfile}`,
    '--minify-syntax', '--minify-whitespace', '--sourcemap',
    `--define=QQQ_BUILD_SHA=${JSON.stringify(sha)}`,
    `--define=QQQ_BUILD_TARGET=${JSON.stringify(name)}`,
  ], { stdio: ['ignore', 'ignore', 'inherit'] })
  const bytes = readFileSync(outfile)
  built.push({ file, size: statSync(outfile).size, sha256: createHash('sha256').update(bytes).digest('hex'), seconds: (Date.now() - started) / 1000 })
}

// keep the sums of binaries built by an earlier run that this run did not rebuild
const sums = new Map()
const sumsFile = join(outDir, 'SHA256SUMS')
if (existsSync(sumsFile)) {
  for (const line of readFileSync(sumsFile, 'utf8').split('\n')) {
    const [hash, file] = line.split(/\s+/)
    if (hash && file && existsSync(join(outDir, file))) sums.set(file, hash)
  }
}
for (const b of built) sums.set(b.file, b.sha256)
writeFileSync(sumsFile, [...sums].sort(([a], [b]) => a.localeCompare(b)).map(([file, hash]) => `${hash}  ${file}`).join('\n') + '\n')
console.log('')
for (const b of built) console.log(`${b.file.padEnd(26)} ${megabytes(b.size).padStart(9)}  ${b.seconds.toFixed(1)}s  sha256 ${b.sha256.slice(0, 16)}`)
console.log(`${args.out}/SHA256SUMS`)

const host = `qqq-${hostTarget()}${process.platform === 'win32' ? '.exe' : ''}`
if (built.some((b) => b.file === host)) {
  const smoke = spawnSync(join(outDir, host), ['--version'], { encoding: 'utf8' })
  if (smoke.status !== 0 || !smoke.stdout.includes(`qqq ${version}`)) fail(`${host} --version failed: ${smoke.stderr || smoke.stdout}`)
  console.log(`\n${host} --version:\n${smoke.stdout.trim()}`)
}
