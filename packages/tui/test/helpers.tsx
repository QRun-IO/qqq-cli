/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act } from 'react'
import { testRender } from '@opentui/react/test-utils'
import type { TestRendererSetup } from '@opentui/core/testing'
import { upsertProfile, type SecretStore } from '@qrun-io/qqq-core'
import { App } from '../src/app'
import { boot, parseArgs } from '../src/boot'
import type { AppStore } from '../src/store'
import { fakeFetch, type FakeAuth, type FakeLog } from './fake-server'

// async loads repaint outside act(); the frames are awaited explicitly, so the warning is noise here
const consoleError = console.error
console.error = (...args: unknown[]) => {
  if (typeof args[0] === 'string' && args[0].includes('not wrapped in act')) return
  consoleError(...args)
}

/** Isolated config, cache and state directories for one test file. */
export function isolate(): void {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-tui-test-'))
  process.env.QQQ_CONFIG_DIR = join(dir, 'config')
  process.env.QQQ_CACHE_DIR = join(dir, 'cache')
  process.env.QQQ_STATE_DIR = join(dir, 'state')
  delete process.env.QQQ_TOKEN
  delete process.env.QQQ_PROFILE
  delete process.env.QQQ_SERVER
  upsertProfile('fake', { server: 'http://fake.test' })
}

/** A secret store holding a session sign-in for every account. */
export function sessionSecrets(): SecretStore {
  const login = JSON.stringify({ kind: 'session', authType: 'MOCK', sessionUUID: 'test-session', user: { name: 'Tester', email: 'tester@fake.test' }, createdAt: new Date().toISOString() })
  return { kind: 'memory', get: async () => login, set: async () => undefined, delete: async () => true }
}

export interface Harness {
  setup: TestRendererSetup
  store: AppStore
  log: FakeLog
  frame(): string
}

/** Renders the whole TUI against the fake server and waits for the home screen. */
export async function startTui(width = 120, height = 36, options: { metaData?: unknown; auth?: FakeAuth; secrets?: () => SecretStore; until?: 'home' | 'signin' } = {}): Promise<Harness> {
  const log: FakeLog = { requests: [] }
  // the sign-in tests drive the sign-in screen (--no-splash); the rest go through the splash
  const store = boot({ args: parseArgs(['--profile', 'fake', ...(options.until === 'signin' ? ['--no-splash'] : [])]), quit: () => undefined, build: 'test', secrets: options.secrets ?? sessionSecrets, fetch: fakeFetch(log, options.metaData, options.auth) })
  const setup = await testRender(<App store={store} />, { width, height })
  const h: Harness = { setup, store, log, frame: () => setup.captureCharFrame() }
  store.captureScreen = () => setup.captureCharFrame()
  if ((options.until ?? 'home') === 'home') await waitFor(h, (f) => f.includes('Apps') && h.store.screen?.kind === 'home')
  else await waitFor(h, () => h.store.screen?.kind === 'signin')
  return h
}

/** A secret store that starts empty and keeps what is written (sign-in tests). */
export function memorySecrets(): () => SecretStore {
  const m = new Map<string, string>()
  const store: SecretStore = { kind: 'memory', get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v) }, delete: async (k) => m.delete(k) }
  return () => store
}

/** Fires input inside act(), lets data events settle, paints one frame. */
export async function press(h: Harness, fire: () => void | Promise<void>, settleMs = 30): Promise<string> {
  await act(async () => {
    await fire()
    await new Promise((resolve) => setTimeout(resolve, settleMs))
  })
  await h.setup.renderOnce()
  return h.frame()
}

/** Waits until the frame satisfies a predicate (async loads), or fails with the last frame. */
export async function waitFor(h: Harness, ok: (frame: string) => boolean, timeoutMs = 3000): Promise<string> {
  const end = Date.now() + timeoutMs
  let frame = ''
  while (Date.now() < end) {
    frame = await press(h, () => undefined, 25)
    if (ok(frame)) return frame
  }
  throw new Error(`timed out; last frame:\n${frame}`)
}

/** Types a `:` command and runs it. */
export async function command(h: Harness, line: string): Promise<void> {
  await press(h, () => h.setup.mockInput.typeText(':'))
  await press(h, () => h.setup.mockInput.typeText(line))
  await press(h, () => h.setup.mockInput.pressEnter())
}
