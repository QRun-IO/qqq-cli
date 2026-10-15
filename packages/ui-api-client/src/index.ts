/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

export { createUiApiClient, unwrap } from './client.js'
export type { UiApiClient, UiApiClientOptions } from './client.js'
export { UiApiError, codeForStatus } from './errors.js'
export type { UiApiFieldError } from './errors.js'
export { getNativeSignInConfig, discoverProvider, deviceSignIn, refreshTokens, isExpiring, decodeJwtClaims } from './auth.js'
export type { TokenSet, NativeSignInConfig, ProviderEndpoints, DevicePrompt } from './auth.js'
export { openRealtimeStream, parseEventBlock } from './realtime.js'
export type { RealtimeMessage, RealtimeStreamOptions } from './realtime.js'
export type { paths, components, operations } from './schema.js'

/** The UI API version this client was generated from (info.version of the merged document). */
export const UI_API_VERSION = '1.6.0'
