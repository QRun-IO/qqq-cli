/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import { UiApiError, createSession, decodeJwtClaims, deviceSignIn, endSessionUrl, getAuthenticationMetaData, revokeToken } from '@qrun-io/qqq-ui-api-client'
import { browserSignIn, openInBrowser } from '../browser-login.js'
import type { Context } from '../context.js'
import { UsageError } from '../context.js'
import { CLIENT_CHANNEL, currentToken, getLogin, nativeConfig, removeLogin, saveLogin, secretStoreKind } from '../session.js'
import type { Json } from './shared.js'

export function registerAuth(program: Command, ctx: () => Context): void {
  program.command('login')
    .description('Sign in. OAUTH2 and AUTH_0 servers use the device-authorization grant (or --browser: authorization code with PKCE on a loopback redirect); MOCK and FULLY_ANONYMOUS servers get a server session.')
    .option('--device', 'force the device-authorization grant')
    .option('--browser', 'sign in in the browser: authorization code + PKCE, redirect to http://127.0.0.1:{port}/callback')
    .option('--no-open', 'with --browser, print the URL instead of opening the browser')
    .option('--port <n>', 'with --browser, the loopback port (default: any free port)')
    .option('--redirect-host <host>', 'with --browser, 127.0.0.1 (default) or localhost, as the provider registered it')
    .action(async (options: { device?: boolean; browser?: boolean; open: boolean; port?: string; redirectHost?: string }) => {
      const c = ctx()
      const t = c.target
      const origin = t.server
      const auth = await getAuthenticationMetaData(origin)
      const type = String(auth.type ?? '').toUpperCase()
      if (options.device && options.browser) throw new UsageError('--device and --browser exclude each other.')
      if (options.redirectHost && options.redirectHost !== '127.0.0.1' && options.redirectHost !== 'localhost') throw new UsageError('--redirect-host is 127.0.0.1 or localhost.')
      if (!options.device && !options.browser && (type === 'MOCK' || type === 'FULLY_ANONYMOUS')) {
        const session = await createSession(origin, {}, CLIENT_CHANNEL)
        const user = (session.values.user ?? {}) as Record<string, unknown>
        await saveLogin(t, { kind: 'session', authType: type, sessionUUID: session.sessionUUID, user, createdAt: new Date().toISOString() })
        c.note(`Signed in to ${origin} (${type.toLowerCase()} authentication${user.name || user.email ? ` as ${user.name ?? user.email}` : ''}) as profile "${t.name}"; sign-in kept in the ${secretStoreKind()}.`)
        return
      }
      if (options.browser && type !== 'OAUTH2' && type !== 'AUTH_0') throw new UsageError(`--browser needs an OAUTH2 or AUTH_0 server; this one uses ${type}.`)
      if (!options.device && type === 'TABLE_BASED') throw new UsageError('TABLE_BASED sign-in (username and password) is not implemented yet; set QQQ_TOKEN to a session UUID for now.')
      if (!options.device && type !== 'OAUTH2' && type !== 'AUTH_0') throw new UsageError(`Unknown authentication type "${auth.type}"; this CLI knows OAUTH2, AUTH_0, MOCK and FULLY_ANONYMOUS.`)
      const config = await nativeConfig(origin)
      const tokens = await (options.browser
        ? browserSignIn(config, { port: options.port ? Number(options.port) : undefined, host: options.redirectHost as '127.0.0.1' | 'localhost' | undefined, open: options.open, note: (text) => c.note(text) })
        : deviceSignIn(config, (prompt) => {
          c.note(`To sign in to ${origin}, open:\n\n  ${prompt.verificationUriComplete ?? prompt.verificationUri}\n`)
          c.note(`and confirm the code ${prompt.userCode} (it expires in ${Math.round(prompt.expiresIn / 60)} minutes).`)
          c.note('Waiting for approval...')
        })).catch((error: unknown) => {
          // a denied, forged or failed sign-in is an authentication failure (exit 3); nothing was saved
          throw new UiApiError(401, { code: 'UNAUTHENTICATED', message: error instanceof Error ? error.message : String(error) })
        })
      const claims = decodeJwtClaims(tokens.accessToken)
      // the server must accept the token before the sign-in counts (audience, issuer, bearer tokens enabled)
      const check = await fetch(new URL('/qqq/v1/metaData', origin), { headers: { Authorization: `Bearer ${tokens.accessToken}`, 'X-QQQ-Client': CLIENT_CHANNEL } })
      if (check.status === 401 || check.status === 403) throw new UiApiError(check.status, await check.json().catch(() => ({ message: `the server refused the new token (HTTP ${check.status})` })))
      await saveLogin(t, { kind: 'oauth', config, tokens })
      c.note(`Signed in to ${origin} as ${claims.email ?? claims.preferred_username ?? claims.sub} (profile "${t.name}", ${options.browser ? 'browser' : 'device'} sign-in kept in the ${secretStoreKind()}).`)
    })

  program.command('logout')
    .description("Forget this server's sign-in (and end a server session). --provider-logout also revokes the refresh token at the provider and ends the provider session.")
    .option('--provider-logout', 'OAuth2 sign-ins: revoke the refresh token (RFC 7009) and open the provider end-session URL')
    .option('--no-open', 'with --provider-logout, print the end-session URL instead of opening the browser')
    .action(async (options: { providerLogout?: boolean; open: boolean }) => {
      const c = ctx()
      const t = c.target
      const origin = t.server
      const login = await getLogin(t)
      if (options.providerLogout && login && login.kind !== 'session') {
        try {
          const revoked = login.tokens.refreshToken ? await revokeToken(login.config, login.tokens.refreshToken) : false
          c.note(revoked ? 'Revoked the refresh token at the provider.' : 'The provider has no revocation endpoint (or there was no refresh token).')
        } catch (error) {
          c.note(`Revoking at the provider failed: ${error instanceof Error ? error.message : String(error)}`)
        }
        const url = await endSessionUrl(login.config, { idToken: login.tokens.idToken })
        if (url) {
          c.note(`End the provider session${options.open ? ' (opening your browser)' : ''}:\n\n  ${url}\n`)
          if (options.open) openInBrowser(url)
        } else {
          c.note('The provider publishes no end_session_endpoint; sign out there yourself to end its session.')
        }
      } else if (options.providerLogout && login?.kind === 'session') {
        c.note('This sign-in is a server session, not an OAuth2 sign-in; there is no provider session to end.')
      }
      if (login?.kind === 'session') {
        try {
          await c.call('logout', {})
        } catch {
          // the session may already be gone
        }
      }
      c.note((await removeLogin(t)) ? `Signed out of ${origin} (profile "${t.name}").` : `Not signed in to ${origin}.`)
    })

  program.command('whoami')
    .description('Show the signed-in user, the server version and its extensions.')
    .action(async () => {
      const c = ctx()
      const t = c.target
      const origin = t.server
      const version = await c.unwrap(c.client.GET('/qqq/v1/version')) as Json
      const token = await currentToken(t)
      const claims = token && token.includes('.') ? decodeJwtClaims(token) : {}
      const metaData = await c.metaData() as unknown as Json
      const login = await getLogin(t)
      const sessionUser = login?.kind === 'session' ? login.user ?? {} : {}
      const result = {
        profile: `${t.name} (${t.source})`,
        server: origin,
        auth: login?.kind === 'session' ? `${login.authType.toLowerCase()} session` : login ? 'oauth2 bearer' : process.env.QQQ_TOKEN ? 'QQQ_TOKEN' : 'none',
        user: claims.email ?? claims.preferred_username ?? claims.sub ?? sessionUser.email ?? sessionUser.username ?? sessionUser.name ?? '',
        name: claims.name ?? sessionUser.displayName ?? sessionUser.name ?? '',
        tokenExpires: login && login.kind !== 'session' ? new Date(login.tokens.expiresAt).toISOString() : '',
        apiVersion: version.apiVersion,
        features: ((version.features ?? []) as string[]).join(', '),
        extensions: (await c.extensions({ refresh: true })).describe(),
        apps: Object.keys((metaData.apps ?? {}) as Json).length,
        tables: Object.keys((metaData.tables ?? {}) as Json).length,
        processes: Object.keys((metaData.processes ?? {}) as Json).length,
      }
      c.print({ data: result, rows: Object.entries(result).map(([key, value]) => ({ key, value })), columns: ['key', 'value'] })
    })
}
