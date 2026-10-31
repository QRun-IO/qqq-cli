/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import { createSession, decodeJwtClaims, deviceSignIn, getAuthenticationMetaData } from '@qrun-io/qqq-ui-api-client'
import type { Context } from '../context.js'
import { UsageError } from '../context.js'
import { CLIENT_CHANNEL, currentToken, getLogin, nativeConfig, removeLogin, saveLogin } from '../session.js'
import type { Json } from './shared.js'

export function registerAuth(program: Command, ctx: () => Context): void {
  program.command('login')
    .description('Sign in. OAUTH2 and AUTH_0 servers use the device-authorization grant; MOCK and FULLY_ANONYMOUS servers get a server session.')
    .option('--device', 'force the device-authorization grant')
    .action(async (options: { device?: boolean }) => {
      const c = ctx()
      const origin = c.server
      const auth = await getAuthenticationMetaData(origin)
      const type = String(auth.type ?? '').toUpperCase()
      if (!options.device && (type === 'MOCK' || type === 'FULLY_ANONYMOUS')) {
        const session = await createSession(origin, {}, CLIENT_CHANNEL)
        const user = (session.values.user ?? {}) as Record<string, unknown>
        saveLogin(origin, { kind: 'session', authType: type, sessionUUID: session.sessionUUID, user, createdAt: new Date().toISOString() })
        c.note(`Signed in to ${origin} (${type.toLowerCase()} authentication${user.name || user.email ? ` as ${user.name ?? user.email}` : ''}).`)
        return
      }
      if (!options.device && type === 'TABLE_BASED') throw new UsageError('TABLE_BASED sign-in (username and password) is not implemented yet; set QQQ_TOKEN to a session UUID for now.')
      if (!options.device && type !== 'OAUTH2' && type !== 'AUTH_0') throw new UsageError(`Unknown authentication type "${auth.type}"; this CLI knows OAUTH2, AUTH_0, MOCK and FULLY_ANONYMOUS.`)
      const config = await nativeConfig(origin)
      const tokens = await deviceSignIn(config, (prompt) => {
        c.note(`To sign in to ${origin}, open:\n\n  ${prompt.verificationUriComplete ?? prompt.verificationUri}\n`)
        c.note(`and confirm the code ${prompt.userCode} (it expires in ${Math.round(prompt.expiresIn / 60)} minutes).`)
        c.note('Waiting for approval...')
      })
      saveLogin(origin, { kind: 'oauth', config, tokens })
      const claims = decodeJwtClaims(tokens.accessToken)
      c.note(`Signed in to ${origin} as ${claims.email ?? claims.preferred_username ?? claims.sub}.`)
    })

  program.command('logout')
    .description("Forget this server's sign-in (and end a server session).")
    .action(async () => {
      const c = ctx()
      const origin = c.server
      const login = getLogin(origin)
      if (login?.kind === 'session') {
        try {
          await c.call('logout', {})
        } catch {
          // the session may already be gone
        }
      }
      c.note(removeLogin(origin) ? `Signed out of ${origin}.` : `Not signed in to ${origin}.`)
    })

  program.command('whoami')
    .description('Show the signed-in user, the server version and its extensions.')
    .action(async () => {
      const c = ctx()
      const origin = c.server
      const version = await c.unwrap(c.client.GET('/qqq/v1/version')) as Json
      const token = await currentToken(origin)
      const claims = token && token.includes('.') ? decodeJwtClaims(token) : {}
      const metaData = await c.unwrap(c.client.GET('/qqq/v1/metaData', {})) as Json
      const login = getLogin(origin)
      const sessionUser = login?.kind === 'session' ? login.user ?? {} : {}
      const result = {
        server: origin,
        auth: login?.kind === 'session' ? `${login.authType.toLowerCase()} session` : login ? 'oauth2 bearer' : process.env.QQQ_TOKEN ? 'QQQ_TOKEN' : 'none',
        user: claims.email ?? claims.preferred_username ?? claims.sub ?? sessionUser.email ?? sessionUser.username ?? sessionUser.name ?? '',
        name: claims.name ?? sessionUser.displayName ?? sessionUser.name ?? '',
        tokenExpires: login && login.kind !== 'session' ? new Date(login.tokens.expiresAt).toISOString() : '',
        apiVersion: version.apiVersion,
        features: ((version.features ?? []) as string[]).join(', '),
        extensions: ((version.extensions ?? []) as Json[]).map((e) => `${e.name} ${e.version}`).join(', '),
        apps: Object.keys((metaData.apps ?? {}) as Json).length,
        tables: Object.keys((metaData.tables ?? {}) as Json).length,
        processes: Object.keys((metaData.processes ?? {}) as Json).length,
      }
      c.print({ data: result, rows: Object.entries(result).map(([key, value]) => ({ key, value })), columns: ['key', 'value'] })
    })
}
