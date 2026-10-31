/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Sign-in for native clients (CLI, TUI, desktop), as documented in the QQQ docs
 * UI-API-CLIENTS.md section 7: read GET /qqq/v1/metaData/authentication, use the app's public
 * native client (values.nativeClientId) at its issuer with the OAuth2 device-authorization grant
 * (RFC 8628), then send the access token as `Authorization: Bearer`; refresh it at the provider.
 */

/** Tokens from the provider, with an absolute expiry. */
export interface TokenSet {
  accessToken: string
  refreshToken?: string
  idToken?: string
  /** Epoch milliseconds when the access token expires. */
  expiresAt: number
  scope?: string
}

/** What a native client needs to sign in to one QQQ server. */
export interface NativeSignInConfig {
  /** The issuer (OIDC discovery base URL) of the native client. */
  issuer: string
  clientId: string
  scope: string
}

/** The parts of an OIDC discovery document a native client uses. */
export interface ProviderEndpoints {
  issuer: string
  tokenEndpoint: string
  deviceAuthorizationEndpoint?: string
  authorizationEndpoint?: string
}

/** What to show the user while a device sign-in waits for approval. */
export interface DevicePrompt {
  verificationUri: string
  verificationUriComplete?: string
  userCode: string
  expiresIn: number
}

/**
 * Reads the server's authentication metadata and returns the native client sign-in settings.
 *
 * @param baseUrl - The server origin, e.g. https://admin.example.com.
 * @param fetchImpl - Optional fetch.
 * @returns The native client config, or throws when the server has none.
 */
export async function getNativeSignInConfig(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<NativeSignInConfig> {
  const response = await fetchImpl(new URL('/qqq/v1/metaData/authentication', baseUrl))
  if (!response.ok) throw new Error(`GET /qqq/v1/metaData/authentication answered ${response.status}`)
  const body = await response.json() as { type?: string; values?: Record<string, unknown> }
  const values = body.values ?? {}
  if (body.type !== 'OAUTH2') throw new Error(`The server uses ${body.type ?? 'unknown'} authentication; this client supports OAUTH2.`)
  const clientId = typeof values.nativeClientId === 'string' ? values.nativeClientId : undefined
  if (!clientId) throw new Error('The server publishes no native client (values.nativeClientId); it cannot be used from a CLI yet.')
  const issuer = typeof values.nativeClientBaseUrl === 'string' ? values.nativeClientBaseUrl : String(values.baseUrl)
  const scopes = new Set(String(values.scopes ?? 'openid profile email').split(/\s+/).filter(Boolean))
  scopes.add('offline_access')
  return { issuer, clientId, scope: [...scopes].join(' ') }
}

/**
 * Reads the provider's OIDC discovery document.
 *
 * @param issuer - The issuer URL.
 * @param fetchImpl - Optional fetch.
 */
export async function discoverProvider(issuer: string, fetchImpl: typeof fetch = fetch): Promise<ProviderEndpoints> {
  const base = issuer.endsWith('/') ? issuer : `${issuer}/`
  const response = await fetchImpl(new URL('.well-known/openid-configuration', base))
  if (!response.ok) throw new Error(`OIDC discovery at ${base} answered ${response.status}`)
  const doc = await response.json() as Record<string, string | undefined>
  if (!doc.token_endpoint) throw new Error('The provider discovery document has no token_endpoint')
  return {
    issuer: doc.issuer ?? issuer,
    tokenEndpoint: doc.token_endpoint,
    deviceAuthorizationEndpoint: doc.device_authorization_endpoint,
    authorizationEndpoint: doc.authorization_endpoint,
  }
}

/**
 * Signs in with the device-authorization grant (RFC 8628): asks the provider for a code, shows it
 * through `onPrompt`, then polls the token endpoint until the user approves (or denies, or the code
 * expires).
 *
 * @param config - Native client settings (see {@link getNativeSignInConfig}).
 * @param onPrompt - Shows the verification URI and code to the user.
 * @param options - Optional fetch, abort signal and sleep (for tests).
 */
export async function deviceSignIn(
  config: NativeSignInConfig,
  onPrompt: (prompt: DevicePrompt) => void | Promise<void>,
  options: { fetch?: typeof fetch; signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<TokenSet> {
  const fetchImpl = options.fetch ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const endpoints = await discoverProvider(config.issuer, fetchImpl)
  if (!endpoints.deviceAuthorizationEndpoint) throw new Error('The provider does not offer the device-authorization grant')

  const start = await postForm(fetchImpl, endpoints.deviceAuthorizationEndpoint, { client_id: config.clientId, scope: config.scope }, options.signal)
  if (!start.ok) throw new Error(`Device authorization failed: ${start.body.error_description ?? start.body.error ?? start.status}`)
  const deviceCode = String(start.body.device_code)
  let interval = Number(start.body.interval ?? 5)
  const expiresIn = Number(start.body.expires_in ?? 600)
  const deadline = Date.now() + expiresIn * 1000

  await onPrompt({
    verificationUri: String(start.body.verification_uri),
    verificationUriComplete: start.body.verification_uri_complete ? String(start.body.verification_uri_complete) : undefined,
    userCode: String(start.body.user_code),
    expiresIn,
  })

  while (Date.now() < deadline) {
    await sleep(interval * 1000)
    if (options.signal?.aborted) throw new Error('Sign-in cancelled')
    const poll = await postForm(fetchImpl, endpoints.tokenEndpoint, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: config.clientId,
      device_code: deviceCode,
    }, options.signal)
    if (poll.ok) return toTokenSet(poll.body)
    const error = String(poll.body.error ?? '')
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      interval += 5
      continue
    }
    throw new Error(error === 'access_denied' ? 'Sign-in was denied' : error === 'expired_token' ? 'The code expired; sign in again' : `Sign-in failed: ${poll.body.error_description ?? error ?? poll.status}`)
  }
  throw new Error('The code expired; sign in again')
}

/**
 * Refreshes the access token at the provider (refresh_token grant, public client).
 *
 * @param config - Native client settings.
 * @param refreshToken - The current refresh token.
 * @param fetchImpl - Optional fetch.
 * @returns The new tokens (keep the new refresh token: providers may rotate it).
 */
export async function refreshTokens(config: NativeSignInConfig, refreshToken: string, fetchImpl: typeof fetch = fetch): Promise<TokenSet> {
  const endpoints = await discoverProvider(config.issuer, fetchImpl)
  const result = await postForm(fetchImpl, endpoints.tokenEndpoint, {
    grant_type: 'refresh_token',
    client_id: config.clientId,
    refresh_token: refreshToken,
  })
  if (!result.ok) throw new Error(`Refreshing the token failed: ${result.body.error_description ?? result.body.error ?? result.status}`)
  const tokens = toTokenSet(result.body)
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken }
}

/** True when the access token expires within `skewSeconds`. */
export function isExpiring(tokens: TokenSet, skewSeconds = 60): boolean {
  return Date.now() + skewSeconds * 1000 >= tokens.expiresAt
}

/** The (unverified) claims of a JWT, for display only - the server is what verifies tokens. */
export function decodeJwtClaims(jwt: string): Record<string, unknown> {
  const payload = jwt.split('.')[1]
  if (!payload) return {}
  return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>
}

async function postForm(fetchImpl: typeof fetch, url: string, form: Record<string, string>, signal?: AbortSignal): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    signal,
  })
  let body: Record<string, unknown> = {}
  try {
    body = await response.json() as Record<string, unknown>
  } catch {
    body = {}
  }
  return { ok: response.ok, status: response.status, body }
}

function toTokenSet(body: Record<string, unknown>): TokenSet {
  if (typeof body.access_token !== 'string') throw new Error('The token response has no access_token')
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    idToken: typeof body.id_token === 'string' ? body.id_token : undefined,
    expiresAt: Date.now() + Number(body.expires_in ?? 300) * 1000,
    scope: typeof body.scope === 'string' ? body.scope : undefined,
  }
}

/** The authentication metadata a server publishes before sign-in (GET /qqq/v1/metaData/authentication). */
export interface AuthenticationMetaData {
  /** OAUTH2, AUTH_0, TABLE_BASED, MOCK, FULLY_ANONYMOUS, or a type this client does not know. */
  type: string
  name?: string
  branding?: { appName?: string; companyName?: string }
  values?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Reads the server's authentication metadata.
 *
 * @param baseUrl - Server origin.
 */
export async function getAuthenticationMetaData(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<AuthenticationMetaData> {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/qqq/v1/metaData/authentication`, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`GET /qqq/v1/metaData/authentication failed: HTTP ${response.status}`)
  return await response.json() as AuthenticationMetaData
}

/** What `manageSession` accepts: nothing (MOCK, FULLY_ANONYMOUS), a provider access token, or a PKCE code. */
export interface ManageSessionRequest {
  accessToken?: string
  code?: string
  codeVerifier?: string
  redirectUri?: string
  sessionUUID?: string
}

/** A session created by `manageSession`. */
export interface ServerSession {
  /** The session UUID, from the response body or the `sessionUUID` cookie the server set. */
  sessionUUID: string
  /** Application-defined values, including `user` (name, email or username, displayName, avatarUrl). */
  values: Record<string, unknown>
}

/**
 * Creates (or resumes) a server session with POST /qqq/v1/manageSession. The UUID is taken from the
 * body when the server returns it, else from the `Set-Cookie` header (HttpOnly cookies are not in the body).
 *
 * @param baseUrl - Server origin.
 * @param request - Credentials; `{}` for MOCK and FULLY_ANONYMOUS servers.
 * @param clientChannel - X-QQQ-Client value.
 */
export async function createSession(baseUrl: string, request: ManageSessionRequest = {}, clientChannel?: string, fetchImpl: typeof fetch = fetch): Promise<ServerSession> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' }
  if (clientChannel) headers['X-QQQ-Client'] = clientChannel
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/qqq/v1/manageSession`, { method: 'POST', headers, body: JSON.stringify(request) })
  const text = await response.text()
  let body: { uuid?: string; values?: Record<string, unknown>; message?: string } = {}
  try {
    body = text ? JSON.parse(text) as typeof body : {}
  } catch {
    // not JSON
  }
  if (!response.ok) throw new Error(`manageSession failed: HTTP ${response.status}${body.message ? ` ${body.message}` : ''}`)
  const cookies: string[] = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [response.headers.get('set-cookie') ?? '']
  const fromCookie = cookies.map((c) => /(?:^|;\s*)sessionUUID=([^;]+)/.exec(c)?.[1]).find(Boolean)
  const sessionUUID = body.uuid ?? fromCookie
  if (!sessionUUID) throw new Error('manageSession returned neither a uuid nor a sessionUUID cookie')
  return { sessionUUID, values: body.values ?? {} }
}
