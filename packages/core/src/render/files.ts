/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Saving downloaded files. A file name that comes from the server (a record's file name, a
 * Content-Disposition, a process DOWNLOAD_FORM) is untrusted: only its final path component is
 * kept, and names that could escape the working directory or hide characters are refused. A
 * default name never overwrites an existing file; only a path the user named does.
 */

import { writeFileSync } from 'node:fs'

export class UnsafeFileNameError extends Error {}

/** The final path component of a server-supplied name; throws on empty, `.`, `..` or control characters. */
export function safeFileName(name: unknown): string {
  const base = String(name ?? '').replace(/\\/g, '/').split('/').pop() ?? ''
  if (!base.trim() || base === '.' || base === '..' || /[\u0000-\u001f\u007f]/.test(base)) {
    throw new UnsafeFileNameError(`unsafe file name from server: ${JSON.stringify(String(name ?? ''))}`)
  }
  return base
}

/**
 * Writes a download. `explicit` is true when the user named the path (it may be overwritten);
 * otherwise the file is created exclusively and an existing one is an error.
 */
export function saveDownload(path: string, bytes: Uint8Array, options: { explicit: boolean }): void {
  try {
    writeFileSync(path, bytes, { flag: options.explicit ? 'w' : 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new UnsafeFileNameError(`${path} already exists; name the output file to overwrite it`)
    throw error
  }
}
