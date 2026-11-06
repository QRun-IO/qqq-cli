/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Browser sign-in for `qqq login --browser`: the authorization-code grant with PKCE on a loopback
 * redirect (RFC 8252). A one-shot HTTP listener on 127.0.0.1 receives the provider's redirect,
 * the state is checked, and the code is exchanged at the provider's token endpoint with the
 * verifier (UI-API-CLIENTS.md section 7). Nothing is saved unless every step succeeds.
 */

import { spawn } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { authorizationUrl, createPkce, createState, discoverProvider, exchangeAuthorizationCode, readAuthorizationCallback, type NativeSignInConfig, type TokenSet } from '@qrun-io/qqq-ui-api-client'

export interface BrowserSignInOptions {
  /** Loopback port (default: any free port). Some providers need the exact registered redirect URI. */
  port?: number
  /** Host in the redirect URI: 127.0.0.1 (default) or localhost, whichever the provider registered. */
  host?: '127.0.0.1' | 'localhost'
  /** Open the system browser (default true); the URL is always printed. */
  open?: boolean
  /** How long to wait for the redirect. */
  timeoutMillis?: number
  note: (text: string) => void
  signal?: AbortSignal
}

/** Opens a URL with the platform's opener; failures are ignored (the URL is printed anyway). */
export function openInBrowser(url: string): void {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? [process.env.QQQ_POWERSHELL || 'powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from('Start-Process -FilePath $env:QQQ_BROWSER_URL', 'utf16le').toString('base64')]] : ['xdg-open', [url]]
  try {
    const child = spawn(command, args as string[], { stdio: 'ignore', detached: true, windowsHide: true, env: { ...process.env, QQQ_BROWSER_URL: url } })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // no opener: the printed URL is the way
  }
}

const page = (title: string, text: string): string => `<!doctype html><meta charset="utf-8"><title>${title}</title><p style="font-family:sans-serif">${text}</p>`

/** Runs the browser sign-in and returns the provider's tokens. */
export async function browserSignIn(config: NativeSignInConfig, options: BrowserSignInOptions): Promise<TokenSet> {
  const endpoints = await discoverProvider(config.issuer)
  if (!endpoints.authorizationEndpoint) throw new Error('The provider publishes no authorization_endpoint; use the device flow (qqq login --device).')
  const pkce = await createPkce()
  const state = createState()
  const host = options.host ?? '127.0.0.1'

  let settle!: { resolve: (url: URL) => void; reject: (error: Error) => void }
  const callback = new Promise<URL>((resolve, reject) => {
    settle = { resolve, reject }
  })
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`)
    if (url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('Not found')
      return
    }
    let ok = false
    try {
      readAuthorizationCallback(url, state)
      ok = true
    } catch {
      ok = false
    }
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(ok ? page('Signed in', 'Signed in. You can close this tab and return to the terminal.') : page('Sign-in failed', 'Sign-in did not complete. See the terminal for the reason.'))
    settle.resolve(url)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  const redirectUri = `http://${host}:${port}/callback`
  const url = authorizationUrl(endpoints, config, { redirectUri, state, challenge: pkce.challenge })
  const timer = setTimeout(() => settle.reject(new Error('Sign-in timed out waiting for the browser; run qqq login --browser again')), options.timeoutMillis ?? 300_000)
  const onAbort = () => settle.reject(new Error('Sign-in cancelled'))
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    options.note(`Open this URL to sign in${options.open === false ? '' : ' (opening your browser)'}:\n\n  ${url}\n\nWaiting for the browser on ${redirectUri} ...`)
    if (options.open !== false) openInBrowser(url)
    const received = await callback
    const { code } = readAuthorizationCallback(received, state)
    return await exchangeAuthorizationCode(config, { code, verifier: pkce.verifier, redirectUri }, fetch, endpoints)
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    server.close()
  }
}
