/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Saving downloaded files. A file name that comes from the server (a record's file name, a
 * Content-Disposition, a process DOWNLOAD_FORM) is untrusted: only its final path component is
 * kept, and names that could escape the directory or hide characters are refused. A default
 * name never overwrites an existing file: the next free `name-1.ext`, `name-2.ext` is taken;
 * only a path the user named (`--out`) is overwritten.
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

/** Candidate names when one exists already: `a.csv`, `a-1.csv`, `a-2.csv`, … */
export function* alternativeNames(name: string): Generator<string> {
  yield name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 1; i < 1000; i++) yield `${stem}-${i}${ext}`
}

/**
 * Writes a download and returns the path written. `explicit` is true when the user named the
 * path: it is written as given (an existing file is replaced). Otherwise the file is created
 * exclusively (flag wx), taking `name-1.ext`, `name-2.ext`, … when the name is taken.
 */
export function saveDownload(path: string, bytes: Uint8Array, options: { explicit: boolean }): string {
  if (options.explicit) {
    writeFileSync(path, bytes)
    return path
  }
  const dir = dirname(path)
  for (const candidate of alternativeNames(basename(path))) {
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
