/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Bulk load and bulk changes: `qqq table bulk-insert`, `bulk-edit`, `bulk-delete`, `actions`, and
 * `qqq bulk-profile` (saved bulk load profiles). The steps are the kernel's (`runBulkProcess`);
 * this file answers each screen from flags, a mapping document or terminal prompts.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import type { Command } from 'commander'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import {
  BACK, BulkDeclinedError, BulkMappingError, FilterLabelError, resolveFilterLabels, FormInputError, FormSession, ProcessCancelledError, ProcessError, SavedBulkLoadProfileError, blocksToText, buildFilter, bulkProcesses,
  checkInputRecords, checkMapping, columnLetter, columnName, columnPreview, deleteSavedBulkLoadProfile, diffMappings, displayDateTime, filterDateTimesToUtc, findColumn, findSavedBulkLoadProfile,
  formatTable, formatValue, isProfileOwner, listSavedBulkLoadProfiles, mappingDocument, mappingFromProfile, mappingRows, parseMappingDocument, profileFromMapping, readFileDescription, resolvePossibleValue,
  runBulkProcess, safeFileName, savedBulkLoadProfilesAvailable, screenToText, searchPossibleValues, setHasHeaderRow, storeSavedBulkLoadProfile, structureFields, uploadTemplates, variantParam,
  type BulkLoadTableStructure, type BulkMapping, type BulkOutcome, type FieldMeta, type FileDescription, type MappingContext, type ProcessMeta, type QueryFilter, type ReviewContext, type ReviewDecision,
  type SavedBulkLoadProfile, type ScreenBlock, type ValueMappingContext,
} from '@qrun-io/qqq-core'
import { UsageError, type Context } from '../context.js'
import { ask, promptForm } from '../prompt.js'
import { authenticatedFetch } from '../session.js'
import { printOutcome } from './process.js'
import { currentUserId } from './saved-view.js'
import { countFooter, parsePairs, positiveInt, readFileArg, readJson, writeDownload, type Json } from './shared.js'
import { chooseVariant, VARIANT_OPTION } from './variants.js'

interface SelectOptions { records?: string; where?: string[]; group?: string[]; or?: boolean; filterJson?: string; allRecords?: boolean }
interface ReviewOptions { validate?: boolean; skipValidation?: boolean; dryRun?: boolean; quiet?: boolean; recordLimit: string; variant?: string }
interface FileOptions { file?: string; mapping?: string; column?: string[]; default?: string[]; layout?: string; header: boolean; saved?: string; saveMapping?: string; saveProfile?: string; interactive?: boolean; key?: string; template?: string; out?: string }

/** The records a bulk edit or delete runs on: -r ids, or a filter (--where/--group/--filter-json), or --all-records. */
function selection(options: SelectOptions, meta: Json): { ids: string[] } | { filter: QueryFilter } {
  const given = [options.records, options.where?.length || options.group?.length ? 'filter' : undefined, options.filterJson, options.allRecords ? 'all' : undefined].filter(Boolean)
  if (given.length === 0) throw new UsageError('Choose the records: -r <ids>, --where/--group criteria, --filter-json, or --all-records for every record of the table.')
  if (given.length > 1) throw new UsageError('-r, --where/--group, --filter-json and --all-records exclude each other.')
  if (options.records) return { ids: options.records.split(',').map((x) => x.trim()).filter(Boolean) }
  if (options.filterJson) return { filter: readJson(options.filterJson, '--filter-json') as QueryFilter }
  if (options.allRecords) return { filter: { criteria: [], booleanOperator: 'AND' } as unknown as QueryFilter }
  const fields = (meta.fields ?? {}) as Record<string, FieldMeta>
  return { filter: filterDateTimesToUtc(buildFilter({ where: options.where, group: options.group, or: options.or, knownFields: Object.keys(fields) }), fields) }
}

/** selection, with possible-value labels in --where resolved to ids. */
async function resolvedSelection(c: Context, options: SelectOptions, meta: Json): Promise<{ ids: string[] } | { filter: QueryFilter }> {
  const chosen = selection(options, meta)
  if (!('filter' in chosen) || options.filterJson) return chosen
  try {
    const { filter, notes } = await resolveFilterLabels(c.server, authenticatedFetch(c.target), String(meta.name), (meta.fields ?? {}) as Record<string, FieldMeta>, chosen.filter)
    for (const n of notes) c.note(`filter: ${n}`)
    return { filter }
  } catch (error) {
    if (error instanceof FilterLabelError) throw new UsageError(`--where: ${error.message}`)
    throw error
  }
}

function addSelectOptions(cmd: Command): Command {
  return cmd
    .option('-r, --records <ids>', 'comma-separated primary keys (the checked records)')
    .option('-w, --where <criteria...>', 'criteria, ANDed (or --or): the whole query result')
    .option('-g, --group <expression...>', 'a group with AND/OR and parentheses')
    .option('--or', 'OR the --where criteria')
    .option('--filter-json <json|file|->', 'a QueryFilter selecting the records')
    .option('--all-records', 'every record of the table')
}

function addReviewOptions(cmd: Command): Command {
  return cmd
    .option('--validate', 'run full validation before loading (the default when there is a choice)')
    .option('--skip-validation', 'load without full validation')
    .option('--dry-run', 'stop at the review (after validation): show what would happen, change nothing')
    .option('--record-limit <n>', 'most preview records the review shows', '20')
    .option('--quiet', 'no intermediate screens on stderr')
    .option(...VARIANT_OPTION)
}

function addFileOptions(cmd: Command): Command {
  return cmd
    .option('--mapping <file>', 'a mapping document (YAML or JSON): fields to columns, defaults, value mappings; or a saved profile\'s v1 JSON')
    .option('-c, --column <field=column...>', 'map a field to a column (header name or letter); adds to or replaces the mapping')
    .option('-d, --default <field=value...>', 'a value for every row (possible values by label or id)')
    .option('--layout <layout>', 'FLAT, TALL or WIDE (tables with child tables)')
    .option('--no-header', 'the file has no header row (columns are letters)')
    .option('--saved <id|name>', 'start from a saved bulk load profile')
    .option('--save-mapping <file>', 'write the mapping used as a document (YAML, or JSON for .json) for --mapping next time')
    .option('--save-profile <name>', 'store the mapping used as a saved bulk load profile (yours) after the load')
    .option('-i, --interactive', 'review and edit the mapping and the value mappings on the terminal')
}

export function registerBulk(program: Command, ctx: () => Context): void {
  const table = program.commands.find((x) => x.name() === 'table')!

  addFileOptions(addReviewOptions(table.command('bulk-insert <table>')
    .description('Bulk insert from a CSV or Excel file: upload, map columns to fields (the server\'s suggestion, a --mapping document, flags or -i), map values, review (validation), load. Asks before loading unless --yes.')
    .option('-f, --file <path>', 'the CSV or .xlsx file to load')
    .option('--template [layout]', 'save the template file the upload instructions offer (flat, tall, wide; default all) and stop')
    .option('--out <path>', 'with --template: where to save (a file, or - for stdout)')))
    .action(async (name: string, options: FileOptions & ReviewOptions) => {
      const c = ctx()
      const meta = await c.tableMeta<Json>(name)
      const processName = bulkProcesses(meta, await c.metaData() as unknown as Json).insert
      if (!processName) throw new UsageError(`${meta.label} offers no bulk insert to you.`)
      if (options.template !== undefined) return await saveTemplates(c, processName, name, options)
      if (!options.file) throw new UsageError('--file <path> names the file to load (or --template to get a template).')
      await runFileLoad(c, meta, processName, options, undefined)
    })

  addFileOptions(addReviewOptions(addSelectOptions(table.command('bulk-edit <table>')
    .description('Bulk edit: the chosen records (-r, --where, --filter-json) get the --set values (only those fields change; --clear empties one); with --file, each file row updates the record found by --key fields. Review, then asks unless --yes.'))
    .option('-s, --set <name=value...>', 'a field and its new value (possible values by label or id)')
    .option('--clear <field...>', 'fields to empty')
    .option('-f, --file <path>', 'edit with a file: rows matched to records by --key')
    .option('-k, --key <fields>', 'with --file: the key field(s) that find each record (name or label; a|b for a compound key)')))
    .action(async (name: string, options: FileOptions & ReviewOptions & SelectOptions & { set?: string[]; clear?: string[] }) => {
      const c = ctx()
      const meta = await c.tableMeta<Json>(name)
      const processes = bulkProcesses(meta, await c.metaData() as unknown as Json)
      if (options.file) {
        if (!processes.editWithFile) throw new UsageError(`${meta.label} offers no bulk edit with a file to you.`)
        if (options.records || options.where || options.filterJson || options.allRecords || options.set || options.clear) throw new UsageError('With --file the file rows choose the records and the values; -r/--where/--set/--clear do not apply.')
        return await runFileLoad(c, meta, processes.editWithFile, options, options.key)
      }
      if (!processes.edit) throw new UsageError(`${meta.label} offers no bulk edit to you.`)
      if (!options.set?.length && !options.clear?.length && !options.interactive) throw new UsageError('Give the new values with --set field=value (or --clear field), or -i to choose them on the terminal.')
      await runSelected(c, meta, processes.edit, options, 'edit')
    })

  addReviewOptions(addSelectOptions(table.command('bulk-delete <table>')
    .description('Bulk delete the chosen records (-r ids, the whole --where result, --filter-json): review with the count and a preview, optional validation, then asks unless --yes.')))
    .action(async (name: string, options: ReviewOptions & SelectOptions) => {
      const c = ctx()
      const meta = await c.tableMeta<Json>(name)
      const processName = bulkProcesses(meta, await c.metaData() as unknown as Json).delete
      if (!processName) throw new UsageError(`${meta.label} offers no bulk delete to you.`)
      await runSelected(c, meta, processName, options, 'delete')
    })

  table.command('actions <table>')
    .description("What you can do to a table's records beyond query and edit, with the command for each: bulk insert, bulk edit (with and without a file), bulk delete, and the table's processes.")
    .option('--all', 'include hidden processes')
    .action(async (name: string, options: { all?: boolean }) => {
      const c = ctx()
      const meta = await c.tableMeta<Json>(name)
      const metaData = await c.metaData() as unknown as Json
      const bulk = bulkProcesses(meta, metaData)
      const bulkNames = new Set(Object.values(bulk))
      const rows: Json[] = []
      if (bulk.insert) rows.push({ action: 'Bulk insert', kind: 'bulk load', process: bulk.insert, command: `qqq table bulk-insert ${name} --file <file>` })
      if (bulk.editWithFile) rows.push({ action: 'Bulk edit with a file', kind: 'bulk load', process: bulk.editWithFile, command: `qqq table bulk-edit ${name} --file <file> --key <field>` })
      if (bulk.edit) rows.push({ action: 'Bulk edit', kind: 'bulk', process: bulk.edit, command: `qqq table bulk-edit ${name} -r <ids> --set <field=value>` })
      if (bulk.delete) rows.push({ action: 'Bulk delete', kind: 'bulk', process: bulk.delete, command: `qqq table bulk-delete ${name} -r <ids>` })
      const processes = Object.values((metaData.processes ?? {}) as Record<string, Json>)
        .filter((p) => p.tableName === name && !bulkNames.has(String(p.name)) && (options.all || !p.isHidden))
        .sort((a, b) => String(a.label).localeCompare(String(b.label)))
      for (const p of processes) rows.push({ action: p.label, kind: p.hasPermission === false ? 'process (no permission)' : 'process', process: p.name, command: `qqq process run ${String(p.name)} -r <ids>` })
      c.print({ data: rows, columns: ['action', 'kind', 'process', 'command'], footer: countFooter(rows.length, 'action') })
    })

  registerBulkProfile(program, ctx)
}

/** Saves the upload instructions' template file(s) (data: links in upload.html) and cancels the run. */
async function saveTemplates(c: Context, processName: string, table: string, options: FileOptions): Promise<void> {
  const init = (await c.call('initProcess', { path: { processName }, form: { values: JSON.stringify({ tableName: table }), stepTimeoutMillis: '60000' } })).data as Json
  if (init.type !== 'COMPLETE') throw new ProcessError(String(init.userFacingError ?? init.error ?? 'the bulk insert did not start'))
  const values = (init.values ?? {}) as Json
  const html = Object.entries(values).find(([k]) => k.endsWith('.html'))?.[1]
  await c.call('cancelProcess', { path: { processName, processUUID: String(init.processUUID) } }).catch(() => undefined)
  const templates = uploadTemplates(html)
  if (!templates.length) throw new UsageError('The upload instructions offer no template file.')
  const wanted = typeof options.template === 'string' ? options.template.toLowerCase() : undefined
  const chosen = wanted ? templates.filter((t) => t.name.toLowerCase().includes(wanted)) : templates
  if (!chosen.length) throw new UsageError(`No template matches "${options.template}" (offered: ${templates.map((t) => t.name).join(', ')}).`)
  if (options.out && chosen.length > 1) throw new UsageError(`--out takes one template; choose one of: ${templates.map((t) => t.name).join(', ')}`)
  for (const t of chosen) {
    const written = writeDownload(options.out, safeFileName(t.name), t.bytes)
    if (written) c.note(`saved ${written} (${t.bytes.length} bytes)`)
  }
}

/** The screens as text (records with the table renderer, widgets with the block renderer). */
function screenText(screen: ScreenBlock[]): string {
  const width = process.stdout.columns ?? 100
  return screenToText(screen, { table: (rows, columns, headers) => formatTable(rows, columns, headers), widget: (blocks) => blocksToText(blocks, { width }) })
}

/** Ctrl-C cancels the run on the server; a second leaves at once. */
function interruptible(c: Context): { signal: AbortSignal; done: () => void } {
  const abort = new AbortController()
  const onInterrupt = () => {
    if (abort.signal.aborted) process.exit(130)
    c.note('\ncancelling (Ctrl-C again to leave at once)...')
    abort.abort()
  }
  process.on('SIGINT', onInterrupt)
  return { signal: abort.signal, done: () => process.off('SIGINT', onInterrupt) }
}

/**
 * The review screen's answer: validate first unless --skip-validation (asked on a terminal), then
 * submit with --yes or after a y; --dry-run stops after the validation; without a terminal and
 * without --yes the run is cancelled and the command exits 2.
 */
function reviewer(c: Context, options: ReviewOptions, state: { needYes?: boolean; dryRun?: boolean }, verb: string) {
  const canPrompt = Boolean(process.stdin.isTTY)
  return async (ctx: ReviewContext): Promise<ReviewDecision | typeof BACK> => {
    if (options.validate && options.skipValidation) throw new UsageError('--validate and --skip-validation exclude each other.')
    if (!ctx.validated && ctx.supportsFullValidation) {
      if (options.dryRun || options.validate) return 'validate'
      if (options.skipValidation) {
        if (c.options.yes) return 'skip'
        if (!canPrompt) {
          state.needYes = true
          return 'cancel'
        }
        const answer = await ask(`${verb} now without full validation? [y/N${ctx.canGoBack ? '/b' : ''}] `)
        if (ctx.canGoBack && /^b/i.test(answer)) return BACK
        return /^y/i.test(answer) ? 'skip' : 'cancel'
      }
      if (c.options.yes || !canPrompt) return 'validate'
      const answer = await ask(`Validate fully before you ${verb.toLowerCase()} (v), ${verb.toLowerCase()} now without validation (r)${ctx.canGoBack ? ', go back (b)' : ''}, or cancel (c)? [V/r${ctx.canGoBack ? '/b' : ''}/c] `)
      if (ctx.canGoBack && /^b/i.test(answer)) return BACK
      if (/^c/i.test(answer)) return 'cancel'
      return /^r/i.test(answer) ? 'skip' : 'validate'
    }
    if (options.dryRun) {
      state.dryRun = true
      return 'cancel'
    }
    if (c.options.yes) return 'submit'
    if (!canPrompt) {
      state.needYes = true
      return 'cancel'
    }
    const answer = await ask(`${verb}? [y/N${ctx.canGoBack ? '/b' : ''}] `)
    if (ctx.canGoBack && /^b/i.test(answer)) return BACK
    return /^y/i.test(answer) ? 'submit' : 'cancel'
  }
}

/** Runs the kernel driver with the shared screen printing, Ctrl-C handling and endings. */
async function drive(c: Context, meta: Json, processName: string, options: ReviewOptions, verb: string, setup: (state: { needYes?: boolean; dryRun?: boolean }, review: ReturnType<typeof reviewer>) => Omit<Parameters<typeof runBulkProcess>[0], 'baseUrl' | 'fetch' | 'meta' | 'review'>): Promise<BulkOutcome | undefined> {
  const procMeta = await c.unwrap(c.client.GET('/qqq/v1/metaData/process/{processName}', { params: { path: { processName } } })) as unknown as ProcessMeta
  const tableVariant = options.variant !== undefined || meta.backendDetails ? variantParam(await chooseVariant(c, meta, options.variant)) : undefined
  const fetchImpl = authenticatedFetch(c.target)
  const state: { needYes?: boolean; dryRun?: boolean } = {}
  const review = reviewer(c, options, state, verb)
  const { signal, done } = interruptible(c)
  let outcome: BulkOutcome
  try {
    outcome = await runBulkProcess({
      baseUrl: c.server,
      fetch: fetchImpl,
      meta: procMeta,
      review,
      signal,
      tableVariant,
      stepTimeoutMillis: 0,
      screen: { recordLimit: positiveInt(options.recordLimit, '--record-limit'), previewLimit: positiveInt(options.recordLimit, '--record-limit'), format: (field, value, shown) => (field.type === 'DATE_TIME' ? displayDateTime(value, shown, c.dateTimeDisplay) : formatValue(field, value)) },
      onProgress: (e) => {
        if (options.quiet) return
        if (e.phase === 'init') c.note(`${procMeta.label ?? processName}: starting`)
        else if (e.phase === 'running') c.note(`  running${e.current !== undefined ? ` ${e.current}/${e.total ?? '?'}` : ''}${e.message ? ` ${e.message}` : ''}`)
        else if (e.phase === 'back') c.note('  going back')
        else if (e.phase === 'cancel') c.note('  asking the server to cancel the run')
      },
      present: ({ step, screen, isLast }) => {
        if (isLast || options.quiet) return
        const text = screenText(screen.filter((b) => b.kind !== 'form'))
        if (text) c.note(`\n== ${step.label ?? step.name} ==\n${text}`)
      },
      ...setup(state, review),
    })
  } catch (error) {
    if (error instanceof BulkDeclinedError) {
      if (state.needYes) throw new UsageError(`Confirmation needed: pass --yes to ${verb.toLowerCase()} without a terminal (the run was cancelled; nothing changed).`)
      c.note(state.dryRun ? `Dry run: nothing was changed (${procMeta.label ?? processName} cancelled at the review).` : `Not submitted; nothing was changed.`)
      return undefined
    }
    if (error instanceof ProcessCancelledError) {
      c.note(`${procMeta.label ?? processName}: ${error.message}`)
      process.exitCode = 130
      return undefined
    }
    if (error instanceof BulkMappingError) throw new UsageError(error.message)
    throw error
  } finally {
    done()
  }
  printOutcome(c, outcome, screenText, [])
  return outcome
}

/** bulk-edit (no file) and bulk-delete: records chosen by ids or a filter. */
async function runSelected(c: Context, meta: Json, processName: string, options: ReviewOptions & SelectOptions & { set?: string[]; clear?: string[]; interactive?: boolean }, kind: 'edit' | 'delete'): Promise<void> {
  const records = await resolvedSelection(c, options, meta)
  const procMeta = await c.unwrap(c.client.GET('/qqq/v1/metaData/process/{processName}', { params: { path: { processName } } })) as unknown as ProcessMeta
  try {
    await checkInputRecords(procMeta, records, async (filter) => Number(((await c.call('countTable', { path: { tableName: String(meta.name) }, json: { filter } })).data as Json).count ?? 0))
  } catch (error) {
    if (error instanceof ProcessError) throw new UsageError(error.message)
    throw error
  }
  const given = parsePairs(options.set, '--set')
  const fetchImpl = authenticatedFetch(c.target)
  await drive(c, meta, processName, options, kind === 'edit' ? 'Update the records' : 'Delete the records', () => ({
    records,
    editForm: async ({ step, fields, values }) => {
      const names = new Set(fields.map((f) => f.name))
      const resolveName = (n: string): string => {
        if (names.has(n)) return n
        const byLabel = fields.find((f) => String(f.label ?? '').toLowerCase() === n.toLowerCase())
        if (byLabel) return byLabel.name
        throw new UsageError(`${step.label ?? step.name}: ${n} is not a field bulk edit can change (${fields.map((f) => f.name).join(', ')})`)
      }
      const enabled: string[] = []
      const session = new FormSession({ baseUrl: c.server, fetch: fetchImpl, scope: { process: processName }, fields, initialValues: values })
      for (const [n, v] of Object.entries(given)) {
        const fieldName = resolveName(n)
        try {
          await session.set(fieldName, v === '' ? null : v)
        } catch (error) {
          if (error instanceof FormInputError) throw new UsageError(error.message)
          throw error
        }
        enabled.push(fieldName)
      }
      for (const n of options.clear ?? []) {
        const fieldName = resolveName(n)
        await session.set(fieldName, null)
        if (!enabled.includes(fieldName)) enabled.push(fieldName)
      }
      if (options.interactive) {
        c.note(`Fields: ${fields.map((f) => `${f.label} (${f.name})`).join(', ')}`)
        const answer = await ask(`Fields to change (comma-separated names or labels${enabled.length ? `; Enter keeps ${enabled.join(', ')}` : ''}): `)
        for (const n of answer.split(',').map((x) => x.trim()).filter(Boolean)) {
          const fieldName = resolveName(n)
          if (!enabled.includes(fieldName)) enabled.push(fieldName)
        }
        if (!enabled.length) throw new UsageError('No fields chosen; nothing to change.')
        c.note('An empty answer clears the field in every record.')
        await promptForm(session, { only: enabled })
      }
      const problems = session.validate(enabled.filter((n) => session.values[n] !== null && session.values[n] !== undefined))
      if (Object.keys(problems).length) throw new UsageError(Object.entries(problems).map(([f, m]) => `${session.fields[f]?.label ?? f} ${m}`).join('; '))
      c.note(`Changing ${enabled.map((n) => `${session.fields[n]?.label ?? n} = ${session.values[n] === null || session.values[n] === undefined ? '(cleared)' : String(session.state(n).displayValue ?? session.values[n])}`).join(', ')}`)
      return { values: session.values, enabled }
    },
  }))
}

/** bulk-insert and bulk-edit --file: upload, mapping, value mapping, review, result. */
async function runFileLoad(c: Context, meta: Json, processName: string, options: FileOptions & ReviewOptions, key: string | undefined): Promise<void> {
  const path = options.file!
  const bytes = readFileArg(path, '--file')
  const fetchImpl = authenticatedFetch(c.target)
  const layout = options.layout?.toUpperCase()
  if (layout && !['FLAT', 'TALL', 'WIDE'].includes(layout)) throw new UsageError(`--layout ${options.layout}: one of FLAT, TALL, WIDE`)
  const doc = options.mapping ? readMappingFile(options.mapping) : undefined
  let saved: SavedBulkLoadProfile | undefined
  const isBulkEdit = key !== undefined
  if (options.saved) {
    if (!savedBulkLoadProfilesAvailable(await c.metaData() as unknown as Json)) throw new UsageError('This server offers no saved bulk load profiles.')
    try {
      saved = findSavedBulkLoadProfile(await listSavedBulkLoadProfiles(c.server, fetchImpl, String(meta.name), isBulkEdit), options.saved)
    } catch (error) {
      if (error instanceof SavedBulkLoadProfileError) throw new UsageError(error.message)
      throw error
    }
  }
  const outcome = await drive(c, meta, processName, options, isBulkEdit ? 'Update the records' : 'Load the file', () => ({
    file: { name: basename(path), bytes, type: contentTypeOf(path) },
    values: { tableName: String(meta.name) },
    savedProfile: saved,
    chooseMapping: async (ctx) => {
      let mapping = doc !== undefined ? parseMappingDocument(doc, ctx.structure, ctx.file) : structuredClone(ctx.suggestion)
      if (ctx.previous && doc === undefined) mapping = structuredClone(ctx.previous)
      if (options.header === false && mapping.hasHeaderRow) for (const w of setHasHeaderRow(mapping, false, ctx.file)) c.note(`warning: ${w}`)
      if (layout) mapping.layout = layout as BulkMapping['layout']
      applyFlags(mapping, ctx, options)
      if (isBulkEdit) mapping.keyFields = await chooseKey(ctx, key!, mapping)
      if (options.interactive) {
        const edited = await editMapping(c, ctx, mapping)
        if (edited === BACK) return BACK
        mapping = edited
      } else if (!options.quiet) {
        showMapping(c, ctx, mapping)
      }
      const { errors, warnings } = checkMapping(mapping, ctx.structure, ctx.file)
      for (const w of warnings) c.note(`warning: ${w}`)
      if (errors.length) throw new UsageError(`The mapping cannot be used:\n  ${errors.join('\n  ')}\n(map with --column field=column or --default field=value, a --mapping document, or -i)`)
      if (options.saveMapping) {
        const docOut = mappingDocument(mapping, ctx.file)
        writeFileSync(options.saveMapping, extname(options.saveMapping).toLowerCase() === '.json' ? `${JSON.stringify(docOut, null, 2)}\n` : stringifyYaml(docOut))
        c.note(`mapping saved to ${options.saveMapping}`)
      }
      return mapping
    },
    mapValues: async (ctx) => mapValues(c, ctx, Boolean(options.interactive)),
  }))
  if (outcome?.mapping && options.saveProfile && outcome.structure && outcome.file) {
    try {
      const stored = await storeSavedBulkLoadProfile(c.server, fetchImpl, { table: String(meta.name), label: options.saveProfile, isBulkEdit, profile: profileFromMapping(outcome.mapping) })
      c.note(`saved bulk load profile "${stored.label}" (${stored.id})`)
    } catch (error) {
      if (error instanceof SavedBulkLoadProfileError) throw new UsageError(`The load finished, but the profile was not saved: ${error.message}`)
      throw error
    }
  }
}

function contentTypeOf(path: string): string | undefined {
  const ext = extname(path).toLowerCase()
  return ext === '.csv' ? 'text/csv' : ext === '.xlsx' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : undefined
}

/** A mapping document file: YAML or JSON. */
function readMappingFile(path: string): unknown {
  const text = new TextDecoder().decode(readFileArg(path, '--mapping'))
  try {
    return extname(path).toLowerCase() === '.json' ? JSON.parse(text) : parseYaml(text)
  } catch (error) {
    throw new UsageError(`--mapping ${path}: not valid ${extname(path).toLowerCase() === '.json' ? 'JSON' : 'YAML'} (${error instanceof Error ? error.message : String(error)})`)
  }
}

/** A field by name, qualified name, label or `Child: Label`. */
function fieldByText(structure: BulkLoadTableStructure, text: string): { name: string; label: string; field: FieldMeta; tableName: string; isMany: boolean } {
  const all = structureFields(structure)
  const { base, wide } = (() => {
    const m = /^(.*),(\d+)$/.exec(text.trim())
    return m ? { base: m[1]!, wide: m[2] } : { base: text.trim(), wide: undefined }
  })()
  const found = all.find((f) => f.name === base) ?? all.find((f) => f.label.toLowerCase() === base.toLowerCase()) ?? all.find((f) => String(f.field.label ?? '').toLowerCase() === base.toLowerCase() && f.isMain)
  if (!found) throw new UsageError(`${text}: no such field (${all.map((f) => f.name).join(', ')})`)
  return { ...found, name: wide !== undefined ? `${found.name},${wide}` : found.name }
}

/** --column and --default on top of the mapping. */
function applyFlags(mapping: BulkMapping, ctx: MappingContext, options: FileOptions): void {
  for (const [text, column] of Object.entries(parsePairs(options.column, '--column'))) {
    const f = fieldByText(ctx.structure, text)
    const index = findColumn(ctx.file, column, mapping.hasHeaderRow)
    if (index === undefined) throw new UsageError(`--column ${text}=${column}: no such column (${columnsList(ctx.file, mapping.hasHeaderRow)})`)
    const existing = mapping.fields.find((m) => m.name === f.name)
    const entry = { name: f.name, column: index, ...(mapping.hasHeaderRow ? { header: ctx.file.headers[index] } : {}) }
    if (existing) {
      delete existing.defaultValue
      Object.assign(existing, entry)
    } else mapping.fields.push(entry)
  }
  for (const [text, value] of Object.entries(parsePairs(options.default, '--default'))) {
    const f = fieldByText(ctx.structure, text)
    const existing = mapping.fields.find((m) => m.name === f.name)
    if (existing) {
      delete existing.column
      delete existing.header
      delete existing.doValueMapping
      delete existing.valueMappings
      existing.defaultValue = value
    } else mapping.fields.push({ name: f.name, defaultValue: value })
  }
}

function columnsList(file: FileDescription, hasHeaderRow: boolean): string {
  return file.letters.map((l, i) => (hasHeaderRow ? `${l} ${file.headers[i]}` : l)).join(', ')
}

/** Bulk edit with a file: --key names the key field(s), checked against the server's choices. */
async function chooseKey(ctx: MappingContext, key: string, mapping: BulkMapping): Promise<string> {
  const names = key.split(/[|,]/).map((k) => fieldByText(ctx.structure, k).name)
  const wanted = names.join('|')
  const options = await ctx.keyFieldOptions()
  if (options.length && !options.some((o) => o.id === wanted)) throw new UsageError(`--key ${key}: not a key of this table (keys: ${options.map((o) => `${o.id} (${o.label})`).join(', ')})`)
  for (const name of names) {
    if (mapping.fields.some((f) => f.name === name && f.column !== undefined)) continue
    const label = structureFields(ctx.structure).find((f) => f.name === name)?.label ?? name
    const column = findColumn(ctx.file, label, mapping.hasHeaderRow) ?? findColumn(ctx.file, name, mapping.hasHeaderRow)
    if (column === undefined) continue
    const existing = mapping.fields.find((f) => f.name === name)
    if (existing) Object.assign(existing, { column, ...(mapping.hasHeaderRow ? { header: ctx.file.headers[column] } : {}) })
    else mapping.fields.push({ name, column, ...(mapping.hasHeaderRow ? { header: ctx.file.headers[column] } : {}) })
  }
  return wanted
}

function showMapping(c: Context, ctx: MappingContext, mapping: BulkMapping): void {
  const rows = mappingRows(mapping, ctx.structure, ctx.file)
  const head = [`File ${ctx.file.name ?? ''}: ${ctx.file.headers.length} columns${mapping.hasHeaderRow ? '' : ' (no header row)'}; layout ${mapping.layout}${mapping.isBulkEdit && mapping.keyFields ? `; key ${mapping.keyFields}` : ''}${ctx.savedProfile ? `; profile ${ctx.savedProfile.label}` : ''}`]
  c.note(`\n== ${ctx.step.label ?? ctx.step.name} ==\n${head.join('\n')}\n${formatTable(rows, ['field', 'source', 'preview', 'options'], ['Field', 'Source', 'Preview', 'Options'])}`)
}

/**
 * -i on the mapping screen: the file's columns and the mapping, then questions: header row,
 * layout, each mapped field's source, fields to add (grouped by table), fields whose values to
 * map; repeated until accepted. `b` goes back to the upload.
 */
async function editMapping(c: Context, ctx: MappingContext, start: BulkMapping): Promise<BulkMapping | typeof BACK> {
  const mapping = structuredClone(start)
  const columns = ctx.file.headers.map((h, i) => ({ col: ctx.file.letters[i] ?? columnLetter(i), header: h, preview: columnPreview(ctx.file, i, true).slice(0, 3).join(', ') }))
  c.note(`\n== ${ctx.step.label ?? ctx.step.name}: ${ctx.file.name ?? 'the file'} ==\n${formatTable(columns, ['col', 'header', 'preview'], ['Col', 'First row', 'Preview'])}`)
  const helps = (ctx.step.formFields ?? []).map((f) => (f as FieldMeta & { helpContents?: Array<{ contentAsText?: string; content?: string }> })).filter((f) => f.helpContents?.length)
  for (const f of helps) c.note(`  ${f.label}: ${f.helpContents!.map((h) => h.contentAsText ?? h.content ?? '').join(' ').replace(/<[^>]+>/g, '').trim()}`)
  for (;;) {
    const header = await ask(`Does the first row hold headers? [${mapping.hasHeaderRow ? 'Y/n' : 'y/N'}] `)
    if (header) for (const w of setHasHeaderRow(mapping, /^y/i.test(header), ctx.file)) c.note(`warning: ${w}`)
    if (ctx.structure.associations?.length) {
      const answer = (await ask(`Layout: FLAT (one row per record), TALL (rows grouped into child records), WIDE (child records in extra columns) [${mapping.layout}]: `)).toUpperCase()
      if (['FLAT', 'TALL', 'WIDE'].includes(answer)) mapping.layout = answer as BulkMapping['layout']
    }
    const label = (n: string) => mappingRows({ ...mapping, fields: mapping.fields.filter((f) => f.name === n) }, ctx.structure, ctx.file)[0]?.field ?? n
    c.note('For each field: a column (header or letter), =value for a default value, - to drop it, Enter to keep.')
    for (const f of [...mapping.fields]) {
      const current = f.column !== undefined ? columnName(ctx.file, f.column, mapping.hasHeaderRow) : f.defaultValue !== undefined ? `=${String(f.defaultValue)}` : 'not mapped'
      for (;;) {
        const answer = await ask(`  ${label(f.name)} (${current}): `)
        if (!answer) break
        if (answer === '-') {
          mapping.fields = mapping.fields.filter((m) => m !== f)
          break
        }
        if (answer.startsWith('=')) {
          delete f.column
          delete f.header
          delete f.doValueMapping
          f.defaultValue = answer.slice(1)
          break
        }
        const index = findColumn(ctx.file, answer, mapping.hasHeaderRow)
        if (index === undefined) {
          c.note(`  no column ${answer} (${columnsList(ctx.file, mapping.hasHeaderRow)})`)
          continue
        }
        delete f.defaultValue
        f.column = index
        if (mapping.hasHeaderRow) f.header = ctx.file.headers[index]
        break
      }
    }
    const unused = structureFields(ctx.structure).filter((s) => !mapping.fields.some((m) => m.name.replace(/,\d+$/, '') === s.name) || (s.isMany && mapping.layout === 'WIDE'))
    if (unused.length) {
      const groups = new Map<string, string[]>()
      for (const u of unused) {
        const table = u.isMain ? String(ctx.structure.label) : u.label.split(':')[0]!
        groups.set(table, [...(groups.get(table) ?? []), `${u.isMain ? u.label : u.label.split(': ')[1]} (${u.name})`])
      }
      c.note(`Fields you can add:\n${[...groups].map(([t, fs]) => `  ${t}: ${fs.join(', ')}`).join('\n')}`)
      const add = await ask('Add fields (comma-separated; Enter for none): ')
      for (const text of add.split(',').map((x) => x.trim()).filter(Boolean)) {
        let f: ReturnType<typeof fieldByText>
        try {
          f = fieldByText(ctx.structure, text)
        } catch (error) {
          c.note(`  ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        let name = f.name
        if (f.isMany && mapping.layout === 'WIDE' && !/,\d+$/.test(name)) name = `${name},${mapping.fields.filter((m) => m.name.startsWith(`${f.name},`)).length}`
        for (;;) {
          const answer = await ask(`  ${f.label}: column (header or letter) or =default value: `)
          if (!answer) break
          if (answer.startsWith('=')) {
            mapping.fields.push({ name, defaultValue: answer.slice(1) })
            break
          }
          const index = findColumn(ctx.file, answer, mapping.hasHeaderRow)
          if (index === undefined) {
            c.note(`  no column ${answer}`)
            continue
          }
          mapping.fields.push({ name, column: index, ...(mapping.hasHeaderRow ? { header: ctx.file.headers[index] } : {}) })
          break
        }
      }
    }
    const columnFields = mapping.fields.filter((f) => f.column !== undefined)
    if (columnFields.length) {
      const current = columnFields.filter((f) => f.doValueMapping).map((f) => f.name)
      const answer = await ask(`Map file values to table values for which fields? (comma-separated${current.length ? `; now: ${current.join(', ')}; - for none` : ''}; Enter keeps): `)
      if (answer === '-') for (const f of columnFields) delete f.doValueMapping
      else if (answer) {
        const names = answer.split(',').map((x) => fieldByText(ctx.structure, x.trim()).name)
        for (const f of columnFields) {
          if (names.includes(f.name.replace(/,\d+$/, '')) || names.includes(f.name)) f.doValueMapping = true
          else delete f.doValueMapping
        }
      }
      const clear = mapping.isBulkEdit ? await ask('Clear a field when its file value is empty, for which fields? (comma-separated, Enter for none): ') : ''
      if (clear) {
        const names = clear.split(',').map((x) => fieldByText(ctx.structure, x.trim()).name)
        for (const f of columnFields) if (names.includes(f.name)) f.clearIfEmpty = true
      }
    }
    if (mapping.isBulkEdit) {
      const options = await ctx.keyFieldOptions()
      if (options.length) {
        const answer = await ask(`Key fields that find each record (${options.map((o) => `${o.id} = ${o.label}`).join('; ')}) [${mapping.keyFields ?? ''}]: `)
        if (answer) {
          const found = options.find((o) => o.id === answer || o.label.toLowerCase() === answer.toLowerCase())
          if (found) mapping.keyFields = found.id
          else c.note(`  ${answer} is not one of the keys`)
        }
      }
    }
    showMapping(c, ctx, mapping)
    const { errors, warnings } = checkMapping(mapping, ctx.structure, ctx.file)
    for (const w of warnings) c.note(`warning: ${w}`)
    if (errors.length) c.note(`Not ready:\n  ${errors.join('\n  ')}`)
    const answer = await ask(`Use this mapping? [${errors.length ? 'y/N' : 'Y/n'}${ctx.canGoBack ? '/b' : ''}] (n edits again) `)
    if (ctx.canGoBack && /^b/i.test(answer)) return BACK
    if (errors.length ? /^y/i.test(answer) : !/^n/i.test(answer)) return mapping
  }
}

/**
 * The value mapping screen: file values to table values for one field. Known mappings (profile,
 * mapping document) are used; on a terminal each value is asked for (choices listed for
 * possible-value fields, Enter keeps the known one); without one, a required field with unmapped
 * values stops with the values to map.
 */
async function mapValues(c: Context, ctx: ValueMappingContext, interactive: boolean): Promise<Record<string, unknown> | typeof BACK> {
  const mapped: Record<string, unknown> = { ...ctx.mapped }
  const fetchImpl = authenticatedFetch(c.target)
  const label = String(ctx.field.label ?? ctx.field.name)
  const unmapped = () => ctx.fileValues.filter((v) => mapped[v] === undefined || mapped[v] === null || mapped[v] === '')
  if (!interactive) {
    const missing = unmapped()
    if (missing.length && ctx.field.isRequired) throw new UsageError(`${label} (${ctx.fieldName}) needs a table value for each file value; unmapped: ${missing.map((v) => JSON.stringify(v)).join(', ')}. Map them in a --mapping document (fields: { ${ctx.fieldName}: { column: …, values: { "${missing[0]}": <value> } } }) or run with -i.`)
    if (missing.length) c.note(`${label}: ${missing.length} file value${missing.length === 1 ? '' : 's'} not mapped (sent as in the file): ${missing.slice(0, 10).join(', ')}`)
    return mapped
  }
  c.note(`\n== Value mapping: ${label} (${ctx.index + 1} of ${ctx.count}) ==`)
  if (ctx.field.possibleValueSourceName) {
    const choices = await searchPossibleValues(c.server, fetchImpl, { table: ctx.tableName }, ctx.field.name, { searchTerm: '', limit: 15 })
    if (choices.length) c.note(`Choices: ${choices.map((o) => `${o.label} (${String(o.id)})`).join(', ')}${choices.length === 15 ? ', … (type part of a label to search)' : ''}`)
  } else if (ctx.field.type === 'BOOLEAN') c.note('Answer yes or no.')
  c.note(`For each file value: the ${label} value${ctx.field.possibleValueSourceName ? ' (label or id)' : ''}, Enter keeps what is shown, - clears${ctx.canGoBack ? ', b goes back' : ''}.`)
  for (const fileValue of ctx.fileValues) {
    for (;;) {
      const known = mapped[fileValue]
      const shown = known === undefined || known === null || known === '' ? '' : ` (${ctx.labels[String(known)] ?? String(known)})`
      const answer = await ask(`  ${fileValue}${shown}${ctx.field.isRequired && !shown ? ' *' : ''}: `)
      if (answer === 'b' && ctx.canGoBack) return BACK
      if (!answer) {
        if (ctx.field.isRequired && !shown) {
          c.note('  required')
          continue
        }
        break
      }
      if (answer === '-') {
        delete mapped[fileValue]
        break
      }
      if (ctx.field.possibleValueSourceName) {
        const { option, candidates } = await resolvePossibleValue(c.server, fetchImpl, { table: ctx.tableName }, ctx.field.name, answer, { fieldType: ctx.field.type })
        if (!option) {
          c.note(`  ${candidates.length ? `several match: ${candidates.slice(0, 8).map((o) => `${o.label} (${String(o.id)})`).join(', ')}` : 'no match'}`)
          continue
        }
        mapped[fileValue] = option.id
        ctx.labels[String(option.id)] = option.label
      } else mapped[fileValue] = answer
      break
    }
  }
  return mapped
}

/** The header row and first rows of a local CSV (for saving a profile from a mapping document). */
function localFileDescription(path: string): FileDescription {
  if (extname(path).toLowerCase() !== '.csv') throw new UsageError('--file: a CSV whose header names the columns (for an Excel file, save the profile from bulk-insert --save-profile)')
  const rows = parseCsv(readFileSync(path, 'utf8')).slice(0, 6)
  const width = Math.max(0, ...rows.map((r) => r.length))
  const headers = Array.from({ length: width }, (_, i) => rows[0]?.[i] ?? '')
  return readFileDescription({ headerValues: headers, headerLetters: headers.map((_, i) => columnLetter(i)), bodyValuesPreview: headers.map((_, i) => rows.slice(1).map((r) => r[i] ?? '')), fileBaseName: basename(path) })
}

/** A small RFC 4180 reader (quotes, doubled quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

/** `qqq bulk-profile`: saved bulk load profiles. */
function registerBulkProfile(program: Command, ctx: () => Context): void {
  const bp = program.command('bulk-profile').description('Saved bulk load profiles (column mappings kept by the server): list, show, save, rename, delete. Use one with `table bulk-insert --saved <name>`.')

  const setup = async (c: Context, table: string) => {
    const meta = await c.tableMeta<Json>(table)
    if (!savedBulkLoadProfilesAvailable(await c.metaData() as unknown as Json)) throw new UsageError('This server offers no saved bulk load profiles (the querySavedBulkLoadProfile, storeSavedBulkLoadProfile and deleteSavedBulkLoadProfile processes).')
    return { meta, fetchImpl: authenticatedFetch(c.target), me: await currentUserId(c) }
  }
  const guard = async <T>(f: () => Promise<T>): Promise<T> => {
    try {
      return await f()
    } catch (error) {
      if (error instanceof SavedBulkLoadProfileError || error instanceof BulkMappingError) throw new UsageError(error.message)
      throw error
    }
  }
  const mustOwn = (p: SavedBulkLoadProfile, me: string | undefined, verb: string) => {
    if (!isProfileOwner(p, me)) throw new UsageError(`"${p.label}" is shared with you by ${p.userId ?? 'another user'}; only its owner may ${verb} it.`)
  }

  bp.command('list <table>')
    .description('Your profiles for the table, then those shared with you.')
    .option('--edit', 'bulk-edit-with-file profiles instead of bulk insert ones')
    .action(async (table: string, options: { edit?: boolean }) => {
      const c = ctx()
      const { fetchImpl, me } = await setup(c, table)
      const profiles = await guard(() => listSavedBulkLoadProfiles(c.server, fetchImpl, table, Boolean(options.edit)))
      const rows = profiles.map((p) => ({ id: p.id, label: p.label, owner: isProfileOwner(p, me) ? 'you' : `shared by ${p.userId ?? '?'}`, layout: p.profile.layout ?? '', fields: (p.profile.fieldList ?? []).map((f) => f.fieldName).join(', ') }))
      const ordered = [...rows.filter((r) => r.owner === 'you'), ...rows.filter((r) => r.owner !== 'you')]
      c.print({ data: profiles, rows: ordered, columns: ['id', 'label', 'owner', 'layout', 'fields'], footer: countFooter(profiles.length, 'profile') })
    })

  bp.command('show <table> <profile>')
    .description('One profile: its fields and their columns, defaults and value mappings (--output yaml gives a --mapping document).')
    .option('--edit', 'a bulk-edit-with-file profile')
    .action(async (table: string, name: string, options: { edit?: boolean }) => {
      const c = ctx()
      const { fetchImpl, me } = await setup(c, table)
      const p = await guard(async () => findSavedBulkLoadProfile(await listSavedBulkLoadProfiles(c.server, fetchImpl, table, Boolean(options.edit)), name))
      const rows = (p.profile.fieldList ?? []).map((f) => ({ field: f.fieldName, source: f.headerName ? `column ${f.headerName}` : f.columnIndex !== undefined && f.columnIndex !== null ? `column ${columnLetter(f.columnIndex)}` : `default ${String(f.defaultValue ?? '')}`, options: [f.doValueMapping ? `map values${f.valueMappings ? ` (${Object.entries(f.valueMappings).map(([k, v]) => `${k}=${String(v)}`).join(', ')})` : ''}` : '', f.clearIfEmpty ? 'clear if empty' : ''].filter(Boolean).join('; ') }))
      c.print({ data: p, rows, columns: ['field', 'source', 'options'], footer: `${p.label} (${p.id}), ${isProfileOwner(p, me) ? 'yours' : `shared by ${p.userId ?? '?'}`}; layout ${p.profile.layout}; header row ${p.profile.hasHeaderRow === false ? 'no' : 'yes'}${p.profile.keyFields ? `; key ${p.profile.keyFields}` : ''}` })
    })

  bp.command('save <table>')
    .description('Save a mapping as a profile: --mapping (a document, read against --file\'s header row, or a v1 profile JSON). --replace updates your profile of that name after showing what changes.')
    .requiredOption('-n, --name <name>', 'the profile name')
    .requiredOption('--mapping <file>', 'the mapping document (YAML/JSON) or a v1 profile JSON')
    .option('-f, --file <csv>', 'a CSV with the header row the document names')
    .option('--edit', 'a bulk-edit-with-file profile')
    .option('--replace', 'update your profile with this name')
    .action(async (table: string, options: { name: string; mapping: string; file?: string; edit?: boolean; replace?: boolean }) => {
      const c = ctx()
      const { meta, fetchImpl, me } = await setup(c, table)
      const processName = bulkProcesses(meta, await c.metaData() as unknown as Json)[options.edit ? 'editWithFile' : 'insert']
      if (!processName) throw new UsageError(`${meta.label} offers no ${options.edit ? 'bulk edit with a file' : 'bulk insert'} to you.`)
      const structure = await tableStructureFor(c, processName, table)
      const doc = readMappingFile(options.mapping) as Json
      const file = options.file ? localFileDescription(options.file) : readFileDescription({ headerValues: [] })
      if (!Array.isArray(doc.fieldList) && !options.file) throw new UsageError('--file <csv> is needed to read a mapping document\'s column names (a v1 profile JSON needs none).')
      const mapping = await guard(async () => parseMappingDocument(doc, { ...structure, isBulkEdit: Boolean(options.edit) }, file))
      const profiles = await guard(() => listSavedBulkLoadProfiles(c.server, fetchImpl, table, Boolean(options.edit)))
      const same = profiles.filter((p) => p.label.toLowerCase() === options.name.toLowerCase())
      const mine = same.find((p) => isProfileOwner(p, me))
      if (mine && !options.replace) throw new UsageError(`You already have a profile "${mine.label}" (${mine.id}); pass --replace to update it.`)
      if (options.replace && !mine) {
        if (same.length) mustOwn(same[0]!, me, 'save over')
        throw new UsageError(`No profile of yours named "${options.name}" to replace.`)
      }
      if (mine) {
        const diff = diffMappings(mappingFromProfile(mine.profile, structure), mapping, structure, file)
        c.note(diff.length ? `Changes to "${mine.label}":\n  ${diff.join('\n  ')}` : `No changes to "${mine.label}".`)
        if (!await c.confirm(`Update the profile "${mine.label}"?`)) {
          c.note('Not saved.')
          return
        }
      }
      const stored = await guard(() => storeSavedBulkLoadProfile(c.server, fetchImpl, { table, label: options.name, isBulkEdit: Boolean(options.edit), profile: profileFromMapping(mapping), id: mine?.id }))
      c.print({ data: stored, rows: [{ id: stored.id, label: stored.label, saved: mine ? 'updated' : 'created' }], columns: ['id', 'label', 'saved'] })
    })

  bp.command('rename <table> <profile> <newName>')
    .description('Rename one of your profiles.')
    .option('--edit', 'a bulk-edit-with-file profile')
    .action(async (table: string, name: string, newName: string, options: { edit?: boolean }) => {
      const c = ctx()
      const { fetchImpl, me } = await setup(c, table)
      const profiles = await guard(() => listSavedBulkLoadProfiles(c.server, fetchImpl, table, Boolean(options.edit)))
      const p = await guard(async () => findSavedBulkLoadProfile(profiles, name))
      mustOwn(p, me, 'rename')
      if (profiles.some((o) => o.id !== p.id && isProfileOwner(o, me) && o.label.toLowerCase() === newName.toLowerCase())) throw new UsageError(`You already have a profile named "${newName}".`)
      const stored = await guard(() => storeSavedBulkLoadProfile(c.server, fetchImpl, { table, label: newName, isBulkEdit: p.isBulkEdit, profile: p.profile, id: p.id }))
      c.print({ data: stored, rows: [{ id: stored.id, label: stored.label, was: p.label }], columns: ['id', 'label', 'was'] })
    })

  bp.command('delete <table> <profile>')
    .description('Delete one of your profiles (asks unless --yes).')
    .option('--edit', 'a bulk-edit-with-file profile')
    .action(async (table: string, name: string, options: { edit?: boolean }) => {
      const c = ctx()
      const { fetchImpl, me } = await setup(c, table)
      const p = await guard(async () => findSavedBulkLoadProfile(await listSavedBulkLoadProfiles(c.server, fetchImpl, table, Boolean(options.edit)), name))
      mustOwn(p, me, 'delete')
      if (!await c.confirm(`Delete the bulk load profile "${p.label}" (${p.id})?`)) {
        c.note('Not deleted.')
        return
      }
      await guard(() => deleteSavedBulkLoadProfile(c.server, fetchImpl, p.id))
      c.note(`Deleted "${p.label}".`)
    })
}

/** The table structure a bulk process offers (init, read `tableStructure`, cancel). */
async function tableStructureFor(c: Context, processName: string, table: string): Promise<BulkLoadTableStructure> {
  const init = (await c.call('initProcess', { path: { processName }, form: { values: JSON.stringify({ tableName: table }), stepTimeoutMillis: '60000' } })).data as Json
  if (init.type !== 'COMPLETE') throw new ProcessError(String(init.userFacingError ?? init.error ?? 'the bulk process did not start'))
  await c.call('cancelProcess', { path: { processName, processUUID: String(init.processUUID) } }).catch(() => undefined)
  const structure = ((init.values ?? {}) as Json).tableStructure as BulkLoadTableStructure | undefined
  if (!structure) throw new ProcessError('the bulk process sent no table structure')
  return structure
}
