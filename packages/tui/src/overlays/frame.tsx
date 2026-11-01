/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { createContext, useContext, type ReactNode } from 'react'
import { DialogZone } from '../mouse/zone'
import { glyphs, theme } from '../theme'
import { fitKeyLine, pad, trunc, type KeyToken } from '../util/text'

/** Cells inside the nearest Frame's border; `Line` and `KeyLines` default to it. */
const FrameInner = createContext<number | undefined>(undefined)

/**
 * A centred modal frame drawn over the screen. The frame never extends past the screen, clips what
 * it holds (overflow hidden) and tells `Line`/`KeyLines` its inner width, so dialog text is cut with
 * an ellipsis at the border instead of running past it.
 */
export function Frame(props: { title: string; width: number; height?: number; screenWidth: number; screenHeight: number; children: ReactNode; top?: number }) {
  const t = theme()
  const width = Math.max(4, Math.min(props.width, props.screenWidth))
  const left = Math.max(0, Math.floor((props.screenWidth - width) / 2))
  const wanted = props.height ? Math.min(props.height, props.screenHeight) : undefined
  const top = Math.max(0, Math.min(props.top ?? Math.max(1, Math.floor((props.screenHeight - (wanted ?? 10)) / 3)), props.screenHeight - (wanted ?? 3)))
  const height = wanted ? Math.min(wanted, props.screenHeight - top) : undefined
  return (
    <DialogZone>
    <box position="absolute" overflow="hidden" left={left} top={top} width={width} {...(height ? { height } : {})} flexDirection="column"
      border borderStyle="double" borderColor={t.focusBorder} {...(glyphs().border ? { customBorderChars: glyphs().border } : {})}
      backgroundColor={t.overlayBg} title={trunc(` ${props.title} `, Math.max(0, width - 4))} zIndex={20}>
      <FrameInner.Provider value={width - 2}>{props.children}</FrameInner.Provider>
    </box>
    </DialogZone>
  )
}

/** The inner width of the enclosing Frame (or `fallback` outside one). */
export function useFrameInner(fallback: number): number {
  return useContext(FrameInner) ?? fallback
}

/** One line of text with a background, padded to the width and cut with an ellipsis (width defaults to the frame's inner width). */
export function Line(props: { text: string; width?: number; fg?: string; bg?: string; bold?: boolean }) {
  const inner = useContext(FrameInner)
  const width = Math.min(props.width ?? inner ?? props.text.length, inner ?? Number.MAX_SAFE_INTEGER)
  const text = pad(props.text, width)
  return <text flexShrink={0} wrapMode="none" fg={props.fg ?? theme().fg} bg={props.bg}>{props.bold ? <strong>{text}</strong> : text}</text>
}

/**
 * Key help in at most `maxLines` lines that break only between tokens (at " · "); the least
 * important tokens (highest `drop`) are dropped first when they still do not fit. One cell of
 * indent on each side.
 */
export function KeyLines(props: { tokens: Array<KeyToken | string>; width?: number; maxLines?: number; fg?: string }) {
  const inner = useContext(FrameInner)
  const width = props.width ?? inner ?? 80
  const lines = fitKeyLine(props.tokens, Math.max(1, width - 2), props.maxLines ?? 3)
  return <>{lines.map((l, i) => <Line key={i} text={` ${l}`} width={width} fg={props.fg ?? theme().dim} />)}</>
}
