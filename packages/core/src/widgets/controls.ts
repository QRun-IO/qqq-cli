/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A dashboard widget's controls, as the web's connected widget has them: the dropdowns its
 * payload declares (possible values or a date picker, paired with the metadata by position),
 * selections reconciled with what the payload offers (defaults applied, stale ones dropped),
 * the request parameters, and the CSV an export button saves.
 */

import { formatCsv } from '../render/output.js'
import { widgetRows, widgetToBlocks } from './render-model.js'

type J = Record<string, unknown>

export interface WidgetDropdown {
  paramName: string
  label: string
  type: 'POSSIBLE_VALUE_SOURCE' | 'DATE_PICKER'
  options: Array<{ id: string; label: string }>
  value: string | null
  labelForNullValue?: string
  isRequired: boolean
}

export interface WidgetControlMeta {
  name: string
  label?: string
  dropdowns?: Array<{ type?: string; label?: string; labelForNullValue?: string; isRequired?: boolean; possibleValueSourceName?: string; name?: string }>
  storeDropdownSelections?: boolean
  hasPermission?: boolean
}

/** The dropdowns of a payload with the current selections. */
export function resolveDropdowns(data: J | undefined, meta: WidgetControlMeta, selections: Record<string, string | null>): WidgetDropdown[] {
  const names = Array.isArray(data?.dropdownNameList) ? data!.dropdownNameList as unknown[] : []
  const labels = Array.isArray(data?.dropdownLabelList) ? data!.dropdownLabelList as unknown[] : []
  const lists = Array.isArray(data?.dropdownDataList) ? data!.dropdownDataList as unknown[] : []
  return names.flatMap((name, index) => {
    if (typeof name !== 'string') return []
    const m = meta.dropdowns?.[index]
    const options = (Array.isArray(lists[index]) ? lists[index] as unknown[] : []).flatMap((o) => {
      const { id, label } = (o ?? {}) as { id?: unknown; label?: unknown }
      return id === undefined || id === null ? [] : [{ id: String(id), label: String(label ?? id) }]
    })
    return [{ paramName: name, label: typeof labels[index] === 'string' ? labels[index] as string : (m?.label ?? name), type: m?.type === 'DATE_PICKER' ? 'DATE_PICKER' as const : 'POSSIBLE_VALUE_SOURCE' as const, options, value: selections[name] ?? null, labelForNullValue: m?.labelForNullValue, isRequired: m?.isRequired === true }]
  })
}

/**
 * Applies the payload's defaults to unset selections and drops selections the payload no longer
 * offers (a stale stored option); returns the new selections and the parameters dropped.
 */
export function reconcileSelections(data: J | undefined, meta: WidgetControlMeta, selections: Record<string, string | null>): { selections: Record<string, string | null>; dropped: string[] } {
  const next = { ...selections }
  const dropped: string[] = []
  const names = Array.isArray(data?.dropdownNameList) ? data!.dropdownNameList as unknown[] : []
  const defaults = Array.isArray(data?.dropdownDefaultValueList) ? data!.dropdownDefaultValueList as unknown[] : []
  const lists = Array.isArray(data?.dropdownDataList) ? data!.dropdownDataList as unknown[] : []
  names.forEach((name, index) => {
    if (typeof name !== 'string') return
    const isDate = meta.dropdowns?.[index]?.type === 'DATE_PICKER'
    const selected = next[name]
    const d = defaults[index]
    if (isDate) {
      if (selected === undefined && typeof d === 'string' && d) next[name] = d
      return
    }
    const ids = (Array.isArray(lists[index]) ? lists[index] as Array<{ id?: unknown }> : []).map((o) => String(o?.id))
    if (selected && !ids.includes(selected) && !(name === 'timeframe' && selected.startsWith('custom,') && ids.includes('custom'))) {
      next[name] = null
      dropped.push(name)
    } else if (selected === undefined && d !== undefined && d !== null && ids.includes(String(d))) next[name] = String(d)
  })
  return { selections: next, dropped }
}

/** The request parameters: the given ones plus every chosen dropdown value. */
export function widgetParams(base: Record<string, string>, selections: Record<string, string | null>): Record<string, string> {
  const out = { ...base }
  for (const [k, v] of Object.entries(selections)) if (v !== null && v !== undefined && v !== '') out[k] = v
  return out
}

/** A date picker value as the web sends it: the local date as en-US M/D/YYYY. */
export function datePickerValue(isoDate: string): string | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate.trim())
  if (!m) return undefined
  return `${Number(m[2])}/${Number(m[3])}/${m[1]}`
}

/** The CSV an export button saves: the payload's csvData, else its first table or series; undefined when there is nothing. */
export function widgetCsv(data: J | undefined): string | undefined {
  if (Array.isArray(data?.csvData) && (data!.csvData as unknown[]).every((r) => Array.isArray(r))) {
    const rows = data!.csvData as unknown[][]
    return rows.map((r) => r.map((c) => {
      const s = c === null || c === undefined ? '' : String(c)
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
    }).join(',')).join('\n') + '\n'
  }
  const rows = widgetRows(widgetToBlocks(data))
  if (!rows || !rows.rows.length) return undefined
  return formatCsv(rows.rows, rows.columns, rows.headers)
}
