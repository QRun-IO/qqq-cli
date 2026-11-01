/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Command } from 'commander'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { BACK, adHocControls, deniedProcessReason, parseFilter, displayDateTime, formatValue, FormInputError, FormSession, ProcessCancelledError, ProcessError, blocksToText, checkInputRecords, downloadProcessFile, formatTable, helpToText, isMissingValue, processHelp, processHelpText, runProcess, safeFileName, saveDownload, screenToText, summaryLines, variantParam, type FieldMeta, type ProcessMeta, type RunOutcome, type ScreenBlock } from '@qrun-io/qqq-core'
import { UsageError, type Context } from '../context.js'
import { ask, promptForm } from '../prompt.js'
import { authenticatedFetch } from '../session.js'
import { downloadDir, intOption, parsePairs, positiveInt, readFileArg, readJson, type Json } from './shared.js'
import { chooseVariant, VARIANT_OPTION } from './variants.js'

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
        .map((p) => ({ name: p.name, label: p.label, table: p.tableName ?? '', hidden: p.isHidden ? 'yes' : '', note: deniedProcessReason(p) ?? '' }))
        .sort((a, b) => String(a.label).localeCompare(String(b.label)))
      c.print({ data: rows, columns: ['name', 'label', 'table', 'hidden', ...(rows.some((r) => r.note) ? ['note'] : [])] })
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
      // the same help `qqq help show process <p>` prints
      const help = processHelp(meta)
      c.print({ data: meta, rows, columns: ['step', 'label', 'components', 'field', 'type', 'required'], footer: `${meta.label} (${meta.name})${meta.tableName ? ` on table ${meta.tableName}` : ''}; records: ${meta.minInputRecords ?? 0}..${meta.maxInputRecords ?? 'any'}${help.length ? `\n\nHelp:\n${helpToText(help)}` : ''}` })
    })

  proc.command('run <process>')
    .description('Run a process to completion: init, then each step with the given values, polling asynchronous jobs. Each screen is shown (help, values, records, review, results); on a terminal, missing values are asked for (-i asks for every field). Ctrl-C cancels the run on the server.')
    .option('-v, --values <name=value...>', 'input values for form fields (any step); possible-value fields take a label or an id')
    .option('--values-json <json|file|->', 'input values as a JSON object')
    .option('-r, --records <ids>', 'comma-separated primary keys of the process table to run on')
    .option('--filter-json <json|file|->', 'a QueryFilter selecting the records to run on')
    .option('-F, --file <field=path...>', 'a file for a BLOB input field (uploads, bulk load)')
    .option('-i, --interactive', 'prompt for every step field, not only missing required ones')
    .option('--no-prompt', 'never prompt; fail when a required value is missing (for scripts)')
    .option('--timeout <ms>', 'how long each step may run before the server backgrounds it', '0')
    .option('--skip-validation', 'on a validation review step, skip full validation')
    .option('--validate', 'on a validation review step, run full validation first')
    .option('--out-dir <dir>', 'where files a step offers for download are saved (default: the download directory, else the current one)')
    .option('--record-limit <n>', 'most records a record list shows', '100')
    .option('--quiet', 'no progress or intermediate screens on stderr')
    .option(...VARIANT_OPTION)
    .action(async (name: string, options: RunOptions) => {
      const c = ctx()
      const meta = await processMeta(c, name) as unknown as ProcessMeta
      // a DISABLED process is listed with hasPermission false: refuse with the reason (the server would too)
      const denied = deniedProcessReason(meta as unknown as Json)
      if (denied) throw new UiApiError(403, { code: 'PERMISSION_DENIED', message: denied })
      // a process on a variant table runs with the variant on init and every step (as the web UI does)
      const tableVariant = meta.tableName && (options.variant !== undefined || ((await c.metaData() as unknown as Json).tables as Record<string, Json> | undefined)?.[meta.tableName])
        ? variantParam(await chooseVariant(c, await c.tableMeta<Json>(meta.tableName), options.variant))
        : undefined
      if (options.variant !== undefined && !meta.tableName) throw new UsageError(`${meta.label ?? name} has no table, so it takes no --variant`)
      const given: Record<string, unknown> = { ...(options.valuesJson ? readJson(options.valuesJson, '--values-json') as Json : {}), ...parsePairs(options.values, '--values') }
      if (options.validate && options.skipValidation) throw new UsageError('--validate and --skip-validation exclude each other.')
      if (options.validate) given.doFullValidation = 'true'
      if (options.skipValidation) given.doFullValidation = 'false'
      const canPrompt = options.prompt !== false && Boolean(process.stdin.isTTY)
      const fetchImpl = authenticatedFetch(c.target)
      const records = options.records ? { ids: options.records.split(',').map((x) => x.trim()).filter(Boolean) } : options.filterJson ? { filter: readJson(options.filterJson, '--filter-json') } : undefined
      try {
        await checkInputRecords(meta, records, meta.tableName ? async (filter) => Number(((await c.call('countTable', { path: { tableName: String(meta.tableName) }, json: { filter } })).data as Json).count ?? 0) : undefined)
      } catch (error) {
        if (error instanceof ProcessError) throw new UsageError(error.message)
        throw error
      }
      const fileFields = new Set(Object.keys(parsePairs(options.file, '--file')))
      const width = process.stdout.columns ?? 100
      const textOf = (screen: ScreenBlock[]) => screenToText(screen, { table: (rows, columns, headers) => formatTable(rows, columns, headers), widget: (blocks) => blocksToText(blocks, { width }) })
      const saved: string[] = []
      const saveDownloads = async (screen: ScreenBlock[]) => {
        for (const block of screen) {
          if (block.kind !== 'download') continue
          const file = await downloadProcessFile(c.server, fetchImpl, block)
          const dir = options.outDir ?? downloadDir()
          mkdirSync(dir, { recursive: true })
          // the name comes from the server: last segment only, and never overwrite an existing file
          const path = saveDownload(join(dir, safeFileName(block.fileName)), file.bytes, { explicit: false })
          saved.push(path)
          c.note(`saved ${path} (${file.bytes.length} bytes${file.contentType ? `, ${file.contentType}` : ''})`)
        }
      }

      // Ctrl-C: the first cancels the run on the server, a second leaves at once
      const abort = new AbortController()
      let declined = false
      const onInterrupt = () => {
        if (abort.signal.aborted) process.exit(130)
        c.note('\ncancelling (Ctrl-C again to leave at once)...')
        abort.abort()
      }
      process.on('SIGINT', onInterrupt)
      if (!options.quiet) for (const text of processHelpText(meta as never)) c.note(text)
      let outcome: RunOutcome
      try {
        outcome = await runProcess({
          baseUrl: c.server,
          fetch: fetchImpl,
          meta,
          values: given,
          records,
          files: Object.fromEntries(Object.entries(parsePairs(options.file, '--file')).map(([field, path]) => [field, { name: basename(path), bytes: readFileArg(path, `--file ${field}`) }])),
          stepTimeoutMillis: intOption(options.timeout, '--timeout'),
          tableVariant,
          always: Boolean(options.interactive),
          signal: abort.signal,
          screen: { recordLimit: positiveInt(options.recordLimit, '--record-limit'), format: (field, value, shown) => (field.type === 'DATE_TIME' ? displayDateTime(value, shown, c.dateTimeDisplay) : formatValue(field, value)) },
          onProgress: (e) => {
            if (options.quiet) return
            if (e.phase === 'init') c.note(`${meta.label ?? name}: starting`)
            else if (e.phase === 'running') c.note(`  running${e.current !== undefined ? ` ${e.current}/${e.total ?? '?'}` : ''}${e.message ? ` ${e.message}` : ''}`)
            else if (e.phase === 'back') c.note(`  back to ${e.step}`)
            else if (e.phase === 'cancel') c.note('  asking the server to cancel the run')
          },
          present: async ({ step, screen, isLast }) => {
            await saveDownloads(screen)
            if (isLast || options.quiet) return
            const text = textOf(screen)
            if (text) c.note(`\n== ${step.label ?? step.name} ==\n${text}`)
          },
          provide: async ({ step, fields, values, missing, screen, backStep }) => {
            const out: Record<string, unknown> = {}
            const review = screen.find((b) => b.kind === 'review')
            if (review && review.kind === 'review') {
              if (given.doFullValidation === undefined && values.validationSummary === undefined && review.supportsFullValidation && canPrompt) {
                const answer = await ask('Validate fully before running, or skip validation? [v/S] ', { signal: abort.signal })
                out.doFullValidation = /^v/i.test(answer) ? 'true' : 'false'
                given.doFullValidation = out.doFullValidation
              } else if (given.doFullValidation === undefined && values.validationSummary === undefined && review.supportsFullValidation && !canPrompt) {
                throw new UsageError(`Step "${step.label ?? step.name}" is a validation review: pass --validate or --skip-validation (or run on a terminal to be asked).`)
              } else if (values.validationSummary !== undefined && canPrompt && !c.options.yes) {
                const answer = await ask('Submit? [Y/n] ', { signal: abort.signal })
                if (/^n/i.test(answer)) {
                  declined = true
                  abort.abort()
                  throw new Error('not submitted')
                }
              }
            }
            // a field drawn by a filterAndColumnsSetup widget (WIDGET adornment) takes a filter: the grammar becomes its QueryFilter JSON
            const widgetMeta = ((await c.metaData() as unknown as Json).widgets ?? {}) as Record<string, Json>
            for (const f of fields) {
              const adornment = (f.adornments ?? []).find((a) => a.type === 'WIDGET') as { values?: Record<string, unknown> } | undefined
              const widgetType = adornment ? widgetMeta[String(adornment.values?.widgetName ?? '')]?.type : undefined
              const typed = given[f.name]
              if (widgetType === 'filterAndColumnsSetup' && typeof typed === 'string' && typed.trim() && !typed.trim().startsWith('{')) {
                try {
                  given[f.name] = JSON.stringify(parseFilter(typed))
                } catch (error) {
                  throw new UsageError(`--values ${f.name}: ${error instanceof Error ? error.message : String(error)}`)
                }
              }
            }
            // every step's fields go through a form session: labels resolve, contingent fields clear and disable, values validate
            const inputs = fields.filter((f) => !(f.type === 'BLOB' && fileFields.has(f.name)))
            if (inputs.length) {
              const session = new FormSession({ baseUrl: c.server, fetch: fetchImpl, scope: { process: name }, fields: inputs, initialValues: values })
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
                // ask for whatever the step still lacks (the server decides what is truly required); -i asks for everything
                await promptForm(session, { skipSet: !options.interactive, signal: abort.signal })
              }
              const problems = session.validate(fields.map((f) => f.name).filter((n) => !fileFields.has(n)))
              if (Object.keys(problems).length) throw new UiApiError(400, { code: 'BAD_REQUEST', message: `Step "${step.label ?? step.name}" has invalid values`, fieldErrors: Object.entries(problems).map(([field, message]) => ({ field, message: `${session.fields[field]?.label ?? field} ${message}` })) })
              for (const f of fields) if (session.values[f.name] !== undefined) out[f.name] = session.values[f.name]
            }
            // an ad hoc composite widget's buttons: an actionCode submits the step with it
            const buttons = adHocControls(step, values).buttons.filter((b) => b.actionCode)
            if (buttons.length && given.actionCode === undefined) {
              if (canPrompt) {
                buttons.forEach((b, i) => c.note(`  ${i + 1}. ${b.label}`))
                const answer = await ask(`Choose a button (1-${buttons.length})${inputs.length ? ', or Enter to submit the values' : ''}: `, { signal: abort.signal })
                const chosen = buttons[Number(answer) - 1] ?? buttons.find((b) => b.label.toLowerCase() === answer.toLowerCase() || b.actionCode === answer)
                if (chosen) out.actionCode = chosen.actionCode
                else if (answer || !inputs.length) throw new UsageError(`No button "${answer}" (${buttons.map((b) => b.label).join(', ')})`)
              } else if (!inputs.length) {
                throw new UsageError(`Step "${step.label ?? step.name}" offers buttons: pass --values actionCode=<code> (${buttons.map((b) => `${b.actionCode} = ${b.label}`).join(', ')})`)
              }
            } else if (given.actionCode !== undefined) out.actionCode = given.actionCode
            if (backStep && canPrompt) {
              const backLabel = outcomeStepLabel(meta, backStep)
              const answer = await ask(`Enter to continue, b to go back to ${backLabel}: `, { signal: abort.signal })
              if (/^b/i.test(answer)) return BACK
            }
            return out
          },
        })
      } catch (error) {
        if (error instanceof ProcessCancelledError && declined) {
          // answering no is a choice, as "Not deleted." is for table delete: exit 0
          c.note(`Not submitted; ${meta.label ?? name} ${error.message}${error.processUUID ? ` (process ${error.processUUID})` : ''}`)
          return
        }
        if (error instanceof ProcessCancelledError) {
          c.note(`${meta.label ?? name}: ${error.message}${error.processUUID ? ` (process ${error.processUUID})` : ''}`)
          process.exitCode = 130
          return
        }
        throw error
      } finally {
        process.off('SIGINT', onInterrupt)
      }
      printOutcome(c, outcome, textOf, saved)
    })
}

interface RunOptions { values?: string[]; valuesJson?: string; records?: string; filterJson?: string; file?: string[]; interactive?: boolean; prompt: boolean; timeout: string; skipValidation?: boolean; validate?: boolean; outDir?: string; recordLimit: string; quiet?: boolean; variant?: string }

function outcomeStepLabel(meta: ProcessMeta, stepName: string): string {
  return meta.frontendSteps?.find((s) => s.name === stepName)?.label ?? stepName
}

/** Prints the last screen: as text on table/text output, else the response with summary or value rows. */
export function printOutcome(c: Context, outcome: RunOutcome, textOf: (screen: ScreenBlock[]) => string, saved: string[]): void {
  const out = outcome.values
  if ((c.format === 'table' || c.format === 'text') && !c.options.query && outcome.lastScreen?.length) {
    const text = textOf(outcome.lastScreen)
    process.stdout.write(`${text || 'Done.'}${saved.length ? `\n${saved.map((p) => `saved: ${p}`).join('\n')}` : ''}\n`)
    return
  }
  const summary = (out.processResults ?? out.recordListSummary ?? []) as Json[]
  const viewFields = (outcome.lastStep?.viewFields ?? []) as FieldMeta[]
  if (Array.isArray(summary) && summary.length) {
    const rows = summaryLines(summary).map((line) => ({ status: line.status, count: line.count ?? '', message: line.message }))
    c.print({ data: outcome.response, rows, columns: ['status', 'count', 'message'] })
  } else {
    const names = viewFields.length ? viewFields.map((f) => f.name) : Object.keys(out).filter((k) => out[k] !== null && typeof out[k] !== 'object').slice(0, 30)
    const rows = names.map((k) => ({ value: viewFields.find((f) => f.name === k)?.label ?? k, result: String(out[k] ?? '') }))
    c.print({ data: outcome.response, rows, columns: ['value', 'result'], footer: rows.length ? '' : 'Done.' })
  }
}
