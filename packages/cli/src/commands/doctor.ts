/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * `qqq doctor`: is this client ready to use? The connectivity side (profile, server reachable, UI
 * API version within the supported range, authentication type, sign-in accepted, extensions,
 * keyring, metadata cache age, and with --conformance the read-only conformance checks) and the
 * terminal side (the kernel's checkTerminalEnvironment: tmux key bindings, alternate screen,
 * colour, unicode, size). Exit 0 when every check passes, 1 with the failing ones listed.
 */

import type { Command } from 'commander'
import { UI_API_VERSION, getAuthenticationMetaData } from '@qrun-io/qqq-ui-api-client'
import * as core from '@qrun-io/qqq-core'
import { callOperation, readCachedMetaData, type ServerVersion } from '@qrun-io/qqq-core'
import { EXIT, type Context } from '../context.js'
import { CLI_VERSION, authenticatedFetch, currentToken, getLogin, secretStoreKind } from '../session.js'
import type { Json } from './shared.js'

/** The oldest UI API this client works with (README: UI API 1.6.0 or later). */
export const MIN_UI_API = '1.6.0'

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip'
export interface DoctorCheck { area: string; check: string; status: CheckStatus; detail: string }

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

/** Whether a server's UI API version is one this client supports. */
export function versionSupport(apiVersion: string | undefined, supportedMajors: number[] | undefined): { status: CheckStatus; detail: string } {
  if (!apiVersion) return { status: 'warn', detail: 'the server does not say its UI API version' }
  const clientMajor = Number.parseInt(UI_API_VERSION, 10)
  if (supportedMajors?.length && !supportedMajors.includes(clientMajor)) return { status: 'fail', detail: `${apiVersion}; the server supports major ${supportedMajors.join(', ')}, this client speaks ${clientMajor}` }
  if (compareVersions(apiVersion, MIN_UI_API) < 0) return { status: 'fail', detail: `${apiVersion}; this client needs ${MIN_UI_API} or later` }
  if (compareVersions(apiVersion, UI_API_VERSION) > 0) return { status: 'warn', detail: `${apiVersion}; newer than this client (${UI_API_VERSION}): new operations need a newer qqq` }
  return { status: 'ok', detail: `${apiVersion} (this client: ${UI_API_VERSION}, supports ${MIN_UI_API} to ${UI_API_VERSION})` }
}

/** The connectivity checks, in order; a check that cannot run says why. */
export async function connectivityChecks(c: Context, options: { conformance?: boolean } = {}): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = []
  const add = (check: string, status: CheckStatus, detail: string) => out.push({ area: 'server', check, status, detail })
  let t
  try {
    t = c.target
  } catch (error) {
    add('profile', 'fail', error instanceof Error ? error.message : String(error))
    return out
  }
  add('profile', 'ok', `${t.name} (${t.source}) -> ${t.server}`)
  let version: ServerVersion
  try {
    version = (await callOperation(t.server, 'getVersion', {}, fetch)).data as ServerVersion
    add('reachable', 'ok', `${t.server}/qqq/v1/version answered`)
  } catch (error) {
    add('reachable', 'fail', error instanceof Error ? `${error.message}${(error as { cause?: { message?: string } }).cause?.message ? ` (${(error as { cause?: { message?: string } }).cause!.message})` : ''}` : String(error))
    return out
  }
  const support = versionSupport(version.apiVersion, version.supportedMajorVersions)
  add('UI API version', support.status, support.detail)
  try {
    const auth = await getAuthenticationMetaData(t.server)
    add('authentication', 'ok', String(auth.type ?? 'unknown'))
  } catch (error) {
    add('authentication', 'warn', `could not read the authentication metadata (${error instanceof Error ? error.message : String(error)})`)
  }
  const login = await getLogin(t).catch((error: unknown) => error as Error)
  const token = process.env.QQQ_TOKEN ? 'QQQ_TOKEN' : login instanceof Error ? undefined : login ? (login.kind === 'session' ? `${login.authType.toLowerCase()} session` : 'oauth2 sign-in') : undefined
  if (login instanceof Error) add('signed in', 'fail', login.message)
  else if (!token) add('signed in', 'fail', `no sign-in for profile "${t.name}"; run qqq login --profile ${t.name}`)
  else {
    try {
      await callOperation(t.server, 'getMetaData', {}, authenticatedFetch(t))
      add('signed in', 'ok', `${token}, accepted by the server`)
    } catch (error) {
      add('signed in', 'fail', `${token}, refused: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    const registry = await c.extensions({ refresh: true })
    const below = registry.installed.filter((e) => e.known && !e.meetsMinimum)
    add('extensions', below.length ? 'warn' : 'ok', `${registry.describe()}${below.length ? `; below this client's minimum: ${below.map((e) => e.name).join(', ')}` : ''}`)
  } catch (error) {
    add('extensions', 'warn', error instanceof Error ? error.message : String(error))
  }
  out.push({ area: 'local', check: 'keyring', status: 'ok', detail: secretStoreKind() })
  const cached = readCachedMetaData(t.server)
  out.push({ area: 'local', check: 'metadata cache', status: 'ok', detail: cached ? `fetched ${Math.round((Date.now() - Date.parse(cached.fetchedAt)) / 1000)} s ago (qqq cache refresh rereads it)` : 'empty (filled by the next command)' })
  if (options.conformance) {
    const name = '@qrun-io/qqq-ui-api-conformance'
    let suite: { runConformance: (o: { baseUrl: string; token?: string }) => Promise<Array<{ name: string; ok: boolean; skipped?: boolean; detail?: string }>> } | undefined
    try {
      suite = await import(name) as typeof suite
    } catch {
      out.push({ area: 'conformance', check: 'suite', status: 'fail', detail: `${name} is not installed (npm install -g ${name})` })
    }
    if (suite) {
      for (const r of await suite.runConformance({ baseUrl: t.server, token: await currentToken(t).catch(() => undefined) })) {
        out.push({ area: 'conformance', check: r.name, status: r.skipped ? 'skip' : r.ok ? 'ok' : 'fail', detail: r.detail ?? '' })
      }
    }
  }
  return out
}

/** The terminal report of the kernel, when the kernel has it (the TUI branch adds it). */
interface TerminalReport { checks: Array<{ check: string; status: CheckStatus; detail: string; fix?: unknown }>; applyFixes?: (options: { permanent?: boolean }) => Promise<string[]> }

async function terminalChecks(): Promise<{ checks: DoctorCheck[]; report?: TerminalReport }> {
  // TODO(merge with the TUI branch): checkTerminalEnvironment() is the kernel's terminal check
  // (tmux root bindings that take PageUp/PageDown/F-keys, alternate screen, truecolor, unicode,
  // size, terminal notes, tmux fixes). Looked up by name so this compiles before it lands.
  const check = (core as Record<string, unknown>).checkTerminalEnvironment as undefined | (() => Promise<TerminalReport> | TerminalReport)
  if (!check) return { checks: [{ area: 'terminal', check: 'environment', status: 'skip', detail: 'this build has no terminal checks yet (the kernel\'s checkTerminalEnvironment)' }] }
  const report = await check()
  return { report, checks: report.checks.map((x) => ({ area: 'terminal', check: x.check, status: x.status, detail: x.detail })) }
}

export function registerDoctor(program: Command, ctx: () => Context): void {
  program.command('doctor')
    .description('Check this client: server reachable, UI API version, sign-in, extensions, keyring, cache, and the terminal (tmux keys, colour, size). Exit 1 lists what is wrong.')
    .option('--conformance', 'also run the read-only conformance checks against the server')
    .option('--fix', 'apply the terminal fixes the report offers (asks first)')
    .action(async (options: { conformance?: boolean; fix?: boolean }) => {
      const c = ctx()
      const terminal = await terminalChecks()
      const checks = [...await connectivityChecks(c, options), ...terminal.checks]
      const failed = checks.filter((x) => x.status === 'fail')
      c.print({
        data: { client: CLI_VERSION, uiApi: UI_API_VERSION, ok: failed.length === 0, checks },
        rows: checks as unknown as Json[],
        columns: ['area', 'check', 'status', 'detail'],
        footer: failed.length ? `(${failed.length} of ${checks.length} checks failed: ${failed.map((x) => x.check).join(', ')})` : `(all ${checks.length} checks passed${checks.some((x) => x.status === 'warn') ? '; see the warnings' : ''})`,
      })
      if (options.fix) {
        if (!terminal.report?.applyFixes) c.note('No terminal fixes to apply.')
        else if (await c.confirm('Apply the terminal fixes now (this tmux session)?')) {
          for (const line of await terminal.report.applyFixes({})) c.note(line)
          if (await c.confirm('Make them permanent (append to ~/.tmux.conf)?')) for (const line of await terminal.report.applyFixes({ permanent: true })) c.note(line)
        }
      }
      if (failed.length) process.exitCode = EXIT.error
    })
}
