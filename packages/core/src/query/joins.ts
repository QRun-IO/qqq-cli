/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Exposed joins: the joins a table's metadata exposes (`exposedJoins`) let a query show, filter
 * and sort on fields of another table, named `joinTable.field`. As in the web UI, a query joins
 * only the exposed joins it uses (named explicitly, or referenced by a shown column, a criterion
 * or a sort), each as a LEFT join with its join name when the path is one hop; a many-side join
 * can repeat base records, so counts then ask for the distinct count too.
 */

import type { QueryFilter } from '../filter/grammar.js'

type J = Record<string, unknown>

/** One exposed join of a table. */
export interface ExposedJoin {
  /** The joined table's name (the prefix of its qualified field names). */
  table: string
  label: string
  isMany: boolean
  /** The join name, when the path is a single hop. */
  joinName?: string
  /** The joined table's metadata, as the exposed join carries it. */
  tableMeta: J
}

/** The UI API's `QueryJoin`. */
export interface QueryJoin {
  joinTable: string
  select?: boolean
  type?: 'INNER' | 'LEFT' | 'RIGHT' | 'FULL'
  joinName?: string
  alias?: string
  baseTableOrAlias?: string
}

/**
 * The exposed joins the user may read: the joined table and every table on the path readable
 * (`readPermission` in `tables`, the instance metadata's table list, when given).
 */
export function exposedJoins(tableMeta: J, tables?: Record<string, J>): ExposedJoin[] {
  const out: ExposedJoin[] = []
  for (const raw of (tableMeta.exposedJoins ?? []) as J[]) {
    const joinTable = raw.joinTable as J | undefined
    if (!joinTable?.name || joinTable.readPermission === false) continue
    const path = (raw.joinPath ?? []) as J[]
    if (tables) {
      const names = [String(joinTable.name), ...path.flatMap((p) => [String(p.leftTable), String(p.rightTable)])]
      if (!names.every((n) => n === tableMeta.name || tables[n]?.readPermission !== false && tables[n] !== undefined)) continue
    }
    out.push({
      table: String(joinTable.name),
      label: String(raw.label ?? joinTable.label ?? joinTable.name),
      isMany: raw.isMany === true,
      ...(path.length === 1 && path[0]!.name ? { joinName: String(path[0]!.name) } : {}),
      tableMeta: joinTable,
    })
  }
  return out
}

/** Finds an exposed join by its table name or label (any case). */
export function findExposedJoin(joins: ExposedJoin[], name: string): ExposedJoin | undefined {
  const lower = name.toLowerCase()
  return joins.find((j) => j.table === name) ?? joins.find((j) => j.table.toLowerCase() === lower || j.label.toLowerCase() === lower)
}

/** Every qualified `joinTable.field` name the joins offer (hidden fields left out). */
export function joinFieldNames(joins: ExposedJoin[]): string[] {
  return joins.flatMap((j) => Object.entries((j.tableMeta.fields ?? {}) as Record<string, J>).filter(([, f]) => !f.isHidden).map(([n]) => `${j.table}.${n}`))
}

/** A field of the table, or `joinTable.field` of an exposed join, with its metadata and the join. */
export function resolveField(tableMeta: J, joins: ExposedJoin[], name: string): { field: J; join?: ExposedJoin } | undefined {
  const own = ((tableMeta.fields ?? {}) as Record<string, J>)[name]
  if (own) return { field: own }
  const at = name.indexOf('.')
  if (at < 1) return undefined
  const join = joins.find((j) => j.table === name.slice(0, at))
  const field = join && ((join.tableMeta.fields ?? {}) as Record<string, J>)[name.slice(at + 1)]
  return field ? { field, join } : undefined
}

/** A column header: the field label, prefixed with the join label for joined fields. */
export function fieldLabel(tableMeta: J, joins: ExposedJoin[], name: string): string {
  const found = resolveField(tableMeta, joins, name)
  if (!found) return name
  const label = String(found.field.label ?? found.field.name ?? name)
  return found.join ? `${found.join.label}: ${label}` : label
}

/** Every field name a filter refers to (criteria, sub-filters and sorts). */
export function filterFieldNames(filter: Partial<QueryFilter> | undefined): string[] {
  if (!filter) return []
  return [
    ...(filter.criteria ?? []).map((c) => c.fieldName),
    ...(filter.orderBys ?? []).map((o) => o.fieldName),
    ...(filter.subFilters ?? []).flatMap((s) => filterFieldNames(s)),
  ]
}

/** The default joined columns for a selected join: its sections' fields by tier, then the rest, without the primary key; capped. */
export function defaultJoinColumns(join: ExposedJoin, cap = 4): string[] {
  const fields = (join.tableMeta.fields ?? {}) as Record<string, J>
  const pk = String(join.tableMeta.primaryKeyField ?? '')
  const order: string[] = []
  const add = (n: string) => { if (fields[n] && !fields[n]!.isHidden && !fields[n]!.isHeavy && n !== pk && !order.includes(n)) order.push(n) }
  const sections = (join.tableMeta.sections ?? []) as J[]
  for (const tier of ['T1', 'T2', 'T3']) for (const section of sections.filter((x) => x.tier === tier)) for (const n of (section.fieldNames ?? []) as string[]) add(n)
  for (const n of Object.keys(fields)) add(n)
  return order.slice(0, cap).map((n) => `${join.table}.${n}`)
}

/**
 * The joins a query needs: the named ones plus those its columns and filter refer to. A join is
 * selected when it was named with `select`, or when a shown column comes from it.
 */
export function planJoins(joins: ExposedJoin[], options: { named?: string[]; select?: boolean; columns?: string[]; filter?: Partial<QueryFilter> }): { joins: QueryJoin[]; used: ExposedJoin[]; includeDistinct: boolean } {
  const prefix = (n: string) => (n.indexOf('.') > 0 ? n.slice(0, n.indexOf('.')) : undefined)
  const shown = new Set((options.columns ?? []).map(prefix).filter((p): p is string => Boolean(p)))
  const used = new Map<string, { join: ExposedJoin; select: boolean }>()
  for (const name of options.named ?? []) {
    const join = findExposedJoin(joins, name)
    if (!join) throw new JoinError(`No exposed join "${name}"${joins.length ? `; joins: ${joins.map((j) => `${j.table} (${j.label})`).join(', ')}` : ' (the table exposes none)'}`)
    used.set(join.table, { join, select: Boolean(options.select) || shown.has(join.table) })
  }
  for (const name of [...(options.columns ?? []), ...filterFieldNames(options.filter)]) {
    const table = prefix(name)
    if (!table || used.has(table)) continue
    const join = joins.find((j) => j.table === table)
    if (!join) throw new JoinError(`"${name}" names no exposed join${joins.length ? `; joins: ${joins.map((j) => j.table).join(', ')}` : ' (the table exposes none)'}`)
    used.set(table, { join, select: shown.has(table) })
  }
  const list = [...used.values()]
  return {
    joins: list.map(({ join, select }) => ({ joinTable: join.table, select, type: 'LEFT' as const, ...(join.joinName ? { joinName: join.joinName } : {}) })),
    used: list.map((u) => u.join),
    includeDistinct: list.some((u) => u.join.isMany),
  }
}

/** A join cannot be resolved. */
export class JoinError extends Error {}

/**
 * A join from one of the table's associations (`associations[].join`), for tables that expose no
 * join to it. The web UI joins only exposed joins; the CLI also offers these, marked as such.
 */
export function associationJoin(association: J, joinedTableMeta: J): ExposedJoin | undefined {
  const join = association.join as J | undefined
  if (!joinedTableMeta?.name || joinedTableMeta.readPermission === false) return undefined
  return {
    table: String(joinedTableMeta.name),
    label: String(joinedTableMeta.label ?? association.name ?? joinedTableMeta.name),
    isMany: join?.type === 'ONE_TO_MANY' || join?.type === 'MANY_TO_MANY',
    ...(join?.name ? { joinName: String(join.name) } : {}),
    tableMeta: joinedTableMeta,
  }
}
