/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import type { UiApiClient } from '@qrun-io/qqq-ui-api-client'
import type { Context } from '../context.js'
import { UsageError } from '../context.js'
import { parsePairs, readJson, type Json } from './shared.js'

async function processMeta(c: Context, name: string): Promise<Json> {
  return await c.unwrap(c.client.GET('/qqq/v1/metaData/process/{processName}', { params: { path: { processName: name } } })) as Json
}

/** Polls an asynchronous step (JOB_STARTED / RUNNING) until it completes, reporting progress on stderr. */
async function waitForJob(c: Context, client: UiApiClient, processName: string, response: Json, quiet: boolean): Promise<Json> {
  let current = response
  let lastLine = ''
  while (current.type === 'JOB_STARTED' || current.type === 'RUNNING') {
    const jobUUID = String(current.jobUUID ?? response.jobUUID)
    await new Promise((resolve) => setTimeout(resolve, 500))
    current = await c.unwrap(client.GET('/qqq/v1/processes/{processName}/{processUUID}/status/{jobUUID}', {
      params: { path: { processName, processUUID: String(response.processUUID), jobUUID } },
    })) as Json
    if (current.type === 'RUNNING' && !quiet) {
      const line = `  running${current.current !== undefined ? ` ${current.current}/${current.total ?? '?'}` : ''}${current.message ? ` ${current.message}` : ''}`
      if (line !== lastLine) c.note(line)
      lastLine = line
    }
    current = { ...current, jobUUID, processUUID: response.processUUID }
  }
  return current
}

export function registerProcess(program: Command, ctx: () => Context): void {
  const proc = program.command('process').description('Processes: list, describe, run.')

  proc.command('list')
    .description('List the processes you may run (hidden ones with --all).')
    .option('--all', 'include hidden processes (bulk edit/delete and the like)')
    .option('-t, --table <name>', 'only processes of this table')
    .action(async (options: { all?: boolean; table?: string }) => {
      const c = ctx()
      const metaData = await c.unwrap(c.client.GET('/qqq/v1/metaData', {})) as Json
      const rows = Object.values((metaData.processes ?? {}) as Record<string, Json>)
        .filter((p) => (options.all || !p.isHidden) && (!options.table || p.tableName === options.table))
        .map((p) => ({ name: p.name, label: p.label, table: p.tableName ?? '', hidden: p.isHidden ? 'yes' : '' }))
        .sort((a, b) => String(a.label).localeCompare(String(b.label)))
      c.print({ data: rows, columns: ['name', 'label', 'table', 'hidden'] })
    })

  proc.command('describe <process>')
    .description("A process's steps and the fields each step asks for (what --values can set).")
    .action(async (name: string) => {
      const c = ctx()
      const meta = await processMeta(c, name)
      const rows: Json[] = []
      for (const step of (meta.frontendSteps ?? []) as Json[]) {
        const components = ((step.components ?? []) as Json[]).map((x) => x.type).join(', ')
        const formFields = (step.formFields ?? []) as Json[]
        if (!formFields.length) rows.push({ step: step.name, label: step.label, components, field: '', type: '', required: '' })
        for (const f of formFields) rows.push({ step: step.name, label: step.label, components, field: f.name, type: f.type, required: f.isRequired ? 'yes' : '' })
      }
      c.print({ data: meta, rows, columns: ['step', 'label', 'components', 'field', 'type', 'required'], footer: `${meta.label} (${meta.name})${meta.tableName ? ` on table ${meta.tableName}` : ''}; records: ${meta.minInputRecords ?? 0}..${meta.maxInputRecords ?? 'any'}` })
    })

  proc.command('run <process>')
    .description('Run a process to completion: init, then each step with the given values, polling asynchronous jobs.')
    .option('-v, --values <name=value...>', 'input values for form fields (any step)')
    .option('--values-json <json|file|->', 'input values as a JSON object')
    .option('-r, --records <ids>', 'comma-separated primary keys of the process table to run on')
    .option('--filter-json <json|file|->', 'a QueryFilter selecting the records to run on')
    .option('--timeout <ms>', 'how long each step may run before the server backgrounds it', '0')
    .option('--skip-validation', 'on a validation review step, skip full validation')
    .option('--validate', 'on a validation review step, run full validation first')
    .option('--quiet', 'no progress on stderr')
    .action(async (name: string, options: { values?: string[]; valuesJson?: string; records?: string; filterJson?: string; timeout: string; skipValidation?: boolean; validate?: boolean; quiet?: boolean }) => {
      const c = ctx()
      const client = c.client
      const meta = await processMeta(c, name)
      const steps = ((meta.frontendSteps ?? []) as Json[])
      const stepNames = steps.map((s) => String(s.name))
      const values: Json = { ...(options.valuesJson ? readJson(options.valuesJson, '--values-json') as Json : {}), ...parsePairs(options.values, '--values') }
      if (options.validate && options.skipValidation) throw new UsageError('--validate and --skip-validation exclude each other.')
      if (options.validate) values.doFullValidation = 'true'
      if (options.skipValidation) values.doFullValidation = 'false'
      const form = (extra: Record<string, string>) => {
        const data = new FormData()
        data.append('values', JSON.stringify(values))
        data.append('stepTimeoutMillis', options.timeout)
        for (const [k, v] of Object.entries(extra)) data.append(k, v)
        return data
      }
      const records: Record<string, string> = options.records ? { recordsParam: 'recordIds', recordIds: options.records }
        : options.filterJson ? { recordsParam: 'filterJSON', filterJSON: JSON.stringify(readJson(options.filterJson, '--filter-json')) } : {}
      let response = await c.unwrap(client.POST('/qqq/v1/processes/{processName}/init', {
        params: { path: { processName: name } }, body: {} as never, bodySerializer: () => form(records),
      })) as Json
      if (!options.quiet) c.note(`${meta.label ?? name}: started (${response.processUUID})`)
      for (let guard = 0; guard < 100; guard++) {
        response = await waitForJob(c, client, name, response, Boolean(options.quiet))
        if (response.type === 'ERROR' || response.error) throw new Error(String(response.userFacingError ?? response.error))
        const next = response.nextStep as string | undefined
        if (!next) break
        const step = steps.find((s) => s.name === next)
        const isLast = stepNames.indexOf(next) === stepNames.length - 1
        if (!options.quiet) c.note(`  step ${next}${step?.label ? ` (${step.label})` : ''}${isLast ? ' - results' : ''}`)
        if (isLast) break
        const missing = ((step?.formFields ?? []) as Json[]).filter((f) => f.isRequired && values[String(f.name)] === undefined && (response.values as Json | undefined)?.[String(f.name)] === undefined)
        if (missing.length) throw new UsageError(`Step "${next}" needs ${missing.map((f) => `--values ${f.name}=…`).join(' ')} (qqq process describe ${name} lists every field)`)
        response = await c.unwrap(client.POST('/qqq/v1/processes/{processName}/{processUUID}/step/{stepName}', {
          params: { path: { processName: name, processUUID: String(response.processUUID), stepName: next } }, body: {} as never, bodySerializer: () => form({}),
        })) as Json
      }
      const out = (response.values ?? {}) as Json
      const summary = (out.processResults ?? out.recordListSummary ?? []) as Json[]
      if (Array.isArray(summary) && summary.length) {
        const rows = summary.map((line) => ({ status: line.status ?? 'INFO', count: line.count ?? '', message: String(line.message ?? '').replace(/\s+/g, ' ').trim() }))
        c.print({ data: response, rows, columns: ['status', 'count', 'message'] })
      } else {
        const shown = Object.entries(out).filter(([, v]) => v !== null && typeof v !== 'object').slice(0, 30)
        c.print({ data: response, rows: shown.map(([value, result]) => ({ value, result: String(result) })), columns: ['value', 'result'], footer: shown.length ? '' : 'Done.' })
      }
    })
}
