/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { FormInputError, FormSession, isMissingValue, runProcess, type FieldMeta, type ProcessMeta } from '@qrun-io/qqq-core'
import { UsageError, type Context } from '../context.js'
import { promptForm } from '../prompt.js'
import { authenticatedFetch } from '../session.js'
import { parsePairs, readJson, type Json } from './shared.js'

async function processMeta(c: Context, name: string): Promise<Json> {
  return await c.unwrap(c.client.GET('/qqq/v1/metaData/process/{processName}', { params: { path: { processName: name } } })) as Json
}

export function registerProcess(program: Command, ctx: () => Context): void {
  const proc = program.command('process').description('Processes: list, describe, run.')

  proc.command('list')
    .description('List the processes you may run (hidden ones with --all).')
    .option('--all', 'include hidden processes (bulk edit/delete and the like)')
    .option('-t, --table <name>', 'only processes of this table')
    .action(async (options: { all?: boolean; table?: string }) => {
      const c = ctx()
      const metaData = await c.metaData() as unknown as Json
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
    .description('Run a process to completion: init, then each step with the given values, polling asynchronous jobs. On a terminal, missing values are asked for (-i asks for every field).')
    .option('-v, --values <name=value...>', 'input values for form fields (any step); possible-value fields take a label or an id')
    .option('--values-json <json|file|->', 'input values as a JSON object')
    .option('-r, --records <ids>', 'comma-separated primary keys of the process table to run on')
    .option('--filter-json <json|file|->', 'a QueryFilter selecting the records to run on')
    .option('-i, --interactive', 'prompt for every step field, not only missing required ones')
    .option('--no-prompt', 'never prompt; fail when a required value is missing (for scripts)')
    .option('--timeout <ms>', 'how long each step may run before the server backgrounds it', '0')
    .option('--skip-validation', 'on a validation review step, skip full validation')
    .option('--validate', 'on a validation review step, run full validation first')
    .option('--quiet', 'no progress on stderr')
    .action(async (name: string, options: { values?: string[]; valuesJson?: string; records?: string; filterJson?: string; interactive?: boolean; prompt: boolean; timeout: string; skipValidation?: boolean; validate?: boolean; quiet?: boolean }) => {
      const c = ctx()
      const meta = await processMeta(c, name) as unknown as ProcessMeta
      const given: Record<string, unknown> = { ...(options.valuesJson ? readJson(options.valuesJson, '--values-json') as Json : {}), ...parsePairs(options.values, '--values') }
      if (options.validate && options.skipValidation) throw new UsageError('--validate and --skip-validation exclude each other.')
      if (options.validate) given.doFullValidation = 'true'
      if (options.skipValidation) given.doFullValidation = 'false'
      const canPrompt = options.prompt !== false && Boolean(process.stdin.isTTY)
      const fetchImpl = authenticatedFetch(c.server)
      const outcome = await runProcess({
        baseUrl: c.server,
        fetch: fetchImpl,
        meta,
        values: given,
        records: options.records ? { ids: options.records.split(',').map((x) => x.trim()) } : options.filterJson ? { filter: readJson(options.filterJson, '--filter-json') } : undefined,
        stepTimeoutMillis: Number(options.timeout),
        always: Boolean(options.interactive),
        onProgress: (e) => {
          if (options.quiet) return
          if (e.phase === 'init') c.note(`${meta.label ?? name}: starting`)
          else if (e.phase === 'step') c.note(`  step ${e.step}`)
          else if (e.phase === 'running') c.note(`  running${e.current !== undefined ? ` ${e.current}/${e.total ?? '?'}` : ''}${e.message ? ` ${e.message}` : ''}`)
        },
        provide: async ({ step, fields, values, missing }) => {
          // every step's fields go through a form session: labels resolve, contingent fields clear and disable, values validate
          const session = new FormSession({ baseUrl: c.server, fetch: fetchImpl, scope: { process: name }, fields, initialValues: values })
          for (const n of session.promptOrder(fields.map((f) => f.name).filter((n) => given[n] !== undefined))) {
            try {
              await session.set(n, given[n])
            } catch (error) {
              if (error instanceof FormInputError) throw new UsageError(error.message)
              throw error
            }
          }
          if (!canPrompt) {
            const still = missing.filter((f) => isMissingValue(session.values[f.name]))
            if (still.length) throw new UsageError(`Step "${step.label ?? step.name}" needs ${still.map((f) => `--values ${f.name}=…`).join(' ')} (qqq process describe ${name} lists every field; run on a terminal to be asked)`)
          } else {
            if (!options.quiet) c.note(`  ${step.label ?? step.name}:`)
            // ask for whatever the step still lacks (the server decides what is truly required); -i asks for everything
            await promptForm(session, { skipSet: !options.interactive })
          }
          const problems = session.validate(fields.map((f) => f.name))
          if (Object.keys(problems).length) throw new UiApiError(400, { code: 'BAD_REQUEST', message: `Step "${step.label ?? step.name}" has invalid values`, fieldErrors: Object.entries(problems).map(([field, message]) => ({ field, message: `${session.fields[field]?.label ?? field} ${message}` })) })
          const out: Record<string, unknown> = {}
          for (const f of fields) if (session.values[f.name] !== undefined) out[f.name] = session.values[f.name]
          return out
        },
      })
      const out = outcome.values
      const summary = (out.processResults ?? out.recordListSummary ?? []) as Json[]
      const viewFields = (outcome.lastStep?.viewFields ?? []) as FieldMeta[]
      if (Array.isArray(summary) && summary.length) {
        const rows = summary.map((line) => ({ status: line.status ?? 'INFO', count: line.count ?? '', message: String(line.message ?? '').replace(/\s+/g, ' ').trim() }))
        c.print({ data: outcome.response, rows, columns: ['status', 'count', 'message'] })
      } else {
        const names = viewFields.length ? viewFields.map((f) => f.name) : Object.keys(out).filter((k) => out[k] !== null && typeof out[k] !== 'object').slice(0, 30)
        const rows = names.map((k) => ({ value: viewFields.find((f) => f.name === k)?.label ?? k, result: String(out[k] ?? '') }))
        c.print({ data: outcome.response, rows, columns: ['value', 'result'], footer: rows.length ? '' : 'Done.' })
      }
    })
}
