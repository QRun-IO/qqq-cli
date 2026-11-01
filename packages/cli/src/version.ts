/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The CLI's version and the UI API versions it supports, printed by `qqq --version` and sent in
 * X-QQQ-Client. CLI_VERSION must equal packages/cli/package.json (scripts/lint.mjs checks it).
 * The single-file binaries (scripts/build-binaries.mjs) define QQQ_BUILD_SHA, QQQ_BUILD_TARGET and
 * QQQ_BUILD_UI (true when the terminal UI is bundled);
 * an npm install leaves them undefined.
 */

import { release } from 'node:os'
import { UI_API_VERSION } from '@qrun-io/qqq-ui-api-client'

declare const QQQ_BUILD_SHA: string | undefined
declare const QQQ_BUILD_TARGET: string | undefined
declare const QQQ_BUILD_UI: boolean | undefined

export const CLI_VERSION = '1.0.0-rc.1'

/** The oldest UI API a server may serve for this CLI (operationIds, clientCapabilities and traceId since 1.6.0). */
export const UI_API_MIN_VERSION = '1.6.0'

/** The supported range: from UI_API_MIN_VERSION up to, not including, the next major version. */
export const UI_API_RANGE = `>=${UI_API_MIN_VERSION} <2.0.0`

export const BUILD_SHA = typeof QQQ_BUILD_SHA === 'string' ? QQQ_BUILD_SHA : undefined
export const BUILD_TARGET = typeof QQQ_BUILD_TARGET === 'string' ? QQQ_BUILD_TARGET : undefined
/** True in a binary that carries the terminal UI. */
export const BUILD_UI = typeof QQQ_BUILD_UI === 'boolean' ? QQQ_BUILD_UI : false

/** The JavaScript runtime this process runs on: the Bun embedded in a binary, or Node. */
export function runtimeText(): string {
  return process.versions.bun ? `Bun ${process.versions.bun}` : `Node ${process.versions.node}`
}

/**
 * One line for support (qqq doctor, qqq ui --check): version, how qqq was installed (which binary,
 * with or without the UI, from which commit), the runtime and the platform.
 */
export function buildDescription(): string {
  const parts = [`qqq ${CLI_VERSION}`]
  parts.push(BUILD_TARGET ? `${BUILD_TARGET} binary ${BUILD_UI ? 'with ui' : 'without ui'}` : 'npm package or source checkout')
  if (BUILD_SHA) parts.push(`commit ${BUILD_SHA}`)
  parts.push(BUILD_TARGET ? `${runtimeText()} runtime (embedded)` : runtimeText())
  parts.push(`${process.platform} ${release()} ${process.arch}`)
  return parts.join('; ')
}

/** The text of `qqq --version`. */
export function versionText(): string {
  const build = BUILD_TARGET ? `${BUILD_TARGET} binary${BUILD_UI ? ' with ui' : ''}${BUILD_SHA ? `, ${BUILD_SHA}` : ''}, ${runtimeText().toLowerCase()}` : runtimeText().toLowerCase()
  return [
    `qqq ${CLI_VERSION} (${build})`,
    `UI API client ${UI_API_VERSION}; servers UI API ${UI_API_RANGE}`,
  ].join('\n')
}
