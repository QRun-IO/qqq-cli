/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A small stub server for CLI tests of features the sample app cannot exercise (variants, reports,
 * TABLE_BASED sign-in, denied tables): routes by `METHOD /path` regular expressions (path without
 * `/qqq/v1`), records every request with its multipart `values` or JSON body.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type J = Record<string, unknown>

export interface StubRequest { method: string; path: string; query: URLSearchParams; headers: IncomingMessage['headers']; body: string; values: J; json: unknown }

/** A route answers with a JSON body, or `{ status, body, headers }` for anything else. */
export type StubHandler = (request: StubRequest) => unknown

export interface Stub { url: string; requests: StubRequest[]; close(): Promise<void> }

export class StubResponse {
  constructor(readonly status: number, readonly body: unknown, readonly headers: Record<string, string> = {}) {}
}

export async function startStub(routes: Array<[RegExp, StubHandler]>): Promise<Stub> {
  const requests: StubRequest[] = []
  const handle = async (req: IncomingMessage, body: string, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://stub')
    const path = url.pathname.replace(/^\/qqq\/v1/, '')
    const m = /name="values"\r\n\r\n([\s\S]*?)\r\n--/.exec(body)
    let json: unknown
    try { json = body && !m ? JSON.parse(body) : undefined } catch { json = undefined }
    const request: StubRequest = { method: req.method ?? 'GET', path, query: url.searchParams, headers: req.headers, body, values: m ? JSON.parse(m[1]!) as J : {}, json }
    requests.push(request)
    const route = routes.find(([re]) => re.test(`${request.method} ${path}`))
    let answer: unknown = route ? await route[1](request) : new StubResponse(404, { code: 'NOT_FOUND', message: `no route ${request.method} ${path}` })
    if (!(answer instanceof StubResponse)) answer = new StubResponse(200, answer)
    const r = answer as StubResponse
    const isBytes = r.body instanceof Uint8Array || typeof r.body === 'string'
    res.writeHead(r.status, { 'content-type': isBytes ? 'application/octet-stream' : 'application/json', ...r.headers })
    res.end(isBytes ? r.body as Uint8Array | string : JSON.stringify(r.body))
  }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => void handle(req, Buffer.concat(chunks).toString('utf8'), res))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

/** The routes every stub needs: version and an empty authentication. */
export const BASE_ROUTES: Array<[RegExp, StubHandler]> = [
  [/^GET \/version$/, () => ({ apiVersion: '1.8.0', supportedMajorVersions: [1], features: [], extensions: [] })],
]
