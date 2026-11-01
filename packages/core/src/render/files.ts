/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Saving downloaded files. A file name that comes from the server (a record's file name, a
 * Content-Disposition, a process DOWNLOAD_FORM) is untrusted: only its final path component is
 * kept, and names that could escape the directory or hide characters are refused. A default
 * name never overwrites an existing file: the date and time are put before the extension
 * (`name_2026-11-01_102316.ext`), then `-1`, `-2`, … if even that is taken; only a path the user
 * named (`--out`) is overwritten. A name this client chooses (an export) carries the stamp from the start.
 */

import { writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

export class UnsafeFileNameError extends Error {}

/** The final path component of a server-supplied name (either separator); throws on empty, `.`, `..` or control characters. */
export function safeFileName(name: unknown): string {
  const base = String(name ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  if (!base.trim() || base === '.' || base === '..' || /[\u0000-\u001f\u007f]/.test(base)) {
    throw new UnsafeFileNameError(`unsafe file name from server: ${JSON.stringify(String(name ?? ''))}`)
  }
  return base
}

const STAMP_AT_END = /_\d{4}-\d{2}-\d{2}_\d{6}$/

/** `_YYYY-MM-DD_HHmmss` in local time, 24-hour, with no colons (valid on Windows). */
export function fileStamp(now: Date = new Date()): string {
  const p = (n: number, width = 2) => String(n).padStart(width, '0')
  return `_${p(now.getFullYear(), 4)}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
}

/** Puts the stamp before the extension of a whole name (`a.csv` becomes `a_2026-11-01_102316.csv`); a name already stamped is left alone. */
export function stampFileName(name: string, now: Date = new Date()): string {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return STAMP_AT_END.test(stem) ? name : `${stem}${fileStamp(now)}${ext}`
}

/**
 * The default name of a file this client chooses (an export, a report, a captured screen):
 * `<base>_<YYYY-MM-DD>_<HHmmss>.<ext>` in local time. The base is cleaned as `safeFileName` does
 * (last path component, no control characters); a base that already ends in the extension or in a
 * stamp is not stamped twice. An empty `ext` gives a name without an extension.
 */
export function exportFileName(base: string, ext: string, now: Date = new Date()): string {
  const extension = ext.replace(/^\./, '')
  let stem = safeFileName(base)
  if (extension && stem.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) stem = stem.slice(0, -(extension.length + 1))
  if (!STAMP_AT_END.test(stem)) stem += fileStamp(now)
  return extension ? `${stem}.${extension}` : stem
}

/** Candidate names when one exists already: `a.csv`, `a_<stamp>.csv`, `a_<stamp>-1.csv`, … */
export function* alternativeNames(name: string, now: Date = new Date()): Generator<string> {
  yield name
  const stamped = stampFileName(name, now)
  if (stamped !== name) yield stamped
  const dot = stamped.lastIndexOf('.')
  const stem = dot > 0 ? stamped.slice(0, dot) : stamped
  const ext = dot > 0 ? stamped.slice(dot) : ''
  for (let i = 1; i < 1000; i++) yield `${stem}-${i}${ext}`
}

/**
 * Writes a download and returns the path written. `explicit` is true when the user named the
 * path: it is written as given (an existing file is replaced). Otherwise the file is created
 * exclusively (flag wx), taking the stamped name (then `-1`, `-2`, …) when the name is taken.
 */
export function saveDownload(path: string, bytes: Uint8Array, options: { explicit: boolean; now?: Date }): string {
  if (options.explicit) {
    writeFileSync(path, bytes)
    return path
  }
  const dir = dirname(path)
  for (const candidate of alternativeNames(basename(path), options.now)) {
    const target = dir === '.' ? candidate : join(dir, candidate)
    try {
      writeFileSync(target, bytes, { flag: 'wx' })
      return target
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  throw new UnsafeFileNameError(`no free file name for ${basename(path)} in ${dir}`)
}
