/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Leaving when the terminal is already gone (the tmux pane or window closed first): the renderer's
 * own restore steps fail (setRawMode errno, the native session's stdout) and it logs them with stack
 * traces. Those messages say nothing useful to the person who closed the window, so they are dropped.
 */

const NOISE = [/setRawMode failed/i, /Error disabling raw mode/i, /Native scene shutdown failed/i, /ot_session_post_stdout/i, /OutputFailed/, /\bEIO\b.*\b(read|write)\b/i, /\b(read|write) EIO\b/i, /\bENXIO\b/, /\bEBADF\b.*\b(tty|stdin|stdout)\b/i]

function textOf(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message} ${(value as { code?: string }).code ?? ''}`
  return typeof value === 'string' ? value : ''
}

/** Whether a console message or an error is one of the renderer's shutdown failures on a closed terminal. */
export function isShutdownNoise(args: unknown[]): boolean {
  const text = args.map(textOf).join(' ')
  return Boolean(text) && NOISE.some((r) => r.test(text))
}

/** Drops shutdown noise from console.error and console.warn; returns the function that puts them back. */
export function quietShutdownNoise(target: Pick<Console, 'error' | 'warn'> = console): () => void {
  const error = target.error
  const warn = target.warn
  target.error = (...args: unknown[]) => { if (!isShutdownNoise(args)) error.apply(target, args) }
  target.warn = (...args: unknown[]) => { if (!isShutdownNoise(args)) warn.apply(target, args) }
  return () => {
    target.error = error
    target.warn = warn
  }
}
