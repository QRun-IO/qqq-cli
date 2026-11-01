/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The record view's layout, kept identical across the records of one table so paging record to
 * record does not move anything: the section plan comes from the table metadata only, each child
 * list is a fixed-height box (heading, column header, N data rows, a count line) that pads short
 * lists and scrolls long ones, and column widths come from field metadata, never from values.
 */

import { childListFields, childWidgetColumns, widgetAssociation, type AssociationGroup, type TableMetaLike, type WidgetMetaLike } from '@qrun-io/qqq-core'
import type { FieldMetaData, SectionMetaData, TableMetaData } from '../client'
import { pad } from '../util/text'
import type { Row } from './list'

/** One block of the record view, in display order. */
export type LayoutItem =
  | { kind: 'fields'; section: SectionMetaData }
  | { kind: 'widget'; section: SectionMetaData }
  /** A child list: `gi` indexes the record's association groups; `section` is the widget section it renders in. */
  | { kind: 'children'; gi: number; group: AssociationGroup; label: string; columns: string[]; section?: SectionMetaData }

/**
 * Plans the record view: the sections in tier order, where a widget section that lists an
 * association (kernel widgetAssociation, Next's binding) becomes that association's child list,
 * under the section's label with the widget's column set; then the associations no section
 * binds; then deeper child lists (a child's own children), whose number varies with the record,
 * last so they move nothing above them. Each association appears once.
 */
export function planRecordLayout(sections: SectionMetaData[], meta: TableMetaData, groups: AssociationGroup[], widgets: Record<string, WidgetMetaLike> | undefined, childMeta: Map<string, TableMetaData>): LayoutItem[] {
  const table = meta as unknown as TableMetaLike
  const binding = (group: AssociationGroup) => (group.association.join?.joinOns ?? []).map((j) => j.rightField)
  const placed = new Set<number>()
  const items: LayoutItem[] = []
  const topIndex = (name: string) => groups.findIndex((g) => g.depth === 1 && g.association.name === name)
  for (const section of sections) {
    if (!section.widgetName) {
      items.push({ kind: 'fields', section })
      continue
    }
    const widget = widgets?.[section.widgetName]
    const association = widgetAssociation(widget, table)
    const gi = association ? topIndex(association.name) : -1
    if (!association || gi < 0) {
      items.push({ kind: 'widget', section })
      continue
    }
    placed.add(gi)
    // Next leaves out a bound section the user may not see, and its association with it
    if (widget?.hasPermission === false) continue
    const group = groups[gi]!
    const child = childMeta.get(group.table)
    items.push({ kind: 'children', gi, group, label: section.label ?? group.label, columns: child ? childWidgetColumns(child as unknown as TableMetaLike, { widget, bindingFields: binding(group) }) : [], section })
  }
  const listed = (group: AssociationGroup, gi: number): LayoutItem => {
    const child = childMeta.get(group.table)
    return { kind: 'children', gi, group, label: group.depth > 1 ? group.title : group.label, columns: child ? childListFields(child as unknown as TableMetaLike, binding(group)) : [] }
  }
  groups.forEach((group, gi) => { if (group.depth === 1 && !placed.has(gi)) items.push(listed(group, gi)) })
  // grandchild lists: empty ones stay out of the way (as before)
  groups.forEach((group, gi) => { if (group.depth > 1 && group.records.length) items.push(listed(group, gi)) })
  return items
}

/** A child-list column's width from its field metadata (label and type), never from the values shown. */
export function childColumnWidth(field: FieldMetaData): number {
  const type = field.possibleValueSourceName ? 'PVS' : field.type
  const byType = type === 'DATE_TIME' ? 23 : type === 'DATE' ? 10 : type === 'TIME' ? 8 : type === 'BOOLEAN' ? 5 : type === 'INTEGER' || type === 'LONG' ? 8 : type === 'DECIMAL' ? 12 : type === 'PVS' ? 20 : Math.min(24, Number((field as { maxLength?: number }).maxLength ?? 20))
  return Math.min(30, Math.max(field.label.length, byType))
}

export interface ChildBoxInput {
  /** Heading text, without the count (`Lines`). */
  heading: string
  /** Leading spaces of a nested list. */
  indent?: string
  inner: number
  /** Data rows the box shows. */
  rows: number
  /** First record shown (clamped). */
  offset: number
  columns: Array<{ label: string; width: number }>
  /** Every record's cells, in column order. */
  cells: string[][]
  /** Set when the children cannot be read; the box keeps its height. */
  unavailable?: string
  /** Row key of the heading (`c:0`) and of the record at an index (`c:0:7`). */
  key: (index?: number) => string
  onHeading?: () => void
  onOpen?: (index: number) => void
  rule: string
  colors: { heading: string; dim: string }
}

/** The clamped first record of a box of `rows` over `count` records. */
export function clampOffset(offset: number, count: number, rows: number): number {
  return Math.max(0, Math.min(offset, count - rows))
}

/** The count line under a child list: none, the count, or the rows shown when it scrolls. */
export function childBoxIndicator(count: number, offset: number, rows: number): string {
  if (!count) return '(none) · Enter on the heading or F7 adds one'
  if (count <= rows) return `${count} row${count === 1 ? '' : 's'}`
  const first = clampOffset(offset, count, rows)
  return `rows ${first + 1}-${first + rows} of ${count} · PgDn/PgUp or j/k scroll`
}

/** Rows of a child list: blank, heading, column header, exactly `rows` data rows (blank-padded), count line. */
export function childBox(input: ChildBoxInput): Row[] {
  const indent = input.indent ?? ''
  const count = input.cells.length
  const heading = `${indent}${input.heading} (${count}) `
  const out: Row[] = [{ text: '' }, { text: heading + input.rule.repeat(Math.max(0, Math.min(60, input.inner - heading.length - 6))), fg: input.colors.heading, bold: true, key: input.key(), action: input.onHeading }]
  const height = input.rows + 4
  if (input.unavailable) {
    out.push({ text: `${indent}  ${input.unavailable}`, fg: input.colors.dim })
    while (out.length < height) out.push({ text: '' })
    return out
  }
  const line = (values: string[]) => `${indent}  ` + input.columns.map((c, i) => pad(values[i] ?? '', c.width)).join('  ')
  out.push({ text: line(input.columns.map((c) => c.label)), fg: input.colors.dim })
  const first = clampOffset(input.offset, count, input.rows)
  for (let slot = 0; slot < input.rows; slot++) {
    const index = first + slot
    const cells = input.cells[index]
    if (!cells) out.push({ text: '' })
    else out.push({ text: line(cells), key: input.key(index), action: input.onOpen ? () => input.onOpen!(index) : undefined })
  }
  out.push({ text: `${indent}  ${childBoxIndicator(count, first, input.rows)}`, fg: input.colors.dim })
  return out
}

/** Pads a block of rows with blank rows to `height`. */
export function padRows(rows: Row[], height: number): Row[] {
  while (rows.length < height) rows.push({ text: '' })
  return rows
}
