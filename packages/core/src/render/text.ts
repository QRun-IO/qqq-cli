/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Small text helpers that run in linear time on any input. Server metadata and user input reach
 * them, so they use plain scanning rather than regular expressions that can backtrack (an
 * unanchored `/x+$/` or `/\$\{[^}]+\}/g` is quadratic on a long run of `x` or `${`).
 */

/** The text without any leading `ch` characters. */
export function trimStartChar(text: string, ch: string): string {
  let start = 0
  while (start < text.length && text[start] === ch) start++
  return text.slice(start)
}

/** The text without any trailing `ch` characters. */
export function trimEndChar(text: string, ch: string): string {
  let end = text.length
  while (end > 0 && text[end - 1] === ch) end--
  return text.slice(0, end)
}

/** The text without leading or trailing `ch` characters (`/a/b//` -> `a/b` for `/`). */
export function trimChar(text: string, ch: string): string {
  return trimEndChar(trimStartChar(text, ch), ch)
}

/**
 * Replaces each `${prefix}name}` reference (a non-empty name up to the first `}`) with what
 * `replace` returns for the name; the same matches as `/\$\{prefix([^}]+)\}/g`, in linear time.
 */
export function replaceReferences(text: string, prefix: string, replace: (name: string, reference: string) => string): string {
  const open = `\${${prefix}`
  let out = ''
  let from = 0
  let at = text.indexOf(open)
  while (at >= 0) {
    const close = text.indexOf('}', at + open.length)
    if (close < 0) break // no closing brace anywhere after: no further reference can match
    if (close === at + open.length) {
      at = text.indexOf(open, at + 1) // `${prefix}` with an empty name is not a reference
      continue
    }
    out += text.slice(from, at) + replace(text.slice(at + open.length, close), text.slice(at, close + 1))
    from = close + 1
    at = text.indexOf(open, from)
  }
  return out + text.slice(from)
}

/** The names of the `${prefix}name}` references in a text, in order (see {@link replaceReferences}). */
export function findReferences(text: string, prefix: string): string[] {
  const names: string[] = []
  replaceReferences(text, prefix, (name, reference) => {
    names.push(name)
    return reference
  })
  return names
}

/**
 * Removes markup tags (`<` up to the next `>`, at least one character between) for plain-text
 * display in a terminal; a `<` with no `>` after it stays. `replaceTag` may give text for a tag
 * from what is between its brackets. The result is not HTML-safe and must not be put into a page.
 */
export function stripTags(html: string, replaceTag: (inner: string) => string = () => ''): string {
  let out = ''
  let from = 0
  let at = html.indexOf('<')
  while (at >= 0) {
    const close = html.indexOf('>', at + 1)
    if (close < 0) break
    if (close === at + 1) {
      at = html.indexOf('<', at + 1) // `<>` is text
      continue
    }
    out += html.slice(from, at) + replaceTag(html.slice(at + 1, close))
    from = close + 1
    at = html.indexOf('<', from)
  }
  return out + html.slice(from)
}

const ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", middot: '·', bull: '•', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›', rarr: '→', larr: '←', uarr: '↑', darr: '↓',
  times: '×', divide: '÷', plusmn: '±', deg: '°', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', check: '✓',
}

/**
 * Decodes the common HTML entities (named ones and numeric `&#183;` / `&#xB7;`) in one pass, so an
 * escaped entity stays one level escaped (`&amp;lt;` -> `&lt;`, not `<`). Unknown names stay as they are.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,8});/g, (whole, name: string) => {
    if (name === '#39') return "'"
    if (name.startsWith('#')) {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name] ?? whole
  })
}

const LINE_BREAK = /[\n\r\u2028\u2029]/

/**
 * The `HH:mm` of the last ` HH:mm` (a space, two digits, a colon, two digits) in a one-line text, or
 * undefined; the same as the match of `/^.* (\d\d:\d\d).*$/`, in linear time. A text with a line
 * break has no match (`.` does not cross one).
 */
export function lastClockTime(text: string): string | undefined {
  if (LINE_BREAK.test(text)) return undefined
  const isDigit = (i: number): boolean => text.charCodeAt(i) >= 48 && text.charCodeAt(i) <= 57
  for (let at = text.length - 6; at >= 0; at--) {
    if (text[at] === ' ' && isDigit(at + 1) && isDigit(at + 2) && text[at + 3] === ':' && isDigit(at + 4) && isDigit(at + 5)) return text.slice(at + 1, at + 6)
  }
  return undefined
}

/**
 * Splits `date[T time]` at the first `T`, `t` or space after a non-empty run of non-space characters,
 * when a non-empty time follows on the same line; the same as `/^(\S+?)(?:[T ](.+))?$/i`, in linear
 * time. Returns undefined when the text does not have that shape (it starts with a space, is empty,
 * or has a line break after the separator).
 */
export function splitDateAndTime(text: string): { date: string; time: string | undefined } | undefined {
  const isSpace = (ch: string): boolean => /\s/.test(ch)
  let end = 0
  while (end < text.length && !isSpace(text[end]!)) end++
  if (end === 0) return undefined
  let lastBreak = -1
  for (let i = text.length - 1; i >= 0 && lastBreak < 0; i--) if (LINE_BREAK.test(text[i]!)) lastBreak = i
  // the date part is lazy: it stops at the first T/t that leaves a valid time, else at the space
  for (let at = 1; at <= end; at++) {
    const sep = text[at]
    if (at < text.length && (sep === 'T' || sep === 't' || sep === ' ') && at + 1 < text.length && lastBreak < at + 1) {
      return { date: text.slice(0, at), time: text.slice(at + 1) }
    }
  }
  return end === text.length ? { date: text, time: undefined } : undefined
}
