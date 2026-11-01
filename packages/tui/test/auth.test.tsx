/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { afterEach, beforeAll, expect, test } from 'bun:test'
import type { FakeAuth } from './fake-server'
import { command, isolate, memorySecrets, press, startTui, waitFor, type Harness } from './helpers'

let h: Harness | undefined
beforeAll(() => isolate())
afterEach(() => {
  h?.store.dispose()
  h?.setup.renderer.destroy()
  h = undefined
})

const type = (t: string) => press(h!, () => h!.setup.mockInput.typeText(t))
const enter = () => press(h!, () => h!.setup.mockInput.pressEnter())
const key = (k: string) => press(h!, () => h!.setup.mockInput.pressKey(k))

test('TABLE_BASED sign-in: username and password under the app name; a refusal stores nothing; the password is never kept', async () => {
  const auth: FakeAuth = { type: 'TABLE_BASED', users: { pat: 'secret' }, sessions: new Set() }
  const secrets = memorySecrets()
  h = await startTui(120, 36, { auth, secrets, until: 'signin' })
  // the default profile signs in at once: the username is asked first
  await waitFor(h, (x) => x.includes('Sign in to Fake Corp'))
  await type('pat')
  await enter()
  await waitFor(h, (x) => x.includes('Password for pat'))
  await type('wrong')
  await enter()
  await waitFor(h, (x) => x.includes('The username or password was not accepted'))
  expect(auth.sessions.size).toBe(0)
  expect(await secrets().get('fake@http://fake.test')).toBeUndefined()
  await enter()
  await waitFor(h, (x) => x.includes('Sign in to Fake Corp'))
  await type('pat')
  await enter()
  await type('secret')
  await enter()
  await waitFor(h, (x) => x.includes('Apps') && h!.store.screen?.kind === 'home')
  const session = h.log.requests.filter((r) => r.path === '/manageSession')
  expect(session.length).toBe(2)
  expect(session[1]!.auth).toBe(`Basic ${Buffer.from('pat:secret').toString('base64')}`)
  // data requests carry the session cookie, never the password
  const later = h.log.requests.filter((r) => r.path === '/metaData')
  expect(later.at(-1)!.cookie).toBe('sessionUUID=s-1')
  expect(later.every((r) => !r.auth)).toBe(true)
})

test('session expiry mid-use: a 401 opens sign-in on top; afterwards the same screen is back and refreshed', async () => {
  const auth: FakeAuth = { type: 'TABLE_BASED', users: { pat: 'secret' }, sessions: new Set() }
  h = await startTui(120, 36, { auth })
  await command(h, 'table query person')
  await waitFor(h, (x) => x.includes('records'))
  auth.expire = true
  await key('r')
  await waitFor(h, (x) => x.includes('Sign in to Fake Corp'))
  expect(h.store.routes.map((r) => r.kind)).toEqual(['home', 'table', 'signin'])
  await type('pat')
  await enter()
  await type('secret')
  await enter()
  const f = await waitFor(h, (x) => x.includes('signed in again') && h!.store.screen?.kind === 'table')
  expect(f).toContain('records')
})

test('sign out ends the server session (POST /logout with the cookie) and returns to sign-in', async () => {
  const auth: FakeAuth = { type: 'MOCK', sessions: new Set(['test-session']) }
  h = await startTui(120, 36, { auth })
  await command(h, 'signout')
  await waitFor(h, (x) => x.includes('Sign out of'))
  await key('y')
  await waitFor(h, () => h!.store.screen?.kind === 'signin')
  const logout = h.log.requests.find((r) => r.path === '/logout')!
  expect(logout.cookie).toBe('sessionUUID=test-session')
  expect(auth.sessions.size).toBe(0)
})
