/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { UiApiError, decodeJwtClaims, deviceSignIn, getAuthenticationMetaData, getNativeSignInConfig } from '@qrun-io/qqq-ui-api-client'
import { loginFetch, profileNameForServer, readConfig, readLogin, signInWithSession, writeLogin, type SecretStore } from '@qrun-io/qqq-core'
import { TUI_CHANNEL, TuiClient } from '../client'
import type { Key } from '../keys'
import { PromptOverlay } from '../overlays/basic'
import type { AppStore, Target } from '../store'
import { glyphs, theme } from '../theme'
import type { FKeyLabels, Screen } from '../types'
import { errorText, pad } from '../util/text'
import { HomeScreen } from './home'
import { ListModel, Panel, type Row } from './list'

export interface SignInDeps {
  secrets: () => SecretStore
  fetch?: typeof fetch
  /** Runs after the home screen is shown (the route given on the command line). */
  afterConnect?: (store: AppStore) => void
  timers?: boolean
}

/** Connects the store to a profile: the stored sign-in, a client, metadata; then the home screen. */
export async function connect(store: AppStore, target: Target, deps: SignInDeps): Promise<void> {
  const store_ = deps.secrets()
  const login = await readLogin(store_, target)
  if (!login && !process.env.QQQ_TOKEN) throw new NeedsSignIn()
  const fetchImpl = loginFetch({ store: store_, target, clientChannel: TUI_CHANNEL, fetch: deps.fetch })
  const client = new TuiClient({ server: target.server, fetch: fetchImpl })
  store.target = target
  store.status.profile = target.name
  store.status.server = target.server
  if (login?.kind === 'session') {
    const u = login.user ?? {}
    store.status.user = String(u.displayName ?? u.name ?? u.email ?? u.username ?? '')
    store.status.auth = `${login.authType.toLowerCase()} session`
  } else if (login) {
    const claims = decodeJwtClaims(login.tokens.accessToken)
    store.status.user = String(claims.email ?? claims.preferred_username ?? claims.sub ?? '')
    store.status.auth = 'oauth2'
  } else {
    store.status.auth = 'QQQ_TOKEN'
  }
  try {
    await store.connect(client, { timers: deps.timers })
  } catch (e) {
    if (e instanceof UiApiError && (e.status === 401 || e.status === 403)) throw new NeedsSignIn('your sign-in expired; sign in again')
    throw e
  }
  while (store.routes.length) store.routes.pop()?.dispose?.()
  store.push(new HomeScreen(store))
  deps.afterConnect?.(store)
}

export class NeedsSignIn extends Error {
  constructor(message = 'not signed in') {
    super(message)
  }
}

/** The sign-in screen: pick a profile (or a new server); MOCK/anonymous get a session, OAuth2 uses the device flow. */
export class SignInScreen implements Screen {
  readonly kind = 'signin'
  readonly id = 'signin'
  readonly list = new ListModel()
  status = ''
  device?: { url: string; code: string; expires: number }
  connecting = false

  constructor(private store: AppStore, private deps: SignInDeps, private initial?: Target, note?: string) {
    this.status = note ?? ''
    this.build()
  }

  title(): string {
    return 'Sign in'
  }

  fkeys(): FKeyLabels {
    return { 3: null, 4: null, 5: null, 6: null, 7: null, 8: null }
  }

  build(): void {
    const t = theme()
    const g = glyphs()
    const config = readConfig()
    const rows: Row[] = [{ text: 'Choose a profile (a server and its sign-in), or connect to another server.', fg: t.dim }, { text: '' }]
    const names = Object.keys(config.profiles)
    if (this.initial && !config.profiles[this.initial.name]) rows.push({ text: `  ${g.pointer} ${pad(this.initial.name, 24)} ${this.initial.server}  (new)`, key: `p:${this.initial.name}`, action: () => this.choose(this.initial!) })
    for (const n of names) {
      const p = config.profiles[n]!
      rows.push({ text: `  ${n === config.defaultProfile ? '*' : ' '} ${pad(n, 24)} ${p.server}`, key: `p:${n}`, action: () => this.choose({ name: n, server: p.server }) })
    }
    rows.push({ text: `    ${pad('Connect to another server…', 24)}`, key: 'new', action: () => this.newServer() })
    rows.push({ text: '' })
    rows.push({ text: '* is the default profile · Enter signs in · F10 quits', fg: t.dim })
    this.list.setRows(rows)
    if (this.initial) {
      const i = this.list.rows.findIndex((r) => r.key === `p:${this.initial!.name}`)
      if (i >= 0) this.list.cursor = i
    }
  }

  newServer(): void {
    this.store.open(new PromptOverlay(this.store, 'Connect to a server', 'The server URL, e.g. http://localhost:8077. A profile named after the host is created.', (url) => {
      try {
        const origin = new URL(url.trim()).origin
        this.choose({ name: profileNameForServer(origin), server: origin })
      } catch {
        this.status = `not a URL: ${url}`
      }
    }, 'http://localhost:8077'))
  }

  /** Uses the stored sign-in, or signs in now. */
  choose(target: Target): void {
    if (this.connecting) return
    this.connecting = true
    this.status = `connecting to ${target.server}…`
    this.store.bump()
    connect(this.store, target, this.deps).catch(async (e) => {
      if (!(e instanceof NeedsSignIn)) throw e
      await this.signIn(target)
      await connect(this.store, target, this.deps)
    }).catch((e) => {
      this.status = errorText(e)
    }).finally(() => {
      this.connecting = false
      this.device = undefined
      this.store.bump()
    })
  }

  async signIn(target: Target): Promise<void> {
    const secrets = this.deps.secrets()
    const auth = await getAuthenticationMetaData(target.server, this.deps.fetch)
    const type = String(auth.type ?? '').toUpperCase()
    if (type === 'MOCK' || type === 'FULLY_ANONYMOUS') {
      this.status = `${type.toLowerCase()} authentication: creating a session…`
      this.store.bump()
      await signInWithSession(secrets, target, type, TUI_CHANNEL, this.deps.fetch)
      return
    }
    if (type === 'OAUTH2' || type === 'AUTH_0') {
      const config = await getNativeSignInConfig(target.server, this.deps.fetch)
      const tokens = await deviceSignIn(config, (prompt) => {
        this.device = { url: prompt.verificationUriComplete ?? prompt.verificationUri, code: prompt.userCode, expires: Date.now() + prompt.expiresIn * 1000 }
        this.status = 'waiting for approval in the browser…'
        this.store.bump()
      }, { fetch: this.deps.fetch })
      await writeLogin(secrets, target, { kind: 'oauth', config, tokens })
      return
    }
    if (type === 'TABLE_BASED') throw new Error('TABLE_BASED sign-in (username and password) is not supported yet; set QQQ_TOKEN to a session UUID.')
    throw new Error(`unknown authentication type "${auth.type}"`)
  }

  onKey(key: Key): boolean {
    if (key.name === 'escape') return true
    return this.list.onKey(key)
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    const extra: React.ReactNode[] = []
    if (this.device) {
      const left = Math.max(0, Math.round((this.device.expires - Date.now()) / 1000))
      extra.push(<text flexShrink={0} wrapMode="none" key="d1" fg={t.acc}>{pad(' Open this address in a browser:', width - 2)}</text>)
      extra.push(<text flexShrink={0} wrapMode="none" key="d2" fg={t.fg}><strong>{pad(`   ${this.device.url}`, width - 2)}</strong></text>)
      extra.push(<text flexShrink={0} wrapMode="none" key="d3" fg={t.acc}>{pad(' and confirm the code:', width - 2)}</text>)
      extra.push(<text flexShrink={0} wrapMode="none" key="d4" fg={t.acc2}><strong>{pad(`   ${this.device.code}`, width - 2)}</strong></text>)
      extra.push(<text flexShrink={0} wrapMode="none" key="d5" fg={t.dim}>{pad(` the code expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`, width - 2)}</text>)
    }
    const listHeight = Math.max(3, height - 3 - extra.length - 1)
    return (
      <Panel title="Sign in" width={width} height={height} focused={focused}>
        {this.list.view(width - 2, listHeight, focused)}
        {extra}
        <text flexShrink={0} wrapMode="none" fg={/fail|error|cannot|not /i.test(this.status) ? t.err : t.dim}>{pad(` ${this.status}`, width - 2)}</text>
      </Panel>
    )
  }
}
