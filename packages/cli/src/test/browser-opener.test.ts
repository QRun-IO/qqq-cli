/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */


import assert from 'node:assert/strict'
import { test } from 'node:test'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { EventEmitter } from 'node:events'
import { openInBrowser } from '../browser-login.js'

test('Windows browser opener preserves OAuth query parameters without shell interpretation', { skip: process.platform !== 'win32' }, () => {
  const original = childProcess.spawn
  const url = 'https://example.invalid/authorize?response_type=code&client_id=fixture-native&state=fake%20state&redirect_uri=http%3A%2F%2F127.0.0.1%3A4567%2Fcallback'
  let captured: unknown[] = []
  childProcess.spawn = ((...args: unknown[]) => {
    captured = args
    return Object.assign(new EventEmitter(), { unref() {} })
  }) as typeof childProcess.spawn
  syncBuiltinESMExports()
  try { openInBrowser(url) } finally { childProcess.spawn = original; syncBuiltinESMExports() }
  const [command, args, options] = captured as [string, string[], { env: NodeJS.ProcessEnv; windowsHide: boolean }]
  assert.notEqual(command, 'cmd')
  assert.equal(options.env.QQQ_BROWSER_URL, url)
  assert.equal(options.windowsHide, true)
  const script = Buffer.from(args.at(-1)!, 'base64').toString('utf16le')
  const probe = 'function Start-Process { param([string]$FilePath) [Console]::Write($FilePath) }; ' + script
  const result = childProcess.spawnSync(command, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(probe, 'utf16le').toString('base64')], { env: options.env, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, url)
})
