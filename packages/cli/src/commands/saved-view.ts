/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import { decodeJwtClaims } from '@qrun-io/qqq-ui-api-client'
import { SavedViewError, buildFilter, buildViewJson, callOperation, deleteSavedView, exposedJoins, findSavedView, joinFieldNames, listSavedViews, printFilter, resolveField, savedViewProcesses, storeSavedView, variantBody, viewToQuery, type QueryFilter, type SavedView, type SavedViewProcesses } from '@qrun-io/qqq-core'
import { UsageError, type Context } from '../context.js'
import { authenticatedFetch, currentToken, getLogin } from '../session.js'
import { defaultFields, readJson, type Json } from './shared.js'
import { chooseVariant, VARIANT_OPTION } from './variants.js'

/** The signed-in user's id as saved views record owners (email, else username or subject). */
async function currentUserId(c: Context): Promise<string | undefined> {
  const t = c.target
  const token = await currentToken(t)
  const claims = token && token.includes('.') ? decodeJwtClaims(token) as Json : {}
  const login = await getLogin(t)
  const user = login?.kind === 'session' ? login.user ?? {} : {}
  const id = claims.email ?? user.email ?? user.idReference ?? user.username ?? claims.preferred_username ?? claims.sub
  return id === undefined || id === null || id === '' ? undefined : String(id)
}

async function context(c: Context, table: string): Promise<{ meta: Json; processes: SavedViewProcesses; fetchImpl: typeof fetch }> {
  const meta = await c.tableMeta<Json>(table)
  const processes = savedViewProcesses(meta, await c.metaData() as unknown as Json)
  if (!processes.query) throw new UsageError(`${meta.label} has no saved views on this server (clientCapabilities.savedViews is unavailable).`)
  return { meta, processes, fetchImpl: authenticatedFetch(c.target) }
}

async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof SavedViewError) throw new UsageError(error.message)
    throw error
  }
}

function describeFilter(view: SavedView): string {
  try {
    const filter = view.view.queryFilter as QueryFilter
    return filter.criteria?.length || filter.subFilters?.length ? printFilter({ criteria: filter.criteria ?? [], booleanOperator: filter.booleanOperator ?? 'AND', subFilters: filter.subFilters }) : ''
  } catch {
    return '(unreadable filter)'
  }
}

export function registerSavedView(program: Command, ctx: () => Context): void {
  const sv = program.command('saved-view').description('Saved views (named query screens kept by the server): list, open, save, rename, delete.')

  sv.command('list <table>')
    .description("A table's saved views: yours and those shared with you, with quick views and their counts.")
    .option('--counts', 'count the records of every view (quick views with doCount are always counted)')
    .option(...VARIANT_OPTION)
    .action(async (table: string, options: { counts?: boolean; variant?: string }) => {
      const c = ctx()
      const { meta, processes, fetchImpl } = await context(c, table)
      const me = await currentUserId(c)
      const views = await guard(() => listSavedViews(c.server, fetchImpl, processes, table))
      const joins = exposedJoins(meta)
      const counting = options.counts || views.some((v) => v.type === 'quickView' && v.doCount)
      const variant = counting ? await chooseVariant(c, meta, options.variant) : undefined
      const rows = await Promise.all(views.map(async (v) => {
        let count: unknown = ''
        if (options.counts || (v.type === 'quickView' && v.doCount)) {
          const { filter } = viewToQuery(meta, joins, v.view)
          const { orderBys: _o, ...criteria } = filter
          void _o
          try {
            count = ((await callOperation(c.server, 'countTable', { path: { tableName: table }, json: { filter: criteria, ...variantBody(variant) } }, fetchImpl)).data as Json).count ?? ''
          } catch {
            count = '?'
          }
        }
        return { id: v.id, label: v.label, owner: me && v.userId === me ? 'you' : v.userId ? `shared by ${v.userId}` : '', type: v.type ?? '', filter: describeFilter(v), count }
      }))
      const mine = rows.filter((r) => r.owner === 'you')
      const ordered = [...mine, ...rows.filter((r) => r.owner !== 'you')]
      c.print({ data: views, rows: ordered, columns: ['id', 'label', 'owner', 'type', 'filter', 'count'], footer: `(${views.length} view${views.length === 1 ? '' : 's'}${processes.store ? '' : '; saving is unavailable'})` })
    })

  sv.command('open <table> <view>')
    .description('Run a saved view: its filter, sort, columns and page size (the same as `table query <table> --view <view>`; query options are passed on).')
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async (table: string, view: string, _options: unknown, command: Command) => {
      const query = program.commands.find((x) => x.name() === 'table')!.commands.find((x) => x.name() === 'query')!
      await query.parseAsync([table, '--view', view, ...command.args.slice(2)], { from: 'user' })
    })

  sv.command('save <table>')
    .description('Save a view from criteria, sort, columns and page size. A name you already use is refused unless --replace.')
    .requiredOption('-n, --name <name>', 'the view name')
    .option('-w, --where <criteria...>', 'criteria, ANDed (or --or)')
    .option('-g, --group <expression...>', 'a group with AND/OR and parentheses')
    .option('--or', 'OR the --where criteria')
    .option('-o, --order <field...>', 'sort; prefix - for descending')
    .option('--filter-json <json|file|->', 'a QueryFilter as JSON instead')
    .option('-f, --fields <names>', 'comma-separated columns to show (default: the table\'s default columns)')
    .option('-l, --page-size <n>', 'rows per page', '25')
    .option('--replace', 'update your view of that name instead of refusing')
    .action(async (table: string, options: { name: string; where?: string[]; group?: string[]; or?: boolean; order?: string[]; filterJson?: string; fields?: string; pageSize: string; replace?: boolean }) => {
      const c = ctx()
      const { meta, processes, fetchImpl } = await context(c, table)
      const filter = options.filterJson ? readJson(options.filterJson, '--filter-json') as QueryFilter
        : buildFilter({ where: options.where, group: options.group, or: options.or, order: options.order, knownFields: [...Object.keys((meta.fields ?? {}) as Json), ...joinFieldNames(exposedJoins(meta))] })
      const columns = c.fields ?? (options.fields ? options.fields.split(',').map((f) => f.trim()).filter(Boolean) : defaultFields(meta))
      const unknown = columns.filter((f) => !resolveField(meta, exposedJoins(meta), f))
      if (unknown.length) throw new UsageError(`No field ${unknown.join(', ')} in ${table}`)
      const views = await guard(() => listSavedViews(c.server, fetchImpl, processes, table))
      const me = await currentUserId(c)
      const same = views.filter((v) => v.label.toLowerCase() === options.name.toLowerCase())
      if (same.length && !options.replace) throw new UsageError(`A view named "${options.name}" exists (id ${same.map((v) => v.id).join(', ')}); nothing was saved. --replace updates it.`)
      const target = same.find((v) => !me || !v.userId || v.userId === me) ?? same[0]
      const allColumns = Object.keys((meta.fields ?? {}) as Json).filter((n) => !((meta.fields as Record<string, Json>)[n]!.isHidden))
      const view = buildViewJson({ filter, columns, allColumns, rowsPerPage: Number(options.pageSize), base: target?.view })
      const stored = await guard(() => storeSavedView(c.server, fetchImpl, processes, { table, label: options.name, view, ...(target ? { id: target.id } : {}) }))
      c.print({ data: stored, rows: [{ [target ? 'updated' : 'saved']: stored.label, id: stored.id }], columns: [target ? 'updated' : 'saved', 'id'] })
    })

  sv.command('rename <table> <view> <newName>')
    .description('Rename a view (yours; the server refuses others\').')
    .action(async (table: string, idOrName: string, newName: string) => {
      const c = ctx()
      const { processes, fetchImpl } = await context(c, table)
      const views = await guard(() => listSavedViews(c.server, fetchImpl, processes, table))
      const view = await guard(async () => findSavedView(views, idOrName))
      const clash = views.find((v) => v.id !== view.id && v.label.toLowerCase() === newName.toLowerCase())
      if (clash) throw new UsageError(`A view named "${newName}" exists (id ${clash.id}); nothing was renamed.`)
      const stored = await guard(() => storeSavedView(c.server, fetchImpl, processes, { table, label: newName, view: view.view, id: view.id }))
      c.print({ data: stored, rows: [{ renamed: `${view.label} -> ${stored.label}`, id: stored.id }], columns: ['renamed', 'id'] })
    })

  sv.command('delete <table> <view>')
    .description('Delete a view (asks first; --yes skips the question).')
    .action(async (table: string, idOrName: string) => {
      const c = ctx()
      const { processes, fetchImpl } = await context(c, table)
      const view = await guard(async () => findSavedView(await listSavedViews(c.server, fetchImpl, processes, table), idOrName))
      if (!await c.confirm(`Delete the view "${view.label}" (${view.id})?`)) {
        c.note('Not deleted.')
        return
      }
      await guard(() => deleteSavedView(c.server, fetchImpl, processes, view.id))
      c.print({ data: { deleted: view.id }, rows: [{ deleted: view.label, id: view.id }], columns: ['deleted', 'id'] })
    })
}
