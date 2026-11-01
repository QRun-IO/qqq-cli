/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { alternativeNames, readFilePreferences, safeFileName, silentDownloadPath, startDirForSave, startDirForUpload } from '@qrun-io/qqq-core'
import type { AppStore } from '../store'
import { FileDialog } from './files'

/**
 * Where to save a download: with "save silently" set, straight to the default download directory
 * (a free name, never overwriting); otherwise the save dialog.
 */
export function saveFile(store: AppStore, title: string, suggested: string, write: (path: string) => void): void {
  const prefs = readFilePreferences()
  if (prefs.downloadMode === 'silent') {
    const base = silentDownloadPath(safeFileName(suggested), prefs)
    let path = base
    // taken: the date and time go before the extension, then -1, -2, ...
    for (const candidate of alternativeNames(basename(base))) {
      path = join(dirname(base), candidate)
      if (!existsSync(path)) break
    }
    write(path)
    return
  }
  store.open(new FileDialog(store, { mode: 'save', title, startDir: startDirForSave(prefs), fileName: suggested, onPick: write }))
}

/** Chooses an existing file to upload. */
export function openFile(store: AppStore, title: string, pick: (path: string) => void): void {
  store.open(new FileDialog(store, { mode: 'open', title, startDir: startDirForUpload(), onPick: pick }))
}

/** Chooses a folder. */
export function chooseFolder(store: AppStore, title: string, start: string, pick: (path: string) => void): void {
  store.open(new FileDialog(store, { mode: 'folder', title, startDir: start, onPick: pick }))
}
