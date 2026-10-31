/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Related records: a table's associations (child lists), the values that bind a child to its
 * parent, the filter that lists a parent's children, and the association tree a record read with
 * `includeAssociations=true` carries. Shared by the CLI (`table get --associations`,
 * `table children`, `table create --parent`) and the TUI record view. Follows the Next UI
 * (`association-utils.ts`, `AssociatedRecords.tsx`).
 */

import type { FieldMeta } from '../forms/fields.js'
import type { QueryFilter } from '../filter/grammar.js'
import { callOperation } from '../api/call.js'

export interface JoinOn {
  leftField: string
  rightField: string
}

export interface AssociationMeta {
  name: string
  associatedTableName: string
  join: {
    name?: string
    type?: string
    leftTable: string
    rightTable: string
    joinOns?: JoinOn[]
    orderBys?: Array<{ fieldName: string; isAscending?: boolean }>
  }
}

export interface ExposedJoinMeta {
  label?: string
  joinTable?: string
  joinPath?: Array<{ name?: string }>
  [key: string]: unknown
}

export interface SectionMeta {
  name: string
  label?: string
  tier?: string
  fieldNames?: string[] | null
  widgetName?: string | null
  isHidden?: boolean | null
  helpContents?: unknown
  [key: string]: unknown
}

/** The table metadata the association model reads (a structural subset of TableMetaData). */
export interface TableMetaLike {
  name: string
  label?: string
  primaryKeyField?: string
  fields: Record<string, FieldMeta>
  associations?: AssociationMeta[] | null
  exposedJoins?: ExposedJoinMeta[] | null
  sections?: SectionMeta[] | null
  readPermission?: boolean
  insertPermission?: boolean
  [key: string]: unknown
}

/** A record as the UI API returns it. */
export interface RecordLike {
  tableName?: string
  values: Record<string, unknown>
  displayValues?: Record<string, unknown>
  recordLabel?: string
  associatedRecords?: Record<string, RecordLike[]>
  [key: string]: unknown
}

/** Widget metadata, as far as child-list widgets go (`childRecordList` with a `joinName`). */
export interface WidgetMetaLike {
  name?: string
  label?: string
  type?: string
  defaultValues?: Record<string, unknown>
  [key: string]: unknown
}

/** The associations a table declares (empty when none). */
export function associationsOf(table: TableMetaLike): AssociationMeta[] {
  return Array.isArray(table.associations) ? table.associations : []
}

/** An association by its name, or by its child table when only one association reaches that table. */
export function findAssociation(table: TableMetaLike, nameOrTable: string): AssociationMeta | undefined {
  const all = associationsOf(table)
  const byName = all.find((a) => a.name === nameOrTable)
  if (byName) return byName
  const byTable = all.filter((a) => a.associatedTableName === nameOrTable)
  return byTable.length === 1 ? byTable[0] : undefined
}

/**
 * The label to show for an association: the record-view section whose child-list widget binds the
 * association's join (Next's widget sections), else an exposed join to the same table, else the
 * child table's label, else the association name.
 */
export function associationLabel(table: TableMetaLike, association: AssociationMeta, options: { widgets?: Record<string, WidgetMetaLike>; childTable?: TableMetaLike } = {}): string {
  const joinName = association.join?.name
  if (joinName) {
    for (const section of table.sections ?? []) {
      if (!section.widgetName || section.isHidden) continue
      const widget = options.widgets?.[section.widgetName]
      if (widget?.defaultValues?.joinName === joinName) return String(section.label ?? widget.label ?? association.name)
    }
    for (const widget of Object.values(options.widgets ?? {})) {
      if (widget.type === 'childRecordList' && widget.defaultValues?.joinName === joinName && widget.label) return String(widget.label)
    }
  }
  const exposed = (table.exposedJoins ?? []).find((j) => j.joinTable === association.associatedTableName && j.label)
  if (exposed?.label) return exposed.label
  return options.childTable?.label ?? association.name
}

export type RelationshipValues = { values: Record<string, string | number | boolean>; reverse: boolean } | { error: string }

/**
 * The child-field values that bind a child record to `parent` through the association (one per
 * join-on pair, so composite joins give several). A reverse association (the child is the join's
 * left table) is reported, because its children cannot be listed from the parent.
 */
export function relationshipValues(association: AssociationMeta, parentTable: TableMetaLike, parent: RecordLike, childTable: TableMetaLike): RelationshipValues {
  const join = association.join
  const forward = join.leftTable === parentTable.name && join.rightTable === association.associatedTableName
  const reverse = !forward && join.rightTable === parentTable.name && join.leftTable === association.associatedTableName
  if ((!forward && !reverse) || childTable.name !== association.associatedTableName || !join.joinOns?.length) return { error: 'Association join is unavailable.' }
  const values: Record<string, string | number | boolean> = {}
  for (const pair of join.joinOns) {
    const parentField = forward ? pair.leftField : pair.rightField
    const childField = forward ? pair.rightField : pair.leftField
    const value = parent.values[parentField]
    if (!parentTable.fields[parentField] || !childTable.fields[childField] || !['string', 'number', 'boolean'].includes(typeof value) || value === ''
      || (typeof value === 'number' && !Number.isFinite(value))) {
      return { error: 'Relationship values are unavailable; this record cannot be linked.' }
    }
    const scalar = value as string | number | boolean
    if (Object.prototype.hasOwnProperty.call(values, childField) && values[childField] !== scalar) return { error: 'Association join has conflicting relationship values.' }
    values[childField] = scalar
  }
  return { values, reverse }
}

/** The filter that lists a parent's children: EQUALS on every binding field, ordered as the join says (else by the child's key). */
export function childFilter(association: AssociationMeta, parentTable: TableMetaLike, parent: RecordLike, childTable: TableMetaLike, page: { limit?: number; skip?: number } = {}): QueryFilter {
  const relationship = relationshipValues(association, parentTable, parent, childTable)
  if ('error' in relationship) throw new AssociationError(relationship.error)
  if (relationship.reverse) throw new AssociationError(`${association.name} is a reverse association; its records cannot be listed from ${parentTable.label ?? parentTable.name}.`)
  const orderBys = association.join.orderBys?.length
    ? association.join.orderBys.map((o) => ({ fieldName: o.fieldName, isAscending: o.isAscending !== false }))
    : [{ fieldName: childTable.primaryKeyField ?? 'id', isAscending: true }]
  return {
    criteria: Object.entries(relationship.values).map(([fieldName, value]) => ({ fieldName, operator: 'EQUALS' as const, values: [String(value)] })),
    booleanOperator: 'AND',
    orderBys,
    ...(page.skip !== undefined ? { skip: page.skip } : {}),
    ...(page.limit !== undefined ? { limit: page.limit } : {}),
  }
}

export class AssociationError extends Error {}

/** The fields a child list shows: visible, not heavy, without the fields that point back at the parent, first six. */
export function childListFields(childTable: TableMetaLike, bindingFields: string[] = [], cap = 6): string[] {
  const pk = childTable.primaryKeyField ?? 'id'
  const names = Object.values(childTable.fields).filter((f) => !f.isHidden && !f.isHeavy && !bindingFields.includes(f.name)).map((f) => f.name)
  const ordered = names.includes(pk) ? [pk, ...names.filter((n) => n !== pk)] : names
  return ordered.slice(0, cap)
}

/** One child list of a record, with its place in the tree (`pets`, then `pets[Charlie].notes`). */
export interface AssociationGroup {
  association: AssociationMeta
  label: string
  /** Table of the children. */
  table: string
  /** The parent these children belong to (the root record, or a child at a deeper level). */
  parent: RecordLike
  parentTable: string
  /** Depth: 1 for the record's own children, 2 for grandchildren, and so on. */
  depth: number
  /** Human-readable path, e.g. `Pets`, `Pets: Charlie: Notes`. */
  title: string
  records: RecordLike[]
  /** Set when the children could not be read (no metadata, no read permission). */
  unavailable?: string
}

/**
 * Walks a record read with `includeAssociations=true` into child lists, depth first, honouring the
 * table metadata: every declared association appears (an empty list when the server sent none),
 * and an association whose child table the user may not read is marked unavailable.
 */
export function associationGroups(record: RecordLike, table: TableMetaLike, tables: Record<string, TableMetaLike | undefined>, options: { widgets?: Record<string, WidgetMetaLike>; maxDepth?: number } = {}): AssociationGroup[] {
  const groups: AssociationGroup[] = []
  const maxDepth = options.maxDepth ?? 5
  const walk = (parent: RecordLike, parentTable: TableMetaLike, depth: number, prefix: string): void => {
    if (depth > maxDepth) return
    for (const association of associationsOf(parentTable)) {
      const childTable = tables[association.associatedTableName]
      const label = associationLabel(parentTable, association, { widgets: options.widgets, childTable })
      const title = prefix ? `${prefix}: ${label}` : label
      const records = parent.associatedRecords?.[association.name] ?? []
      const unavailable = !childTable ? `No metadata for table ${association.associatedTableName} (no access, or hidden).`
        : childTable.readPermission === false ? `You may not read ${childTable.label ?? childTable.name}.` : undefined
      groups.push({ association, label, table: association.associatedTableName, parent, parentTable: parentTable.name, depth, title, records: unavailable ? [] : records, ...(unavailable ? { unavailable } : {}) })
      if (unavailable || !childTable) continue
      for (const child of records) {
        const childLabel = child.recordLabel ?? String(child.values[childTable.primaryKeyField ?? 'id'] ?? '')
        walk(child, childTable, depth + 1, `${title}: ${childLabel}`)
      }
    }
  }
  walk(record, table, 1, '')
  return groups
}

/**
 * The values a new child record needs to belong to `parent` (`table create <child> --parent
 * <table>=<pk>`): finds the parent table's association to the child table (or the one named) and
 * returns the binding values. Throws when there is none, or more than one and none was named.
 */
export function parentLinkValues(parentTable: TableMetaLike, parent: RecordLike, childTable: TableMetaLike, associationName?: string): { association: AssociationMeta; values: Record<string, string | number | boolean> } {
  const candidates = associationsOf(parentTable).filter((a) => a.associatedTableName === childTable.name && (!associationName || a.name === associationName))
  if (!candidates.length) throw new AssociationError(`${parentTable.label ?? parentTable.name} has no association to ${childTable.label ?? childTable.name}${associationName ? ` named ${associationName}` : ''}; associations: ${associationsOf(parentTable).map((a) => `${a.name} (${a.associatedTableName})`).join(', ') || 'none'}`)
  if (candidates.length > 1) throw new AssociationError(`${parentTable.label ?? parentTable.name} has several associations to ${childTable.label ?? childTable.name} (${candidates.map((a) => a.name).join(', ')}); name one with --association`)
  const association = candidates[0]!
  const relationship = relationshipValues(association, parentTable, parent, childTable)
  if ('error' in relationship) throw new AssociationError(relationship.error)
  if (relationship.reverse) throw new AssociationError(`${association.name} is a reverse association; create the ${parentTable.label ?? parentTable.name} from the other side.`)
  return { association, values: relationship.values }
}

/** A page of a parent's children, with the total count (`table children`). */
export interface ChildPage {
  association: AssociationMeta
  filter: QueryFilter
  records: RecordLike[]
  count?: number
}

/** Reads one page of children through `queryTable` and their total through `countTable`. */
export async function fetchChildren(options: { baseUrl: string; fetch: typeof fetch; parentTable: TableMetaLike; parent: RecordLike; childTable: TableMetaLike; association: AssociationMeta; limit?: number; skip?: number; count?: boolean }): Promise<ChildPage> {
  const filter = childFilter(options.association, options.parentTable, options.parent, options.childTable, { limit: options.limit, skip: options.skip })
  const query = await callOperation(options.baseUrl, 'queryTable', { path: { tableName: options.childTable.name }, json: { filter } }, options.fetch)
  const data = query.data as { records?: RecordLike[] } | RecordLike[]
  const records = Array.isArray(data) ? data : data.records ?? []
  let count: number | undefined
  if (options.count !== false) {
    const { skip: _skip, limit: _limit, orderBys: _orderBys, ...countFilter } = filter
    const result = await callOperation(options.baseUrl, 'countTable', { path: { tableName: options.childTable.name }, query: { includeDistinct: 'false' }, json: { filter: countFilter } }, options.fetch)
    count = (result.data as { count?: number }).count
  }
  return { association: options.association, filter, records, ...(count !== undefined ? { count } : {}) }
}
