/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * React side of the mouse layer. `<Zone onClick=…>` around one drawn element (a `<text>` row, a
 * `<box>`) registers that element's measured rectangle while it is mounted; it adds no layout of its
 * own. `<MouseLayer>` puts a dialog's zones one layer up. `<MouseCapture>` is the transparent box
 * over the whole terminal that receives every event and hands it to the dispatcher.
 */

import { Children, cloneElement, createContext, isValidElement, useContext, useLayoutEffect, useMemo, useRef, type ReactElement, type ReactNode, type Ref } from 'react'
import type { Key } from '../keys'
import type { MouseDispatcher, RawMouse } from './dispatch'
import { wheelAsKeys } from './keys'
import type { Rect } from './hit'
import type { ZoneHandlers } from './registry'

interface Ctx {
  dispatcher?: MouseDispatcher
  /** Presses a key through the store (to the top dialog, else the focused pane). */
  press?: (key: Key) => void
  layer: number
  depth: number
}

const MouseContext = createContext<Ctx>({ layer: 0, depth: 0 })

/** Provides the dispatcher to the zones below (App). */
export function MouseRoot(props: { dispatcher: MouseDispatcher; press: (key: Key) => void; children: ReactNode }) {
  const value = useMemo(() => ({ dispatcher: props.dispatcher, press: props.press, layer: 0, depth: 0 }), [props.dispatcher, props.press])
  return <MouseContext.Provider value={value}>{props.children}</MouseContext.Provider>
}

/** Zones below belong to `layer` (a dialog: its index in the stack, plus one). */
export function MouseLayer(props: { layer: number; children: ReactNode }) {
  const ctx = useContext(MouseContext)
  const value = useMemo(() => ({ ...ctx, layer: props.layer, depth: 0 }), [ctx, props.layer])
  return <MouseContext.Provider value={value}>{props.children}</MouseContext.Provider>
}

/** What a renderable exposes for measuring (OpenTUI Renderable: absolute cell position after layout). */
interface Measurable {
  x: number
  y: number
  width: number
  height: number
  isDestroyed?: boolean
}

function rectOf(node: Measurable | null): Rect | undefined {
  if (!node || node.isDestroyed || node.width <= 0 || node.height <= 0) return undefined
  return { x: node.x, y: node.y, width: node.width, height: node.height }
}

export interface ZoneProps extends ZoneHandlers {
  /** Live while a dialog is open too (the F-key bar). */
  global?: boolean
  /** Exactly one host element (`<text>`, `<box>`), which keeps its own layout. */
  children: ReactNode
}

export function Zone(props: ZoneProps) {
  const ctx = useContext(MouseContext)
  const node = useRef<Measurable | null>(null)
  const handlers = useRef<ZoneHandlers>(props)
  handlers.current = props
  const { dispatcher, layer, depth } = ctx
  const global = Boolean(props.global)
  useLayoutEffect(() => dispatcher?.registry.add({ layer, depth, global, rect: () => rectOf(node.current), handlers: () => handlers.current }), [dispatcher, layer, depth, global])
  const inner = useMemo(() => ({ ...ctx, depth: depth + 1 }), [ctx, depth])
  const child = Children.only(props.children)
  if (!isValidElement(child)) return <>{props.children}</>
  const theirs = (child.props as { ref?: Ref<unknown> }).ref
  const ref = (value: Measurable | null) => {
    node.current = value
    if (typeof theirs === 'function') theirs(value)
    else if (theirs && typeof theirs === 'object') (theirs as { current: unknown }).current = value
  }
  return <MouseContext.Provider value={inner}>{cloneElement(child as ReactElement<{ ref?: unknown }>, { ref })}</MouseContext.Provider>
}

/** A dialog's frame: the wheel scrolls the dialog (arrow keys to it); clicks inside stay inside. */
export function DialogZone(props: { children: ReactNode }) {
  const { press } = useContext(MouseContext)
  return <Zone onClick={() => undefined} onWheel={(e) => (press ? wheelAsKeys(e, press) : false)}>{props.children}</Zone>
}

/** The transparent box over everything: every mouse event lands here (no OpenTUI selection or focus). */
export function MouseCapture(props: { width: number; height: number }) {
  const { dispatcher } = useContext(MouseContext)
  if (!dispatcher) return null
  const on = (e: RawMouse & { preventDefault?: () => void; stopPropagation?: () => void }) => {
    if (dispatcher.handle(e)) e.stopPropagation?.()
  }
  return <box position="absolute" left={0} top={0} width={props.width} height={props.height} zIndex={10_000} onMouseDown={on} onMouseUp={on} onMouseDrag={on} onMouseScroll={on} />
}
