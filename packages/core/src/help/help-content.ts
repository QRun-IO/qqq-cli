/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Help content the metadata carries (`helpContents` on the instance, apps, tables, sections,
 * fields, processes, steps and widgets) as plain text: the server's `contentAsText` when it sent
 * one, else the content with HTML stripped. Entries may be limited to screen roles; a role filter
 * keeps entries with that role or with none.
 */

import { htmlToText } from '../widgets/render-model.js'

type J = Record<string, unknown>

export interface HelpEntry {
  /** Where the entry sits, e.g. `table`, `field firstName`, `section Identity`, `slot help`. */
  where: string
  title?: string
  summary?: string
  text: string
  roles: string[]
  links: Array<{ label: string; url: string }>
}

/** One help content entry as text. */
export function helpContentText(entry: J): string {
  if (typeof entry.contentAsText === 'string' && entry.contentAsText.trim()) return entry.contentAsText.trim()
  const content = typeof entry.content === 'string' ? entry.content : ''
  if (!content) return ''
  if (entry.format === 'HTML') return htmlToText(content)
  if (typeof entry.contentAsHtml === 'string' && entry.contentAsHtml) return htmlToText(entry.contentAsHtml)
  return content.trim()
}

function entries(value: unknown): J[] {
  if (Array.isArray(value)) return value.filter((e): e is J => Boolean(e) && typeof e === 'object')
  if (value && typeof value === 'object') return [value as J]
  return []
}

function toEntries(where: string, raw: unknown, role?: string): HelpEntry[] {
  return entries(raw).map((e) => ({
    where,
    ...(typeof e.title === 'string' ? { title: e.title } : {}),
    ...(typeof e.summary === 'string' ? { summary: e.summary } : {}),
    text: helpContentText(e),
    roles: Array.isArray(e.roles) ? (e.roles as unknown[]).map(String) : [],
    links: Array.isArray(e.links) ? (e.links as J[]).map((l) => ({ label: String(l.label ?? l.url ?? ''), url: String(l.url ?? '') })) : [],
  })).filter((e) => (e.text || e.summary) && (!role || !e.roles.length || e.roles.includes(role)))
}

/** `helpContents` as a slot map (`{ slot: [entries] }`) or a list, flattened with the slot named. */
function slotEntries(where: string, raw: unknown, role?: string): HelpEntry[] {
  if (Array.isArray(raw)) return toEntries(where, raw, role)
  if (raw && typeof raw === 'object') {
    const out: HelpEntry[] = []
    for (const [slot, list] of Object.entries(raw as J)) out.push(...toEntries(slot === 'help' || slot === '' ? where : `${where} (${slot})`, list, role))
    return out
  }
  return []
}

/** A table's help: the table's own, each section's, and each field's (or only one field's). */
export function tableHelp(tableMeta: J, options: { field?: string; role?: string } = {}): HelpEntry[] {
  const fields = (tableMeta.fields ?? {}) as Record<string, J>
  if (options.field) {
    const field = fields[options.field]
    if (!field) throw new Error(`No field "${options.field}" in ${String(tableMeta.name)}`)
    return slotEntries(`field ${options.field}`, field.helpContents, options.role)
  }
  const out = [...slotEntries('table', tableMeta.helpContents, options.role), ...toEntries('table', tableMeta.helpContent, options.role)]
  for (const section of (tableMeta.sections ?? []) as J[]) out.push(...slotEntries(`section ${String(section.label ?? section.name)}`, section.helpContents, options.role))
  for (const [name, field] of Object.entries(fields)) out.push(...slotEntries(`field ${name}`, field.helpContents, options.role))
  return out
}

/** A process's help: the process's own, then each step's and each step field's. */
export function processHelp(processMeta: J, options: { role?: string } = {}): HelpEntry[] {
  const out = slotEntries('process', processMeta.helpContents, options.role)
  for (const step of (processMeta.frontendSteps ?? []) as J[]) {
    const stepName = String(step.label ?? step.name)
    out.push(...slotEntries(`step ${stepName}`, step.helpContents, options.role))
    for (const component of (step.components ?? []) as J[]) {
      if (component.type === 'HELP_TEXT') {
        const values = (component.values ?? {}) as J
        const text = typeof values.text === 'string' ? values.text : typeof values.html === 'string' ? htmlToText(values.html) : ''
        if (text) out.push({ where: `step ${stepName}`, text, roles: [], links: [] })
      }
    }
    for (const field of [...((step.formFields ?? []) as J[]), ...((step.viewFields ?? []) as J[])]) out.push(...slotEntries(`step ${stepName} field ${String(field.name)}`, field.helpContents, options.role))
  }
  return out
}

/** An app's, a widget's or the instance's help. */
export function metaHelp(where: string, meta: J, options: { role?: string } = {}): HelpEntry[] {
  return slotEntries(where, meta.helpContents, options.role)
}

/** Help entries as readable text. */
export function helpToText(list: HelpEntry[]): string {
  return list.map((e) => [
    `${e.where}${e.title ? `: ${e.title}` : ''}${e.roles.length ? ` [${e.roles.join(', ')}]` : ''}`,
    ...(e.summary && e.summary !== e.text ? [`  ${e.summary}`] : []),
    ...(e.text ? e.text.split('\n').map((l) => `  ${l}`) : []),
    ...e.links.map((l) => `  ${l.label}: ${l.url}`),
  ].join('\n')).join('\n\n')
}
