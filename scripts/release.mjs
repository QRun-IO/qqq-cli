#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Release check for the CLI packages. Runs everything a release needs locally and then prints the
 * commands that tag and publish it. It never tags, pushes or publishes.
 *
 *   1. the working tree is clean (no staged, unstaged or untracked changes) and the tags are free
 *   2. npm ci, then the steps the qqq-orb `cli` profile runs: npm run generate with no drift in
 *      packages/ui-api-client/src/schema.ts or packages/core/src/api/operations.ts, build, test;
 *      plus npm run lint (versions, headers) and the TUI's Bun tests and type check (npm run test:tui,
 *      typecheck:tui; the TUI ships inside the binaries)
 *   3. npm pack --dry-run for each published package
 *   4. the single-file binaries with the terminal UI (scripts/build-binaries.mjs; --cli-only leaves it
 *      out) and dist/SHA256SUMS
 *   5. prints the tag, GitHub release and npm publish commands
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

/** A literal text as a sed basic regular expression (its metacharacters and the `/` delimiter escaped). */
function sedPattern(text) {
  return text.replace(/[\\/.*[\]^$]/g, '\\$&')
}

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
const client = versions['packages/ui-api-client']
const cli = versions['packages/cli']
const orbTag = `v${client.version}`
const cliTag = `cli-v${cli.version}`

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
for (const tag of [orbTag, cliTag]) {
  if (git('tag', '--list', tag)) fail(`tag ${tag} already exists; bump the versions first`)
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

const registry = 'https://npm.pkg.github.com'
// the orb publishes all four packages as rc when any of them is a prerelease, and as latest only when
// all four are final; the GitHub release follows the CLI version
const prerelease = Object.values(versions).some((p) => p.version.includes('-'))
const distTag = prerelease ? 'rc' : 'latest'
const releaseKind = prerelease ? '--prerelease' : '--latest'
console.log(`
All checks passed at ${branch}@${sha}. Nothing was tagged or published. To release:

  # 1. tag (signed) and push. ${orbTag} makes the qqq-orb cli profile publish the client, conformance
  #    and CLI packages to GitHub Packages with dist-tag ${distTag} (the orb checks ${orbTag} = client version).${prerelease ? '' : '\n  #    All four versions are final, so the orb publishes them as latest (qqq-orb with PR #165).'}
  git tag -s ${orbTag} -m "UI API client ${client.version}, qqq-cli ${cli.version}"
  git tag -s ${cliTag} -m "qqq-cli ${cli.version}"
  git push origin ${orbTag} ${cliTag}

  # 2. until the orb release with PR #165, the orb does not publish @qrun-io/qqq-core, and the CLI
  #    depends on it: publish it by hand right after the orb job, or the CLI cannot be installed.
  npm publish -w ${versions['packages/core'].name} --registry ${registry} --tag ${distTag}

  #    without the orb (all four, in dependency order):
${PUBLISHED.map((dir) => `  npm publish -w ${versions[dir].name} --registry ${registry} --tag ${distTag}`).join('\n')}

  # 3. the binaries with their checksums (${prerelease ? "a prerelease" : "the latest release"})
  gh release create ${cliTag} --repo QRun-IO/qqq-cli ${releaseKind} --title "qqq ${cli.version}" \\
    --notes-file ${existsSync(join(root, `docs/release-notes/${cli.version}.md`)) ? `docs/release-notes/${cli.version}.md` : `<(sed -n '/^## \\[${sedPattern(cli.version)}\\]/,/^## \\[/p' CHANGELOG.md | sed '$d')`} \\
    dist/qqq-* dist/SHA256SUMS

  # 4. node scripts/update-packaging.mjs <SHA256SUMS of the GitHub release>, then copy
  #    docs/packaging/homebrew-tap/Formula/qqq.rb to the tap and docs/packaging/qqq.json to the Scoop
  #    bucket (docs/release-runbook.md steps 7 and 8). With the certificates, sign the macOS and Windows
  #    binaries and recompute dist/SHA256SUMS before step 3 (runbook step 4).
`)
if (!report.ready) {
  console.log('Readiness for a final release (not required for this prerelease):')
  printReport(report, { limit: 5 })
  console.log('')
}
const conformance = versions['packages/conformance']
console.log(`Note: the orb also publishes ${conformance.name} ${conformance.version} on ${orbTag}; bump it first if that version is already in the registry.`)
