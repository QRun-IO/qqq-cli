#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Release readiness: what a final (non-prerelease) release of the CLI and TUI still lacks.
 *
 *   1. parity: docs/parity/feature-matrix.md has no `partial` and no `todo` in the CLI or the TUI
 *      column; a `blocked` row must cite a server finding or an issue in its note
 *   2. findings: every finding in docs/server-findings.md links its filed issue
 *   3. changelog: CHANGELOG.md has an entry for the CLI version
 *   4. docs: every `qqq <command> [<verb>]` in README.md and TRY-IT.md exists in the program
 *      (packages/cli/dist, so build first)
 *   5. versions: a final CLI ships with final client, core and conformance packages (the orb publishes
 *      all four as `latest` only when none is a prerelease, else all as `rc`)
 *
 * scripts/release.mjs refuses a final release while anything is missing; `npm run release -- --check`
 * (or `node scripts/readiness.mjs`) prints the report for any version. Exit 0 when ready.
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

/** Parity rows that block a final release, per column. */
export function parityProblems(text) {
  const problems = []
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (!/^[A-Z]{3}-\d+$/.test(cells[1] ?? '')) continue
    const [, id, feature, cli, tui, note = ''] = cells
    for (const [column, status] of [['CLI', cli], ['TUI', tui]]) {
      if (status === 'partial' || status === 'todo') problems.push({ id, column, status, feature, note })
      else if (status === 'blocked' && !/(#\d+|finding \d+|issues\/\d+)/i.test(note)) problems.push({ id, column, status: 'blocked without a finding or issue', feature, note })
    }
  }
  return problems
}

/** Findings without an Issue link. */
export function findingProblems(text) {
  const problems = []
  let issueColumn = -1
  for (const line of text.split('\n')) {
    const cells = line.split('|').map((c) => c.trim())
    if (cells[1] === '#') issueColumn = cells.indexOf('Issue')
    if (!/^\d+$/.test(cells[1] ?? '')) continue
    const issue = issueColumn > 0 ? cells[issueColumn] ?? '' : ''
    if (!/\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(issue)) problems.push({ finding: cells[1], text: cells[2] })
  }
  return problems
}

/** Whether CHANGELOG.md has a `## [version]` entry. */
export function changelogHas(text, version) {
  return text.split('\n').some((line) => line.startsWith(`## [${version}]`))
}

/** The published workspaces that are still prereleases, when the CLI version is final. */
export function versionProblems(packages) {
  const cli = packages.find((p) => p.name === '@qrun-io/qqq-cli')
  if (!cli || cli.version.includes('-')) return []
  return packages.filter((p) => p.version.includes('-')).map((p) => `${p.name} is still ${p.version}; release it as a final version with qqq ${cli.version}`)
}

/** Global options of qqq that take a value (skipped when reading a command line from the docs). */
const GLOBAL_WITH_VALUE = new Set(['--server', '-p', '--profile', '-O', '--output', '-Q', '--query', '--fields'])

/** The `qqq ...` command lines in a document's code blocks and inline code, as token lists. */
export function commandLines(text) {
  const lines = []
  const code = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]).join('\n') + '\n' + [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).join('\n')
  for (const m of code.matchAll(/(?:^|[\s;(&|"$])qqq((?:[ \t]+[^\s;|&)"#]+)+)/gm)) {
    const tokens = m[1].trim().split(/\s+/)
    lines.push(tokens)
  }
  return lines
}

/** The commands of the program a token list names, or the reason it names none. */
export function resolveCommand(program, tokens) {
  const words = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (GLOBAL_WITH_VALUE.has(t)) { i++; continue }
    if (t.startsWith('-')) {
      if (!words.length) continue
      break
    }
    words.push(t)
    if (words.length === 2) break
  }
  const placeholder = (w) => /^[<[{$'"]/.test(w) || /[<>]/.test(w) || /^(…|\.\.\.)$/.test(w)
  if (!words.length || placeholder(words[0])) return undefined
  const find = (cmd, name) => cmd.commands.find((c) => c.name() === name || c.aliases().includes(name))
  const top = find(program, words[0])
  if (!top) return `no command "${words[0]}"`
  if (top.commands.length && words[1] && !placeholder(words[1]) && !find(top, words[1]) && !top.registeredArguments.length) return `no verb "${words[1]}" in "${words[0]}"`
  return undefined
}

export async function docProblems() {
  const { createProgram } = await import(pathToFileURL(join(root, 'packages/cli/dist/program.js')).href)
  const program = createProgram()
  const problems = []
  for (const doc of ['README.md', 'TRY-IT.md']) {
    const seen = new Set()
    for (const tokens of commandLines(read(doc))) {
      const reason = resolveCommand(program, tokens)
      const shown = `qqq ${tokens.slice(0, 4).join(' ')}`
      if (reason && !seen.has(shown)) {
        seen.add(shown)
        problems.push({ doc, command: shown, reason })
      }
    }
  }
  return problems
}

/** The full report: { ready, sections: [{ title, problems: string[] }] }. */
export async function readiness() {
  const version = JSON.parse(read('packages/cli/package.json')).version
  const packages = ['packages/ui-api-client', 'packages/core', 'packages/conformance', 'packages/cli'].map((dir) => JSON.parse(read(`${dir}/package.json`)))
  const versions = versionProblems(packages)
  const parity = parityProblems(read('docs/parity/feature-matrix.md'))
  const findings = findingProblems(read('docs/server-findings.md'))
  const docs = await docProblems()
  const count = (column) => parity.filter((p) => p.column === column).length
  const sections = [
    { title: `parity: ${count('CLI')} CLI and ${count('TUI')} TUI rows are not pass, n/a or a cited blocked`, problems: parity.map((p) => `${p.id} ${p.column} ${p.status}: ${p.feature.slice(0, 80)}`) },
    { title: `server findings without an issue link: ${findings.length}`, problems: findings.map((f) => `finding ${f.finding}: ${f.text.slice(0, 90)}`) },
    { title: `CHANGELOG entry for ${version}`, problems: changelogHas(read('CHANGELOG.md'), version) ? [] : [`no "## [${version}]" heading in CHANGELOG.md`] },
    { title: `commands in README.md and TRY-IT.md missing from the program: ${docs.length}`, problems: docs.map((d) => `${d.doc}: ${d.command} (${d.reason})`) },
    { title: `package versions: ${packages.map((p) => `${p.name.replace('@qrun-io/', '')} ${p.version}`).join(', ')}`, problems: versions },
  ]
  return { version, ready: sections.every((s) => !s.problems.length), sections }
}

export function printReport(report, { limit = 25 } = {}) {
  console.log(`Release readiness for qqq ${report.version}: ${report.ready ? 'READY' : 'NOT READY'}`)
  for (const s of report.sections) {
    console.log(`\n${s.problems.length ? '✗' : '✓'} ${s.title}`)
    for (const p of s.problems.slice(0, limit)) console.log(`    ${p}`)
    if (s.problems.length > limit) console.log(`    … ${s.problems.length - limit} more (node scripts/readiness.mjs --all)`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await readiness()
  printReport(report, { limit: process.argv.includes('--all') ? Infinity : 25 })
  process.exit(report.ready ? 0 : 1)
}
