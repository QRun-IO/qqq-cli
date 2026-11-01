#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Merge the QQQ UI API core document with extension documents into one OpenAPI document.
 *
 * Usage: node scripts/merge-spec.mjs --out <file.json> <core.yaml|url> [extension.yaml|url ...]
 *
 * Inputs are the committed documents (qqq: qqq-middleware-javalin/src/main/resources/openapi/v1/
 * openapi.yaml; each qbit: src/main/resources/openapi/qqq-v1/{name}.yaml), local paths or URLs.
 * A server's own GET /qqq/v1/openapi.json is already merged and can be used directly instead.
 *
 * Rules: paths and operations are unioned (a duplicate method on one path is an error); component
 * schemas are unioned (a name defined twice must be identical, e.g. BasicErrorResponseV1); the
 * core document's info, servers and securitySchemes are kept; tags are unioned; every extension's
 * name, version, path prefix and operationIds are recorded in info.x-qqq-extensions.
 *
 * An extension whose operations the core input already carries (a server's merged document, e.g.
 * the sample server's esb) is accepted when each such operation is identical; it is then recorded
 * in info.x-qqq-extensions like any other.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { parse } from 'yaml'

const args = process.argv.slice(2)
const outIndex = args.indexOf('--out')
if (outIndex < 0 || args.length < outIndex + 2) {
  console.error('usage: merge-spec.mjs --out <file.json> <core> [extensions...]')
  process.exit(2)
}
const out = args[outIndex + 1]
const deriveMissing = args.includes('--derive-missing-ids')
const inputs = args.filter((a, i) => i !== outIndex && i !== outIndex + 1 && a !== '--derive-missing-ids')

/**
 * The operationId QQQ derives for an operation without one (UiApiOperationIds.derive): the method,
 * then each path segment in camel case, `{param}` as `By{Param}`, relative to /qqq/v1. Only for
 * documents from servers before UI API 1.6.0 (--derive-missing-ids).
 */
function deriveOperationId(method, path) {
  let id = method.toLowerCase()
  for (let segment of path.replace(/^\/qqq\/v1/, '').split('/')) {
    if (!segment) continue
    if (segment.startsWith('{') && segment.endsWith('}')) {
      id += 'By'
      segment = segment.slice(1, -1)
    }
    for (const word of segment.split(/[^A-Za-z0-9]+/)) if (word) id += word[0].toUpperCase() + word.slice(1)
  }
  return id
}

/** The path prefix an extension's operations share, relative to /qqq/v1 (`/qbit/{name}` or an established one such as `/esb`). */
function pathPrefixOf(name, paths) {
  const qbit = `/qqq/v1/qbit/${name}`
  if (paths.length && paths.every((p) => p === qbit || p.startsWith(qbit + '/'))) return `/qbit/${name}`
  const first = new Set(paths.map((p) => p.replace(/^\/qqq\/v1/, '').split('/')[1]))
  return first.size === 1 ? `/${[...first][0]}` : undefined
}

async function load(source) {
  const text = /^https?:\/\//.test(source) ? await (await fetch(source)).text() : await readFile(source, 'utf8')
  return source.endsWith('.json') ? JSON.parse(text) : parse(text)
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]))
  return value
}

const [coreSource, ...extensionSources] = inputs
const merged = await load(coreSource)
merged.paths ??= {}
merged.components ??= {}
merged.components.schemas ??= {}
merged.tags ??= []
const extensions = []

for (const source of extensionSources) {
  const doc = await load(source)
  const name = (doc.info?.title ?? '').replace(/^QQQ Middleware API extension: /, '') || source
  const operationIdsOfExtension = []
  const paths = Object.keys(doc.paths ?? {})
  extensions.push({ name, version: doc.info?.version, description: doc.info?.description, pathPrefix: pathPrefixOf(name, paths), operations: operationIdsOfExtension })

  for (const [path, operations] of Object.entries(doc.paths ?? {})) {
    const target = (merged.paths[path] ??= {})
    for (const [method, operation] of Object.entries(operations)) {
      if (!['get', 'put', 'post', 'patch', 'delete', 'head', 'options'].includes(method)) {
        target[method] ??= operation // path-level parameters, summary
        continue
      }
      if (operation.operationId) operationIdsOfExtension.push(operation.operationId)
      if (target[method]) {
        if (JSON.stringify(stable(target[method])) === JSON.stringify(stable(operation))) continue
        throw new Error(`duplicate operation ${method.toUpperCase()} ${path} (from ${name})`)
      }
      target[method] = operation
    }
  }

  for (const [schemaName, schema] of Object.entries(doc.components?.schemas ?? {})) {
    const existing = merged.components.schemas[schemaName]
    if (existing && JSON.stringify(stable(existing)) !== JSON.stringify(stable(schema))) {
      throw new Error(`schema ${schemaName} differs between the core document and ${name}`)
    }
    merged.components.schemas[schemaName] = schema
  }

  for (const tag of doc.tags ?? []) {
    if (!merged.tags.some((t) => t.name === tag.name)) merged.tags.push(tag)
  }
}

const operationIds = new Map()
for (const [path, operations] of Object.entries(merged.paths)) {
  for (const [method, operation] of Object.entries(operations)) {
    if (!operation.operationId && deriveMissing) operation.operationId = deriveOperationId(method, path)
    const id = operation.operationId
    if (!id) throw new Error(`no operationId: ${method.toUpperCase()} ${path}`)
    if (operationIds.has(id)) throw new Error(`duplicate operationId ${id}: ${operationIds.get(id)} and ${method.toUpperCase()} ${path}`)
    operationIds.set(id, `${method.toUpperCase()} ${path}`)
  }
}

merged.info['x-qqq-extensions'] = extensions
await writeFile(out, JSON.stringify(merged, null, 2) + '\n')
console.log(`merged ${1 + extensionSources.length} documents: ${Object.keys(merged.paths).length} paths, ${operationIds.size} operations -> ${out}`)
