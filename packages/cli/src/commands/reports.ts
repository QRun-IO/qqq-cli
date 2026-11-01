/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Saved reports (`qqq saved-report`) and sharing (`qqq share`): show a saved report's filter,
 * columns and pivot as the setup widgets do, change them, preview its rows, render it through
 * renderSavedReport, schedule it, and share any shareable record (saved reports, saved views).
 */

import type { Command } from 'commander'
import {
  RENDER_SAVED_REPORT_PROCESS, ReportError, SAVED_REPORT_TABLE, SCHEDULED_REPORT_TABLE, SHARE_SCOPES, SharingError, addShare, blocksToText, buildFilter, buildPivot, changeShare,
  filterAndColumnsBlocks, filterDateTimesToUtc, findSavedReport, listReportSchedules, listSavedReports, listShares, pivotTableBlocks, printFilter, removeShare,
  reportFormat, savedReportFilterValues, shareScope, trimChar, type FieldMeta, type QueryFilter, type SavedReport,
} from '@qrun-io/qqq-core'
import { UsageError, type Context } from '../context.js'
import { authenticatedFetch } from '../session.js'
import { currentUserId } from './saved-view.js'
import { ORDER_OPTION, countFooter, deprecatedOrderOption, intOption, orderFrom, valueText, type Json } from './shared.js'

/** A share scope's label (Read-Only, Read and Edit). */
function scopeLabel(id: string): string {
  return SHARE_SCOPES.find((s) => s.id === id)?.label ?? id
}

async function guard<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f()
  } catch (error) {
    if (error instanceof ReportError || error instanceof SharingError) throw new UsageError(error.message)
    throw error
  }
}

async function savedReports(c: Context): Promise<SavedReport[]> {
  const tables = ((await c.metaData() as unknown as Json).tables ?? {}) as Record<string, Json>
  if (!tables[SAVED_REPORT_TABLE]) throw new UsageError('This server has no saved reports (the savedReport table).')
  return listSavedReports(c.server, authenticatedFetch(c.target))
}

export function registerReports(program: Command, ctx: () => Context): void {
  const sr = program.command('saved-report').description('Saved reports: list, show, preview, run, set (filter, sort, columns), pivot, schedules, schedule. Share one with `qqq share … savedReport <id>`.')

  sr.command('list')
    .description('Your saved reports and those shared with you.')
    .action(async () => {
      const c = ctx()
      const me = await currentUserId(c)
      const reports = await savedReports(c)
      const rows = reports.map((r) => ({ id: r.id, label: r.label, table: r.tableName, owner: me && r.userId === me ? 'you' : r.userId ? `shared by ${r.userId}` : '', pivot: r.pivot ? 'yes' : '', filter: r.filter ? printFilter(r.filter) : '' }))
      c.print({ data: reports.map((r) => r.raw), rows, columns: ['id', 'label', 'table', 'owner', 'pivot', 'filter'], footer: countFooter(rows.length, 'saved report') })
    })

  sr.command('show <report>')
    .description("A saved report as its setup widgets show it: filter (match all/any), sort, visible columns, pivot table (rows, columns, values).")
    .action(async (name: string) => {
      const c = ctx()
      const report = await guard(async () => findSavedReport(await savedReports(c), name))
      const meta = await c.tableMeta<Json>(report.tableName).catch(() => ({} as Json))
      const label = (f: string) => String(((meta.fields ?? {}) as Record<string, Json>)[f]?.label ?? f)
      if (c.format === 'json' || c.format === 'yaml') {
        c.print({ data: report })
        return
      }
      const values = ((report.raw.values ?? report.raw) as Json)
      process.stdout.write([`${report.label} (${report.id}) on ${String(meta.label ?? report.tableName)}`, blocksToText(filterAndColumnsBlocks(values, {}, label)), 'Pivot table:', blocksToText(pivotTableBlocks(values, label))].join('\n') + '\n')
    })

  sr.command('preview <report>')
    .description("The report's rows as its filter, sort and columns select them (paged by the server: --limit, --skip, --order replaces the sort). --api-path/--api-version preview through an application API, as API-versioned report setups do.")
    .option('-l, --limit <n>', 'rows', '25')
    .option('--skip <n>', 'rows to skip')
    .option('--order <field...>', 'sort instead of the report\'s; prefix - for descending')
    .addOption(deprecatedOrderOption())
    .option('--api-path <path>', 'an application API path (e.g. /api/)')
    .option('--api-version <version>', 'with --api-path, the API version')
    .action(async (name: string, options: { limit: string; skip?: string; order?: string[]; o?: string[]; apiPath?: string; apiVersion?: string }) => {
      const c = ctx()
      options.order = orderFrom((text) => c.note(text), options)
      const report = await guard(async () => findSavedReport(await savedReports(c), name))
      const meta = await c.tableMeta<Json>(report.tableName)
      const filter: QueryFilter = { ...(report.filter ?? { criteria: [], booleanOperator: 'AND' }), skip: intOption(options.skip, '--skip') ?? 0, limit: intOption(options.limit, '--limit', 1)! }
      if (options.order?.length) filter.orderBys = options.order.map((o) => ({ fieldName: o.replace(/^-/, ''), isAscending: !o.startsWith('-') }))
      const columns = (report.columns ?? []).filter((col) => col.isVisible !== false && col.name !== '__check__').map((col) => col.name)
      const fields = columns.length ? columns : Object.keys((meta.fields ?? {}) as Json).slice(0, 8)
      let records: Json[]
      let total: unknown
      if (options.apiPath) {
        if (!options.apiVersion) throw new UsageError('--api-path needs --api-version')
        const base = `${c.server}/${trimChar(options.apiPath, '/')}/${options.apiVersion}/table/${report.tableName}`
        const fetchImpl = authenticatedFetch(c.target)
        const q = await (await fetchImpl(`${base}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filter }) })).json() as Json
        const n = await (await fetchImpl(`${base}/count`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ filter: { ...filter, skip: undefined, limit: undefined } }) })).json() as Json
        records = (q.records ?? []) as Json[]
        total = n.count
      } else {
        records = ((await c.call('queryTable', { path: { tableName: report.tableName }, json: { filter } })).data as Json).records as Json[] ?? []
        total = ((await c.call('countTable', { path: { tableName: report.tableName }, json: { filter: { criteria: filter.criteria, booleanOperator: filter.booleanOperator, subFilters: filter.subFilters } } })).data as Json).count
      }
      const rows = records.map((r) => Object.fromEntries(fields.map((f) => [f, valueText(r, f, meta, c.dateTimeDisplay)])))
      c.print({ data: records, rows, columns: fields, headers: fields.map((f) => String(((meta.fields ?? {}) as Record<string, Json>)[f]?.label ?? f)), footer: countFooter(rows.length, 'row', [`${String(total ?? '?')} in all`, `rows ${filter.skip! + 1}-${filter.skip! + rows.length}`]) })
    })

  sr.command('run <report>')
    .description('Render a saved report through renderSavedReport and save the file (its input step asks for report variables; -v gives them).')
    .option('--format <fmt>', 'csv, xlsx or json', 'csv')
    .option('-v, --values <name=value...>', 'report variable values')
    .option('--out-dir <dir>', 'where the file is saved')
    .action(async (name: string, options: { format: string; values?: string[]; outDir?: string }) => {
      const c = ctx()
      const report = await guard(async () => findSavedReport(await savedReports(c), name))
      const format = await guard(async () => reportFormat(options.format))
      const run = program.commands.find((x) => x.name() === 'process')!.commands.find((x) => x.name() === 'run')!
      await run.parseAsync([RENDER_SAVED_REPORT_PROCESS, '-r', String(report.id), '-v', `reportFormat=${format}`, ...(options.values ?? []).flatMap((v) => ['-v', v]), ...(options.outDir ? ['--out-dir', options.outDir] : [])], { from: 'user' })
    })

  sr.command('set <report>')
    .description("Change a saved report's filter and sort (--where/--group/--order, filter variables as ${variable.x}), visible columns (--columns), or name (--label), as the filter and columns setup does.")
    .option('-w, --where <criteria...>', 'criteria, ANDed (or --or)')
    .option('-g, --group <expression...>', 'a group with AND/OR and parentheses')
    .option('--or', 'OR the --where criteria')
    .option(...ORDER_OPTION)
    .addOption(deprecatedOrderOption())
    .option('--clear-filter', 'no filter (every record)')
    .option('--columns <names>', 'visible columns, in order (comma-separated)')
    .option('--label <text>', 'a new name')
    .action(async (name: string, options: { where?: string[]; group?: string[]; or?: boolean; order?: string[]; o?: string[]; clearFilter?: boolean; columns?: string; label?: string }) => {
      const c = ctx()
      options.order = orderFrom((text) => c.note(text), options)
      const report = await guard(async () => findSavedReport(await savedReports(c), name))
      const meta = await c.tableMeta<Json>(report.tableName)
      const known = Object.keys((meta.fields ?? {}) as Json)
      const touchesFilter = options.where || options.group || options.order || options.clearFilter
      const filter = options.clearFilter ? { criteria: [], booleanOperator: 'AND' } as QueryFilter
        : touchesFilter ? filterDateTimesToUtc(buildFilter({ where: options.where, group: options.group, or: options.or, order: options.order, knownFields: known }), (meta.fields ?? {}) as Record<string, FieldMeta>) : undefined
      if (filter && !options.where && !options.group && !options.clearFilter && report.filter) {
        filter.criteria = report.filter.criteria
        filter.booleanOperator = report.filter.booleanOperator
        if (report.filter.subFilters) filter.subFilters = report.filter.subFilters
      }
      const columns = options.columns?.split(',').map((f) => f.trim()).filter(Boolean)
      for (const col of columns ?? []) if (!known.includes(col)) throw new UsageError(`${col}: not a field of ${String(meta.label ?? report.tableName)}`)
      const body = { ...savedReportFilterValues(filter, columns), ...(options.label ? { label: options.label } : {}) }
      if (!Object.keys(body).length) throw new UsageError('Nothing to change: --where/--group/--order/--clear-filter, --columns or --label.')
      await c.unwrap(c.client.PATCH('/qqq/v1/table/{tableName}/{primaryKey}', { params: { path: { tableName: SAVED_REPORT_TABLE, primaryKey: String(report.id) } }, body: body as never }))
      c.print({ data: body, rows: Object.keys(body).map((k) => ({ changed: k, value: String(body[k as keyof typeof body]) })), columns: ['changed', 'value'], footer: `${report.label} (${report.id}) updated` })
    })

  sr.command('pivot <report>')
    .description("Set (--rows, --columns, --values FUNCTION:field) or clear (--clear) a saved report's pivot table, as the pivot table setup does.")
    .option('--rows <fields>', 'row fields, comma-separated')
    .option('--columns <fields>', 'column fields, comma-separated')
    .option('--values <specs>', 'values, comma-separated FUNCTION:field (SUM, COUNT, COUNT_NUMS, AVERAGE, MAX, MIN, PRODUCT, STD_DEV, STD_DEVP, VAR, VARP)')
    .option('--clear', 'remove the pivot table')
    .action(async (name: string, options: { rows?: string; columns?: string; values?: string; clear?: boolean }) => {
      const c = ctx()
      const report = await guard(async () => findSavedReport(await savedReports(c), name))
      const meta = await c.tableMeta<Json>(report.tableName)
      const list = (s?: string) => s?.split(',').map((x) => x.trim()).filter(Boolean)
      const body = options.clear ? { pivotTableJson: null } : { pivotTableJson: JSON.stringify(await guard(async () => buildPivot({ rows: list(options.rows), columns: list(options.columns), values: list(options.values) }, Object.keys((meta.fields ?? {}) as Json)))) }
      await c.unwrap(c.client.PATCH('/qqq/v1/table/{tableName}/{primaryKey}', { params: { path: { tableName: SAVED_REPORT_TABLE, primaryKey: String(report.id) } }, body: body as never }))
      const label = (f: string) => String(((meta.fields ?? {}) as Record<string, Json>)[f]?.label ?? f)
      process.stdout.write(`${report.label} (${report.id}) pivot table:\n${blocksToText(pivotTableBlocks({ pivotTableJson: body.pivotTableJson }, label))}\n`)
    })

  sr.command('schedules <report>')
    .description("A saved report's schedules: cron expression and its description, time zone, recipients, format.")
    .action(async (name: string) => {
      const c = ctx()
      const report = await guard(async () => findSavedReport(await savedReports(c), name))
      const schedules = await listReportSchedules(c.server, authenticatedFetch(c.target), report.id)
      c.print({ data: schedules, rows: schedules.map((s) => ({ id: s.id, cron: s.cronExpression, description: s.cronDescription ?? '', zone: s.timeZone, active: s.isActive ? 'yes' : 'no', to: s.toAddresses, format: s.format })), columns: ['id', 'cron', 'description', 'zone', 'active', 'to', 'format'], footer: countFooter(schedules.length, 'schedule') })
    })

  sr.command('schedule <report>')
    .description('Schedule a saved report: a cron expression (Quartz: seconds first), its time zone, recipients, subject and format.')
    .requiredOption('--cron <expression>', 'e.g. "0 0 7 ? * MON-FRI"')
    .requiredOption('--time-zone <zone>', 'e.g. America/Chicago')
    .requiredOption('--to <addresses>', 'comma-separated email addresses')
    .option('--subject <text>', 'email subject (default: the report name)')
    .option('--format <fmt>', 'csv, xlsx or json', 'xlsx')
    .option('--inactive', 'create it switched off')
    .action(async (name: string, options: { cron: string; timeZone: string; to: string; subject?: string; format: string; inactive?: boolean }) => {
      const c = ctx()
      const report = await guard(async () => findSavedReport(await savedReports(c), name))
      const format = await guard(async () => reportFormat(options.format))
      const body = { savedReportId: report.id, cronExpression: options.cron, cronTimeZoneId: options.timeZone, toAddresses: options.to, subject: options.subject ?? report.label, format, isActive: !options.inactive }
      const created = await c.unwrap(c.client.POST('/qqq/v1/table/{tableName}', { params: { path: { tableName: SCHEDULED_REPORT_TABLE } }, body: body as never })) as Json
      const values = (((created.record ?? created) as Json).values ?? {}) as Json
      c.print({ data: created, rows: [{ id: values.id ?? '', cron: values.cronExpression ?? options.cron, description: values.cronDescription ?? '', zone: options.timeZone }], columns: ['id', 'cron', 'description', 'zone'], footer: `scheduled ${report.label}` })
    })

  const share = program.command('share').description('Share a record of a shareable table (saved reports, saved views) with users or groups: list, add, scope, remove. Only the owner may share.')

  share.command('list <table> <primaryKey>')
    .description('Who the record is shared with, and how.')
    .action(async (table: string, pk: string) => {
      const c = ctx()
      const meta = await c.tableMeta<Json>(table)
      const shares = await guard(() => listShares(c.server, authenticatedFetch(c.target), meta, pk))
      c.print({ data: shares, rows: shares.map((s) => ({ share: s.shareId, with: s.audienceLabel, type: s.audienceType, scope: scopeLabel(s.scopeId) })), columns: ['share', 'with', 'type', 'scope'], footer: countFooter(shares.length, 'share') })
    })

  share.command('add <table> <primaryKey> <audience>')
    .description('Share the record: audience as type:id (user:jane@example.com, group:7) or an id for the first audience type of the table; --scope read-only (default) or read-write.')
    .option('--scope <scope>', 'read-only or read-write', 'read-only')
    .action(async (table: string, pk: string, audience: string, options: { scope: string }) => {
      const c = ctx()
      const meta = await c.tableMeta<Json>(table)
      const types = (((meta.shareableTableMetaData ?? {}) as Json).audienceTypes ?? {}) as Record<string, Json>
      const [type, id] = audience.includes(':') ? audience.split(/:(.*)/s, 2) as [string, string] : [Object.keys(types)[0] ?? 'user', audience]
      if (Object.keys(types).length && !types[type]) throw new UsageError(`${table} shares with ${Object.keys(types).join(', ')}, not ${type}`)
      const scopeId = await guard(async () => shareScope(options.scope))
      await guard(() => addShare(c.server, authenticatedFetch(c.target), meta, pk, `${type}:${id}`, scopeId))
      c.note(`Shared ${table} ${pk} with ${type} ${id} (${scopeLabel(scopeId)}).`)
    })

  share.command('scope <table> <primaryKey> <share> <scope>')
    .description('Change a share\'s scope (read-only, read-write).')
    .action(async (table: string, pk: string, shareId: string, scope: string) => {
      const c = ctx()
      const scopeId = await guard(async () => shareScope(scope))
      await guard(async () => changeShare(c.server, authenticatedFetch(c.target), await c.tableMeta<Json>(table), pk, Number(shareId), scopeId))
      c.note(`Share ${shareId} of ${table} ${pk} is now ${scopeLabel(scopeId)}.`)
    })

  share.command('remove <table> <primaryKey> <share>')
    .description('Stop sharing (asks unless --yes).')
    .action(async (table: string, pk: string, shareId: string) => {
      const c = ctx()
      if (!await c.confirm(`Remove share ${shareId} of ${table} ${pk}?`)) {
        c.note('Not removed.')
        return
      }
      await guard(async () => removeShare(c.server, authenticatedFetch(c.target), await c.tableMeta<Json>(table), pk, Number(shareId)))
      c.note(`Removed share ${shareId} of ${table} ${pk}.`)
    })

}
