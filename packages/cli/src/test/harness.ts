/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Test harness for the CLI as a whole: a small fake QQQ server (node:http) that answers from
 * responses recorded against the sample server (src/test/fixtures) plus a little state for
 * writes and process runs, and a runner that spawns the built CLI against it with a throwaway
 * config, cache and file keyring. Hermetic: no network beyond 127.0.0.1, no terminal.
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

type J = Record<string, unknown>

const here = dirname(fileURLToPath(import.meta.url))
/** src/test, wherever the compiled test runs from (dist/test reads the fixtures from src). */
export const TEST_SOURCE = join(here, '..', '..', 'src', 'test')
const FIXTURES = join(TEST_SOURCE, 'fixtures')
export const CLI = join(here, '..', 'main.js')

export function fixture(name: string): J {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as J
}

export interface RecordedRequest {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string | string[] | undefined>
  body: string
}

export interface FakeServer {
  url: string
  requests: RecordedRequest[]
  close(): Promise<void>
}

const PEOPLE = [{ id: 1, label: 'Avery Sample' }, { id: 2, label: 'Blair Sample' }, { id: 3, label: 'Casey Sample' }]
const SPECIES = [{ id: 1, label: 'Dog' }, { id: 2, label: 'Cat' }]
const COUNTRIES = [{ id: 1, label: 'USA' }, { id: 2, label: 'Canada' }]
const STATES: Record<string, Array<{ id: number; label: string }>> = { 1: [{ id: 1, label: 'Illinois' }, { id: 2, label: 'Missouri' }], 2: [{ id: 5, label: 'Ontario' }] }
const CITIES: Record<string, Array<{ id: number; label: string }>> = { 1: [{ id: 1, label: 'Chester' }, { id: 2, label: 'Springfield' }], 2: [{ id: 3, label: 'St. Louis' }, { id: 4, label: 'Kansas City' }], 5: [{ id: 6, label: 'Toronto' }] }

/** The error a table named errNNN answers with (exit-code tests). */
function errorFor(status: number): J {
  const codes: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 500: 'INTERNAL_ERROR', 503: 'UNAVAILABLE' }
  return { code: codes[status] ?? 'ERROR', message: `fake ${status}`, traceId: `trace-${status}`, ...(status === 400 ? { fieldErrors: [{ field: 'name', message: 'is required' }] } : {}) }
}

/** Starts the fake server on a free loopback port. */
export async function startFakeServer(): Promise<FakeServer> {
  const requests: RecordedRequest[] = []
  const pets: Record<string, J> = {
    7: { values: { id: 7, name: 'Rex', personId: 1, speciesId: 1 }, displayValues: { personId: 'Avery Sample', speciesId: 'Dog' }, recordLabel: 'Rex' },
  }
  const jobs: Record<string, number> = {}

  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body)
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(text)
  }

  const handle = (req: IncomingMessage, body: string, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://fake')
    const path = url.pathname.replace(/^\/qqq\/v1/, '')
    const method = req.method ?? 'GET'
    requests.push({ method, path, query: Object.fromEntries(url.searchParams), headers: req.headers, body })
    const json = (): J => {
      try {
        return body ? JSON.parse(body) as J : {}
      } catch {
        return {}
      }
    }
    if (path === '/version') return send(res, 200, fixture('version'))
    if (path === '/metaData/authentication') return send(res, 200, { type: 'OAUTH2', values: {} })
    if (!req.headers.authorization && !String(req.headers.cookie ?? '').includes('sessionUUID=')) return send(res, 401, errorFor(401))
    if (req.headers.authorization === 'Bearer expired') return send(res, 401, errorFor(401))

    const err = /\/err(\d{3})(\/|$)/.exec(path)
    if (err) return send(res, Number(err[1]), errorFor(Number(err[1])))

    let m: RegExpExecArray | null
    if (path === '/metaData') return send(res, 200, fixture('metaData'))
    if ((m = /^\/metaData\/table\/([^/]+)$/.exec(path))) {
      try {
        return send(res, 200, fixture(`table-${m[1]}`))
      } catch {
        return send(res, 404, { code: 'NOT_FOUND', message: `Table ${m[1]} was not found.` })
      }
    }
    if ((m = /^\/metaData\/process\/([^/]+)$/.exec(path))) {
      try {
        return send(res, 200, fixture(`process-${m[1]}`))
      } catch {
        return send(res, 404, { code: 'NOT_FOUND', message: `Process ${m[1]} was not found.` })
      }
    }
    if ((m = /^\/table\/([^/]+)\/query$/.exec(path)) && method === 'POST') {
      const filter = (json().filter ?? {}) as J
      const skip = Number(filter.skip ?? 0)
      const limit = Number(filter.limit ?? 25)
      const all = m[1] === 'person' ? (fixture('query-person').records as J[]) : m[1] === 'pet' ? Object.values(pets) : []
      return send(res, 200, { records: all.slice(skip, skip + limit) })
    }
    if ((m = /^\/table\/([^/]+)\/export$/.exec(path)) && method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'text/csv' })
      res.end('id,firstName\n1,Avery\n2,Blair\n')
      return
    }
    if ((m = /^\/table\/([^/]+)\/count$/.exec(path)) && method === 'POST') return send(res, 200, { count: m[1] === 'person' ? 3 : m[1] === 'pet' ? Object.keys(pets).length : 0 })
    if ((m = /^\/table\/([^/]+)\/possibleValues\/([^/]+)$/.exec(path)) && method === 'POST') {
      const input = json()
      const values = (input.values ?? {}) as J
      const list = m[2] === 'countryId' ? COUNTRIES : m[2] === 'stateId' ? STATES[String(values.countryId)] ?? [] : m[2] === 'cityId' ? CITIES[String(values.stateId)] ?? [] : m[2] === 'personId' ? PEOPLE : m[2] === 'speciesId' ? SPECIES : []
      const ids = (input.ids as string[] | undefined)?.map(String)
      const labels = (input.labels as string[] | undefined)?.map((l) => l.toLowerCase())
      const term = String(input.searchTerm ?? '').toLowerCase()
      const options = list.filter((o) => (ids ? ids.includes(String(o.id)) : labels ? labels.includes(o.label.toLowerCase()) : o.label.toLowerCase().includes(term)))
      return send(res, 200, { options })
    }
    if ((m = /^\/table\/([^/]+)$/.exec(path)) && method === 'POST') {
      const values = json()
      return send(res, 200, { record: { values: { ...values, id: 101 }, displayValues: {}, recordLabel: String(values.name ?? 'new') } })
    }
    if ((m = /^\/table\/([^/]+)\/([^/]+)$/.exec(path))) {
      const [, table, pk] = m
      if (method === 'GET') {
        if (table === 'person' && pk === '1') return send(res, 200, fixture('get-person-1'))
        if (table === 'placeAddress' && pk === '1') return send(res, 200, fixture('get-placeAddress-1'))
        if (table === 'pet' && pets[pk!]) return send(res, 200, { record: pets[pk!] })
        return send(res, 404, { code: 'NOT_FOUND', message: 'Record not found.' })
      }
      if (method === 'PATCH') return send(res, 200, { record: { values: { id: Number(pk), ...json() }, recordLabel: `${table} ${pk}` } })
      if (method === 'DELETE') return send(res, 200, {})
    }
    if ((m = /^\/widget\/([^/]+)$/.exec(path)) && method === 'POST') {
      if (m[1] === 'SampleLineChartWidget') return send(res, 200, fixture('widget-line'))
      return send(res, 404, { code: 'NOT_FOUND', message: `Widget ${m[1]} was not found.` })
    }
    if ((m = /^\/processes\/([^/]+)\/init$/.exec(path)) && method === 'POST') {
      return send(res, 200, { values: { sleepMillis: 100 }, processUUID: 'p-1', nextStep: 'screen0', type: 'COMPLETE' })
    }
    if ((m = /^\/processes\/([^/]+)\/([^/]+)\/step\/([^/]+)$/.exec(path)) && method === 'POST') {
      const millis = /name="values"\r\n\r\n(\{[^\r]*\})/.exec(body)?.[1]
      const sleep = millis ? Number((JSON.parse(millis) as J).sleepMillis ?? 0) : 0
      const timeout = /name="stepTimeoutMillis"\r\n\r\n(\d+)/.exec(body)?.[1]
      const done = { values: { outputMessage: `Slept for ${sleep} milliseconds.`, sleepMillis: sleep }, processUUID: m[2], nextStep: 'screen1', type: 'COMPLETE' }
      if (timeout === '0') {
        jobs['j-1'] = 0
        return send(res, 200, { jobUUID: 'j-1', processUUID: m[2], type: 'JOB_STARTED' })
      }
      return send(res, 200, done)
    }
    if ((m = /^\/processes\/([^/]+)\/([^/]+)\/status\/([^/]+)$/.exec(path))) {
      const polls = (jobs[m[3]!] = (jobs[m[3]!] ?? 0) + 1)
      if (polls === 1) return send(res, 200, { processUUID: m[2], type: 'RUNNING', message: 'sleeping', current: 1, total: 2 })
      return send(res, 200, { values: { outputMessage: 'Slept for 100 milliseconds.', sleepMillis: 100 }, processUUID: m[2], nextStep: 'screen1', type: 'COMPLETE' })
    }
    if (path === '/esb/overview') return send(res, 200, { providers: [{ name: 'local' }], destinations: [{ name: 'personEvents', type: 'TOPIC', provider: 'local', publishers: [{}], triggers: [], counters: { published: 3, consumed: 3, failed: 0, deadLettered: 0, lastActivity: '2026-10-31T19:30:00Z' } }] })
    return send(res, 404, { code: 'NOT_FOUND', message: `no route ${method} ${path} in the fake server` })
  }

  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => handle(req, Buffer.concat(chunks).toString('utf8'), res))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

export interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

/** A throwaway home for config, cache and the file keyring. */
export function sandbox(): { env: Record<string, string>; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-cli-test-'))
  return {
    env: { QQQ_CONFIG_DIR: join(dir, 'config'), QQQ_CACHE_DIR: join(dir, 'cache'), QQQ_CLI_HOME: join(dir, 'legacy'), QQQ_KEYRING: 'file', HOME: dir },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  }
}

/** Runs the built CLI with arguments; stdin is closed (no terminal), TZ is UTC. */
export function runCli(args: string[], env: Record<string, string> = {}, input?: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const base: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('QQQ_')) base[k] = v
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...base, TZ: 'UTC', NO_COLOR: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input ?? '')
  })
}
