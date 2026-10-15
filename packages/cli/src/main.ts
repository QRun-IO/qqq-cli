#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * qqq - a reference command-line client for QQQ applications. Every call is an operation of the
 * QQQ UI API (/qqq/v1), through the generated @qrun-io/qqq-ui-api-client; nothing is hard-coded
 * about an application: apps, tables, fields and processes all come from metadata.
 */

import { Command } from 'commander'
import {
  UiApiError, decodeJwtClaims, deviceSignIn, openRealtimeStream, unwrap, UI_API_VERSION,
} from '@qrun-io/qqq-ui-api-client'
import { CLIENT_CHANNEL, CLI_VERSION, clientFor, currentToken, getLogin, nativeConfig, removeLogin, resolveServer, saveLogin } from './session.js'
import { formatTable, parseCriteria, parseValues, valueText } from './format.js'

type Json = Record<string, unknown>

const program = new Command()
program
  .name('qqq')
  .description('Reference CLI for QQQ applications, built only on the QQQ UI API (/qqq/v1).')
  .version(`${CLI_VERSION} (UI API client ${UI_API_VERSION})`)
  .option('-s, --server <url>', 'the QQQ server (default: QQQ_SERVER, or the last one signed in to)')
  .option('--json', 'print JSON instead of tables')

function server(): string {
  return resolveServer(program.opts().server)
}

function json(): boolean {
  return Boolean(program.opts().json)
}

function print(data: unknown, table?: () => string): void {
  console.log(json() || !table ? JSON.stringify(data, null, 2) : table())
}

program.command('login')
  .description('Sign in with the device-authorization grant (approve the code in any browser).')
  .action(async () => {
    const origin = server()
    const config = await nativeConfig(origin)
    const tokens = await deviceSignIn(config, (prompt) => {
      console.error(`To sign in to ${origin}, open:\n\n  ${prompt.verificationUriComplete ?? prompt.verificationUri}\n`)
      console.error(`and confirm the code ${prompt.userCode} (it expires in ${Math.round(prompt.expiresIn / 60)} minutes).`)
      console.error('Waiting for approval...')
    })
    saveLogin(origin, { config, tokens })
    const claims = decodeJwtClaims(tokens.accessToken)
    console.error(`Signed in to ${origin} as ${claims.email ?? claims.preferred_username ?? claims.sub}.`)
  })

program.command('logout')
  .description('Forget this server\'s tokens.')
  .action(() => {
    const origin = server()
    console.error(removeLogin(origin) ? `Signed out of ${origin}.` : `Not signed in to ${origin}.`)
  })

program.command('whoami')
  .description('Show the signed-in user, the server version and its extensions.')
  .action(async () => {
    const origin = server()
    const client = clientFor(origin)
    const version = await unwrap(client.GET('/qqq/v1/version')) as Json
    const token = await currentToken(origin)
    const claims = token && token.includes('.') ? decodeJwtClaims(token) : {}
    const metaData = await unwrap(client.GET('/qqq/v1/metaData', {})) as Json
    const login = getLogin(origin)
    const result = {
      server: origin,
      user: claims.email ?? claims.preferred_username ?? claims.sub,
      name: claims.name,
      tokenExpires: login ? new Date(login.tokens.expiresAt).toISOString() : undefined,
      apiVersion: version.apiVersion,
      extensions: (version.extensions as Json[] | undefined)?.map((e) => `${e.name} ${e.version}`),
      apps: Object.keys((metaData.apps ?? {}) as Json).length,
      tables: Object.keys((metaData.tables ?? {}) as Json).length,
      processes: Object.keys((metaData.processes ?? {}) as Json).length,
    }
    print(result, () => Object.entries(result).map(([k, v]) => `${k.padEnd(13)} ${Array.isArray(v) ? v.join(', ') : v ?? ''}`).join('\n'))
  })

program.command('apps')
  .description('List the apps you may use.')
  .action(async () => {
    const metaData = await unwrap(clientFor(server()).GET('/qqq/v1/metaData', {})) as Json
    const apps = Object.values((metaData.apps ?? {}) as Record<string, Json>)
      .map((a) => ({ name: a.name, label: a.label, items: (a.children as unknown[] | undefined)?.length ?? 0 }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)))
    print(apps, () => formatTable(apps, ['name', 'label', 'items']))
  })

program.command('tables')
  .description('List the tables you may read (optionally of one app).')
  .option('-a, --app <name>', 'only tables in this app')
  .action(async (options: { app?: string }) => {
    const metaData = await unwrap(clientFor(server()).GET('/qqq/v1/metaData', {})) as Json
    let tables = Object.values((metaData.tables ?? {}) as Record<string, Json>).filter((t) => !t.isHidden && t.readPermission !== false)
    if (options.app) {
      const app = (metaData.apps as Record<string, Json> | undefined)?.[options.app]
      if (!app) throw new Error(`No app named ${options.app} (see \`qqq apps\`)`)
      const names = new Set<unknown>()
      const visit = (node: Json | undefined, seen: Set<unknown>) => {
        for (const child of (node?.children ?? []) as Json[]) {
          if (child.type === 'TABLE') names.add(child.name)
          else if (child.type === 'APP' && !seen.has(child.name)) visit((metaData.apps as Record<string, Json>)[String(child.name)], seen.add(child.name))
        }
      }
      visit(app, new Set([options.app]))
      tables = tables.filter((t) => names.has(t.name))
    }
    const rows = tables.map((t) => ({ name: t.name, label: t.label, insert: t.insertPermission ? 'yes' : '', edit: t.editPermission ? 'yes' : '', delete: t.deletePermission ? 'yes' : '' }))
      .sort((a, b) => String(a.label).localeCompare(String(b.label)))
    print(rows, () => formatTable(rows, ['name', 'label', 'insert', 'edit', 'delete']))
  })

program.command('query <table>')
  .description('Query a table. Criteria: "field OPERATOR value[,value]", e.g. "status EQUALS active" or "id GREATER_THAN 10".')
  .option('-w, --where <criteria...>', 'criteria (ANDed)')
  .option('--or', 'OR the criteria instead')
  .option('-o, --order <field>', 'order by a field (prefix with - for descending)')
  .option('-l, --limit <n>', 'most records to return', '25')
  .option('-f, --fields <names>', 'comma-separated fields to show (default: the first few)')
  .action(async (table: string, options: { where?: string[]; or?: boolean; order?: string; limit: string; fields?: string }) => {
    const client = clientFor(server())
    const meta = await unwrap(client.GET('/qqq/v1/metaData/table/{tableName}', { params: { path: { tableName: table } } })) as Json
    const fieldMeta = (meta.fields ?? {}) as Record<string, Json>
    const criteria = (options.where ?? []).map((text) => parseCriteria(text, fieldMeta))
    const order = options.order ? [{ fieldName: options.order.replace(/^-/, ''), isAscending: !options.order.startsWith('-') }] : undefined
    const body = { filter: { criteria, booleanOperator: options.or ? 'OR' as const : 'AND' as const, orderBys: order, limit: Number(options.limit) } }
    const result = await unwrap(client.POST('/qqq/v1/table/{tableName}/query', { params: { path: { tableName: table } }, body })) as Json
    const records = (result.records ?? []) as Json[]
    const fields = options.fields ? options.fields.split(',') : defaultFields(meta)
    const rows = records.map((r) => Object.fromEntries(fields.map((f) => [f, valueText(r, f)])))
    print(json() ? records : rows, () => `${formatTable(rows, fields, fields.map((f) => String(fieldMeta[f]?.label ?? f)))}\n(${records.length} record${records.length === 1 ? '' : 's'})`)
  })

program.command('get <table> <primaryKey>')
  .description('View one record, with field labels and display values.')
  .action(async (table: string, primaryKey: string) => {
    const client = clientFor(server())
    const meta = await unwrap(client.GET('/qqq/v1/metaData/table/{tableName}', { params: { path: { tableName: table } } })) as Json
    const result = await unwrap(client.GET('/qqq/v1/table/{tableName}/{primaryKey}', { params: { path: { tableName: table, primaryKey } } })) as Json
    const record = (result.record ?? result) as Json
    const fieldMeta = (meta.fields ?? {}) as Record<string, Json>
    const rows = Object.keys(fieldMeta).filter((f) => !fieldMeta[f].isHidden)
      .map((f) => ({ field: String(fieldMeta[f].label ?? f), value: valueText(record, f) }))
    print(record, () => `${record.recordLabel ?? `${meta.label} ${primaryKey}`}\n${formatTable(rows, ['field', 'value'], ['Field', 'Value'])}`)
  })

program.command('run <process>')
  .description('Run a process: init, then each step until it completes; prints its results.')
  .option('-v, --value <name=value...>', 'process input values')
  .option('-r, --records <ids>', 'comma-separated primary keys of the process table\'s records to run on')
  .option('--timeout <ms>', 'how long each step may run synchronously', '60000')
  .action(async (processName: string, options: { value?: string[]; records?: string; timeout: string }) => {
    const client = clientFor(server())
    const meta = await unwrap(client.GET('/qqq/v1/metaData/process/{processName}', { params: { path: { processName } } })) as Json
    const steps = ((meta.frontendSteps ?? []) as Json[]).map((s) => String(s.name))
    const values = parseValues(options.value ?? [])
    const form = (extra: Record<string, string>) => {
      const data = new FormData()
      data.append('values', JSON.stringify(values))
      data.append('stepTimeoutMillis', options.timeout)
      for (const [k, v] of Object.entries(extra)) data.append(k, v)
      return data
    }
    const records: Record<string, string> = options.records ? { recordsParam: 'recordIds', recordIds: options.records } : {}
    let response = await unwrap(client.POST('/qqq/v1/processes/{processName}/init', {
      params: { path: { processName } }, body: {} as never, bodySerializer: () => form(records),
    })) as Json
    console.error(`${meta.label ?? processName}: started (${response.processUUID})`)

    for (let guard = 0; guard < 50; guard++) {
      response = await waitForJob(client, processName, response)
      if (response.type === 'ERROR' || response.error) throw new Error(String(response.userFacingError ?? response.error))
      const next = response.nextStep as string | undefined
      if (!next) break
      const isLast = steps.indexOf(next) === steps.length - 1
      console.error(`  step ${next}${isLast ? ' (results)' : ''}`)
      if (isLast) break
      response = await unwrap(client.POST('/qqq/v1/processes/{processName}/{processUUID}/step/{stepName}', {
        params: { path: { processName, processUUID: String(response.processUUID), stepName: next } }, body: {} as never, bodySerializer: () => form({}),
      })) as Json
    }

    const out = (response.values ?? {}) as Json
    const summary = (out.processResults ?? out.recordListSummary ?? []) as Json[]
    if (json()) return print(response)
    if (Array.isArray(summary) && summary.length) {
      for (const line of summary) console.log(`[${line.status ?? 'INFO'}] ${line.count ?? ''} ${line.message ?? ''}`.replace(/\s+/g, ' ').trim())
    } else {
      const shown = Object.entries(out).filter(([, v]) => v !== null && typeof v !== 'object').slice(0, 20)
      console.log(shown.length ? formatTable(shown.map(([k, v]) => ({ value: k, result: String(v) })), ['value', 'result']) : 'Done.')
    }
  })

program.command('jobs')
  .description('List your jobs (durable and tracked processes).')
  .option('--all', 'all states (default: active and recent)')
  .action(async (options: { all?: boolean }) => {
    let result: Json
    try {
      result = await unwrap(clientFor(server()).GET('/qqq/v1/jobs', { params: { query: { scope: 'mine', ...(options.all ? {} : { state: 'active' }) } as never } })) as Json
    } catch (error) {
      if (error instanceof UiApiError && error.status === 404) throw new Error('This server has no jobs operations (durable jobs are not enabled on it).')
      throw error
    }
    const jobs = ((result.jobs ?? []) as Json[]).map((j) => ({ id: j.jobId, label: j.label ?? j.processName, status: j.status, percent: j.percent ?? '', message: j.message ?? '' }))
    print(result, () => `${formatTable(jobs, ['id', 'label', 'status', 'percent', 'message'])}\n(${result.activeCount ?? 0} active)`)
  })

program.command('tail')
  .description('Follow your jobs and notifications live (realtime stream, channel user:me).')
  .option('-c, --channel <channels...>', 'more channels, e.g. table:person or record:person:42')
  .action(async (options: { channel?: string[] }) => {
    const origin = server()
    const client = clientFor(origin)
    const controller = new AbortController()
    process.on('SIGINT', () => controller.abort())
    for await (const message of openRealtimeStream({ baseUrl: origin, token: () => currentToken(origin), clientChannel: CLIENT_CHANNEL, signal: controller.signal })) {
      const data = (message.data ?? {}) as Json
      if (message.event === 'hello') {
        const connectionId = String(data.connectionId ?? (data.data as Json | undefined)?.connectionId ?? '')
        const add = ['user:me', ...(options.channel ?? [])]
        await unwrap(client.POST('/qqq/v1/realtime/subscriptions', { body: { connectionId, add } }))
        console.error(`Following ${add.join(', ')} on ${origin} (Ctrl-C to stop).`)
        continue
      }
      if (json()) {
        console.log(JSON.stringify(message))
        continue
      }
      const payload = (data.data ?? data) as Json
      const time = new Date().toISOString().slice(11, 19)
      const detail = payload.label ?? payload.title ?? payload.message ?? payload.jobId ?? ''
      const progress = payload.percent !== undefined && payload.percent !== null ? ` ${payload.percent}%` : ''
      console.log(`${time} ${message.event}${data.channel ? ` [${data.channel}]` : ''} ${detail}${progress}${payload.status ? ` ${payload.status}` : ''}`.trim())
    }
  })

/** The fields a query shows by default: the primary key and the next few visible fields. */
function defaultFields(meta: Json): string[] {
  const fields = Object.values((meta.fields ?? {}) as Record<string, Json>).filter((f) => !f.isHidden && !f.isHeavy).map((f) => String(f.name))
  const pk = String(meta.primaryKeyField ?? 'id')
  return [pk, ...fields.filter((f) => f !== pk)].slice(0, 6)
}

/** Polls an asynchronous step (JOB_STARTED / RUNNING) until it completes. */
async function waitForJob(client: ReturnType<typeof clientFor>, processName: string, response: Json): Promise<Json> {
  let current = response
  while (current.type === 'JOB_STARTED' || current.type === 'RUNNING') {
    const jobUUID = String(current.jobUUID ?? response.jobUUID)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    current = await unwrap(client.GET('/qqq/v1/processes/{processName}/{processUUID}/status/{jobUUID}', {
      params: { path: { processName, processUUID: String(response.processUUID), jobUUID } },
    })) as Json
    if (current.type === 'RUNNING') console.error(`  running ${current.current ?? ''}/${current.total ?? ''} ${current.message ?? ''}`)
    current = { ...current, jobUUID, processUUID: response.processUUID }
  }
  return current
}

program.parseAsync().catch((error: unknown) => {
  if (error instanceof UiApiError) {
    console.error(`Error: ${error.message} (${error.code}, HTTP ${error.status}${error.traceId ? `, trace ${error.traceId}` : ''})`)
    for (const fieldError of error.fieldErrors) console.error(`  ${fieldError.field}: ${fieldError.message}`)
    if (error.code === 'UNAUTHENTICATED') console.error('Sign in again with `qqq login`.')
  } else {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
  }
  process.exitCode = 1
})
