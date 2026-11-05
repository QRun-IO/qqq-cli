/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { VariantError, readRememberedVariant, rememberVariant, listTableVariants, resolveVariant, usesVariants, variantLabel, type TableVariant } from '@qrun-io/qqq-core'
import { authenticatedFetch } from '../session.js'
import { UsageError, type Context } from '../context.js'
import type { Json } from './shared.js'

/** The --variant option every table command and `process run` take. */
export const VARIANT_OPTION = ['--variant <id|name|type:id>', 'the table variant (tenant, store, …) to use, remembered for the table (- forgets it); see `qqq table variants <table>`'] as const

/**
 * The variant a command runs with: the one --variant names, or for a table that uses variants and
 * none was named, the only one, a choice on a terminal, or a usage error listing them (the web UI
 * asks and queries nothing until one is chosen).
 */
export async function chooseVariant(c: Context, meta: Json, typed: string | undefined, options: { write?: boolean } = {}): Promise<TableVariant | undefined> {
  const table = String(meta.name)
  if (typed === '-') {
    rememberVariant(c.server, table, undefined)
    typed = undefined
  }
  if (typed === undefined && !usesVariants(meta)) return undefined
  const label = variantLabel(meta)
  // the variant chosen last time for this table (as the web keeps it); --variant changes it, --variant - forgets it
  if (typed === undefined) {
    const remembered = readRememberedVariant(c.server, table)
    if (remembered) {
      c.note(`${label}: ${remembered.name ?? remembered.id} (chosen before; --variant to change, --variant - to forget)`)
      return remembered
    }
  }
  const variants = await listTableVariants(c.server, authenticatedFetch(c.target), table)
  let chosen: TableVariant | undefined
  if (typed !== undefined) {
    try {
      chosen = resolveVariant(variants, typed)
    } catch (error) {
      if (error instanceof VariantError) throw new UsageError(`--variant: ${error.message}`)
      throw error
    }
    if (!usesVariants(meta)) c.note(`note: ${meta.label} does not use variants; sending ${label} ${chosen.name ?? chosen.id} anyway`)
  } else if (variants.length === 1) {
    chosen = variants[0]!
    c.note(`${label}: ${chosen.name ?? chosen.id} (the only one)`)
  } else if (variants.length && process.stdin.isTTY) {
    const { ask } = await import('../prompt.js')
    variants.forEach((v, i) => process.stderr.write(`  ${i + 1}. ${v.name ?? v.id} (${v.id})\n`))
    const answer = await ask(`${meta.label} needs a ${label}: `)
    if (!answer) throw new UsageError(`No ${label} chosen; nothing was queried.`)
    const index = Number(answer)
    try {
      chosen = Number.isInteger(index) && index >= 1 && index <= variants.length ? variants[index - 1]! : resolveVariant(variants, answer)
    } catch (error) {
      if (error instanceof VariantError) throw new UsageError(error.message)
      throw error
    }
  } else {
    throw new UsageError(`${meta.label} needs a ${label}: --variant <id|name>${variants.length ? ` (${variants.slice(0, 10).map((v) => `${v.name ?? v.id} (${v.id})`).join(', ')}${variants.length > 10 ? ', …' : ''})` : '; the server lists none'}`)
  }
  if (chosen && usesVariants(meta)) rememberVariant(c.server, table, chosen)
  // servers before UI API 1.9.0 read tableVariant on query, count, get, export and processes only (docs/server-findings.md #19)
  if (options.write) c.note(`note: servers before UI API 1.9.0 ignore the ${label} on inserts, updates and deletes; see docs/server-findings.md #19`)
  return chosen
}
