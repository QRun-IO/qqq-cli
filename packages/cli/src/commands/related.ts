/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The record view and related records: `table get` (sections, adornments, help, associations),
 * `table children` (a page of one child list, with its count) and `table download` (a stored
 * file). The models are the kernel's (records/associations, records/record-view).
 */

import type { Command } from 'commander'
import {
  associationGroups, associationLabel, associationsOf, childListFields, fetchChildren, fileDownload, safeFileName, findAssociation, helpToText, recordView, relationshipValues, tableHelp, VIEW_SCREEN_HELP_ROLES,
  defaultJoinColumns, withJoinFields, fieldLabel, variantBody, variantParam, type ExposedJoin, type RecordLike, type TableMetaLike, type WidgetMetaLike,
} from '@qrun-io/qqq-core'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { UsageError, type Context } from '../context.js'
import { authenticatedFetch } from '../session.js'
import { countFooter, intOption, valueText, writeDownload, type Json } from './shared.js'
import { chooseVariant, VARIANT_OPTION } from './variants.js'

/** Reads one record (`{ record }` or a bare record). */
export async function getRecord(c: Context, table: string, primaryKey: string, associations: boolean, query: Record<string, string | undefined> = {}): Promise<Json> {
  const result = await c.unwrap(c.client.GET('/qqq/v1/table/{tableName}/{primaryKey}', { params: { path: { tableName: table, primaryKey }, query: { includeAssociations: associations ? true : undefined, ...query } as never } })) as Json
  return (result.record ?? result) as Json
}

/** Table metadata for the record's table and every table its associations reach (missing ones stay undefined: no access). */
async function associationTables(c: Context, root: TableMetaLike): Promise<Record<string, TableMetaLike | undefined>> {
  const tables: Record<string, TableMetaLike | undefined> = { [root.name]: root }
  const known = new Set(Object.keys((await c.metaData()).tables ?? {}))
  const queue = [root]
  while (queue.length) {
    const table = queue.shift()!
    for (const association of associationsOf(table)) {
      const name = association.associatedTableName
      if (name in tables) continue
      tables[name] = undefined
      if (!known.has(name)) continue
      try {
        const meta = await c.tableMeta<TableMetaLike>(name)
        tables[name] = meta
        queue.push(meta)
      } catch (error) {
        // no access to the child table (403, or 404 for a table the user may not see): shown as
        // unavailable; anything else (the server down, a 500) is a real failure
        if (!(error instanceof UiApiError && (error.status === 403 || error.status === 404))) throw error
      }
    }
  }
  return tables
}

/** Prints a record: its sections, then links, help and child lists as asked. */
export async function showRecord(c: Context, table: string, primaryKey: string, options: { associations?: boolean; links?: boolean; reveal?: boolean; helpContent?: boolean; query?: Record<string, string | undefined>; joined?: ExposedJoin[] }): Promise<void> {
  const meta = await c.tableMeta<TableMetaLike>(table)
  const metaData = await c.metaData()
  const record = await getRecord(c, table, primaryKey, Boolean(options.associations), options.query) as unknown as RecordLike
  const widgets = (metaData.widgets ?? {}) as Record<string, WidgetMetaLike>
  const tableNames = Object.keys(metaData.tables ?? {})
  const sections = recordView(meta, record, { reveal: options.reveal, tableNames, widgets, helpContent: options.helpContent, tableName: table, primaryKey, empty: c.format === 'table' ? '--' : '', dateTime: c.dateTimeDisplay })
  const rows: Json[] = []
  for (const section of sections) {
    if (options.helpContent && section.help) rows.push({ section: section.label, field: '(help)', value: section.help })
    for (const { field, value, help } of section.fields) {
      rows.push({ section: section.label, field: field.label, value: value.text })
      if (help) rows.push({ section: section.label, field: '', value: `help: ${help}` })
    }
  }
  // fields of joined tables (--join), one section per join
  for (const join of options.joined ?? []) {
    for (const name of defaultJoinColumns(join, 1000)) rows.push({ section: join.label, field: fieldLabel(meta as unknown as Json, options.joined!, name), value: valueText(record as unknown as Json, name, withJoinFields(meta as unknown as Json, options.joined!), c.dateTimeDisplay, options.reveal) })
  }
  const links = sections.flatMap((s) => s.fields).filter((x) => x.value.link && 'tableName' in x.value.link)
  const structured = c.format === 'json' || c.format === 'yaml'
  const footer = [String(record.recordLabel ?? `${meta.label} ${primaryKey}`)]
  if (links.length && !options.links) footer.push(`links: ${links.map((x) => x.field.name).join(', ')} (--links lists them, --follow <field> opens one)`)
  const masked = sections.flatMap((s) => s.fields).filter((x) => x.value.masked)
  if (masked.length) footer.push(`masked: ${masked.map((x) => x.field.name).join(', ')} (--reveal shows them)`)
  if (!options.associations && associationsOf(meta).length) footer.push(`associations: ${associationsOf(meta).map((a) => a.name).join(', ')} (--associations lists the child records)`)
  c.print({ data: record, rows, columns: ['section', 'field', 'value'], headers: ['Section', 'Field', 'Value'], footer: footer.join('\n') })
  if (structured) return

  if (options.helpContent) {
    // the table's own help, as `qqq help show table <t>` prints it (sections and fields are inline above)
    const help = tableHelp(meta as unknown as Json, { role: VIEW_SCREEN_HELP_ROLES }).filter((e) => e.where === 'table' || e.where.startsWith('table ('))
    if (help.length) process.stdout.write(`\n${helpToText(help)}\n`)
  }
  if (options.links && links.length) {
    c.print({
      data: links,
      rows: links.map(({ field, value }) => {
        const link = value.link as { tableName: string; primaryKey: string }
        return { field: field.name, label: field.label, record: String(record.displayValues?.[field.name] ?? record.values[field.name] ?? ''), table: link.tableName, key: link.primaryKey, open: `qqq table get ${table} ${primaryKey} --follow ${field.name}` }
      }),
      columns: ['field', 'label', 'record', 'table', 'key', 'open'],
      headers: ['Field', 'Label', 'Record', 'Table', 'Key', 'Open with'],
    })
  }
  if (options.associations) {
    const tables = await associationTables(c, meta)
    for (const group of associationGroups(record, meta, tables, { widgets })) {
      const indent = '  '.repeat(group.depth - 1)
      const title = group.depth === 1 ? `${group.title} [${group.association.name}]` : group.title
      if (group.unavailable) {
        process.stdout.write(`\n${indent}${title}: unavailable (${group.unavailable})\n`)
        continue
      }
      // nested lists only when they have records; the record's own lists always (an empty one says none)
      if (group.depth > 1 && !group.records.length) continue
      const childTable = tables[group.table]!
      const parentTable = tables[group.parentTable]!
      const relationship = relationshipValues(group.association, parentTable, group.parent, childTable)
      const binding = 'error' in relationship ? [] : Object.keys(relationship.values)
      const fields = childListFields(childTable, binding)
      const childRows = group.records.map((child) => Object.fromEntries(fields.map((f) => [f, valueText(child as unknown as Json, f, childTable as unknown as Json, c.dateTimeDisplay, options.reveal)])))
      process.stdout.write(`\n${indent}${title} (${group.records.length})\n`)
      if (childRows.length) c.print({ data: group.records, rows: childRows, columns: fields, headers: fields.map((f) => childTable.fields[f]?.label ?? f) })
      else process.stdout.write(`${indent}  none\n`)
    }
  }
}

export function registerRelated(program: Command, ctx: () => Context): void {
  const table = program.commands.find((x) => x.name() === 'table')!

  table.command('children <table> <primaryKey> [association]')
    .description("Page through one child list of a record (an association: name or child table), with the total count; without an association, lists the record's associations and their counts.")
    .option('-l, --limit <n>', 'children per page', '25')
    .option('--skip <n>', 'children to skip', '0')
    .option('--all', 'every child (pages of --limit)')
    .option('--reveal', 'show REVEAL (masked) values')
    .option(...VARIANT_OPTION)
    .action(async (name: string, primaryKey: string, associationName: string | undefined, options: { limit: string; skip: string; all?: boolean; reveal?: boolean; variant?: string }) => {
      const c = ctx()
      const meta = await c.tableMeta<TableMetaLike>(name)
      const all = associationsOf(meta)
      if (!all.length) throw new UsageError(`${meta.label ?? name} has no associations (child lists).`)
      const limit = intOption(options.limit, '--limit', 1)!
      let skip = intOption(options.skip, '--skip')!
      const variant = await chooseVariant(c, meta as unknown as Json, options.variant)
      const parent = await getRecord(c, name, primaryKey, false, { tableVariant: variantParam(variant) }) as unknown as RecordLike
      const widgets = ((await c.metaData()).widgets ?? {}) as Record<string, WidgetMetaLike>
      const fetchImpl = authenticatedFetch(c.target)
      // a child table on the same variant-backed backend is queried with the parent's variant
      const childVariant = (child: TableMetaLike) => (variant && (child as unknown as Json).usesVariants === true ? variantBody(variant) : {})
      if (!associationName) {
        const rows: Json[] = []
        for (const association of all) {
          let childTable: TableMetaLike | undefined
          let count: number | string = ''
          try {
            childTable = await c.tableMeta<TableMetaLike>(association.associatedTableName)
            count = (await fetchChildren({ baseUrl: c.server, fetch: fetchImpl, parentTable: meta, parent, childTable, association, limit: 0, ...childVariant(childTable) })).count ?? ''
          } catch (error) {
            count = `unavailable: ${error instanceof Error ? error.message : String(error)}`
          }
          rows.push({ association: association.name, label: associationLabel(meta, association, { widgets, childTable }), table: association.associatedTableName, count })
        }
        c.print({ data: rows, columns: ['association', 'label', 'table', 'count'], footer: `qqq table children ${name} ${primaryKey} <association> pages one list` })
        return
      }
      const association = findAssociation(meta, associationName)
      if (!association) throw new UsageError(`No association "${associationName}" on ${meta.label ?? name}; associations: ${all.map((a) => `${a.name} (${a.associatedTableName})`).join(', ')}`)
      const childTable = await c.tableMeta<TableMetaLike>(association.associatedTableName)
      const records: RecordLike[] = []
      let count: number | undefined
      for (;;) {
        const page = await fetchChildren({ baseUrl: c.server, fetch: fetchImpl, parentTable: meta, parent, childTable, association, limit, skip, count: count === undefined, ...childVariant(childTable) })
        count ??= page.count
        records.push(...page.records)
        if (!options.all || page.records.length < limit) break
        skip += limit
      }
      const relationship = relationshipValues(association, meta, parent, childTable)
      const fields = childListFields(childTable, 'error' in relationship ? [] : Object.keys(relationship.values), 8)
      const first = Number(options.skip)
      const label = associationLabel(meta, association, { widgets, childTable })
      c.print({
        data: { association: association.name, table: childTable.name, count, skip: first, records },
        rows: records.map((r) => Object.fromEntries(fields.map((f) => [f, valueText(r as unknown as Json, f, childTable as unknown as Json, c.dateTimeDisplay, options.reveal)]))),
        columns: fields,
        headers: fields.map((f) => childTable.fields[f]?.label ?? f),
        footer: countFooter(records.length, 'record', [
          `${label} of ${parent.recordLabel ?? `${meta.label} ${primaryKey}`}`,
          records.length ? `${first + 1}-${first + records.length} of ${count ?? '?'}` : `of ${count ?? '?'}`,
          !options.all && count !== undefined && first + records.length < count && `next: --skip ${first + records.length}`,
        ]),
      })
    })

  table.command('download <table> <primaryKey> <field>')
    .description('Save a file stored in a record field (FILE_DOWNLOAD through GET /table/{t}/{pk}/{field}/{file}, or a BLOB value).')
    .option('-o, --out <file>', 'where to write, replacing an existing file (default: the file name in the download directory, name-1.ext when taken; - for stdout)')
    .option(...VARIANT_OPTION)
    .action(async (name: string, primaryKey: string, fieldName: string, options: { out?: string; variant?: string }) => {
      const c = ctx()
      const meta = await c.tableMeta<TableMetaLike>(name)
      const field = meta.fields[fieldName]
      if (!field) throw new UsageError(`No field "${fieldName}" in ${name}`)
      const variant = await chooseVariant(c, meta as unknown as Json, options.variant)
      const record = await getRecord(c, name, primaryKey, false, { tableVariant: variantParam(variant) }) as unknown as RecordLike
      const file = fileDownload(field, record)
      let bytes: Uint8Array
      let fileName: string
      if (file?.route) {
        const result = await c.call('downloadRecordFieldFile', { path: file.route })
        bytes = result.bytes ?? new TextEncoder().encode(typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
        fileName = safeFileName(file.fileName)
      } else if (file?.url) {
        c.print({ data: file, rows: [{ file: file.fileName, url: file.url }], columns: ['file', 'url'], footer: 'The file is outside the QQQ server; download it from the URL.' })
        return
      } else {
        const raw = record.values[fieldName]
        if (raw === null || raw === undefined || raw === '') throw new UsageError(`${meta.label} ${primaryKey} has no file in ${field.label}.`)
        if (typeof raw !== 'string' || field.type !== 'BLOB') throw new UsageError(`${field.label} is not a file field (no FILE_DOWNLOAD adornment, not a BLOB).`)
        bytes = new Uint8Array(Buffer.from(raw, 'base64'))
        fileName = safeFileName(`${name}-${primaryKey}-${fieldName}`)
      }
      const written = writeDownload(options.out, fileName, bytes)
      if (written) c.note(`wrote ${written} (${bytes.length} bytes)`)
    })
}
