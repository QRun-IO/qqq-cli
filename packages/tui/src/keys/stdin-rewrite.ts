/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Feeds the renderer canonical function-key sequences: every `data` chunk of the input stream goes
 * through rewriteFKeyInput before any listener (OpenTUI's stdin parser) sees it. OpenTUI's own input
 * handlers run after its parser, which already took Shift+F3 for a cursor report, so the bytes are
 * rewritten on the stream itself.
 */

import { rewriteFKeyInput, type LegacyProfile } from './fkeys'

/** Cursor reports are expected for this long after start and after a resume (the capability probe). */
export const CPR_QUIET_MS = 1500

export interface FKeyRewrite {
  /** Call after renderer.resume(): the probe runs again, so CSI 1;m R is a cursor report for a while. */
  quiet(): void
  /** Restores the stream. */
  dispose(): void
}

export function installFKeyRewrite(stream: NodeJS.EventEmitter, profile: LegacyProfile, clock: () => number = Date.now): FKeyRewrite {
  const original = stream.emit
  let quietUntil = clock() + CPR_QUIET_MS
  const patched = function (this: NodeJS.EventEmitter, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'data' && args.length) {
      const chunk = args[0]
      const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('latin1') : undefined
      if (text !== undefined && text.includes('\x1b')) {
        const out = rewriteFKeyInput(text, profile, { cpr: clock() >= quietUntil })
        if (out !== text) args[0] = typeof chunk === 'string' ? out : Buffer.from(out, 'latin1')
      }
    }
    return original.call(this, event, ...args)
  }
  stream.emit = patched as typeof stream.emit
  return {
    quiet: () => { quietUntil = clock() + CPR_QUIET_MS },
    dispose: () => { if (stream.emit === patched) stream.emit = original },
  }
}
