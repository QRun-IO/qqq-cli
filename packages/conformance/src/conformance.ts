/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A black-box conformance suite for QQQ UI API servers (and, run against the Prism mock, for the
 * document itself). Any client author can run it against a server to see that the server keeps the
 * contract their client relies on: versioning, the published document, authentication (401s),
 * the one error schema, and that real responses validate against the document's schemas.
 *
 * It only reads (GET, and POST queries/counts); it never writes.
 */

import { Ajv, type ValidateFunction } from 'ajv'

/** One check's outcome. */
export interface CheckResult {
  name: string
  ok: boolean
  skipped?: boolean
  detail?: string
}

/** Options of {@link runConformance}. */
export interface ConformanceOptions {
  baseUrl: string
  /** A bearer token (access token or session UUID); without one only the public checks run. */
  token?: string
  /** A table to read (default: the first readable table in the metadata). */
  table?: string
  fetch?: typeof fetch
  log?: (result: CheckResult) => void
}

type Json = Record<string, any>

/**
 * Runs the suite. Resolves with every result; `ok` is false for failures only.
 *
 * @param options - Server and token.
 */
export async function runConformance(options: ConformanceOptions): Promise<CheckResult[]> {
  const fetchImpl = options.fetch ?? fetch
  const results: CheckResult[] = []
  const base = options.baseUrl.replace(/\/$/, '')
  const record = (result: CheckResult) => {
    results.push(result)
    options.log?.(result)
  }
  const check = async (name: string, body: () => Promise<string | void>) => {
    try {
      const detail = await body()
      record({ name, ok: true, detail: detail || undefined })
    } catch (error) {
      if (error instanceof Skip) record({ name, ok: true, skipped: true, detail: error.message })
      else record({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }
  const call = async (method: string, path: string, init: { token?: string | null; body?: unknown; headers?: Record<string, string> } = {}) => {
    const headers: Record<string, string> = { Accept: 'application/json', 'X-QQQ-Client': 'cli/qqq-ui-api-conformance', ...(init.headers ?? {}) }
    const token = init.token === undefined ? options.token : init.token
    if (token) headers.Authorization = `Bearer ${token}`
    if (init.body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetchImpl(`${base}${path}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
    const text = await response.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : undefined
    } catch {
      json = undefined
    }
    return { status: response.status, headers: response.headers, json: json as Json, text }
  }

  /////////////////////////////////////////
  // the document, version and validator //
  /////////////////////////////////////////
  let document: Json | undefined
  let version: Json | undefined
  let validator: SchemaValidator | undefined

  await check('GET /qqq/v1/version answers a 1.x semantic version', async () => {
    const r = await call('GET', '/qqq/v1/version', { token: null })
    expect(r.status === 200, `status ${r.status}`)
    version = r.json
    expect(/^1\.\d+\.\d+$/.test(String(version?.apiVersion)), `apiVersion ${version?.apiVersion}`)
    return `apiVersion ${version?.apiVersion}, ${(version?.extensions ?? []).length} extensions`
  })

  await check('GET /qqq/v1/openapi.json is the served, merged document', async () => {
    const r = await call('GET', '/qqq/v1/openapi.json', { token: null })
    expect(r.status === 200 && r.json?.paths, `status ${r.status}`)
    document = r.json
    expect(document!.info?.version === version?.apiVersion, `info.version ${document!.info?.version} != apiVersion ${version?.apiVersion}`)
    validator = new SchemaValidator(document!)
    return `${Object.keys(document!.paths).length} paths`
  })

  await check('every operation has a unique operationId (UI API >= 1.6.0)', async () => {
    requireDocument(document)
    if (!atLeast(version?.apiVersion, 1, 6)) throw new Skip(`server is UI API ${version?.apiVersion}`)
    const seen = new Set<string>()
    for (const [path, ops] of Object.entries<Json>(document!.paths)) {
      for (const [method, op] of Object.entries<Json>(ops)) {
        expect(op.operationId, `${method.toUpperCase()} ${path} has no operationId`)
        expect(!seen.has(op.operationId), `duplicate operationId ${op.operationId}`)
        seen.add(op.operationId)
      }
    }
    return `${seen.size} operations`
  })

  await check('every $ref resolves', async () => {
    requireDocument(document)
    const dangling = new Set<string>()
    JSON.stringify(document, (key, value) => {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/') && !document!.components?.schemas?.[value.slice(21)]) dangling.add(value)
      return value
    })
    expect(dangling.size === 0, `dangling: ${[...dangling].join(', ')}`)
  })

  await check('every extension in /version has operations in the document', async () => {
    requireDocument(document)
    const paths = Object.keys(document!.paths)
    const missing = (version?.extensions ?? []).filter((e: Json) => !paths.some((p) => p.startsWith(`/qqq/v1${e.pathPrefix}`)))
    expect(missing.length === 0, `no operations for ${missing.map((e: Json) => e.name).join(', ')}`)
  })

  let authentication: Json | undefined
  await check('GET /qqq/v1/metaData/authentication validates', async () => {
    const r = await call('GET', '/qqq/v1/metaData/authentication', { token: null })
    expect(r.status === 200, `status ${r.status}`)
    authentication = r.json
    validator?.response('get', '/qqq/v1/metaData/authentication', 200, r.json)
    return `type ${authentication?.type}${authentication?.values?.nativeClientId ? `, native client ${authentication.values.nativeClientId}` : ''}`
  })

  const anonymous = authentication?.type === 'FULLY_ANONYMOUS' || authentication?.type === 'MOCK'

  await check('a request without credentials answers 401 with the error schema', async () => {
    if (anonymous) throw new Skip(`authentication type ${authentication?.type}`)
    const r = await call('GET', '/qqq/v1/metaData', { token: null })
    expect(r.status === 401, `status ${r.status}`)
    expectError(r, 'UNAUTHENTICATED', validator, 'get', '/qqq/v1/metaData', 401)
  })

  await check('a forged bearer token answers 401', async () => {
    if (anonymous) throw new Skip(`authentication type ${authentication?.type}`)
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'admin', exp: 4102444800 })}.`
    const r = await call('GET', '/qqq/v1/metaData', { token: forged })
    expect(r.status === 401, `alg none: status ${r.status}`)
    const garbage = await call('GET', '/qqq/v1/metaData', { token: 'not-a-token' })
    expect(garbage.status === 401, `garbage: status ${garbage.status}`)
  })

  if (!options.token && !anonymous) {
    record({ name: 'authenticated checks', ok: true, skipped: true, detail: 'no token given (--token or QQQ_TOKEN)' })
    return results
  }

  let metaData: Json | undefined
  await check('GET /qqq/v1/metaData validates', async () => {
    const r = await call('GET', '/qqq/v1/metaData')
    expect(r.status === 200, `status ${r.status} ${r.text.slice(0, 200)}`)
    metaData = r.json
    validator?.response('get', '/qqq/v1/metaData', 200, r.json)
    return `${Object.keys(metaData?.apps ?? {}).length} apps, ${Object.keys(metaData?.tables ?? {}).length} tables`
  })

  const tableName = options.table ?? Object.values<Json>(metaData?.tables ?? {}).find((t) => t.readPermission !== false && !t.isHidden)?.name
  let tableMeta: Json | undefined
  await check('GET /qqq/v1/metaData/table/{tableName} validates (with clientCapabilities and field validation since 1.6.0)', async () => {
    if (!tableName) throw new Skip('no readable table')
    const r = await call('GET', `/qqq/v1/metaData/table/${encodeURIComponent(tableName)}`)
    expect(r.status === 200, `status ${r.status}`)
    tableMeta = r.json
    validator?.response('get', '/qqq/v1/metaData/table/{tableName}', 200, r.json)
    if (atLeast(version?.apiVersion, 1, 6)) expect(tableMeta?.clientCapabilities, 'no clientCapabilities')
    return tableName
  })

  let firstRecord: Json | undefined
  await check('POST /qqq/v1/table/{tableName}/query validates', async () => {
    if (!tableName) throw new Skip('no readable table')
    const r = await call('POST', `/qqq/v1/table/${encodeURIComponent(tableName)}/query`, { body: { filter: { limit: 3 } } })
    expect(r.status === 200, `status ${r.status}`)
    validator?.response('post', '/qqq/v1/table/{tableName}/query', 200, r.json)
    firstRecord = r.json?.records?.[0]
    return `${r.json?.records?.length ?? 0} records`
  })

  await check('POST /qqq/v1/table/{tableName}/count validates', async () => {
    if (!tableName) throw new Skip('no readable table')
    const r = await call('POST', `/qqq/v1/table/${encodeURIComponent(tableName)}/count`, { body: { filter: {} } })
    expect(r.status === 200, `status ${r.status}`)
    validator?.response('post', '/qqq/v1/table/{tableName}/count', 200, r.json)
    return `count ${r.json?.count}`
  })

  await check('GET /qqq/v1/table/{tableName}/{primaryKey} validates', async () => {
    const pk = firstRecord?.values?.[tableMeta?.primaryKeyField ?? 'id']
    if (pk === undefined || pk === null) throw new Skip('no record to read')
    const r = await call('GET', `/qqq/v1/table/${encodeURIComponent(tableName!)}/${encodeURIComponent(String(pk))}`)
    expect(r.status === 200, `status ${r.status}`)
    validator?.response('get', '/qqq/v1/table/{tableName}/{primaryKey}', 200, r.json)
  })

  await check('an unknown table answers 404 with the error schema', async () => {
    const r = await call('GET', '/qqq/v1/metaData/table/no_such_table_conformance')
    expect(r.status === 404, `status ${r.status}`)
    expectError(r, 'NOT_FOUND', validator, 'get', '/qqq/v1/metaData/table/{tableName}', 404)
  })

  await check('X-Request-Id is echoed as the error traceId (UI API >= 1.6.0)', async () => {
    if (!atLeast(version?.apiVersion, 1, 6)) throw new Skip(`server is UI API ${version?.apiVersion}`)
    const r = await call('GET', '/qqq/v1/metaData/table/no_such_table_conformance', { headers: { 'X-Request-Id': 'conformance-trace-1' } })
    expect(r.json?.traceId === 'conformance-trace-1', `traceId ${r.json?.traceId}`)
    expect(r.headers.get('X-QQQ-Trace-Id') === 'conformance-trace-1', `header ${r.headers.get('X-QQQ-Trace-Id')}`)
  })

  await check('GET /qqq/v1/jobs validates', async () => {
    if (!document?.paths?.['/qqq/v1/jobs']) throw new Skip('no jobs operation')
    const r = await call('GET', '/qqq/v1/jobs?scope=mine')
    if (r.status === 403) throw new Skip('no jobs permission')
    if (r.status === 404) throw new Skip('jobs are not enabled on this server (no durable jobs tables)')
    expect(r.status === 200, `status ${r.status}`)
    validator?.response('get', '/qqq/v1/jobs', 200, r.json)
    return `${r.json?.jobs?.length ?? 0} jobs`
  })

  await check('GET /qqq/v1/realtime/stream opens with a hello event', async () => {
    if (!document?.paths?.['/qqq/v1/realtime/stream']) throw new Skip('no realtime operation')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const headers: Record<string, string> = { Accept: 'text/event-stream' }
      if (options.token) headers.Authorization = `Bearer ${options.token}`
      const response = await fetchImpl(`${base}/qqq/v1/realtime/stream`, { headers, signal: controller.signal })
      if (response.status === 404 || response.status === 503) throw new Skip(`realtime disabled (${response.status})`)
      expect(response.ok && response.body, `status ${response.status}`)
      const reader = (response.body as ReadableStream<Uint8Array>).getReader()
      let text = ''
      while (!/event: ?hello/.test(text)) {
        const { value, done } = await reader.read()
        if (done) break
        text += new TextDecoder().decode(value)
      }
      expect(/event: ?hello/.test(text), 'no hello event')
      await reader.cancel()
    } finally {
      clearTimeout(timer)
      controller.abort()
    }
  })

  return results
}

/** A check that does not apply to this server. */
class Skip extends Error {}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function requireDocument(document: Json | undefined): asserts document is Json {
  if (!document) throw new Skip('no document')
}

function atLeast(version: unknown, major: number, minor: number): boolean {
  const match = /^(\d+)\.(\d+)/.exec(String(version ?? ''))
  return Boolean(match) && (Number(match![1]) > major || (Number(match![1]) === major && Number(match![2]) >= minor))
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function expectError(r: { json: Json; headers: Headers }, code: string, validator: SchemaValidator | undefined, method: string, path: string, status: number): void {
  expect(r.json && typeof r.json.error === 'string', 'error body has no "error" string')
  if (r.json.code !== undefined) {
    expect(r.json.code === code, `code ${r.json.code}, expected ${code}`)
    expect(typeof r.json.traceId === 'string' && r.json.traceId, 'no traceId')
  }
  validator?.response(method, path, status, r.json)
}

/**
 * Validates response bodies against the document's schemas (OpenAPI 3.0 -> JSON Schema: nullable
 * becomes a null type; discriminators and formats are informational).
 */
export class SchemaValidator {
  private readonly ajv = new Ajv({ strict: false, allErrors: false, validateFormats: false })
  private readonly cache = new Map<string, ValidateFunction>()

  constructor(private readonly document: Json) {
    this.ajv.addSchema({ $id: 'oas', components: { schemas: convert(document.components?.schemas ?? {}) } })
  }

  /** Throws when a response body does not match the operation's declared schema. */
  response(method: string, path: string, status: number, body: unknown): void {
    const operation = this.document.paths?.[path]?.[method]
    const schema = operation?.responses?.[String(status)]?.content?.['application/json']?.schema
    if (!schema) return
    const key = `${method} ${path} ${status}`
    const validate = this.cache.get(key) ?? this.ajv.compile(convert(schema) as object)
    this.cache.set(key, validate)
    if (!validate(body)) {
      const error = validate.errors?.[0]
      throw new Error(`${key}: ${error?.instancePath || '(body)'} ${error?.message} ${error?.params ? JSON.stringify(error.params) : ''}`.trim())
    }
  }
}

function convert(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(convert)
  if (!node || typeof node !== 'object') return node
  const out: Json = {}
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/')) out.$ref = `oas${value}`
    else if (key === 'nullable' || key === 'discriminator' || key === 'example' || key === 'examples' || key === 'deprecated' || key === 'xml') continue
    else out[key] = convert(value)
  }
  if ((node as Json).nullable === true) {
    if (typeof out.type === 'string') out.type = [out.type, 'null']
    else if (out.$ref || out.allOf || out.oneOf || out.anyOf) return { anyOf: [out, { type: 'null' }] }
  }
  return out
}
