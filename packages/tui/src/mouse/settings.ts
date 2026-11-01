/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The Mouse setting: saved in the config file's ui section (on unless switched off), like the theme. */

import { readConfig, writeConfig } from '@qrun-io/qqq-core'
import type { AppStore } from '../store'

export function readMouse(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return readConfig(env).ui?.mouse !== false
  } catch {
    return true
  }
}

export function writeMouse(on: boolean, env: NodeJS.ProcessEnv = process.env): void {
  const config = readConfig(env)
  config.ui = { ...config.ui, mouse: on }
  writeConfig(config, env)
}

/** How to select text while the mouse is on, for help and for dialogs that show copyable text. */
export const SELECT_HINT = 'Shift+drag selects text (Option/Alt+drag in some terminals)'

/** Settings > Mouse and `:mouse on|off`: switches tracking now and saves it for next time. */
export function setMouseSetting(store: AppStore, on: boolean): void {
  store.setMouse(on)
  try {
    writeMouse(on)
  } catch (e) {
    store.error(e)
    return
  }
  store.flash(on ? `mouse on (saved) · ${SELECT_HINT}` : 'mouse off (saved) · the terminal selects text as usual')
}
