/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The CLI's version and the UI API versions it supports, printed by `qqq --version` and sent in
 * X-QQQ-Client. CLI_VERSION must equal packages/cli/package.json (scripts/lint.mjs checks it).
 * The single-file binaries (scripts/build-binaries.mjs) define QQQ_BUILD_SHA and QQQ_BUILD_TARGET;
 * an npm install leaves them undefined.
 */

import { UI_API_VERSION } from '@qrun-io/qqq-ui-api-client'

declare const QQQ_BUILD_SHA: string | undefined
declare const QQQ_BUILD_TARGET: string | undefined

export const CLI_VERSION = '1.0.0-rc.1'

/** The oldest UI API a server may serve for this CLI (operationIds, clientCapabilities and traceId since 1.6.0). */
export const UI_API_MIN_VERSION = '1.6.0'

/** The supported range: from UI_API_MIN_VERSION up to, not including, the next major version. */
export const UI_API_RANGE = `>=${UI_API_MIN_VERSION} <2.0.0`

export const BUILD_SHA = typeof QQQ_BUILD_SHA === 'string' ? QQQ_BUILD_SHA : undefined
export const BUILD_TARGET = typeof QQQ_BUILD_TARGET === 'string' ? QQQ_BUILD_TARGET : undefined

/** The text of `qqq --version`. */
export function versionText(): string {
  const build = BUILD_TARGET ? `${BUILD_TARGET} binary${BUILD_SHA ? `, ${BUILD_SHA}` : ''}` : `node ${process.versions.node}`
  return [
    `qqq ${CLI_VERSION} (${build})`,
    `UI API: servers ${UI_API_RANGE}; client generated from ${UI_API_VERSION}`,
  ].join('\n')
}
