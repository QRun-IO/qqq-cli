/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Command } from 'commander'
import { AssociationError, FormInputError, FormSession, buildFilter, parentLinkValues, printFilter, relatedRecordTarget, type FieldMeta, type QueryFilter, type RecordLike, type TableMetaLike } from '@qrun-io/qqq-core'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { promptForm } from '../prompt.js'
import { authenticatedFetch } from '../session.js'
import { UsageError, type Context } from '../context.js'
import { defaultFields, labelsFor, parsePairs, readJson, valueText, type Json } from './shared.js'
import { getRecord, showRecord } from './related.js'

interface QueryOptions { where?: string[]; group?: string[]; or?: boolean; order?: string[]; limit: string; skip?: string; all?: boolean; pageSize: string; fields?: string; filterJson?: string; printFilter?: boolean; count?: boolean }

async function tableMeta(c: Context, table: string): Promise<Json> {
  return c.tableMeta<Json>(table)
}

function filterFrom(options: QueryOptions, meta: Json): QueryFilter {
  if (options.filterJson) return readJson(options.filterJson, '--filter-json') as QueryFilter
  return buildFilter({ where: options.where, group: options.group, or: options.or, order: options.order, knownFields: Object.keys((meta.fields ?? {}) as Json) })
}

export function registerTable(program: Command, ctx: () => Context): void {
  const table = program.command('table').description('Tables: list, describe, query, count, get, create, update, delete, export.')

  table.command('list')
    .description('List the tables you may read (optionally of one app).')
    .option('-a, --app <name>', 'only tables in this app')
    .action(async (options: { app?: string }) => {
      const c = ctx()
      const metaData = await c.metaData() as unknown as Json
      let tables = Object.values((metaData.tables ?? {}) as Record<string, Json>).filter((t) => !t.isHidden && t.readPermission !== false)
      if (options.app) {
        const app = (metaData.apps as Record<string, Json> | undefined)?.[options.app]
        if (!app) throw new UsageError(`No app named ${options.app} (see \`qqq apps\`)`)
        const names = new Set<unknown>()
        const visit = (node: Json | undefined, seen: Set<unknown>) => {
          for (const child of (node?.children ?? []) as Json[]) {
            if (child.type === 'TABLE') names.add(child.name)
            else if (child.type === 'APP' && !seen.has(child.name)) visit((metaData.apps as Record<string, Json>)[String(child.name)], seen.add(child.name))
          }
        }
        visit(app, new Set([options.app]))
        tables = tables.filter((t) => names.has(t.name))
      }
      const rows = tables.map((t) => ({ name: t.name, label: t.label, insert: t.insertPermission ? 'yes' : '', edit: t.editPermission ? 'yes' : '', delete: t.deletePermission ? 'yes' : '' }))
        .sort((a, b) => String(a.label).localeCompare(String(b.label)))
      c.print({ data: rows, columns: ['name', 'label', 'insert', 'edit', 'delete'] })
    })

  table.command('describe <table>')
    .description("A table's fields, sections and capabilities.")
    .action(async (name: string) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const fields = Object.values((meta.fields ?? {}) as Record<string, Json>).map((f) => ({
        name: f.name, label: f.label, type: f.type, required: f.isRequired ? 'yes' : '', editable: f.isEditable === false ? 'no' : 'yes',
        possibleValues: f.possibleValueSourceName ?? '', hidden: f.isHidden ? 'yes' : '',
      }))
      const sections = ((meta.sections ?? []) as Json[]).map((s) => `${s.tier} ${s.label}: ${((s.fieldNames ?? []) as string[]).join(', ')}`).join('\n')
      c.print({ data: meta, rows: fields, columns: ['name', 'label', 'type', 'required', 'editable', 'possibleValues', 'hidden'], footer: `${meta.label} (${meta.name}), primary key ${meta.primaryKeyField}\n${sections}\ncapabilities: ${((meta.capabilities ?? []) as string[]).join(', ')}` })
    })

  const query = table.command('query <table>')
    .description('Query a table. Criteria: "field OPERATOR value[,value]" (operators as the UI API, or = != < <= > >= ~); values may be now(-7d), thisPeriod(month), startOf(quarter,-1), me(), ${variable.x}.')
    .option('-w, --where <criteria...>', 'criteria, ANDed (or --or)')
    .option('-g, --group <expression...>', 'a group with AND/OR and parentheses, e.g. "(a = 1 AND b = 2) OR c IS_BLANK"')
    .option('--or', 'OR the --where criteria instead of AND')
    .option('-o, --order <field...>', 'order by fields; prefix - for descending')
    .option('-l, --limit <n>', 'most records to return', '25')
    .option('--skip <n>', 'records to skip')
    .option('--all', 'fetch every page (with --page-size)')
    .option('--page-size <n>', 'page size for --all', '500')
    .option('-f, --fields <names>', 'comma-separated fields to show')
    .option('--filter-json <json|file|->', 'a QueryFilter as JSON, instead of --where/--group/--order')
    .option('--print-filter', 'print the QueryFilter JSON the options produced and stop')
    .option('--count', 'print only the count of matching records')
    .action(async (name: string, options: QueryOptions) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const filter = filterFrom(options, meta)
      if (options.printFilter) {
        c.print({ data: filter })
        return
      }
      if (options.count) {
        const result = await c.unwrap(c.client.POST('/qqq/v1/table/{tableName}/count', { params: { path: { tableName: name }, query: { includeDistinct: false } }, body: { filter: filter as never } })) as Json
        c.print({ data: result, rows: [{ count: result.count }], columns: ['count'] })
        return
      }
      const records: Json[] = []
      const limit = options.all ? Number(options.pageSize) : Number(options.limit)
      let skip = Number(options.skip ?? 0)
      for (;;) {
        const body = { filter: { ...filter, skip, limit } as never }
        const result = await c.unwrap(c.client.POST('/qqq/v1/table/{tableName}/query', { params: { path: { tableName: name } }, body })) as Json
        const page = (result.records ?? []) as Json[]
        records.push(...page)
        if (!options.all || page.length < limit) break
        skip += limit
      }
      const fields = c.fields ?? (options.fields ? options.fields.split(',') : defaultFields(meta))
      const rows = records.map((r) => Object.fromEntries(fields.map((f) => [f, valueText(r, f)])))
      c.print({ data: records, rows, columns: fields, headers: labelsFor(meta, fields), footer: `(${records.length} record${records.length === 1 ? '' : 's'}${filter.criteria.length || filter.subFilters?.length ? `; filter: ${printFilter(filter)}` : ''}${!options.all && records.length === limit ? '; more may exist: --limit, --skip or --all' : ''})` })
    })

  table.command('count <table>')
    .description('Count the records matching criteria.')
    .option('-w, --where <criteria...>', 'criteria, ANDed (or --or)')
    .option('-g, --group <expression...>', 'a group with AND/OR and parentheses')
    .option('--or', 'OR the --where criteria')
    .option('--filter-json <json|file|->', 'a QueryFilter as JSON')
    .action(async (name: string, options: QueryOptions) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const filter = filterFrom(options, meta)
      const result = await c.unwrap(c.client.POST('/qqq/v1/table/{tableName}/count', { params: { path: { tableName: name }, query: { includeDistinct: false } }, body: { filter: filter as never } })) as Json
      c.print({ data: result, rows: [{ count: result.count }], columns: ['count'] })
    })

  table.command('get <table> <primaryKey>')
    .description('View one record by section, values through their adornments (links, chips, masked values, files); --associations adds the child records.')
    .option('--associations', 'list every association (child records, all levels) as tables')
    .option('--follow <field>', 'open the record a link or possible-value field points at, instead of this one')
    .option('--links', 'list the related records this record links to (fields, tables, keys)')
    .option('--reveal', 'show REVEAL (masked) values')
    .option('--help-content', 'show table, section and field help content')
    .action(async (name: string, primaryKey: string, options: { associations?: boolean; follow?: string; links?: boolean; reveal?: boolean; helpContent?: boolean }) => {
      const c = ctx()
      if (options.follow) {
        const meta = await tableMeta(c, name)
        const field = ((meta.fields ?? {}) as Record<string, FieldMeta>)[options.follow]
        if (!field) throw new UsageError(`No field "${options.follow}" in ${name}`)
        const record = await getRecord(c, name, primaryKey, false)
        const target = relatedRecordTarget(field, record as unknown as RecordLike, Object.keys((await c.metaData()).tables ?? {}))
        if (!target) throw new UsageError(`${meta.label} ${primaryKey}: ${field.label} links to no record (empty, or not a link or possible-value field)`)
        c.note(`${field.label} → ${target.tableName} ${target.primaryKey}`)
        await showRecord(c, target.tableName, target.primaryKey, { associations: options.associations, links: options.links, reveal: options.reveal, helpContent: options.helpContent })
        return
      }
      await showRecord(c, name, primaryKey, options)
    })

  /** Fills a form session from --set / --input-json, then prompts when asked or when required values are missing on a terminal. */
  async function fillForm(c: Context, meta: Json, name: string, given: Json, options: { interactive?: boolean }, initial?: Json): Promise<FormSession> {
    const fields = Object.values((meta.fields ?? {}) as Record<string, FieldMeta>)
    for (const k of Object.keys(given)) if (!(meta.fields as Json)[k]) throw new UsageError(`No field "${k}" in ${name}; fields: ${Object.keys(meta.fields as Json).join(', ')}`)
    const session = new FormSession({ baseUrl: c.server, fetch: authenticatedFetch(c.target), scope: { table: name }, fields, initialValues: initial, tableMeta: meta as never, exclude: initial ? [] : [String(meta.primaryKeyField)] })
    await session.load()
    for (const k of session.promptOrder(Object.keys(given))) {
      try {
        await session.set(k, given[k])
      } catch (error) {
        if (error instanceof FormInputError) throw new UsageError(error.message)
        throw error
      }
    }
    if (options.interactive) await promptForm(session, { skipSet: true })
    return session
  }

  function validationError(session: FormSession, problems: Record<string, string>): never {
    throw new UiApiError(400, { code: 'BAD_REQUEST', message: 'Validation failed before sending', fieldErrors: Object.entries(problems).map(([field, message]) => ({ field, message: `${session.fields[field]?.label ?? field} ${message}` })) })
  }

  /** `--upload field=path` pairs as files, checked against the table's fields. */
  function readUploads(meta: Json, pairs: string[] | undefined): Record<string, File> {
    const out: Record<string, File> = {}
    const fields = (meta.fields ?? {}) as Record<string, Json>
    for (const [field, path] of Object.entries(parsePairs(pairs, '--upload'))) {
      if (!fields[field]) throw new UsageError(`No field "${field}" in ${String(meta.name)}`)
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(readFileSync(path))
      } catch (error) {
        throw new UsageError(`--upload ${field}: cannot read ${path} (${error instanceof Error ? error.message : String(error)})`)
      }
      out[field] = new File([bytes as BlobPart], basename(path))
    }
    return out
  }

  /** The multipart record body (the Next UI's recordFormData): text fields as strings, null as an empty value (a clear), files as parts. */
  function multipartRecord(values: Json, files: Record<string, File>): Record<string, string | Blob> {
    const form: Record<string, string | Blob> = {}
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined || files[key]) continue
      form[key] = value === null ? '' : Array.isArray(value) || typeof value === 'object' ? JSON.stringify(value) : String(value)
    }
    return { ...form, ...files }
  }

  table.command('create <table>')
    .description('Insert a record from --set name=value pairs or --input-json; -i prompts for the rest. Possible-value fields take a label or an id.')
    .option('-s, --set <name=value...>', 'field values')
    .option('--input-json <json|file|->', 'the whole record as a JSON object of field values')
    .option('-i, --interactive', 'prompt for fields on the terminal')
    .option('--generate-input-skeleton', 'print an empty JSON object with the editable fields and stop')
    .option('--parent <table=primaryKey>', 'create a child record linked to this parent (through the parent table\'s association)')
    .option('--association <name>', 'with --parent: the association, when the parent has several to this table')
    .option('-u, --upload <field=path...>', 'a file for a file field (sent as multipart/form-data)')
    .action(async (name: string, options: { set?: string[]; inputJson?: string; interactive?: boolean; generateInputSkeleton?: boolean; parent?: string; association?: string; upload?: string[] }) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const fields = (meta.fields ?? {}) as Record<string, Json>
      if (options.generateInputSkeleton) {
        const editable = Object.values(fields).filter((f) => f.isEditable !== false && !f.isHidden && f.name !== meta.primaryKeyField)
        c.print({ data: Object.fromEntries(editable.map((f) => [f.name, f.defaultValue ?? ''])) })
        c.note(editable.map((f) => `${String(f.name).padEnd(24)} ${f.type}${f.isRequired ? ' required' : ''}${f.possibleValueSourceName ? ` (possible values: ${f.possibleValueSourceName}${Array.isArray(f.possibleValueSourceDependsOn) ? `, depends on ${(f.possibleValueSourceDependsOn as string[]).join(', ')}` : ''})` : ''}`).join('\n'))
        return
      }
      const given: Json = { ...(options.inputJson ? readJson(options.inputJson, '--input-json') as Json : {}), ...parsePairs(options.set, '--set') }
      const uploads = readUploads(meta, options.upload)
      let parentNote = ''
      if (options.parent) {
        const at = options.parent.indexOf('=')
        if (at < 1) throw new UsageError(`--parent takes table=primaryKey: ${options.parent}`)
        const parentName = options.parent.slice(0, at)
        const parentKey = options.parent.slice(at + 1)
        const parentMeta = await c.tableMeta<TableMetaLike>(parentName)
        const parent = await getRecord(c, parentName, parentKey, false) as unknown as RecordLike
        let link: ReturnType<typeof parentLinkValues>
        try {
          link = parentLinkValues(parentMeta, parent, meta as unknown as TableMetaLike, options.association)
        } catch (error) {
          if (error instanceof AssociationError) throw new UsageError(error.message)
          throw error
        }
        for (const [field, value] of Object.entries(link.values)) {
          if (given[field] !== undefined && String(given[field]) !== String(value)) throw new UsageError(`--set ${field}=${String(given[field])} contradicts --parent ${options.parent} (${field} is ${String(value)})`)
          given[field] = String(value)
        }
        parentNote = `${parentMeta.label ?? parentName} ${parentKey}${parent.recordLabel ? ` (${parent.recordLabel})` : ''}, association ${link.association.name}`
      }
      if (!Object.keys(given).length && !Object.keys(uploads).length && !options.interactive) throw new UsageError('Give field values with --set name=value or --input-json, or prompt with -i.')
      const session = await fillForm(c, meta, name, given, options)
      const problems = session.validate(Object.keys(uploads).length ? Object.keys(session.fields).filter((n) => !uploads[n]) : undefined)
      if (Object.keys(problems).length) validationError(session, problems)
      const result = Object.keys(uploads).length
        ? (await c.call('insertRecord', { path: { tableName: name }, form: multipartRecord(session.submission(), uploads) })).data as Json
        : await c.unwrap(c.client.POST('/qqq/v1/table/{tableName}', { params: { path: { tableName: name } }, body: session.submission() as never })) as Json
      const record = (result.record ?? result) as Json
      const pk = (record.values as Json | undefined)?.[String(meta.primaryKeyField)] ?? record[String(meta.primaryKeyField)] ?? ''
      c.print({ data: result, rows: [{ created: `${meta.label} ${pk}`, label: record.recordLabel ?? '', ...(parentNote ? { parent: parentNote } : {}) }], columns: parentNote ? ['created', 'label', 'parent'] : ['created', 'label'] })
    })

  table.command('update <table> <primaryKey>')
    .description('Update fields of a record from --set name=value pairs or --input-json; -i prompts with the current values.')
    .option('-s, --set <name=value...>', 'field values (an empty value clears the field)')
    .option('--input-json <json|file|->', 'field values as a JSON object')
    .option('-i, --interactive', 'prompt for every editable field, current values shown')
    .option('--expected-version <v>', 'optimistic locking: fail when the record changed')
    .option('-u, --upload <field=path...>', 'replace a file field with this file (multipart/form-data); --set field= removes the file')
    .action(async (name: string, primaryKey: string, options: { set?: string[]; inputJson?: string; interactive?: boolean; expectedVersion?: string; upload?: string[] }) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const given = { ...(options.inputJson ? readJson(options.inputJson, '--input-json') as Json : {}), ...parsePairs(options.set, '--set') }
      const uploads = readUploads(meta, options.upload)
      if (!Object.keys(given).length && !Object.keys(uploads).length && !options.interactive) throw new UsageError('Give field values with --set name=value or --input-json, or prompt with -i.')
      let initial: Json | undefined
      if (options.interactive) {
        const existing = await c.unwrap(c.client.GET('/qqq/v1/table/{tableName}/{primaryKey}', { params: { path: { tableName: name, primaryKey }, query: {} as never } })) as Json
        initial = ((existing.record ?? existing) as Json).values as Json
      }
      const session = await fillForm(c, meta, name, given, { interactive: false }, initial)
      if (options.interactive) await promptForm(session, { skipSet: false })
      const touched = options.interactive ? session.editable.map((f) => f.name).filter((n) => String(session.values[n] ?? '') !== String(initial?.[n] ?? '')) : Object.keys(given)
      if (!touched.length && !Object.keys(uploads).length) {
        c.note('Nothing changed.')
        return
      }
      const problems = session.validate(touched)
      if (Object.keys(problems).length) validationError(session, problems)
      const values = Object.fromEntries(touched.map((n) => [n, session.values[n] ?? null]))
      const result = Object.keys(uploads).length
        ? (await c.call('updateRecord', { path: { tableName: name, primaryKey }, query: { expectedVersion: options.expectedVersion }, form: multipartRecord(values, uploads) })).data as Json
        : await c.unwrap(c.client.PATCH('/qqq/v1/table/{tableName}/{primaryKey}', { params: { path: { tableName: name, primaryKey }, query: { expectedVersion: options.expectedVersion } as never }, body: values as never })) as Json
      const record = (result.record ?? result) as Json
      c.print({ data: result, rows: [{ updated: `${meta.label} ${primaryKey}`, label: record.recordLabel ?? '', fields: [...touched, ...Object.keys(uploads)].join(', ') }], columns: ['updated', 'label', 'fields'] })
    })

  table.command('delete <table> <primaryKey>')
    .description('Delete a record (asks first; --yes skips the question).')
    .action(async (name: string, primaryKey: string) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      if (!await c.confirm(`Delete ${meta.label} ${primaryKey}?`)) {
        c.note('Not deleted.')
        return
      }
      const result = await c.unwrap(c.client.DELETE('/qqq/v1/table/{tableName}/{primaryKey}', { params: { path: { tableName: name, primaryKey } } })) as Json
      c.print({ data: result ?? {}, rows: [{ deleted: `${meta.label} ${primaryKey}` }], columns: ['deleted'] })
    })

  table.command('export <table>')
    .description('Export matching records to a file (csv, xlsx, json, tsv).')
    .option('-w, --where <criteria...>', 'criteria, ANDed (or --or)')
    .option('-g, --group <expression...>', 'a group with AND/OR and parentheses')
    .option('--or', 'OR the --where criteria')
    .option('-o, --order <field...>', 'order by fields; prefix - for descending')
    .option('--filter-json <json|file|->', 'a QueryFilter as JSON')
    .option('--format <fmt>', 'csv, xlsx, json or tsv', 'csv')
    .option('-f, --fields <names>', 'comma-separated fields to include')
    .option('-l, --limit <n>', 'most records')
    .option('--out <file>', 'output file (default: <table>.<format>)')
    .action(async (name: string, options: QueryOptions & { format: string; out?: string }) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const filter = filterFrom(options, meta)
      const out = options.out ?? `${name}.${options.format}`
      const result = await c.call('exportTable', { path: { tableName: name }, json: { format: options.format, filter, fieldNames: options.fields ? options.fields.split(',') : undefined, limit: options.limit ? Number(options.limit) : undefined } })
      const bytes = result.bytes ?? new TextEncoder().encode(typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
      writeFileSync(out, bytes)
      c.note(`wrote ${out} (${bytes.length} bytes, ${result.contentType})`)
    })

  // flat aliases, kept from 0.1
  program.command('tables', { hidden: true }).description('Alias of `table list`.').option('-a, --app <name>').action(async (options: { app?: string }) => { await table.commands.find((x) => x.name() === 'list')!.parseAsync([...(options.app ? ['--app', options.app] : [])], { from: 'user' }) })
}
