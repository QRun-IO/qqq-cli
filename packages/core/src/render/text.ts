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

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }

/**
 * Decodes the common HTML entities in one pass, so an escaped entity stays one level escaped
 * (`&amp;lt;` -> `&lt;`, not `<`).
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITIES[name]!)
}
