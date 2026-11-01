/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The model of the Servers dialog (Ctrl+O, `:servers`, F9 › Connection › Servers): every saved
 * profile with its server, short name, description, sign-in and last use; a background probe of
 * each server (UI API version, authentication type) with a short timeout; add, edit, remove and
 * default. It reads and writes the same config.json as `qqq profile …` (core session/profiles.ts);
 * the dialog (overlays/servers.tsx) only draws it.
 */

import {
  AUTH_MODES, PROFILE_NAME, deleteLogin, descriptionOf, editProfile, probeServer, readConfig, readLogin, removeProfile, setDefaultProfile,
  shortNameOf, shortNameProblem, upsertProfile, writeLogin, type AuthMode, type Profile, type SecretStore, type ServerProbe,
} from '@qrun-io/qqq-core'
import { decodeJwtClaims } from '@qrun-io/qqq-ui-api-client'

export type ProbeState = { state: 'probing' } | { state: 'ok'; apiVersion: string; authType?: string; ms?: number } | { state: 'down'; error: string }

export interface ServerRow {
  name: string
  short: string
  description: string
  server: string
  authMode: AuthMode
  /** Who is signed in (the keyring's sign-in), else who signed in last (config). */
  user: string
  /** The stored sign-in: `mock session`, `table_based session`, `oauth2`; '' when none. */
  signIn: string
  lastUsedAt?: string
  isDefault: boolean
  isCurrent: boolean
}

/** What the add/edit form collects. */
export interface ProfileInput {
  name: string
  short: string
  description: string
  server: string
  authMode: AuthMode
}

export interface ServersModelOptions {
  /** The profile in use (marked, cannot be removed). */
  current?: string
  secrets?: () => SecretStore
  probe?: (server: string) => Promise<ServerProbe>
  /** Something changed (a probe answered, a sign-in was read): repaint. */
  onChange?: () => void
}

/** Why a form is refused, or undefined. `editing` is the profile's current name when editing. */
export function inputProblem(input: ProfileInput, names: string[], editing?: string): string | undefined {
  if (!input.name.trim()) return 'a profile needs a name'
  if (!PROFILE_NAME.test(input.name.trim())) return 'a name is letters, digits, dots, dashes and underscores'
  if (input.name.trim() !== editing && names.includes(input.name.trim())) return `a profile "${input.name.trim()}" exists already`
  if (input.short.trim()) {
    const problem = shortNameProblem(input.short.trim())
    if (problem) return problem
  }
  try {
    const url = new URL(input.server.trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'the server is an http:// or https:// address'
  } catch {
    return 'the server is an address such as http://localhost:8077'
  }
  if (!AUTH_MODES.includes(input.authMode)) return `sign-in is one of ${AUTH_MODES.join(', ')}`
  return undefined
}

/** "3 min ago", "2 h ago", "yesterday", "12 Oct"; '' for never. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return ''
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  if (s < 2 * 86_400) return 'yesterday'
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} days ago`
  return new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** The status column: `…` while probing, the UI API version, or `unreachable`. */
export function statusText(p: ProbeState | undefined): string {
  if (!p || p.state === 'probing') return '…'
  return p.state === 'ok' ? `UI API ${p.apiVersion}` : 'unreachable'
}

export class ServersModel {
  rows: ServerRow[] = []
  /** By server (profiles on the same server share one probe). */
  readonly probes = new Map<string, ProbeState>()
  private readonly logins = new Map<string, { user: string; signIn: string }>()

  constructor(private options: ServersModelOptions = {}) {
    this.reload()
  }

  get current(): string | undefined {
    return this.options.current
  }

  set current(name: string | undefined) {
    this.options.current = name
  }

  /** Reads config.json again (after a change here or in the CLI). */
  reload(): void {
    const config = readConfig()
    this.rows = Object.entries(config.profiles).map(([name, p]) => this.row(name, p, config.defaultProfile))
  }

  private row(name: string, p: Profile, defaultProfile?: string): ServerRow {
    const login = this.logins.get(name)
    return {
      name, short: shortNameOf(name, p), description: descriptionOf(p), server: p.server, authMode: p.authMode ?? 'auto',
      user: login?.user || p.user || '', signIn: login?.signIn ?? '', lastUsedAt: p.lastUsedAt, isDefault: name === defaultProfile, isCurrent: name === this.options.current,
    }
  }

  /** The rows whose name, short name, description or server contain the text (any case). */
  visible(filter = ''): ServerRow[] {
    const needle = filter.trim().toLowerCase()
    if (!needle) return this.rows
    return this.rows.filter((r) => `${r.name} ${r.short} ${r.description} ${r.server}`.toLowerCase().includes(needle))
  }

  /** The auth column: the stored sign-in, else the server's type, plus a non-default sign-in mode. */
  authText(row: ServerRow): string {
    const p = this.probes.get(row.server)
    const base = row.signIn || (p?.state === 'ok' && p.authType ? p.authType.toLowerCase() : '')
    return [base, row.authMode !== 'auto' ? row.authMode : ''].filter(Boolean).join(' · ')
  }

  /** Asks every server for its version, in the background; `onChange` repaints as answers come. */
  probeAll(): Promise<void> {
    const probe = this.options.probe ?? ((server: string) => probeServer(server))
    const servers = [...new Set(this.rows.map((r) => r.server))]
    for (const s of servers) this.probes.set(s, { state: 'probing' })
    this.options.onChange?.()
    return Promise.all(servers.map(async (server) => {
      let result: ServerProbe
      try {
        result = await probe(server)
      } catch (e) {
        result = { reachable: false, error: e instanceof Error ? e.message : String(e) }
      }
      this.probes.set(server, result.reachable ? { state: 'ok', apiVersion: result.apiVersion ?? '?', authType: result.authType, ms: result.ms } : { state: 'down', error: result.error ?? 'no answer' })
      this.options.onChange?.()
    })).then(() => undefined)
  }

  /** Reads who is signed in to each profile from the keyring (in the background). */
  async readSignIns(): Promise<void> {
    const secrets = this.options.secrets?.()
    if (!secrets) return
    await Promise.all(this.rows.map(async (r) => {
      try {
        const login = await readLogin(secrets, r)
        if (!login) return
        if (login.kind === 'session') {
          const u = login.user ?? {}
          this.logins.set(r.name, { user: String(u.displayName ?? u.name ?? u.email ?? u.username ?? ''), signIn: `${login.authType.toLowerCase()} session` })
        } else {
          const claims = decodeJwtClaims(login.tokens.accessToken) as Record<string, unknown>
          this.logins.set(r.name, { user: String(claims.email ?? claims.preferred_username ?? claims.sub ?? ''), signIn: 'oauth2' })
        }
      } catch {
        // a keyring that cannot be read: the row shows the last user from config
      }
    }))
    this.reload()
    this.options.onChange?.()
  }

  /** Checks a form and, unless `force`, that the server answers /qqq/v1/version. */
  async check(input: ProfileInput, editing?: string, force = false): Promise<{ ok: true; probe?: ServerProbe } | { ok: false; error: string; unreachable?: boolean }> {
    const problem = inputProblem(input, this.rows.map((r) => r.name), editing)
    if (problem) return { ok: false, error: problem }
    if (force) return { ok: true }
    const probe = await (this.options.probe ?? ((server: string) => probeServer(server)))(new URL(input.server.trim()).origin)
    if (!probe.reachable) return { ok: false, error: `${new URL(input.server.trim()).origin} did not answer as a QQQ server (${probe.error})`, unreachable: true }
    return { ok: true, probe }
  }

  /** Saves a new profile (after `check`). */
  add(input: ProfileInput): void {
    const fields: Profile = { server: new URL(input.server.trim()).origin, ...(input.short.trim() ? { short: input.short.trim() } : {}), ...(input.description.trim() ? { description: input.description.trim() } : {}), ...(input.authMode !== 'auto' ? { authMode: input.authMode } : {}) }
    upsertProfile(input.name.trim(), fields)
    this.reload()
  }

  /**
   * Saves changes to a profile (after `check`). A new name keeps the stored sign-in; a new server
   * drops it (it belonged to the old server). Returns the profile's name afterwards.
   */
  async edit(name: string, input: ProfileInput): Promise<string> {
    const before = readConfig().profiles[name]
    if (!before) throw new Error(`No profile "${name}".`)
    const server = new URL(input.server.trim()).origin
    const next = input.name.trim()
    const clear: Array<keyof Profile> = []
    if (!input.short.trim()) clear.push('short')
    if (!input.description.trim()) clear.push('description', 'note')
    if (input.authMode === 'auto') clear.push('authMode')
    editProfile(name, { server, short: input.short.trim() || undefined, description: input.description.trim() || undefined, authMode: input.authMode === 'auto' ? undefined : input.authMode }, { rename: next !== name ? next : undefined, clear })
    const secrets = this.options.secrets?.()
    if (secrets && (next !== name || server !== before.server)) {
      const old = { name, server: before.server }
      const login = await readLogin(secrets, old).catch(() => undefined)
      await deleteLogin(secrets, old).catch(() => false)
      if (login && server === before.server) await writeLogin(secrets, { name: next, server }, login)
      this.logins.delete(name)
    }
    if (this.options.current === name) this.options.current = next
    this.reload()
    return next
  }

  /** Removes a profile and its stored sign-in; the profile in use cannot be removed. */
  async remove(name: string): Promise<void> {
    if (name === this.options.current) throw new Error(`"${name}" is in use; switch to another server first`)
    const p = readConfig().profiles[name]
    if (!p) return
    const secrets = this.options.secrets?.()
    if (secrets) await deleteLogin(secrets, { name, server: p.server }).catch(() => false)
    removeProfile(name)
    this.logins.delete(name)
    this.reload()
  }

  setDefault(name: string): void {
    setDefaultProfile(name)
    this.reload()
  }

  /** The form's starting values for a profile (or empty for a new one). */
  inputOf(name?: string): ProfileInput {
    const p = name ? readConfig().profiles[name] : undefined
    return { name: name ?? '', short: p?.short ?? '', description: p ? descriptionOf(p) : '', server: p?.server ?? '', authMode: p?.authMode ?? 'auto' }
  }
}
