/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import type { Context } from '../context.js'
import { countFooter, instantText, positiveInt, type Json } from './shared.js'

function noJobs(error: unknown): never {
  if (error instanceof UiApiError && error.status === 404) throw new Error('This server has no jobs operations (durable jobs are not enabled on it).')
  throw error
}

export function registerJob(program: Command, ctx: () => Context): void {
  const job = program.command('job').description('Jobs (durable and tracked processes): list, get, logs, cancel, retry.')

  job.command('list')
    .description('List your jobs (active by default; --all for every state).')
    .option('--all', 'all states')
    .option('-l, --limit <n>', 'most jobs', '50')
    .action(async (options: { all?: boolean; limit: string }) => {
      const c = ctx()
      const result = await c.call('listJobs', { query: { scope: 'mine', state: options.all ? undefined : 'active', limit: String(positiveInt(options.limit, '--limit')) } }).catch(noJobs)
      const data = result.data as Json
      const jobs = ((data.jobs ?? []) as Json[]).map((j) => ({ id: j.jobId, label: j.label ?? j.processName, status: j.status, percent: j.percent ?? '', message: j.message ?? '' }))
      c.print({ data, rows: jobs, columns: ['id', 'label', 'status', 'percent', 'message'], footer: countFooter(jobs.length, 'job', [`${data.activeCount ?? 0} active`]) })
    })

  job.command('get <jobId>')
    .description('One job with its phases.')
    .action(async (jobId: string) => {
      const c = ctx()
      const result = await c.call('getJob', { path: { jobId } }).catch(noJobs)
      c.print({ data: result.data })
    })

  job.command('logs <jobId>')
    .description("A job's progress log; --follow keeps reading until it ends.")
    .option('-f, --follow', 'keep following')
    .action(async (jobId: string, options: { follow?: boolean }) => {
      const c = ctx()
      let afterLogId: string | undefined
      for (;;) {
        const result = await c.call('getJobProgress', { path: { jobId }, query: { afterLogId, logLimit: '200' } }).catch(noJobs)
        const data = result.data as Json
        const lines = (data.log ?? data.lines ?? []) as Json[]
        for (const line of lines) {
          console.log(`${instantText(line.timestamp ?? line.at ?? '', c.dateTimeDisplay)}  ${line.level ?? 'info'}  ${line.message ?? ''}`.trim())
          afterLogId = String(line.id ?? line.logId ?? afterLogId ?? '')
        }
        const status = String(data.status ?? data.state ?? '')
        if (!options.follow || /complete|error|fail|cancel/i.test(status)) {
          if (status) c.note(`status: ${status}`)
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    })

  job.command('cancel <jobId>').description('Cancel a job.').action(async (jobId: string) => {
    const c = ctx()
    const result = await c.call('cancelJob', { path: { jobId } }).catch(noJobs)
    c.print({ data: result.data ?? {}, rows: [{ cancelled: jobId }], columns: ['cancelled'] })
  })

  job.command('retry <jobId>').description('Retry a failed job.').action(async (jobId: string) => {
    const c = ctx()
    const result = await c.call('retryJob', { path: { jobId } }).catch(noJobs)
    c.print({ data: result.data ?? {}, rows: [{ retried: jobId }], columns: ['retried'] })
  })

  program.command('jobs', { hidden: true }).description('Alias of `job list`.').option('--all').action(async (options: { all?: boolean }) => { await job.commands.find((x) => x.name() === 'list')!.parseAsync(options.all ? ['--all'] : [], { from: 'user' }) })
}
