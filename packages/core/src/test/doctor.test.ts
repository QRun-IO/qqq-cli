/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CONF_MARK_BEGIN, appendTmuxConf, applyLiveFix, checkEnvironment, detectTerminal, parseRootBindings, readDoctorState, startupFindings, writeDoctorState } from '../env/doctor.js'

const LIST_KEYS = [
  'bind-key  -T root F12                       set-option prefix None',
  'bind-key  -T root NPage                     if-shell -F "#{pane_in_mode}" "send-keys PageDown" \'\'',
  'bind-key  -T root PPage                     if-shell -F "#{pane_in_mode}" "send-keys PageUp" "copy-mode -eu"',
  'bind-key  -T root Home                      if-shell -F "#{alternate_on}" "send-keys Home" "copy-mode"',
  'bind-key  -T root MouseDown1Pane            select-pane -t = \; send-keys -M',
].join('\n')

function fakeTmux(calls: string[][], overrides = 'xterm-256color:Tc') {
  return (args: string[]) => {
    calls.push(args)
    if (args[0] === 'list-keys') return LIST_KEYS
    if (args.join(' ') === 'show -gv alternate-screen') return 'on\n'
    if (args.join(' ') === 'show -gv terminal-overrides') return overrides
    return ''
  }
}

test('root bindings that take PgUp/PgDn are found; ones that pass to full-screen programs are not', () => {
  assert.deepEqual(parseRootBindings(LIST_KEYS).map((b) => b.key), ['F12', 'NPage', 'PPage', 'Home', 'MouseDown1Pane'])
  const calls: string[][] = []
  const report = checkEnvironment({ env: { TMUX: '/tmp/tmux-1/default,1,0', TERM: 'tmux-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }, columns: 120, rows: 40, tmux: fakeTmux(calls) })
  const keys = report.findings.filter((f) => f.id.startsWith('tmux-key-')).map((f) => f.id)
  assert.deepEqual(keys, ['tmux-key-NPage', 'tmux-key-PPage'])
  const ppage = report.findings.find((f) => f.id === 'tmux-key-PPage')!
  assert.deepEqual(ppage.live, [['bind-key', '-n', 'PPage', 'if-shell', '-F', '#{alternate_on}', 'send-keys PPage', 'if-shell -F "#{pane_in_mode}" "send-keys PageUp" "copy-mode -eu"']])
  assert.equal(ppage.permanent, 'bind-key -n PPage if-shell -F "#{alternate_on}" "send-keys PPage" { if-shell -F "#{pane_in_mode}" "send-keys PageUp" "copy-mode -eu" }')
  assert.ok(!report.findings.some((f) => f.id === 'tmux-truecolor'))
  applyLiveFix(ppage, fakeTmux(calls))
  assert.deepEqual(calls.at(-1), ppage.live![0])
})

test('the permanent fix is appended once in a marked block; choices are remembered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-doc-'))
  try {
    const conf = join(dir, 'tmux.conf')
    writeFileSync(conf, 'set -g mouse on')
    const report = checkEnvironment({ env: { TMUX: 'x', TERM: 'xterm', COLORTERM: '', LANG: 'C' }, columns: 70, rows: 20, tmux: fakeTmux([], '') })
    for (const id of ['tmux-term', 'tmux-truecolor', 'truecolor', 'unicode', 'size']) assert.ok(report.findings.some((f) => f.id === id), id)
    appendTmuxConf(report.findings, conf)
    appendTmuxConf(report.findings, conf)
    const text = readFileSync(conf, 'utf8')
    assert.equal(text.split(CONF_MARK_BEGIN).length, 2)
    assert.ok(text.startsWith('set -g mouse on\n'))
    const env = { QQQ_CONFIG_DIR: dir }
    writeDoctorState({ dontAsk: ['tmux-key-PPage'] }, env)
    assert.deepEqual(readDoctorState(env).dontAsk, ['tmux-key-PPage'])
    assert.ok(!startupFindings(report, readDoctorState(env)).some((f) => f.id === 'tmux-key-PPage'))
    assert.equal(detectTerminal({ TERM_PROGRAM: 'Apple_Terminal' }), 'Terminal.app')
    assert.equal(detectTerminal({ WT_SESSION: '1' }), 'Windows Terminal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
