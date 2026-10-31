/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A per-server cache of GET /metaData on disk, so that listing tables, completing names and
 * walking the app tree costs nothing after the first call. Keyed by server origin; invalidated
 * by the server's `metaDataGeneration` when it changes, else by age.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { callOperation } from '../api/call.js'

export interface CachedMetaData {
  fetchedAt: string
  apiVersion?: string
  metaDataGeneration?: number | string
  metaData: MetaDataDocument
}

export interface MetaDataDocument {
  metaDataGeneration?: number | string
  apps?: Record<string, { name: string; label: string; children?: unknown[] }>
  appTree?: unknown[]
  tables?: Record<string, { name: string; label: string; isHidden?: boolean; readPermission?: boolean }>
  processes?: Record<string, { name: string; label: string; isHidden?: boolean; tableName?: string }>
  widgets?: Record<string, { name: string; type?: string; label?: string }>
  reports?: Record<string, { name: string; label: string }>
  branding?: { appName?: string }
  [key: string]: unknown
}

export interface MetaDataCacheOptions {
  /** Directory for cache files (default: $XDG_CACHE_HOME/qqq or ~/.cache/qqq; QQQ_CACHE_DIR overrides). */
  dir?: string
  /** Seconds a cached document stays fresh without a generation check (default 300). */
  ttlSeconds?: number
}

function defaultDir(): string {
  return process.env.QQQ_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'qqq')
}

function fileFor(dir: string, server: string): string {
  return join(dir, `metadata-${server.replace(/[^A-Za-z0-9.-]+/g, '_')}.json`)
}

/** Reads the cached document of a server, fresh or not; undefined when none. */
export function readCachedMetaData(server: string, options: MetaDataCacheOptions = {}): CachedMetaData | undefined {
  const file = fileFor(options.dir ?? defaultDir(), server)
  if (!existsSync(file)) return undefined
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CachedMetaData
  } catch {
    return undefined
  }
}

/** Writes a document to the cache. */
export function writeCachedMetaData(server: string, metaData: MetaDataDocument, apiVersion: string | undefined, options: MetaDataCacheOptions = {}): void {
  const dir = options.dir ?? defaultDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const entry: CachedMetaData = { fetchedAt: new Date().toISOString(), apiVersion, metaDataGeneration: metaData.metaDataGeneration, metaData }
  writeFileSync(fileFor(dir, server), JSON.stringify(entry), { mode: 0o600 })
}

/** Removes the cache of one server, or of every server. */
export function clearMetaDataCache(server?: string, options: MetaDataCacheOptions = {}): void {
  const dir = options.dir ?? defaultDir()
  if (server) {
    rmSync(fileFor(dir, server), { force: true })
    rmSync(versionFileFor(dir, server), { force: true })
  }
  else rmSync(dir, { recursive: true, force: true })
}

/**
 * The server's metadata: from the cache when fresh (younger than the TTL), else fetched and cached.
 * With `offline`, a stale cache is used rather than the network (for completion, which must be quick).
 */
export async function getMetaData(server: string, fetchImpl: typeof fetch, options: MetaDataCacheOptions & { offline?: boolean; refresh?: boolean } = {}): Promise<MetaDataDocument> {
  const cached = options.refresh ? undefined : readCachedMetaData(server, options)
  const ttl = (options.ttlSeconds ?? 300) * 1000
  if (cached && (options.offline || Date.now() - Date.parse(cached.fetchedAt) < ttl)) return cached.metaData
  if (options.offline && !cached) throw new Error('No cached metadata for this server; run any qqq command once to fill the cache.')
  let version: string | undefined
  try {
    const v = (await callOperation(server, 'getVersion', {}, fetchImpl)).data as ServerVersion
    writeCachedVersion(server, v, options)
    version = v.apiVersion
  } catch (error) {
    if (cached) return cached.metaData
    throw error
  }
  const metaData = (await callOperation(server, 'getMetaData', {}, fetchImpl)).data as MetaDataDocument
  writeCachedMetaData(server, metaData, version, options)
  return metaData
}

function tableFileFor(dir: string, server: string, table: string): string {
  return join(dir, `table-${server.replace(/[^A-Za-z0-9.-]+/g, '_')}-${table.replace(/[^A-Za-z0-9_.-]+/g, '_')}.json`)
}

/** A cached table definition (fields and sections), for completion and offline use. */
export function readCachedTableMeta<T = unknown>(server: string, table: string, options: MetaDataCacheOptions = {}): T | undefined {
  const file = tableFileFor(options.dir ?? defaultDir(), server, table)
  if (!existsSync(file)) return undefined
  try {
    return (JSON.parse(readFileSync(file, 'utf8')) as { metaData: T }).metaData
  } catch {
    return undefined
  }
}

/** Caches a table definition after it was fetched. */
export function writeCachedTableMeta(server: string, table: string, metaData: unknown, options: MetaDataCacheOptions = {}): void {
  const dir = options.dir ?? defaultDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(tableFileFor(dir, server, table), JSON.stringify({ fetchedAt: new Date().toISOString(), metaData }), { mode: 0o600 })
}

/** A table definition, from the cache when fresh, else fetched and cached. */
export async function getTableMetaData<T = unknown>(server: string, table: string, fetchImpl: typeof fetch, options: MetaDataCacheOptions & { refresh?: boolean } = {}): Promise<T> {
  const file = tableFileFor(options.dir ?? defaultDir(), server, table)
  if (!options.refresh && existsSync(file)) {
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt: string; metaData: T }
      if (Date.now() - Date.parse(entry.fetchedAt) < (options.ttlSeconds ?? 300) * 1000) return entry.metaData
    } catch {
      // refetch
    }
  }
  const metaData = (await callOperation(server, 'getTableMetaData', { path: { tableName: table } }, fetchImpl)).data as T
  writeCachedTableMeta(server, table, metaData, options)
  return metaData
}

/** GET /version: the API semver, core features, registered extensions and accepted client channels. */
export interface ServerVersion {
  apiVersion?: string
  basePath?: string
  supportedMajorVersions?: number[]
  features?: string[]
  extensions?: { name: string; version?: string; pathPrefix?: string; description?: string }[]
  clientChannels?: string[]
  [key: string]: unknown
}

function versionFileFor(dir: string, server: string): string {
  return join(dir, `version-${server.replace(/[^A-Za-z0-9.-]+/g, '_')}.json`)
}

function writeCachedVersion(server: string, version: ServerVersion, options: MetaDataCacheOptions = {}): void {
  const dir = options.dir ?? defaultDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(versionFileFor(dir, server), JSON.stringify({ fetchedAt: new Date().toISOString(), version }), { mode: 0o600 })
}

/**
 * The server's GET /version, cached next to its metadata with the same TTL (it is unsecured and
 * small, but listings and completion should not wait for it). `offline` uses a stale copy.
 */
export async function getServerVersion(server: string, fetchImpl: typeof fetch, options: MetaDataCacheOptions & { offline?: boolean; refresh?: boolean } = {}): Promise<ServerVersion> {
  const file = versionFileFor(options.dir ?? defaultDir(), server)
  let cached: { fetchedAt: string; version: ServerVersion } | undefined
  if (!options.refresh && existsSync(file)) {
    try {
      cached = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt: string; version: ServerVersion }
    } catch {
      cached = undefined
    }
  }
  if (cached && (options.offline || Date.now() - Date.parse(cached.fetchedAt) < (options.ttlSeconds ?? 300) * 1000)) return cached.version
  if (options.offline && !cached) throw new Error('No cached version for this server; run any qqq command once to fill the cache.')
  try {
    const version = (await callOperation(server, 'getVersion', {}, fetchImpl)).data as ServerVersion
    writeCachedVersion(server, version, options)
    return version
  } catch (error) {
    if (cached) return cached.version
    throw error
  }
}
