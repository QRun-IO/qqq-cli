/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { DeveloperError, blocksToText, findAssociatedScript, getRecordDeveloper, getScriptLogs, getScriptRevisionFiles, getTableApiDocument, listDeveloperPanels, listTableApis, panelToBlocks, pickRevision, safeFileName, saveDownload, scriptText, storeScript } from '@qrun-io/qqq-core'
import { UsageError, type Context } from '../context.js'
import { authenticatedFetch } from '../session.js'
import type { Json } from './shared.js'

const values = (record: unknown): Json => (((record as Json | undefined)?.values ?? {}) as Json)

async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof DeveloperError) throw new UsageError(error.message)
    throw error
  }
}

/** Opens $VISUAL / $EDITOR (else vi) on a text and returns what was saved. */
function editText(text: string, name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-script-'))
  const path = join(dir, safeFileName(name))
  try {
    writeFileSync(path, text, { mode: 0o600 })
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi'
    const result = spawnSync(editor, [path], { stdio: 'inherit', shell: true })
    if (result.status !== 0) throw new UsageError(`${editor} exited with ${result.status ?? result.signal}; nothing was stored.`)
    return readFileSync(path, 'utf8')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function registerDeveloper(program: Command, ctx: () => Context): void {
  const table = program.commands.find((x) => x.name() === 'table')!

  table.command('apis <table>')
    .description('The application APIs that expose a table, with their versions.')
    .action(async (name: string) => {
      const c = ctx()
      const apis = await listTableApis(c.server, authenticatedFetch(c.target), name)
      const rows = apis.flatMap((a) => (a.versions.length ? a.versions : [{ version: '' }]).map((v) => ({ api: a.name, label: a.label, path: a.path, version: v.version, current: v.version && v.version === a.currentVersion ? 'yes' : '', spec: (v as { tableSpecPath?: string }).tableSpecPath ?? '' })))
      c.print({ data: apis, rows, columns: ['api', 'label', 'path', 'version', 'current', 'spec'], footer: apis.length ? '' : `(no application API exposes ${name})` })
    })

  table.command('api-doc <table> <api> <version>')
    .description("A table's OpenAPI document in one API version, saved as JSON.")
    .option('--out <file>', 'output file, or - for stdout (default: <table>-<api>-<version>.json, never overwriting)')
    .action(async (name: string, api: string, version: string, options: { out?: string }) => {
      const c = ctx()
      const document = await getTableApiDocument(c.server, authenticatedFetch(c.target), name, api, version)
      const text = JSON.stringify(document, null, 2) + '\n'
      if (options.out === '-') {
        process.stdout.write(text)
        return
      }
      const written = saveDownload(options.out ?? safeFileName(`${name}-${api}-${version}.json`), new TextEncoder().encode(text), { explicit: Boolean(options.out) })
      c.note(`wrote ${written} (${text.length} bytes)`)
    })

  table.command('developer <table> <primaryKey>')
    .description("A record's developer view: its associated scripts and the developer panels (record security, ESB, …).")
    .option('--no-panels', 'only the associated scripts')
    .action(async (name: string, primaryKey: string, options: { panels: boolean }) => {
      const c = ctx()
      const fetchImpl = authenticatedFetch(c.target)
      const [developer, panels] = await Promise.all([getRecordDeveloper(c.server, fetchImpl, name, primaryKey), options.panels ? listDeveloperPanels(c.server, fetchImpl, name, primaryKey) : Promise.resolve([])])
      if (c.format === 'json' || c.format === 'yaml' || c.options.query) {
        c.print({ data: { ...developer, panels } })
        return
      }
      const scripts = developer.scripts.map((s) => ({ field: s.fieldName, script: s.script ? `${String(values(s.script).name ?? '')} (${String(values(s.script).id ?? '')})` : '(none)', revisions: s.revisions.length, latest: s.revisions[0] ? `${String(values(s.revisions[0]).sequenceNo ?? '')}: ${String(values(s.revisions[0]).commitMessage ?? '')}` : '' }))
      c.print({ data: developer, rows: scripts, columns: ['field', 'script', 'revisions', 'latest'], footer: `${String(developer.record.recordLabel ?? `${name} ${primaryKey}`)}${scripts.length ? '' : ' (no associated scripts)'}` })
      for (const panel of panels) process.stdout.write('\n' + blocksToText(panelToBlocks(panel), { width: process.stdout.columns ?? 100 }) + '\n')
    })

  const script = program.command('script').description("A record's associated scripts: list, show, store, logs.")

  script.command('list <table> <primaryKey>')
    .description('The associated scripts of a record and their revisions.')
    .action(async (name: string, primaryKey: string) => {
      const c = ctx()
      const developer = await getRecordDeveloper(c.server, authenticatedFetch(c.target), name, primaryKey)
      const rows = developer.scripts.flatMap((s) => (s.revisions.length ? s.revisions : [undefined]).map((r, i) => ({
        field: i ? '' : s.fieldName,
        script: i ? '' : s.script ? String(values(s.script).name ?? values(s.script).id ?? '') : '(none)',
        revision: r ? String(values(r).sequenceNo ?? '') : '',
        id: r ? String(values(r).id ?? '') : '',
        message: r ? String(values(r).commitMessage ?? '') : '',
        created: r ? String(values(r).createDate ?? '') : '',
      })))
      c.print({ data: developer.scripts, rows, columns: ['field', 'script', 'revision', 'id', 'message', 'created'], footer: rows.length ? '' : `(${name} has no associated scripts)` })
    })

  script.command('show <table> <primaryKey> <field>')
    .description('The code of a script revision (the current one, or --revision by sequence number or id).')
    .option('--revision <n>', 'a revision sequence number (or id)')
    .action(async (name: string, primaryKey: string, field: string, options: { revision?: string }) => {
      const c = ctx()
      const fetchImpl = authenticatedFetch(c.target)
      const developer = await getRecordDeveloper(c.server, fetchImpl, name, primaryKey)
      const found = await guard(async () => findAssociatedScript(developer, field))
      const revision = await guard(async () => pickRevision(found, options.revision))
      if (!revision) throw new UsageError(`${name} ${primaryKey} has no ${field} script yet; \`qqq script store\` creates one.`)
      const files = await getScriptRevisionFiles(c.server, fetchImpl, String(values(revision).id))
      const text = scriptText(revision, files)
      if (c.format === 'json' || c.format === 'yaml') {
        c.print({ data: { revision: values(revision), files } })
        return
      }
      c.note(`${field}: revision ${String(values(revision).sequenceNo ?? '?')} (id ${String(values(revision).id)})${values(revision).commitMessage ? ` - ${String(values(revision).commitMessage)}` : ''}`)
      process.stdout.write(text.endsWith('\n') ? text : text + '\n')
    })

  script.command('store <table> <primaryKey> <field>')
    .description('Store new code for the script a record references (a new revision; the script is created when there is none).')
    .option('--file <path>', 'the code, from a file (- for stdin)')
    .option('--editor', 'edit the current code in $VISUAL / $EDITOR')
    .option('-m, --message <text>', 'commit message')
    .action(async (name: string, primaryKey: string, field: string, options: { file?: string; editor?: boolean; message?: string }) => {
      const c = ctx()
      if (Boolean(options.file) === Boolean(options.editor)) throw new UsageError('Give --file <path> or --editor (one of them).')
      const fetchImpl = authenticatedFetch(c.target)
      const developer = await getRecordDeveloper(c.server, fetchImpl, name, primaryKey)
      const found = await guard(async () => findAssociatedScript(developer, field))
      let contents: string
      if (options.file) {
        contents = readFileSync(options.file === '-' ? 0 : options.file, 'utf8')
      } else {
        if (!process.stdin.isTTY) throw new UsageError('--editor needs a terminal; use --file.')
        const revision = pickRevision(found)
        const current = revision ? scriptText(revision, await getScriptRevisionFiles(c.server, fetchImpl, String(values(revision).id))) : ''
        contents = editText(current, `${name}-${primaryKey}-${field}.js`)
        if (contents === current) {
          c.note('No change; nothing was stored.')
          return
        }
      }
      const stored = await storeScript(c.server, fetchImpl, name, primaryKey, field, contents, options.message)
      c.print({ data: stored, rows: [{ script: `${stored.scriptName} (${stored.scriptId})`, revision: stored.scriptRevisionSequenceNo, id: stored.scriptRevisionId }], columns: ['script', 'revision', 'id'] })
    })

  script.command('logs <table> <primaryKey> <field> <revisionId>')
    .description("A script revision's run logs, newest first, with their lines.")
    .action(async (name: string, primaryKey: string, field: string, revisionId: string) => {
      const c = ctx()
      const logs = await getScriptLogs(c.server, authenticatedFetch(c.target), name, primaryKey, field, revisionId)
      const rows = logs.flatMap((log) => (log.lines.length ? log.lines : [undefined]).map((line, i) => ({
        log: i ? '' : String(log.id ?? ''),
        started: i ? '' : log.startTimestamp,
        status: i ? '' : log.hadError ? `error${log.error ? `: ${log.error}` : ''}` : 'ok',
        line: line ? `${line.timestamp ? `${line.timestamp} ` : ''}${line.text}` : '',
      })))
      c.print({ data: logs, rows, columns: ['log', 'started', 'status', 'line'], footer: `(${logs.length} log${logs.length === 1 ? '' : 's'})` })
    })
}
