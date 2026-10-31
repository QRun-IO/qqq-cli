/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { ReactNode } from 'react'
import { glyphs, theme } from '../theme'

/** A centred modal frame drawn over the screen. */
export function Frame(props: { title: string; width: number; height?: number; screenWidth: number; screenHeight: number; children: ReactNode; top?: number }) {
  const t = theme()
  const left = Math.max(0, Math.floor((props.screenWidth - props.width) / 2))
  const top = props.top ?? Math.max(1, Math.floor((props.screenHeight - (props.height ?? 10)) / 3))
  return (
    <box position="absolute" overflow="hidden" left={left} top={top} width={props.width} {...(props.height ? { height: props.height } : {})} flexDirection="column"
      border borderStyle="double" borderColor={t.focusBorder} {...(glyphs().border ? { customBorderChars: glyphs().border } : {})}
      backgroundColor={t.overlayBg} title={` ${props.title} `} zIndex={20}>
      {props.children}
    </box>
  )
}

/** One line of text with a background, padded to the width. */
export function Line(props: { text: string; width: number; fg?: string; bg?: string; bold?: boolean }) {
  const text = props.text.length >= props.width ? props.text.slice(0, props.width) : props.text + ' '.repeat(props.width - props.text.length)
  return <text flexShrink={0} wrapMode="none" fg={props.fg ?? theme().fg} bg={props.bg}>{props.bold ? <strong>{text}</strong> : text}</text>
}
