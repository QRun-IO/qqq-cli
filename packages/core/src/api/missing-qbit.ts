/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A server error that only says a QBit is missing (`IllegalStateException (The Object Storage qbit
 * is not installed)`, a 5xx) as one plain line for people. Attachments need the Object Storage QBit.
 */

export const NO_OBJECT_STORAGE = 'This server cannot store attachments: the Object Storage QBit is not installed.'

const MISSING = /\b(?:the\s+)?([A-Za-z][\w -]{1,60}?)\s+(?:qbit|extension)\s+is\s+not\s+installed\b/i

/**
 * The plain line for an error that names a missing QBit or extension, or undefined. Only server
 * failures count (status 500 and up, or no status known); a 4xx keeps its own message.
 */
export function missingQBitMessage(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' && typeof error !== 'string') return undefined
  const status = typeof error === 'object' ? (error as { status?: unknown }).status : undefined
  if (typeof status === 'number' && status < 500) return undefined
  const message = typeof error === 'string' ? error : String((error as { message?: unknown }).message ?? '')
  const m = MISSING.exec(message)
  if (!m) return undefined
  const name = m[1]!.trim().replace(/^the\s+/i, '')
  if (/object\s*storage/i.test(name)) return NO_OBJECT_STORAGE
  const title = name.replace(/\b\w/g, (c) => c.toUpperCase())
  return `This server cannot do this: the ${title} QBit is not installed.`
}
