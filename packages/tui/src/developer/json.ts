/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The developer view's JSON and code renderer: values pretty-printed into lines of tinted segments,
 * then fitted to a width by cutting (the pane: one source line is one screen line, never split or
 * repeated) or by soft-wrapping (the value viewer: every character kept, in order). Pure; the
 * screens map tones to theme colours.
 */

export type Tone = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'plain'

export interface Seg {
  text: string
  tone: Tone
}

export type SegLine = Seg[]

/** The text of a line. */
export function lineText(line: SegLine): string {
  return line.map((s) => s.text).join('')
}

/** Pretty-prints a value as JSON (two-space indent) into lines of tinted segments. */
export function jsonSegLines(value: unknown, indent = 2): SegLine[] {
  const lines: SegLine[] = []
  let current: SegLine = []
  const emit = (text: string, tone: Tone) => { if (text) current.push({ text, tone }) }
  const newline = (depth: number) => {
    lines.push(current)
    current = depth ? [{ text: ' '.repeat(depth * indent), tone: 'plain' }] : []
  }
  const scalar = (v: unknown) => {
    if (typeof v === 'string') emit(JSON.stringify(v), 'string')
    else if (typeof v === 'number' || typeof v === 'bigint') emit(Number.isFinite(Number(v)) ? String(v) : 'null', Number.isFinite(Number(v)) ? 'number' : 'literal')
    else if (typeof v === 'boolean' || v === null) emit(String(v), 'literal')
    else emit('null', 'literal')
  }
  const walk = (v: unknown, depth: number) => {
    if (Array.isArray(v)) {
      if (!v.length) return emit('[]', 'punct')
      emit('[', 'punct')
      v.forEach((item, i) => {
        newline(depth + 1)
        walk(item === undefined || typeof item === 'function' ? null : item, depth + 1)
        if (i < v.length - 1) emit(',', 'punct')
      })
      newline(depth)
      return emit(']', 'punct')
    }
    if (v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined && typeof x !== 'function')
      if (!entries.length) return emit('{}', 'punct')
      emit('{', 'punct')
      entries.forEach(([k, x], i) => {
        newline(depth + 1)
        emit(JSON.stringify(k), 'key')
        emit(': ', 'punct')
        walk(x, depth + 1)
        if (i < entries.length - 1) emit(',', 'punct')
      })
      newline(depth)
      return emit('}', 'punct')
    }
    scalar(v)
  }
  walk(value, 0)
  lines.push(current)
  return lines
}

/** Plain text (code, logs) as lines, tabs as two spaces. */
export function textSegLines(text: string): SegLine[] {
  return text.replace(/\r\n?/g, '\n').split('\n').map((l) => (l ? [{ text: l.replace(/\t/g, '  '), tone: 'plain' as const }] : []))
}

/**
 * Code as lines: JSON (by language, or when it parses as an object or array) pretty-printed and
 * tinted, anything else as plain text. Returns the parsed value when it was JSON.
 */
export function codeSegLines(code: string, language?: string): { lines: SegLine[]; json?: unknown } {
  const looksJson = language?.toLowerCase() === 'json' || /^\s*[[{]/.test(code)
  if (looksJson) {
    try {
      const json = JSON.parse(code) as unknown
      return { lines: jsonSegLines(json), json }
    } catch {
      // not JSON after all: shown as written
    }
  }
  return { lines: textSegLines(code) }
}

/** Cuts a line to a width: when it was longer, the last cell is the ellipsis. */
export function clipLine(line: SegLine, width: number, ellipsis = '…'): SegLine {
  if (width <= 0) return []
  const total = line.reduce((a, s) => a + s.text.length, 0)
  if (total <= width) return line
  const room = width - ellipsis.length
  const out: SegLine = []
  let used = 0
  for (const s of line) {
    if (used >= room) break
    const take = s.text.slice(0, room - used)
    out.push({ text: take, tone: s.tone })
    used += take.length
  }
  out.push({ text: ellipsis, tone: 'punct' })
  return out
}

/**
 * Soft-wraps a line to a width: consecutive pieces of at most `width` cells whose texts, joined,
 * are exactly the original line (nothing dropped, nothing repeated).
 */
export function wrapLine(line: SegLine, width: number): SegLine[] {
  const w = Math.max(1, width)
  const out: SegLine[] = []
  let current: SegLine = []
  let used = 0
  for (const s of line) {
    let rest = s.text
    while (rest) {
      if (used === w) {
        out.push(current)
        current = []
        used = 0
      }
      const take = rest.slice(0, w - used)
      current.push({ text: take, tone: s.tone })
      used += take.length
      rest = rest.slice(take.length)
    }
  }
  out.push(current)
  return out
}

/**
 * Word-wraps prose to a width without losing characters: words move to the next line, a word longer
 * than the width is broken across lines.
 */
export function wrapText(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  for (const para of text.replace(/\r\n?/g, '\n').split('\n')) {
    let line = ''
    for (const raw of para.split(/[ \t]+/)) {
      if (!raw) continue
      let word = raw
      if (line && line.length + 1 + word.length <= w) {
        line += ' ' + word
        continue
      }
      if (line) out.push(line)
      line = ''
      while (word.length > w) {
        out.push(word.slice(0, w))
        word = word.slice(w)
      }
      line = word
    }
    out.push(line)
  }
  return out
}
