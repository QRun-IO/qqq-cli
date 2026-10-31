/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Extensions (qbits and modules that add UI API operations): which ones the client knows, which
 * operations belong to each, and which ones a server has installed. The server's truth is
 * GET /version `extensions`; the client's knowledge is the merged document it was generated from
 * (DOCUMENT_EXTENSIONS and OperationInfo.extension) plus the facts below that the documents do not
 * carry (documented minimum versions and the realtime channels an extension publishes on).
 *
 * Rules: an extension the server lists but the client does not know is kept and shown, never
 * dropped; an operation of an extension the server does not list is refused before any request,
 * with a message naming what is installed.
 */

import { DOCUMENT_EXTENSIONS, OPERATIONS, operation, type OperationInfo } from '../api/operations.js'
import { getServerVersion, type MetaDataCacheOptions, type ServerVersion } from '../metadata/cache.js'

/** What the client knows about one extension. */
export interface KnownExtension {
  name: string
  /** Short human name, for headings. */
  label: string
  /** The repository that publishes it. */
  repository: string
  /** Path prefix under /qqq/v1 (`/qbit/{name}`, or an established one such as `/esb`). */
  pathPrefix: string
  /** The extension version the client document was generated from. */
  documentVersion?: string
  /** The lowest server version of this extension the client works with, when its docs state one. */
  minVersion?: string
  /** The UI API version the extension's docs say it needs, when they say. */
  minUiApi?: string
  /** Realtime channels (GET /realtime/stream subscriptions) the extension publishes events on. */
  channels: string[]
  /** One line on what it does. */
  description: string
}

/** One extension as the server lists it, joined with what the client knows. */
export interface InstalledExtension {
  name: string
  version?: string
  pathPrefix?: string
  description?: string
  /** False when the client has no document for it (it is still listed). */
  known: boolean
  /** False when the client knows a minimum version and the server's is lower. */
  meetsMinimum: boolean
}

interface Facts {
  label: string
  repository: string
  minVersion?: string
  minUiApi?: string
  channels?: string[]
}

/**
 * Facts from each extension's own docs (README, UI-API-CHANGELOG.md) that the OpenAPI documents
 * do not carry. Minimums are only set where the docs state one.
 */
const FACTS: Record<string, Facts> = {
  // UI-API-CHANGELOG.md: esb and health 1.1.0 added operationIds, tags and the standard errors.
  esb: { label: 'ESB', repository: 'qqq (qqq-esb)', minVersion: '1.1.0' },
  health: { label: 'Health', repository: 'qqq (qqq-middleware-javalin)', minVersion: '1.1.0' },
  alerts: { label: 'Alerts', repository: 'qbit-alerts' },
  assistant: { label: 'Assistant', repository: 'qbit-assistant' },
  // qbit-collaboration README: 1.1.0 carries the UI API 1.6.0 error contract and the published
  // presence schemas; it publishes on record:{table}:{pk}, table:{table} and user:{userId}.
  collaboration: { label: 'Collaboration', repository: 'qbit-collaboration', minVersion: '1.1.0', minUiApi: '1.6.0', channels: ['record:{table}:{pk}', 'table:{table}', 'user:me'] },
  'data-analysis': { label: 'Data analysis', repository: 'qbit-data-analysis' },
  'db-performance': { label: 'DB performance', repository: 'qbit-db-performance' },
  edi: { label: 'EDI', repository: 'qbit-edi', minUiApi: '1.6.0' },
  'qa-capture': { label: 'QA capture', repository: 'qbit-qa-capture' },
  'quick-search': { label: 'Quick search', repository: 'qbit-quick-search' },
  'release-notes': { label: 'Release notes', repository: 'qbit-release-notes' },
  'secured-data': { label: 'Secured data', repository: 'qbit-secured-data', minUiApi: '1.6.0' },
  'sql-workbench': { label: 'SQL workbench', repository: 'qbit-sql-workbench' },
}

/** Every extension the client has a document for, in document order. */
export const KNOWN_EXTENSIONS: readonly KnownExtension[] = DOCUMENT_EXTENSIONS.map((e) => {
  const facts: Facts = FACTS[e.name] ?? { label: e.name, repository: `qbit-${e.name}` }
  return {
    name: e.name,
    label: facts.label,
    repository: facts.repository,
    pathPrefix: e.pathPrefix ?? `/qbit/${e.name}`,
    documentVersion: e.version,
    minVersion: facts.minVersion,
    minUiApi: facts.minUiApi,
    channels: facts.channels ?? [],
    description: e.description ?? '',
  }
})

const knownByName = new Map(KNOWN_EXTENSIONS.map((e) => [e.name, e]))

/** What the client knows about an extension, or undefined. */
export function knownExtension(name: string): KnownExtension | undefined {
  return knownByName.get(name)
}

/** The operations an extension serves, by id. */
export function operationsOf(name: string): OperationInfo[] {
  return OPERATIONS.filter((o) => o.extension === name)
}

/** The extension an operation belongs to; undefined for core operations and unknown ids. */
export function extensionOfOperation(id: string): string | undefined {
  return operation(id)?.extension
}

/** Compares two MAJOR.MINOR.PATCH versions (pre-release suffixes ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0)
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0)
  return 0
}

/** Thrown when an operation or command needs an extension the server does not have (CLI exit 5). */
export class ExtensionNotInstalledError extends Error {
  readonly extension: string
  readonly installed: InstalledExtension[]
  /** `absent`, or `too-old` when the server has it below the client's minimum. */
  readonly reason: 'absent' | 'too-old'

  constructor(extension: string, installed: InstalledExtension[], reason: 'absent' | 'too-old' = 'absent', operationId?: string) {
    const list = installed.length ? installed.map((e) => `${e.name}${e.version ? ` ${e.version}` : ''}`).join(', ') : 'none'
    const subject = operationId ? `${operationId} belongs to extension ${extension}, which` : `extension ${extension}`
    const found = installed.find((e) => e.name === extension)
    const text = reason === 'too-old'
      ? `${operationId ? `${operationId} needs ` : ''}extension ${extension} ${knownExtension(extension)?.minVersion} or later; this server has ${found?.version ?? 'an unknown version'} (installed: ${list})`
      : `${subject} is not installed on this server (installed: ${list})`
    super(text)
    this.name = 'ExtensionNotInstalledError'
    this.extension = extension
    this.installed = installed
    this.reason = reason
  }
}

/** Joins the server's GET /version `extensions` with the client's knowledge. Unknown ones are kept. */
export function joinInstalled(version: ServerVersion): InstalledExtension[] {
  return (version.extensions ?? []).filter((e) => e && typeof e.name === 'string').map((e) => {
    const known = knownByName.get(e.name)
    const meetsMinimum = !known?.minVersion || !e.version || compareVersions(e.version, known.minVersion) >= 0
    return { name: e.name, version: e.version, pathPrefix: e.pathPrefix, description: e.description, known: Boolean(known), meetsMinimum }
  })
}

/** The extensions a server has installed, from its GET /version (cached with the metadata cache). */
export async function installedExtensions(server: string, fetchImpl: typeof fetch, options: MetaDataCacheOptions & { offline?: boolean; refresh?: boolean } = {}): Promise<InstalledExtension[]> {
  return joinInstalled(await getServerVersion(server, fetchImpl, options))
}

/** One server's extensions: what is installed, and the checks commands make before calling. */
export class ExtensionRegistry {
  readonly installed: InstalledExtension[]
  private readonly byName: Map<string, InstalledExtension>

  constructor(installed: InstalledExtension[]) {
    this.installed = installed
    this.byName = new Map(installed.map((e) => [e.name, e]))
  }

  /** A registry from a GET /version document. */
  static fromVersion(version: ServerVersion): ExtensionRegistry {
    return new ExtensionRegistry(joinInstalled(version))
  }

  /** Whether the server has the extension at a version the client works with. */
  has(name: string): boolean {
    const e = this.byName.get(name)
    return Boolean(e && e.meetsMinimum)
  }

  /** The installed version of an extension, or undefined. */
  version(name: string): string | undefined {
    return this.byName.get(name)?.version
  }

  /** The installed extension, or a typed error naming what is installed. */
  require(name: string): InstalledExtension {
    const e = this.byName.get(name)
    if (!e) throw new ExtensionNotInstalledError(name, this.installed, 'absent')
    if (!e.meetsMinimum) throw new ExtensionNotInstalledError(name, this.installed, 'too-old')
    return e
  }

  /** Throws when the operation belongs to an extension this server does not have; core operations pass. */
  requireOperation(id: string): void {
    const name = extensionOfOperation(id)
    if (!name) return
    const e = this.byName.get(name)
    if (!e) throw new ExtensionNotInstalledError(name, this.installed, 'absent', id)
    if (!e.meetsMinimum) throw new ExtensionNotInstalledError(name, this.installed, 'too-old', id)
  }

  /** Installed extensions the client has no document for (tolerated and listed). */
  unknown(): InstalledExtension[] {
    return this.installed.filter((e) => !e.known)
  }

  /** `esb 1.1.0, foo 2.0.0 (unknown to this client)`, or `none`. */
  describe(): string {
    if (!this.installed.length) return 'none'
    return this.installed.map((e) => `${e.name}${e.version ? ` ${e.version}` : ''}${e.known ? '' : ' (unknown to this client)'}${e.meetsMinimum ? '' : ` (below ${knownExtension(e.name)?.minVersion})`}`).join(', ')
  }
}

/** The registry of a server, from its cached GET /version. */
export async function extensionRegistry(server: string, fetchImpl: typeof fetch, options: MetaDataCacheOptions & { offline?: boolean; refresh?: boolean } = {}): Promise<ExtensionRegistry> {
  return new ExtensionRegistry(await installedExtensions(server, fetchImpl, options))
}
