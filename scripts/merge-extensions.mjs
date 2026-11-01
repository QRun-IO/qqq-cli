#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Builds the client document from a core document plus every extension document found in the
 * sibling checkouts of the QRun-IO workspace, and records where each came from.
 *
 * Usage: node scripts/merge-extensions.mjs [--core <url|file>] [--root <QRun-IO dir>] [--out <file>]
 *
 *   --core  the core document; default the sample server's http://localhost:8077/qqq/v1/openapi.json
 *           (a server's document is already merged with the extensions that server has; those are
 *           checked for equality and recorded, not duplicated)
 *   --root  the directory holding the qbit checkouts (default: QRUN_IO_ROOT, else the nearest
 *           ancestor of this repository that contains qbit-* directories)
 *   --out   default packages/ui-api-client/openapi/qqq-v1.json
 *
 * Writes packages/ui-api-client/openapi/extension-sources.json: each extension's name, version,
 * document path and the git branch and commit it was read at.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : fallback
}
const core = option('--core', 'http://localhost:8077/qqq/v1/openapi.json')
const out = option('--out', join(repo, 'packages/ui-api-client/openapi/qqq-v1.json'))

function findRoot() {
  if (process.env.QRUN_IO_ROOT) return process.env.QRUN_IO_ROOT
  for (let dir = dirname(repo); dir !== dirname(dir); dir = dirname(dir)) {
    if (readdirSync(dir).some((d) => d.startsWith('qbit-'))) return dir
  }
  throw new Error('No qbit-* checkouts found above this repository; pass --root or set QRUN_IO_ROOT.')
}
const root = option('--root', findRoot())

/** Where each repository keeps its extension documents (a qbit's own repo, or qqq for esb and health). */
function candidates() {
  const found = []
  const qqq = [join(root, '.worktrees/qqq-develop'), join(root, 'qqq')].find((d) => existsSync(join(d, 'qqq-esb')))
  if (qqq) {
    for (const module of ['qqq-esb', 'qqq-middleware-javalin']) {
      const dir = join(qqq, module, 'src/main/resources/openapi/qqq-v1')
      if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.yaml')) found.push(join(dir, f))
    }
  }
  for (const entry of readdirSync(root).filter((d) => d.startsWith('qbit-')).sort()) {
    for (const base of [join(root, entry), join(root, entry, entry)]) {
      const dir = join(base, 'src/main/resources/openapi/qqq-v1')
      if (existsSync(dir)) for (const f of readdirSync(dir)) if (f.endsWith('.yaml')) found.push(join(dir, f))
    }
  }
  return found
}

function git(dir, ...gitArgs) {
  try {
    return execFileSync('git', ['-C', dir, ...gitArgs], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

const documents = candidates()
if (!documents.length) throw new Error(`No extension documents under ${root}`)
execFileSync('node', [join(repo, 'scripts/merge-spec.mjs'), '--out', out, core, ...documents], { stdio: 'inherit' })

const sources = documents.map((file) => {
  const info = parse(readFileSync(file, 'utf8')).info ?? {}
  const dir = dirname(file)
  return {
    name: String(info.title ?? '').replace(/^QQQ Middleware API extension: /, ''),
    version: info.version,
    document: relative(root, file),
    branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'),
    commit: git(dir, 'rev-parse', '--short', 'HEAD'),
  }
})
writeFileSync(join(dirname(out), 'extension-sources.json'), JSON.stringify({ core, extensions: sources }, null, 2) + '\n')
for (const s of sources) console.log(`${s.name.padEnd(16)} ${String(s.version).padEnd(7)} ${s.branch}@${s.commit}  ${s.document}`)
