#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Release check for the CLI packages. Runs everything a release needs and then prints how to tag it.
 * It never tags, pushes or publishes; the release workflow (.gitea/workflows/release.yaml) runs it as
 * its gate on the tag and then publishes.
 *
 *   1. the working tree is clean (no staged, unstaged or untracked changes) and the tag v<CLI version>
 *      is free, or already points at this commit (the release workflow runs on the tag)
 *   2. npm ci, then the CI steps: npm run generate with no drift in
 *      packages/ui-api-client/src/schema.ts or packages/core/src/api/operations.ts, build, test;
 *      plus npm run lint (versions, headers) and the TUI's Bun tests and type check (npm run test:tui,
 *      typecheck:tui; the TUI ships inside the binaries)
 *   3. npm pack --dry-run for each published package
 *   4. the single-file binaries with the terminal UI (scripts/build-binaries.mjs; --cli-only leaves it
 *      out) and dist/SHA256SUMS
 *   5. prints how to tag the release
 *
 * A final (non-prerelease) version also has to pass the readiness gate (scripts/readiness.mjs: parity
 * 100% in both columns, every server finding filed, a CHANGELOG entry, documented commands exist);
 * a prerelease prints the same report as information.
 *
 * Usage: node scripts/release.mjs [--allow-dirty] [--skip-binaries] [--skip-install] [--cli-only]
 *        node scripts/release.mjs --check     only the readiness report (builds first if needed)
 *   --cli-only  build the binaries without the terminal UI (the release artifact bundles it)
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { printReport, readiness } from './readiness.mjs'

const root = resolve(import.meta.dirname, '..')
const argv = new Set(process.argv.slice(2))
for (const a of argv) if (!['--allow-dirty', '--skip-binaries', '--skip-install', '--cli-only', '--check'].includes(a)) fail(`unknown option ${a}`)
const shell = process.platform === 'win32'

/** Published packages, in publish order (each depends only on the ones before it). */
const PUBLISHED = ['packages/ui-api-client', 'packages/core', 'packages/conformance', 'packages/cli']

function fail(message) {
  console.error(`\nrelease: ${message}`)
  process.exit(1)
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
}

function step(title, command, args) {
  console.log(`\n== ${title}: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell })
  if (result.status !== 0) fail(`${title} failed (exit ${result.status})`)
}

const pkg = (dir) => JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'))
const versions = Object.fromEntries(PUBLISHED.map((dir) => [dir, pkg(dir)]))
const cli = versions['packages/cli']
const tag = `v${cli.version}`

if (argv.has('--check')) {
  if (!existsSync(join(root, 'packages/cli/dist/program.js'))) step('build', 'npm', ['run', 'build'])
  const report = await readiness()
  printReport(report)
  process.exit(report.ready ? 0 : 1)
}

console.log('Release check')
for (const { name, version } of Object.values(versions)) console.log(`  ${name.padEnd(34)} ${version}`)

const status = git('status', '--porcelain')
if (status && !argv.has('--allow-dirty')) fail(`the working tree is not clean:\n${status}\n(commit or stash first; --allow-dirty for a trial run)`)
if (git('tag', '--list', tag) && !git('tag', '--points-at', 'HEAD').split(/\s+/).includes(tag)) {
  fail(`tag ${tag} already exists on another commit; bump the versions first`)
}
const sha = git('rev-parse', '--short=12', 'HEAD')
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')

if (!argv.has('--skip-install')) step('install', 'npm', ['ci'])
step('generate', 'npm', ['run', 'generate'])
const drift = git('status', '--porcelain', '--', 'packages/ui-api-client/src/schema.ts', 'packages/core/src/api/operations.ts')
if (drift) fail(`generated sources drifted from the OpenAPI document (commit them):\n${drift}`)
step('build', 'npm', ['run', 'build'])
const report = await readiness()
if (!cli.version.includes('-') && !report.ready) {
  printReport(report)
  fail(`${cli.version} is a final version and the readiness gate is not met (above); a prerelease (-rc.N) is not gated`)
}
step('test', 'npm', ['test'])
step('lint', 'npm', ['run', 'lint'])
step('TUI tests', 'npm', ['run', 'test:tui'])
step('TUI type check', 'npm', ['run', 'typecheck:tui'])
for (const dir of PUBLISHED) step(`pack ${versions[dir].name}`, 'npm', ['pack', '--dry-run', '--silent', '-w', versions[dir].name])
if (!argv.has('--skip-binaries')) step('binaries', 'node', ['scripts/build-binaries.mjs', '--no-build', '--musl', ...(argv.has('--cli-only') ? ['--cli-only'] : [])])

const prerelease = Object.values(versions).some((p) => p.version.includes('-'))
console.log(`
All checks passed at ${branch}@${sha}. Nothing was tagged or published. To release, with this commit
merged to main, tag the merge commit and push the tag:

  git tag -s ${tag} -m "qqq ${cli.version}" && git push origin ${tag}

The release workflow (.gitea/workflows/release.yaml) then reruns this check, builds the binaries (Linux
targets in the container, macOS arm64 and Windows x64 on native runners), publishes the four packages to
the QRun-IO Gitea npm registry with dist-tag ${prerelease ? 'next' : 'latest'}, creates the Gitea ${prerelease ? 'prerelease' : 'release'} ${tag} with
the binaries and SHA256SUMS${prerelease ? '' : ', and updates the Homebrew tap and the Scoop bucket'} (docs/release-runbook.md).
`)
if (!report.ready) {
  console.log('Readiness for a final release (not required for this prerelease):')
  printReport(report, { limit: 5 })
  console.log('')
}
console.log('Note: every package version must be new in the registry; bump any that is already published.')
