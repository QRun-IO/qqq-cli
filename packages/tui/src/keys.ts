/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The parts of an OpenTUI KeyEvent the TUI reads (tests build these directly). */
export interface Key {
  name: string
  sequence: string
  ctrl?: boolean
  shift?: boolean
  meta?: boolean
}

/** A key that types a character. */
export function isPrintable(key: Key): boolean {
  if (key.ctrl || key.meta) return false
  const s = key.sequence ?? ''
  return s.length >= 1 && !/[\x00-\x1f\x7f]/.test(s) && !s.startsWith('\x1b')
}

/** The character a key types ('' for none). */
export function charOf(key: Key): string {
  return isPrintable(key) ? key.sequence : ''
}

export function isFKey(key: Key, n: number): boolean {
  return key.name === `f${n}`
}
