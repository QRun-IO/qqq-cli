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
 *      typecheck:tui; the TUI is not published, and is bundled only with --with-tui, but a release
 *      must not break it)
 *   3. npm pack --dry-run for each published package
 *   4. the single-file binaries (scripts/build-binaries.mjs; CLI only, or with the terminal UI
 *      with --with-tui) and dist/SHA256SUMS
 *   5. prints the tag, GitHub release and npm publish commands
 *
 * Usage: node scripts/release.mjs [--allow-dirty] [--skip-binaries] [--skip-install] [--with-tui]
 *   --with-tui  build the binaries with the terminal UI bundled (scripts/build-binaries.mjs --with-tui)
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const argv = new Set(process.argv.slice(2))
for (const a of argv) if (!['--allow-dirty', '--skip-binaries', '--skip-install', '--with-tui'].includes(a)) fail(`unknown option ${a}`)
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
const client = versions['packages/ui-api-client']
const cli = versions['packages/cli']
const orbTag = `v${client.version}`
const cliTag = `cli-v${cli.version}`

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
step('test', 'npm', ['test'])
step('lint', 'npm', ['run', 'lint'])
step('TUI tests', 'npm', ['run', 'test:tui'])
step('TUI type check', 'npm', ['run', 'typecheck:tui'])
for (const dir of PUBLISHED) step(`pack ${versions[dir].name}`, 'npm', ['pack', '--dry-run', '--silent', '-w', versions[dir].name])
if (!argv.has('--skip-binaries')) step('binaries', 'node', ['scripts/build-binaries.mjs', '--no-build', '--musl', ...(argv.has('--with-tui') ? ['--with-tui'] : [])])

const registry = 'https://npm.pkg.github.com'
console.log(`
All checks passed at ${branch}@${sha}. Nothing was tagged or published. To release:

  # 1. tag (signed) and push. ${orbTag} makes the qqq-orb cli profile publish the client, conformance
  #    and CLI packages to GitHub Packages with dist-tag rc (the orb checks ${orbTag} = client version).
  git tag -s ${orbTag} -m "UI API client ${client.version}, qqq-cli ${cli.version}"
  git tag -s ${cliTag} -m "qqq-cli ${cli.version}"
  git push origin ${orbTag} ${cliTag}

  # 2. the orb does not publish @qrun-io/qqq-core yet, and the CLI depends on it: publish it by hand
  #    before (or right after) the orb job, or the CLI package cannot be installed.
  npm publish -w ${versions['packages/core'].name} --registry ${registry} --tag rc

  #    without the orb (all four, in dependency order):
${PUBLISHED.map((dir) => `  npm publish -w ${versions[dir].name} --registry ${registry} --tag rc`).join('\n')}

  # 3. the binaries, as a prerelease with their checksums
  gh release create ${cliTag} --repo QRun-IO/qqq-cli --prerelease --title "qqq-cli ${cli.version}" \\
    --notes-file <(sed -n '/^## \\[${cli.version.replace(/\./g, '\\.')}\\]/,/^## \\[/p' CHANGELOG.md | sed '$d') \\
    dist/qqq-* dist/SHA256SUMS

  # 4. fill the sha256 values from dist/SHA256SUMS into docs/packaging/qqq.rb and qqq.json and
  #    open pull requests on the Homebrew tap and the Scoop bucket (see docs/packaging/README.md).
`)
const conformance = versions['packages/conformance']
console.log(`Note: the orb also publishes ${conformance.name} ${conformance.version} on ${orbTag}; bump it first if that version is already in the registry.`)
