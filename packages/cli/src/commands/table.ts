/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { writeFileSync } from 'node:fs'
import type { Command } from 'commander'
import { FormInputError, FormSession, JoinError, buildFilter, combineWithQuickSearch, copyRecordValues, SavedViewError, associationJoin, columnStatsAvailability, findSavedView, listSavedViews, savedViewProcesses, viewToQuery, computeColumnStats, runColumnStats, defaultJoinColumns, exposedJoins, fieldLabel, findRecordByKey, gotoKeys, isGotoKey, joinFieldNames, planJoins, printFilter, quickSearchFields, quickSearchFilter, resolveField, listTableVariants, variantBody, variantParam, type ExposedJoin, type FieldMeta, type QueryFilter, type QueryJoin } from '@qrun-io/qqq-core'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { promptForm } from '../prompt.js'
import { authenticatedFetch } from '../session.js'
import { UsageError, type Context } from '../context.js'
import { defaultFields, parsePairs, readJson, valueText, type Json } from './shared.js'
import { chooseVariant, VARIANT_OPTION } from './variants.js'

interface QueryOptions { where?: string[]; group?: string[]; or?: boolean; order?: string[]; limit?: string; skip?: string; all?: boolean; pageSize: string; fields?: string; filterJson?: string; printFilter?: boolean; count?: boolean; search?: string; variant?: string; join?: string[]; select?: boolean; view?: string }

/** The formats the export route writes. */
const EXPORT_FORMATS = ['csv', 'xlsx', 'json', 'tsv']

/**
 * The joins a command may use: the table's exposed joins, plus, when a join is asked for that is not
 * exposed, the table's associations (each joined table's metadata fetched).
 */
async function availableJoins(c: Context, meta: Json, options: { join?: string[]; where?: string[]; group?: string[]; order?: string[]; filterJson?: string }, columns?: string[]): Promise<ExposedJoin[]> {
  const exposed = exposedJoins(meta, (await c.metaData() as unknown as Json).tables as Record<string, Json> | undefined)
  const text = [...(options.join ?? []), ...(columns ?? []), ...(options.where ?? []), ...(options.group ?? []), ...(options.order ?? []), options.filterJson ?? ''].join(' ')
  const wanted = (meta.associations ?? []) as Json[]
  const extra: ExposedJoin[] = []
  for (const association of wanted) {
    const table = String(association.associatedTableName ?? '')
    if (!table || exposed.some((j) => j.table === table) || extra.some((j) => j.table === table)) continue
    if (!(options.join ?? []).includes(table) && !text.includes(`${table}.`)) continue
    const join = associationJoin(association, await c.tableMeta<Json>(table))
    if (join) extra.push(join)
  }
  return [...exposed, ...extra]
}

async function tableMeta(c: Context, table: string): Promise<Json> {
  return c.tableMeta<Json>(table)
}

function filterFrom(options: QueryOptions, meta: Json, columns?: string[], joins: ExposedJoin[] = []): QueryFilter {
  const knownFields = [...Object.keys((meta.fields ?? {}) as Json), ...joinFieldNames(joins)]
  const filter = options.filterJson ? readJson(options.filterJson, '--filter-json') as QueryFilter
    : buildFilter({ where: options.where, group: options.group, or: options.or, order: options.order, knownFields })
  if (options.search === undefined) return filter
  // quick search as the web UI does it: CONTAINS on each shown string field, ORed, ANDed onto the filter
  const fields = quickSearchFields(meta, columns)
  if (!fields.length) throw new UsageError(`--search: ${meta.label} has no text fields to search${columns ? ' among --fields' : ''}`)
  return combineWithQuickSearch(filter, quickSearchFilter(options.search, fields))
}

/** The joins a query or count needs (--join, plus joined names in columns and the filter). */
function joinsFrom(options: QueryOptions, available: ExposedJoin[], columns: string[] | undefined, filter: QueryFilter): { joins?: QueryJoin[]; used: ExposedJoin[]; includeDistinct: boolean } {
  try {
    const plan = planJoins(available, { named: options.join, select: options.select, columns, filter })
    return { ...(plan.joins.length ? { joins: plan.joins } : {}), used: plan.used, includeDistinct: plan.includeDistinct }
  } catch (error) {
    if (error instanceof JoinError) throw new UsageError(error.message)
    throw error
  }
}

/** Prints a count, with the distinct count when a many-side join can repeat records. */
function printCount(c: Context, result: Json, includeDistinct: boolean): void {
  const row: Json = { count: result.count }
  if (includeDistinct) row.distinctCount = result.distinctCount ?? ''
  c.print({ data: result, rows: [row], columns: Object.keys(row) })
}

/** Opens a saved view for a query: the view's filter, columns and page size, with Material's reconcile warnings on stderr. */
async function openSavedView(c: Context, meta: Json, idOrName: string): Promise<{ label: string; filter: QueryFilter; columns: string[]; rowsPerPage?: number }> {
  const metaData = await c.metaData() as unknown as Json
  const processes = savedViewProcesses(meta, metaData)
  try {
    const view = findSavedView(await listSavedViews(c.server, authenticatedFetch(c.target), processes, String(meta.name)), idOrName)
    const joins = await availableJoins(c, meta, { filterJson: JSON.stringify(view.view) })
    const opened = viewToQuery(meta, joins, view.view)
    for (const warning of opened.warnings) c.note(`warning: ${warning}`)
    return { label: view.label, ...opened }
  } catch (error) {
    if (error instanceof SavedViewError) throw new UsageError(error.message)
    throw error
  }
}

/** ANDs the command's criteria onto a view's filter; the command's sort replaces the view's. */
function withSavedView(view: QueryFilter | undefined, given: QueryFilter): QueryFilter {
  if (!view) return given
  const { orderBys: viewOrder, ...viewRest } = view
  const { orderBys: givenOrder, ...givenRest } = given
  const orderBys = givenOrder?.length ? givenOrder : viewOrder
  const empty = (f: Partial<QueryFilter>) => !f.criteria?.length && !f.subFilters?.length
  const base: QueryFilter = empty(givenRest) ? viewRest as QueryFilter : empty(viewRest) ? givenRest as QueryFilter : { criteria: [], booleanOperator: 'AND', subFilters: [viewRest as QueryFilter, givenRest as QueryFilter] }
  return orderBys?.length ? { ...base, orderBys } : base
}

/** --fields of the command (or the global one), as a list. */
function columnsFrom(c: Context, options: { fields?: string }): string[] | undefined {
  return c.fields ?? (options.fields ? options.fields.split(',').map((f) => f.trim()).filter(Boolean) : undefined)
}

export function registerTable(program: Command, ctx: () => Context): void {
  const table = program.command('table').description('Tables: list, describe, variants, query, count, stats, get, create, copy, update, delete, export.')

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

  table.command('variants <table>')
    .description('The variants a table\'s backend can be scoped to (give one to other commands with --variant).')
    .action(async (name: string) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const variants = await listTableVariants(c.server, authenticatedFetch(c.target), name)
      c.print({ data: variants, rows: variants.map((v) => ({ id: v.id, name: v.name ?? '', type: v.type })), columns: ['id', 'name', 'type'], footer: meta.usesVariants ? `${meta.label} needs a ${String(meta.variantTableLabel ?? 'variant')}: --variant <id|name>` : `${meta.label} does not use variants${variants.length ? '' : ' (none listed)'}` })
    })

  const query = table.command('query <table>')
    .description('Query a table. Criteria: "field OPERATOR value[,value]" (operators as the UI API, or = != < <= > >= ~); values may be now(-7d), thisPeriod(month), startOf(quarter,-1), me(), ${variable.x}.')
    .option('-w, --where <criteria...>', 'criteria, ANDed (or --or)')
    .option('-g, --group <expression...>', 'a group with AND/OR and parentheses, e.g. "(a = 1 AND b = 2) OR c IS_BLANK"')
    .option('--or', 'OR the --where criteria instead of AND')
    .option('-o, --order <field...>', 'order by fields; prefix - for descending')
    .option('-l, --limit <n>', 'most records to return (default: the view\'s page size, else 25)')
    .option('--skip <n>', 'records to skip')
    .option('--all', 'fetch every page (with --page-size)')
    .option('--page-size <n>', 'page size for --all', '500')
    .option('-f, --fields <names>', 'comma-separated fields to show')
    .option('--filter-json <json|file|->', 'a QueryFilter as JSON, instead of --where/--group/--order')
    .option('--print-filter', 'print the QueryFilter JSON the options produced and stop')
    .option('--count', 'print only the count of matching records')
    .option('-S, --search <text>', 'quick search: records whose text fields contain this, ANDed with the filter (as the web UI search box)')
    .option('-V, --view <id|name>', 'start from a saved view: its filter, sort, columns and page size (--where and --search are ANDed on, --order and --fields replace)')
    .option('-j, --join <table...>', 'join exposed joins (by joined table name or label); joined fields are named table.field in --fields, --where and --order')
    .option('--select', 'select the --join tables\' fields (shown columns from a join select it anyway)')
    .option(...VARIANT_OPTION)
    .action(async (name: string, options: QueryOptions) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const saved = options.view !== undefined ? await openSavedView(c, meta, options.view) : undefined
      const given = columnsFrom(c, options) ?? (saved?.columns.length ? saved.columns : undefined)
      const available = await availableJoins(c, meta, { ...options, filterJson: `${options.filterJson ?? ''} ${saved ? JSON.stringify(saved.filter) : ''}` }, given)
      const filter = withSavedView(saved?.filter, filterFrom(options, meta, given, available))
      const { joins, used, includeDistinct } = joinsFrom(options, available, given, filter)
      if (options.printFilter) {
        c.print({ data: joins ? { filter, joins } : filter })
        return
      }
      const variant = await chooseVariant(c, meta, options.variant)
      if (options.count) {
        const result = await c.unwrap(c.client.POST('/qqq/v1/table/{tableName}/count', { params: { path: { tableName: name }, query: { includeDistinct } }, body: { filter: filter as never, ...(joins ? { joins: joins as never } : {}), ...variantBody(variant) } })) as Json
        printCount(c, result, includeDistinct)
        return
      }
      const records: Json[] = []
      const limit = options.all ? Number(options.pageSize) : Number(options.limit ?? saved?.rowsPerPage ?? 25)
      let skip = Number(options.skip ?? 0)
      for (;;) {
        const body = { filter: { ...filter, skip, limit } as never, ...(joins ? { joins: joins as never } : {}), ...variantBody(variant) }
        const result = await c.unwrap(c.client.POST('/qqq/v1/table/{tableName}/query', { params: { path: { tableName: name } }, body })) as Json
        const page = (result.records ?? []) as Json[]
        records.push(...page)
        if (!options.all || page.length < limit) break
        skip += limit
      }
      const selected = used.filter((j) => joins?.find((q) => q.joinTable === j.table)?.select || options.select)
      const fields = given ?? [...defaultFields(meta), ...selected.flatMap((j) => defaultJoinColumns(j))]
      const joinsShown = used.map((j) => j.table)
      const rows = records.map((r) => Object.fromEntries(fields.map((f) => [f, valueText(r, f)])))
      c.print({ data: records, rows, columns: fields, headers: fields.map((f) => fieldLabel(meta, used, f)), footer: `(${records.length} record${records.length === 1 ? '' : 's'}${joinsShown.length ? `; joined: ${joinsShown.join(', ')}${includeDistinct ? ' (many-side: rows may repeat a record; --count gives the distinct count)' : ''}` : ''}${variant ? `; variant ${variant.name ?? `${variant.type}:${variant.id}`}` : ''}${saved ? `; view ${saved.label}` : ''}${filter.criteria?.length || filter.subFilters?.length ? `; filter: ${printFilter(filter)}` : ''}${!options.all && records.length === limit ? '; more may exist: --limit, --skip or --all' : ''})` })
    })

  table.command('stats <table> <field>')
    .description('Column statistics over the matching records: count, distinct, sum, average, min, max, and the distribution of values (the server\'s columnStats process; tables need QUERY_STATS).')
    .option('-w, --where <criteria...>', 'criteria, ANDed (or --or)')
    .option('-g, --group <expression...>', 'a group with AND/OR and parentheses')
    .option('--or', 'OR the --where criteria')
    .option('--filter-json <json|file|->', 'a QueryFilter as JSON')
    .option('-S, --search <text>', 'quick search over the text fields, ANDed with the filter')
    .option('-j, --join <table...>', 'join exposed joins (the field may be table.field)')
    .option('--sort <order>', 'distribution order: count (default, most first), count-asc, value, value-desc', 'count')
    .option('-l, --limit <n>', 'most distribution rows to show', '25')
    .option('--local', 'when the server offers no statistics, compute them here from the matching records (paged)')
    .option('--max-records <n>', 'with --local, the most records to read', '100000')
    .option(...VARIANT_OPTION)
    .action(async (name: string, field: string, options: QueryOptions & { sort: string; local?: boolean; maxRecords: string }) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const available = await availableJoins(c, meta, { ...options, join: [...(options.join ?? []), ...(field.includes('.') ? [field.slice(0, field.indexOf('.'))] : [])] }, [field])
      const resolved = resolveField(meta, available, field)
      if (!resolved) throw new UsageError(`No field "${field}" in ${name}`)
      const filter = filterFrom(options, meta, undefined, available)
      const orderField = { count: 'count.desc', 'count-asc': 'count.asc', value: `${field}.asc`, 'value-desc': `${field}.desc` }[options.sort]
      if (!orderField) throw new UsageError('--sort takes count, count-asc, value or value-desc')
      const variant = await chooseVariant(c, meta, options.variant)
      const availability = columnStatsAvailability(meta, await c.metaData() as unknown as Json)
      let stats
      if (availability.available) {
        stats = await runColumnStats(c.server, authenticatedFetch(c.target), { table: name, field, filter, orderBy: orderField, tableVariant: variant })
      } else if (options.local) {
        const { joins } = joinsFrom(options, available, [field], filter)
        const records: Json[] = []
        const pageSize = 1000
        const max = Number(options.maxRecords)
        for (let skip = 0; skip < max; skip += pageSize) {
          const body = { filter: { ...filter, skip, limit: Math.min(pageSize, max - skip) } as never, ...(joins ? { joins: joins as never } : {}), ...variantBody(variant) }
          const page = ((await c.unwrap(c.client.POST('/qqq/v1/table/{tableName}/query', { params: { path: { tableName: name } }, body })) as Json).records ?? []) as Json[]
          records.push(...page)
          if (page.length < pageSize) break
        }
        if (records.length >= max) c.note(`note: stopped at --max-records ${max}; the statistics cover those records only`)
        stats = computeColumnStats(records, field, resolved.field, orderField)
      } else {
        throw new UsageError(`No column statistics: ${availability.reason}. --local computes them here from the matching records.`)
      }
      const label = fieldLabel(meta, available, field)
      const limit = Number(options.limit)
      const distribution = stats.valueCounts.slice(0, limit).map((r) => ({ value: r.displayValues[field] ?? r.values[field] ?? '', count: r.values.count }))
      if (c.format === 'json' || c.format === 'yaml' || c.options.query) {
        c.print({ data: { field, label, ...stats } })
        return
      }
      c.print({ data: stats, rows: stats.fields.map((f) => ({ statistic: f.label, value: stats.stats.displayValues[f.name] ?? stats.stats.values[f.name] ?? '' })), columns: ['statistic', 'value'], footer: `${meta.label}: ${label}${resolved.field.type === 'DATE_TIME' ? ' (grouped by hour)' : ''}${availability.available ? '' : ' (computed locally)'}` })
      c.print({ data: stats.valueCounts, rows: distribution, columns: ['value', 'count'], headers: [label, 'Count'], footer: stats.valueCounts.length > limit ? `(${limit} of ${stats.valueCounts.length} values; --limit for more)` : `(${stats.valueCounts.length} value${stats.valueCounts.length === 1 ? '' : 's'})` })
    })

  table.command('count <table>')
    .description('Count the records matching criteria.')
    .option('-w, --where <criteria...>', 'criteria, ANDed (or --or)')
    .option('-g, --group <expression...>', 'a group with AND/OR and parentheses')
    .option('--or', 'OR the --where criteria')
    .option('--filter-json <json|file|->', 'a QueryFilter as JSON')
    .option('-S, --search <text>', 'quick search over the text fields, ANDed with the filter')
    .option('-j, --join <table...>', 'join exposed joins (by joined table name or label); joined fields are named table.field in --fields, --where and --order')
    .option('--select', 'select the --join tables\' fields (shown columns from a join select it anyway)')
    .option(...VARIANT_OPTION)
    .action(async (name: string, options: QueryOptions) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const available = await availableJoins(c, meta, options)
      const filter = filterFrom(options, meta, undefined, available)
      const { joins, includeDistinct } = joinsFrom(options, available, undefined, filter)
      const variant = await chooseVariant(c, meta, options.variant)
      const result = await c.unwrap(c.client.POST('/qqq/v1/table/{tableName}/count', { params: { path: { tableName: name }, query: { includeDistinct } }, body: { filter: filter as never, ...(joins ? { joins: joins as never } : {}), ...variantBody(variant) } })) as Json
      printCount(c, result, includeDistinct)
    })

  table.command('get <table> [primaryKey]')
    .description('View one record, with field labels and display values: by primary key, or by a unique key with --key field=value (the web UI\'s Go To).')
    .option('--associations', 'include associated records')
    .option('-k, --key <field=value...>', 'find the record by key fields instead of the primary key (one match required)')
    .option('-j, --join <table...>', 'include fields of these exposed joins (table.field)')
    .option(...VARIANT_OPTION)
    .action(async (name: string, primaryKeyArg: string | undefined, options: { associations?: boolean; key?: string[]; join?: string[]; variant?: string }) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const variant = await chooseVariant(c, meta, options.variant)
      const plan = joinsFrom({ join: options.join, select: true } as QueryOptions, await availableJoins(c, meta, { join: options.join }), undefined, { criteria: [], booleanOperator: 'AND' })
      let primaryKey = primaryKeyArg
      if (options.key?.length) {
        if (primaryKey !== undefined) throw new UsageError('Give a primary key or --key, not both.')
        const values = parsePairs(options.key, '--key')
        for (const field of Object.keys(values)) if (!(meta.fields as Json)[field]) throw new UsageError(`No field "${field}" in ${name}`)
        if (!isGotoKey(meta, Object.keys(values))) c.note(`note: ${Object.keys(values).join('+')} is not a declared key of ${meta.label} (keys: ${gotoKeys(meta).map((k) => k.join('+')).join(', ')}); looking it up anyway`)
        const found = await findRecordByKey(c.server, authenticatedFetch(c.target), meta, values, { tableVariant: variant })
        if (found.found === 'none') throw new UiApiError(404, { code: 'NOT_FOUND', message: 'Record not found.' })
        if (found.found === 'many') throw new UsageError(`More than 1 record was found for ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(', ')}; it is not a unique key (use table query).`)
        primaryKey = found.primaryKey
      }
      if (primaryKey === undefined) throw new UsageError('Give a primary key, or --key field=value.')
      const result = await c.unwrap(c.client.GET('/qqq/v1/table/{tableName}/{primaryKey}', { params: { path: { tableName: name, primaryKey }, query: { includeAssociations: options.associations ? true : undefined, queryJoins: plan.joins ? JSON.stringify(plan.joins) : undefined, tableVariant: variantParam(variant) } as never } })) as Json
      const record = (result.record ?? result) as Json
      const shown = [...defaultFields(meta, 1000), ...plan.used.flatMap((j) => defaultJoinColumns(j, 1000))]
      const rows = shown.map((f) => ({ field: fieldLabel(meta, plan.used, f), value: valueText(record, f) }))
      c.print({ data: record, rows, columns: ['field', 'value'], headers: ['Field', 'Value'], footer: String(record.recordLabel ?? `${meta.label} ${primaryKey}`) })
    })

  /** Fills a form session from --set / --input-json, then prompts when asked or when required values are missing on a terminal. */
  async function fillForm(c: Context, meta: Json, name: string, given: Json, options: { interactive?: boolean }, initial?: Json, exclude?: string[]): Promise<FormSession> {
    const fields = Object.values((meta.fields ?? {}) as Record<string, FieldMeta>)
    for (const k of Object.keys(given)) if (!(meta.fields as Json)[k]) throw new UsageError(`No field "${k}" in ${name}; fields: ${Object.keys(meta.fields as Json).join(', ')}`)
    const session = new FormSession({ baseUrl: c.server, fetch: authenticatedFetch(c.target), scope: { table: name }, fields, initialValues: initial, tableMeta: meta as never, exclude: exclude ?? (initial ? [] : [String(meta.primaryKeyField)]) })
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

  table.command('create <table>')
    .description('Insert a record from --set name=value pairs or --input-json; -i prompts for the rest. Possible-value fields take a label or an id.')
    .option('-s, --set <name=value...>', 'field values')
    .option('--input-json <json|file|->', 'the whole record as a JSON object of field values')
    .option('-i, --interactive', 'prompt for fields on the terminal')
    .option('--generate-input-skeleton', 'print an empty JSON object with the editable fields and stop')
    .option(...VARIANT_OPTION)
    .action(async (name: string, options: { set?: string[]; inputJson?: string; interactive?: boolean; generateInputSkeleton?: boolean; variant?: string }) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const fields = (meta.fields ?? {}) as Record<string, Json>
      if (options.generateInputSkeleton) {
        const editable = Object.values(fields).filter((f) => f.isEditable !== false && !f.isHidden && f.name !== meta.primaryKeyField)
        c.print({ data: Object.fromEntries(editable.map((f) => [f.name, f.defaultValue ?? ''])) })
        c.note(editable.map((f) => `${String(f.name).padEnd(24)} ${f.type}${f.isRequired ? ' required' : ''}${f.possibleValueSourceName ? ` (possible values: ${f.possibleValueSourceName}${Array.isArray(f.possibleValueSourceDependsOn) ? `, depends on ${(f.possibleValueSourceDependsOn as string[]).join(', ')}` : ''})` : ''}`).join('\n'))
        return
      }
      const given = { ...(options.inputJson ? readJson(options.inputJson, '--input-json') as Json : {}), ...parsePairs(options.set, '--set') }
      if (!Object.keys(given).length && !options.interactive) throw new UsageError('Give field values with --set name=value or --input-json, or prompt with -i.')
      const variant = await chooseVariant(c, meta, options.variant, { write: true })
      const session = await fillForm(c, meta, name, given, options)
      const problems = session.validate()
      if (Object.keys(problems).length) validationError(session, problems)
      const result = await c.unwrap(c.client.POST('/qqq/v1/table/{tableName}', { params: { path: { tableName: name }, query: { tableVariant: variantParam(variant) } as never }, body: session.submission() as never })) as Json
      const record = (result.record ?? result) as Json
      const pk = (record.values as Json | undefined)?.[String(meta.primaryKeyField)] ?? record[String(meta.primaryKeyField)] ?? ''
      c.print({ data: result, rows: [{ created: `${meta.label} ${pk}`, label: record.recordLabel ?? '' }], columns: ['created', 'label'] })
    })

  table.command('copy <table> <primaryKey>')
    .description('Copy a record: its values prefill a new record (primary key, non-editable and file fields dropped), --set changes some, and it is inserted as a separate record.')
    .option('-s, --set <name=value...>', 'values to change in the copy')
    .option('-i, --interactive', 'prompt for every editable field, the copied values shown')
    .option('--dry-run', 'print the values the copy would insert and stop')
    .option(...VARIANT_OPTION)
    .action(async (name: string, primaryKey: string, options: { set?: string[]; interactive?: boolean; dryRun?: boolean; variant?: string }) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const variant = await chooseVariant(c, meta, options.variant, { write: !options.dryRun })
      if (meta.insertPermission === false) throw new UiApiError(403, { code: 'PERMISSION_DENIED', message: `You may not create ${meta.label} records` })
      const source = await c.unwrap(c.client.GET('/qqq/v1/table/{tableName}/{primaryKey}', { params: { path: { tableName: name, primaryKey }, query: { tableVariant: variantParam(variant) } as never } })) as Json
      const sourceRecord = (source.record ?? source) as Json
      const copied = copyRecordValues(meta, sourceRecord)
      const given = parsePairs(options.set, '--set')
      const session = await fillForm(c, meta, name, given, { interactive: false }, copied, [String(meta.primaryKeyField)])
      for (const [field, label] of Object.entries((sourceRecord.displayValues ?? {}) as Json)) if (copied[field] !== undefined && given[field] === undefined && session.values[field] === copied[field]) session.displayValues[field] = String(label)
      if (options.interactive) await promptForm(session, { skipSet: false })
      const problems = session.validate()
      if (Object.keys(problems).length) validationError(session, problems)
      const values = session.submission()
      if (options.dryRun) {
        c.print({ data: values, rows: Object.entries(values).map(([field, value]) => ({ field, value: session.displayValues[field] ?? value ?? '' })), columns: ['field', 'value'] })
        return
      }
      const result = await c.unwrap(c.client.POST('/qqq/v1/table/{tableName}', { params: { path: { tableName: name }, query: { tableVariant: variantParam(variant) } as never }, body: values as never })) as Json
      const record = (result.record ?? result) as Json
      const pk = (record.values as Json | undefined)?.[String(meta.primaryKeyField)] ?? ''
      c.print({ data: result, rows: [{ created: `${meta.label} ${pk}`, label: record.recordLabel ?? '', from: `${meta.label} ${primaryKey}` }], columns: ['created', 'label', 'from'] })
    })

  table.command('update <table> <primaryKey>')
    .description('Update fields of a record from --set name=value pairs or --input-json; -i prompts with the current values.')
    .option('-s, --set <name=value...>', 'field values (an empty value clears the field)')
    .option('--input-json <json|file|->', 'field values as a JSON object')
    .option('-i, --interactive', 'prompt for every editable field, current values shown')
    .option('--expected-version <v>', 'optimistic locking: fail when the record changed')
    .option(...VARIANT_OPTION)
    .action(async (name: string, primaryKey: string, options: { set?: string[]; inputJson?: string; interactive?: boolean; expectedVersion?: string; variant?: string }) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const variant = await chooseVariant(c, meta, options.variant, { write: true })
      const given = { ...(options.inputJson ? readJson(options.inputJson, '--input-json') as Json : {}), ...parsePairs(options.set, '--set') }
      if (!Object.keys(given).length && !options.interactive) throw new UsageError('Give field values with --set name=value or --input-json, or prompt with -i.')
      let initial: Json | undefined
      if (options.interactive) {
        const existing = await c.unwrap(c.client.GET('/qqq/v1/table/{tableName}/{primaryKey}', { params: { path: { tableName: name, primaryKey }, query: { tableVariant: variantParam(variant) } as never } })) as Json
        initial = ((existing.record ?? existing) as Json).values as Json
      }
      const session = await fillForm(c, meta, name, given, { interactive: false }, initial)
      if (options.interactive) await promptForm(session, { skipSet: false })
      const touched = options.interactive ? session.editable.map((f) => f.name).filter((n) => String(session.values[n] ?? '') !== String(initial?.[n] ?? '')) : Object.keys(given)
      if (!touched.length) {
        c.note('Nothing changed.')
        return
      }
      const problems = session.validate(touched)
      if (Object.keys(problems).length) validationError(session, problems)
      const values = Object.fromEntries(touched.map((n) => [n, session.values[n] ?? null]))
      const result = await c.unwrap(c.client.PATCH('/qqq/v1/table/{tableName}/{primaryKey}', { params: { path: { tableName: name, primaryKey }, query: { expectedVersion: options.expectedVersion, tableVariant: variantParam(variant) } as never }, body: values as never })) as Json
      const record = (result.record ?? result) as Json
      c.print({ data: result, rows: [{ updated: `${meta.label} ${primaryKey}`, label: record.recordLabel ?? '', fields: touched.join(', ') }], columns: ['updated', 'label', 'fields'] })
    })

  table.command('delete <table> <primaryKey>')
    .description('Delete a record (asks first; --yes skips the question).')
    .option(...VARIANT_OPTION)
    .action(async (name: string, primaryKey: string, options: { variant?: string }) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const variant = await chooseVariant(c, meta, options.variant, { write: true })
      if (!await c.confirm(`Delete ${meta.label} ${primaryKey}?`)) {
        c.note('Not deleted.')
        return
      }
      const result = await c.unwrap(c.client.DELETE('/qqq/v1/table/{tableName}/{primaryKey}', { params: { path: { tableName: name, primaryKey }, query: { tableVariant: variantParam(variant) } as never } })) as Json
      c.print({ data: result ?? {}, rows: [{ deleted: `${meta.label} ${primaryKey}` }], columns: ['deleted'] })
    })

  table.command('export <table>')
    .description('Export matching records to a file (csv, xlsx, json, tsv).')
    .option('-w, --where <criteria...>', 'criteria, ANDed (or --or)')
    .option('-g, --group <expression...>', 'a group with AND/OR and parentheses')
    .option('--or', 'OR the --where criteria')
    .option('-o, --order <field...>', 'order by fields; prefix - for descending')
    .option('--filter-json <json|file|->', 'a QueryFilter as JSON')
    .option('--format <fmt>', 'csv, xlsx, json or tsv (default: from the --out extension, else csv)')
    .option('-f, --fields <names>', 'comma-separated fields to include, in column order (default: the server\'s)')
    .option('-l, --limit <n>', 'most records')
    .option('--out <file>', 'output file, or - for stdout (default: <table>.<format>)')
    .option('--no-header', 'leave out the header row (csv, tsv, xlsx)')
    .option('-S, --search <text>', 'quick search over the text fields, ANDed with the filter')
    .option(...VARIANT_OPTION)
    .action(async (name: string, options: QueryOptions & { format?: string; out?: string; header: boolean }) => {
      const c = ctx()
      const meta = await tableMeta(c, name)
      const fromOut = options.out && options.out !== '-' && /\.([a-z]+)$/i.exec(options.out)?.[1]?.toLowerCase()
      const format = (options.format ?? (fromOut && EXPORT_FORMATS.includes(fromOut) ? fromOut : 'csv')).toLowerCase()
      if (!EXPORT_FORMATS.includes(format)) throw new UsageError(`--format must be one of ${EXPORT_FORMATS.join(', ')}`)
      const columns = columnsFrom(c, options)
      // the export route takes joined columns of exposed joins by name (it has no joins member)
      const available = exposedJoins(meta)
      const unknown = (columns ?? []).filter((f) => !resolveField(meta, available, f))
      if (unknown.length) throw new UsageError(`No field ${unknown.join(', ')} in ${name}; fields: ${Object.keys((meta.fields ?? {}) as Json).join(', ')}`)
      if (options.limit !== undefined && !(Number(options.limit) > 0)) throw new UsageError('--limit must be a positive number')
      const filter = filterFrom(options, meta, columns, available)
      const variant = await chooseVariant(c, meta, options.variant)
      const out = options.out ?? `${name}.${format}`
      const result = await c.call('exportTable', { path: { tableName: name }, json: { format, filter, fieldNames: columns, limit: options.limit ? Number(options.limit) : undefined, ...(options.header === false ? { includeHeaderRow: false } : {}), ...variantBody(variant) } })
      const bytes = result.bytes ?? new TextEncoder().encode(typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
      if (out === '-') {
        process.stdout.write(bytes)
        return
      }
      writeFileSync(out, bytes)
      c.note(`wrote ${out} (${bytes.length} bytes, ${result.contentType})`)
    })

  // flat aliases, kept from 0.1
  program.command('tables', { hidden: true }).description('Alias of `table list`.').option('-a, --app <name>').action(async (options: { app?: string }) => { await table.commands.find((x) => x.name() === 'list')!.parseAsync([...(options.app ? ['--app', options.app] : [])], { from: 'user' }) })
}
