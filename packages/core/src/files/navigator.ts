/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * What a file chooser needs, without any terminal code: directory listings (directories first,
 * sizes and dates), path expansion and Tab completion, and the local file preferences (default
 * download and upload directories, the last ones used, ask or save silently) kept in the config
 * file's ui section.
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { readConfig, writeConfig } from '../session/profiles.js'

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  modified: Date
  hidden: boolean
}

/** `~` and `~/x` become the home directory; relative paths resolve against `cwd`. */
export function expandPath(text: string, cwd: string = process.cwd()): string {
  const t = text.trim()
  if (t === '~') return homedir()
  if (t.startsWith(`~${sep}`) || t.startsWith('~/')) return join(homedir(), t.slice(2))
  return isAbsolute(t) ? resolve(t) : resolve(cwd, t)
}

/** The entries of a directory: directories first, then files, each by name (case-insensitive). Unreadable entries are skipped. */
export function listDirectory(dir: string, options: { hidden?: boolean } = {}): DirEntry[] {
  const out: DirEntry[] = []
  for (const name of readdirSync(dir)) {
    const hidden = name.startsWith('.')
    if (hidden && !options.hidden) continue
    const path = join(dir, name)
    try {
      const st = statSync(path)
      out.push({ name, path, isDir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, modified: st.mtime, hidden })
    } catch {
      // a broken link or no permission
    }
  }
  return out.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

/** A size for people: 512 B, 1.4 KB, 3.2 MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`
}

/**
 * Tab completion of a typed path: the longest common extension of the matching entries, and the
 * candidates. A directory that is the only match gets a trailing separator.
 */
export function completePath(text: string, options: { cwd?: string; hidden?: boolean; directoriesOnly?: boolean } = {}): { text: string; candidates: string[] } {
  const cwd = options.cwd ?? process.cwd()
  const typedDir = text.endsWith('/') || text.endsWith(sep) ? text : text.includes('/') || text.includes(sep) ? text.slice(0, Math.max(text.lastIndexOf('/'), text.lastIndexOf(sep)) + 1) : ''
  const prefix = text.slice(typedDir.length)
  const dir = typedDir ? expandPath(typedDir, cwd) : cwd
  let entries: DirEntry[] = []
  try {
    entries = listDirectory(dir, { hidden: options.hidden || prefix.startsWith('.') })
  } catch {
    return { text, candidates: [] }
  }
  const matches = entries.filter((e) => e.name.startsWith(prefix) && (!options.directoriesOnly || e.isDir))
  if (!matches.length) return { text, candidates: [] }
  let common = matches[0]!.name
  for (const m of matches) while (!m.name.startsWith(common)) common = common.slice(0, -1)
  const only = matches.length === 1 ? matches[0]! : undefined
  return { text: typedDir + common + (only?.isDir ? '/' : ''), candidates: matches.map((m) => m.name + (m.isDir ? '/' : '')) }
}

/** Creates a folder (and its parents); returns its path. */
export function createFolder(parent: string, name: string): string {
  if (!name.trim() || /[/\\]/.test(name)) throw new Error('A folder name cannot be empty or contain a slash')
  const path = join(parent, name.trim())
  mkdirSync(path, { recursive: true })
  return path
}

/** Local file preferences of the clients. */
export interface FilePreferences {
  /** Where downloads, exports and reports are saved by default. */
  downloadDir?: string
  /** Where the upload chooser starts by default. */
  uploadDir?: string
  /** `ask` (a save dialog each time) or `silent` (straight to the download directory). */
  downloadMode?: 'ask' | 'silent'
  lastDownloadDir?: string
  lastUploadDir?: string
}

export function readFilePreferences(env: NodeJS.ProcessEnv = process.env): FilePreferences {
  return { ...(((readConfig(env).ui as { files?: FilePreferences } | undefined)?.files) ?? {}) }
}

export function writeFilePreferences(patch: Partial<FilePreferences>, env: NodeJS.ProcessEnv = process.env): FilePreferences {
  const config = readConfig(env)
  const files = { ...(((config.ui as { files?: FilePreferences } | undefined)?.files) ?? {}), ...patch }
  for (const k of Object.keys(files) as Array<keyof FilePreferences>) if (files[k] === undefined || files[k] === '') delete files[k]
  config.ui = { ...config.ui, files } as never
  writeConfig(config, env)
  return files
}

function firstExisting(...dirs: Array<string | undefined>): string {
  for (const d of dirs) if (d && existsSync(d)) return d
  return process.cwd()
}

/** The directory a save dialog starts in: last used, the default download directory, ~/Downloads, the current directory. */
export function startDirForSave(prefs: FilePreferences = readFilePreferences()): string {
  return firstExisting(prefs.lastDownloadDir, prefs.downloadDir, join(homedir(), 'Downloads'))
}

/** The directory an upload chooser starts in: last used, the default upload directory, the current directory. */
export function startDirForUpload(prefs: FilePreferences = readFilePreferences()): string {
  return firstExisting(prefs.lastUploadDir, prefs.uploadDir, process.cwd())
}

/** Where a download goes without asking: the default download directory, else the current directory. */
export function silentDownloadPath(fileName: string, prefs: FilePreferences = readFilePreferences()): string {
  return join(firstExisting(prefs.downloadDir), fileName)
}

export { dirname }
