/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * qqq ui: the terminal UI. Runs in the alternate screen with the mouse off; any crash restores the
 * terminal (renderer.destroy) before the stack trace is printed.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCliRenderer } from '@opentui/core'
import { createRoot } from '@opentui/react'
import { App } from './app'
import { boot, parseArgs } from './boot'
import { runDoctor } from './doctor'

const args = parseArgs(process.argv.slice(2))
if (args.check === 'full') {
  await runDoctor({ full: true })
  process.exit(0)
}
if (!process.stdout.isTTY || process.env.TERM === 'dumb') {
  process.stderr.write('qqq ui needs a terminal with an alternate screen (TERM is dumb or stdout is not a terminal); use the qqq CLI instead.\n')
  process.exit(2)
}
if (args.check === 'startup') {
  const { report } = await runDoctor({ full: false })
  // no UTF-8 locale: plain glyphs rather than boxes of question marks
  if (report.findings.some((f) => f.id === 'unicode') && !args.ascii) args.ascii = true
}

const renderer = await createCliRenderer({
  exitOnCtrlC: true,
  useMouse: args.mouse,
  screenMode: 'alternate-screen',
  openConsoleOnError: false,
  targetFps: 30,
})

let destroyed = false
function restore(): void {
  if (destroyed) return
  destroyed = true
  try {
    renderer.destroy()
  } catch {
    // already gone
  }
}

process.on('uncaughtException', (error) => {
  restore()
  process.stderr.write(`qqq ui crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
renderer.on('destroy', () => {
  destroyed = true
  setTimeout(() => process.exit(0), 10)
})

// QQQ_UI_NO_QUIT=1 (the soak test): quitting from a menu is ignored, so only a crash ends the program
const store = boot({ args, quit: process.env.QQQ_UI_NO_QUIT === '1' ? () => store.flash('quit is off (QQQ_UI_NO_QUIT)') : restore, build: process.env.QQQ_UI_BUILD ?? 'dev', timers: true })
process.on('unhandledRejection', (reason) => store.error(reason))

store.editExternal = async (text: string) => {
  const dir = mkdtempSync(join(tmpdir(), 'qqq-edit-'))
  const file = join(dir, 'value.txt')
  writeFileSync(file, text)
  await renderer.suspend()
  try {
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? (process.platform === 'win32' ? 'notepad' : 'vi')
    spawnSync(editor, [file], { stdio: 'inherit', shell: process.platform === 'win32' })
    return readFileSync(file, 'utf8')
  } finally {
    await renderer.resume()
    rmSync(dir, { recursive: true, force: true })
  }
}

// the system clipboard tool when there is one, else the terminal's OSC 52 (tmux and most terminals)
store.copyText = (text: string) => {
  const tools: Array<[string, string[]]> = process.platform === 'darwin' ? [['pbcopy', []]] : process.platform === 'win32' ? [['clip', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]
  for (const [tool, toolArgs] of tools) {
    if (tool === 'wl-copy' && !process.env.WAYLAND_DISPLAY) continue
    if ((tool === 'xclip' || tool === 'xsel') && !process.env.DISPLAY) continue
    const r = spawnSync(tool, toolArgs, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 2000 })
    if (!r.error && r.status === 0) return tool
  }
  return renderer.isOsc52Supported() && renderer.copyToClipboardOSC52(text) ? 'OSC 52' : undefined
}

createRoot(renderer).render(<App store={store} />)
