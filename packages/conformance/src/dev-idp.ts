#!/usr/bin/env node
/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * qqq-dev-idp - a tiny OpenID Connect provider for LOCAL DEVELOPMENT AND TESTS ONLY, so a client
 * author can run the whole native-client flow (device-authorization grant, refresh, bearer JWTs)
 * against a local QQQ server without an identity provider account. Never expose it: it approves
 * device codes for one configured user without a password.
 *
 * Like Authentik, every client has its own issuer, http://localhost:{port}/application/o/{clientId}/,
 * with discovery and JWKS (RS256); the token and device endpoints are shared; GET /device?code=...
 * approves a code (or start it with --auto-approve).
 *
 *   qqq-dev-idp --port 9400 --client sample-app --client sample-cli --user dev@example.com --groups admins [--auto-approve]
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto'

interface DeviceGrant {
  clientId: string
  scope: string
  userCode: string
  approved: boolean
  expiresAt: number
}

/** Options of {@link startDevIdp}. */
export interface DevIdpOptions {
  port: number
  clients: string[]
  user: { sub: string; email: string; name: string; preferredUsername: string; groups: string[] }
  autoApprove?: boolean
  accessTokenSeconds?: number
  log?: (line: string) => void
}

/** A running dev provider. */
export interface DevIdp {
  close: () => Promise<void>
  issuer: (clientId: string) => string
  approve: (userCode: string) => boolean
}

/**
 * Starts the provider; resolves once it listens.
 *
 * @param options - Port, client ids (each gets an issuer), the user and whether codes auto-approve.
 */
export async function startDevIdp(options: DevIdpOptions): Promise<DevIdp> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const kid = randomUUID()
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid, alg: 'RS256', use: 'sig' }
  const base = `http://localhost:${options.port}`
  const issuer = (clientId: string) => `${base}/application/o/${clientId}/`
  const devices = new Map<string, DeviceGrant>()
  const refreshTokens = new Map<string, { clientId: string; scope: string }>()
  const log = options.log ?? (() => undefined)

  const sign = (clientId: string, scope: string): Record<string, unknown> => {
    const now = Math.floor(Date.now() / 1000)
    const lifetime = options.accessTokenSeconds ?? 600
    const claims = {
      iss: issuer(clientId), aud: clientId, sub: options.user.sub, iat: now, nbf: now, exp: now + lifetime, jti: randomUUID(),
      email: options.user.email, email_verified: true, name: options.user.name, preferred_username: options.user.preferredUsername,
      groups: options.user.groups, scope,
    }
    const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const input = `${encode({ alg: 'RS256', typ: 'JWT', kid })}.${encode(claims)}`
    const signature = createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')
    const refresh = randomBytes(24).toString('base64url')
    refreshTokens.set(refresh, { clientId, scope })
    return { access_token: `${input}.${signature}`, token_type: 'Bearer', expires_in: lifetime, refresh_token: refresh, scope }
  }

  const approve = (userCode: string): boolean => {
    for (const grant of devices.values()) {
      if (grant.userCode === userCode.toUpperCase()) {
        grant.approved = true
        log(`approved ${userCode} for ${grant.clientId}`)
        return true
      }
    }
    return false
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', base)
    const send = (status: number, body: unknown, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
      res.end(type === 'application/json' ? JSON.stringify(body) : String(body))
    }

    if (url.pathname === '/device') {
      const code = url.searchParams.get('code')
      if (code) return send(200, approve(code) ? `Approved ${code}. You can close this page.` : `Unknown code ${code}.`, 'text/plain')
      return send(200, 'Open /device?code=XXXX-XXXX to approve a code.', 'text/plain')
    }

    if (req.method === 'POST' && (url.pathname === '/application/o/token/' || url.pathname === '/application/o/device/')) {
      let text = ''
      for await (const chunk of req) text += chunk
      const body = new URLSearchParams(text)
      const clientId = body.get('client_id') ?? ''
      if (!options.clients.includes(clientId)) return send(401, { error: 'invalid_client' })

      if (url.pathname === '/application/o/device/') {
        const deviceCode = randomBytes(24).toString('base64url')
        const userCode = `${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}`.toUpperCase()
        devices.set(deviceCode, { clientId, scope: body.get('scope') ?? 'openid', userCode, approved: Boolean(options.autoApprove), expiresAt: Date.now() + 600_000 })
        log(`device code ${userCode} for ${clientId}${options.autoApprove ? ' (auto-approved)' : ''}`)
        return send(200, {
          device_code: deviceCode, user_code: userCode, verification_uri: `${base}/device`,
          verification_uri_complete: `${base}/device?code=${userCode}`, expires_in: 600, interval: 1,
        })
      }

      const grantType = body.get('grant_type')
      if (grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
        const grant = devices.get(body.get('device_code') ?? '')
        if (!grant || grant.clientId !== clientId || grant.expiresAt < Date.now()) return send(400, { error: 'expired_token' })
        if (!grant.approved) return send(400, { error: 'authorization_pending' })
        devices.delete(body.get('device_code') ?? '')
        return send(200, sign(clientId, grant.scope))
      }
      if (grantType === 'refresh_token') {
        const stored = refreshTokens.get(body.get('refresh_token') ?? '')
        if (!stored || stored.clientId !== clientId) return send(400, { error: 'invalid_grant' })
        refreshTokens.delete(body.get('refresh_token') ?? '')
        return send(200, sign(clientId, stored.scope))
      }
      return send(400, { error: 'unsupported_grant_type' })
    }

    const match = /^\/application\/o\/([^/]+)\/(.*)$/.exec(url.pathname)
    const clientId = match?.[1]
    if (!match || !clientId || !options.clients.includes(clientId)) return send(404, { error: 'not_found' })
    if (match[2] === '.well-known/openid-configuration') {
      return send(200, {
        issuer: issuer(clientId), jwks_uri: `${issuer(clientId)}jwks/`, token_endpoint: `${base}/application/o/token/`,
        device_authorization_endpoint: `${base}/application/o/device/`, authorization_endpoint: `${base}/application/o/authorize/`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        grant_types_supported: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
      })
    }
    if (match[2] === 'jwks/') return send(200, { keys: [jwk] })
    return send(404, { error: 'not_found' })
  })

  await new Promise<void>((resolve) => server.listen(options.port, resolve))
  log(`qqq-dev-idp on ${base}; issuers: ${options.clients.map(issuer).join(', ')}`)
  return { close: () => new Promise<void>((resolve) => server.close(() => resolve())), issuer, approve }
}

/** CLI entry. */
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const value = (name: string, fallback: string) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : fallback
  }
  const clients = args.flatMap((a, i) => (a === '--client' ? [args[i + 1]] : []))
  const email = value('--user', 'dev@example.com')
  await startDevIdp({
    port: Number(value('--port', '9400')),
    clients: clients.length ? clients : ['sample-app', 'sample-cli'],
    user: { sub: email, email, name: value('--name', 'Dev User'), preferredUsername: email.split('@')[0], groups: value('--groups', 'admins').split(',') },
    autoApprove: args.includes('--auto-approve'),
    accessTokenSeconds: Number(value('--token-seconds', '600')),
    log: (line) => console.log(line),
  })
}

if (process.argv[1] && /dev-idp(\.js)?$/.test(process.argv[1])) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
