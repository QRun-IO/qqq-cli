/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Extension output (an operation's JSON, a widget payload the kernel has no block for) laid out by
 * the kernel's formatDocument, as the CLI prints it: scalars as aligned key/value rows (nested
 * objects as dotted keys), each list of objects as a sub-table under its key, fitted to the width
 * (cells cut with …). The TUI colours the list headings; the raw JSON stays one key away (J).
 */

import { formatDocument } from '@qrun-io/qqq-core'
import { theme } from './theme'
import { trunc } from './util/text'
import type { StyledLine } from './widgets'

/** Lines for any JSON value, fitted to a width. */
export function structuredLines(value: unknown, width: number): StyledLine[] {
  const t = theme()
  const text = formatDocument(value, { width: Math.max(20, width) })
    .replace(/; --columns chooses, --json shows everything\)/g, '; J shows everything)')
  return text.split('\n').map((line) => (/^\S[^ ]* \(\d+\)$/.test(line) ? { text: trunc(line, width), fg: t.acc, bold: true } : /^\(\d+ more columns? did not fit/.test(line) ? { text: trunc(line, width), fg: t.dim } : { text: trunc(line, width) }))
}
