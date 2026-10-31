/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Table variants: tables whose backend is scoped to a variant (a tenant, store, client) need one
 * named on every query, count, get, export and process call. The options come from
 * `GET /table/{t}/variants`; the chosen one goes back as `tableVariant` (a body member on query,
 * count and export, a JSON query parameter on get and on process init, step, status and records).
 */

import { callOperation } from '../api/call.js'

type J = Record<string, unknown>

/** One variant option (the UI API's `TableVariant`). */
export interface TableVariant {
  id: string
  type: string
  name?: string
}

/** Whether a table needs a variant (`usesVariants` in its metadata). */
export function usesVariants(tableMeta: J): boolean {
  return tableMeta.usesVariants === true
}

/** The label of the variant dimension (`variantTableLabel`), or a neutral word. */
export function variantLabel(tableMeta: J): string {
  return typeof tableMeta.variantTableLabel === 'string' && tableMeta.variantTableLabel ? tableMeta.variantTableLabel : 'Variant'
}

/** Lists the variants a table's backend can be scoped to. */
export async function listTableVariants(baseUrl: string, fetchImpl: typeof fetch, table: string): Promise<TableVariant[]> {
  const result = await callOperation(baseUrl, 'listTableVariants', { path: { tableName: table } }, fetchImpl)
  const data = result.data as J | unknown[] | undefined
  // v1 wraps them ({ variants: [...] }); the legacy route answered a bare list
  const list = Array.isArray(data) ? data : ((data as J | undefined)?.variants ?? [])
  if (!Array.isArray(list)) throw new Error('Invalid variants response')
  return list.filter((v): v is J => Boolean(v) && typeof v === 'object' && 'id' in (v as J) && 'type' in (v as J))
    .map((v) => ({ id: String(v.id), type: String(v.type), ...(v.name !== undefined && v.name !== null ? { name: String(v.name) } : {}) }))
}

/**
 * Picks a variant from typed text: an id, an exact name (any case), a unique partial name, or
 * `type:id` for a variant the listing does not show. Throws with the choices otherwise.
 */
export function resolveVariant(variants: TableVariant[], typed: string): TableVariant {
  const text = typed.trim()
  const explicit = /^([^:]+):(.+)$/.exec(text)
  const byId = variants.filter((v) => v.id === text)
  if (byId.length === 1) return byId[0]!
  const lower = text.toLowerCase()
  const byName = variants.filter((v) => (v.name ?? '').toLowerCase() === lower)
  if (byName.length === 1) return byName[0]!
  const partial = variants.filter((v) => (v.name ?? '').toLowerCase().includes(lower))
  if (partial.length === 1) return partial[0]!
  if (explicit) {
    const hit = variants.find((v) => v.type === explicit[1] && v.id === explicit[2])
    return hit ?? { type: explicit[1]!, id: explicit[2]! }
  }
  const shown = (partial.length > 1 ? partial : variants).slice(0, 10).map((v) => `${v.name ?? v.id} (${v.id})`).join(', ')
  throw new VariantError(partial.length > 1 ? `"${typed}" matches ${partial.length} variants: ${shown}` : `No variant "${typed}"${variants.length ? `; variants: ${shown}${variants.length > 10 ? ', …' : ''}` : ' (the table lists none; give type:id)'}`)
}

/** The variant as the JSON text the get and process routes take in their `tableVariant` query parameter. */
export function variantParam(variant: TableVariant | undefined): string | undefined {
  return variant ? JSON.stringify({ type: variant.type, id: variant.id }) : undefined
}

/** The variant as the body member query, count and export take. */
export function variantBody(variant: TableVariant | undefined): { tableVariant?: { type: string; id: string } } {
  return variant ? { tableVariant: { type: variant.type, id: variant.id } } : {}
}

/** A variant cannot be resolved from what was typed. */
export class VariantError extends Error {}
