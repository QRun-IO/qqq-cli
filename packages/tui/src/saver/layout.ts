/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Paints one frame of the screen saver into a Canvas. Pure: the same input (time, size, tiles)
 * gives the same frame, so every style is testable at 80×24 and 120×40. Every style keeps the
 * clock, the server's short name and the profile on the top row and the wake hint on the last.
 *
 * Styles: bounce (Query and the qqq logo drift DVD-style and change colour at each wall, tiles in
 * a corner HUD), starfield (stars fly out of the centre, Query drifts through, the tiles float),
 * flip (big flip-clock digits with the date, tiles beneath, Query peeking from a corner), big (the
 * most interesting metric in block digits beside Query, rotating every 8 s).
 */

import type { ThemeTokens } from '../theme'
import { pad, trunc } from '../util/text'
import { Canvas, type Style } from './canvas'
import { FONT_HEIGHT, blockText, blockWidth, canDraw } from './font'
import { sparkline, type TileState } from './model'
import { queryFrame, queryPoseAt, querySize, type QueryPose } from './query-art'
import { SAVER_STYLES, type SaverStyle, type SaverStyleSetting } from './settings'

export interface SaverTile {
  state: TileState
  stale: boolean
}

export interface SaverInput {
  style: SaverStyle
  now: number
  width: number
  height: number
  tiles: SaverTile[]
  /** Server short name (host:port). */
  server: string
  profile: string
  brand: string
  ascii: boolean
  theme: ThemeTokens
  /** A PIN is set: the hint says locked. */
  locked: boolean
  preview: boolean
  /** The PIN prompt over the saver (it keeps animating behind). */
  pin?: { length: number; message: string }
  /** The sparkline ramp of the glyph set. */
  ramp: string
}

/** How long each style shows in auto mode. */
export const AUTO_STYLE_MILLIS = 3 * 60_000

/** The style in effect at a moment: the setting, or the auto rotation. */
export function styleAt(setting: SaverStyleSetting, now: number): SaverStyle {
  return setting === 'auto' ? SAVER_STYLES[Math.floor(now / AUTO_STYLE_MILLIS) % SAVER_STYLES.length]! : setting
}

/** Animation frame (250 ms: at most 4 fps). */
export const FRAME_MILLIS = 250

/** Milliseconds until the next frame worth drawing: 250 while something moves, else up to 1 s. */
export function nextFrameDelay(style: SaverStyle, now: number): number {
  if (style === 'bounce' || style === 'starfield') return FRAME_MILLIS
  const pose = queryPoseAt(now)
  if (pose.action || flipping(now)) return FRAME_MILLIS
  const toSecond = 1000 - (now % 1000)
  const inBlink = now % 4000 < 250
  const toBlinkEdge = inBlink ? 250 - (now % 4000) : 4000 - (now % 4000)
  return Math.max(50, Math.min(toSecond, toBlinkEdge))
}

/** A triangle wave 0…max…0 over `n` steps (the bounce). */
export function bounce(n: number, max: number): number {
  if (max <= 0) return 0
  const period = 2 * max
  const m = ((n % period) + period) % period
  return m <= max ? m : period - m
}

function direction(n: number, max: number): 1 | -1 {
  return bounce(n + 1, max) >= bounce(n, max) ? 1 : -1
}

function levelColor(t: ThemeTokens, tile: SaverTile): string {
  if (tile.stale || tile.state.status === 'error' || tile.state.status === 'loading') return t.dim
  const level = tile.state.value?.level
  return level === 'ok' ? t.ok : level === 'warn' ? t.warn : level === 'err' ? t.err : t.fg
}

function tileValue(tile: SaverTile, ramp: string): string {
  const v = tile.state.value
  if (!v) return '…'
  return v.spark && v.spark.some((n) => n > 0) ? `${v.value} ${sparkline(v.spark, ramp)}` : v.value
}

const LABEL_WIDTH = 9

/** One tile on one line: label, value (in its level's colour, dimmed when stale), detail. */
function tileLine(c: Canvas, x: number, y: number, width: number, tile: SaverTile, input: SaverInput, bg?: string): void {
  const t = input.theme
  if (width <= 0) return
  const label = pad(tile.state.label, Math.min(LABEL_WIDTH, width))
  c.put(x, y, label, { fg: t.acc, bg })
  const rest = width - label.length - 1
  if (rest <= 0) return
  const value = trunc(tileValue(tile, input.ramp), rest)
  c.put(x + label.length + 1, y, value, { fg: levelColor(t, tile), bg, bold: !tile.stale && Boolean(tile.state.value) })
  const detailWidth = rest - value.length - 2
  const detail = tile.state.value?.detail ?? (tile.state.status === 'error' ? 'not answering, retrying' : '')
  if (detailWidth > 3 && detail) c.put(x + label.length + 1 + value.length + 2, y, trunc(tile.stale ? `${detail} (stale)` : detail, detailWidth), { fg: t.dim, bg })
}

/** The tiles in a framed panel; returns its size. */
function hudSize(input: SaverInput, maxW: number, maxH: number): { w: number; h: number } {
  const w = Math.max(0, Math.min(maxW, input.width >= 100 ? 56 : 46))
  const h = Math.max(0, Math.min(maxH, input.tiles.length + 2))
  return { w, h }
}

function drawHud(c: Canvas, x: number, y: number, w: number, h: number, input: SaverInput): void {
  if (w < 12 || h < 3) return
  const t = input.theme
  const inner = c.box(x, y, w, h, { bg: t.overlayBg, fg: t.fg, border: t.border, title: 'live' }, input.ascii)
  input.tiles.slice(0, inner.h).forEach((tile, i) => tileLine(c, inner.x + 1, inner.y + i, inner.w - 2, tile, input, t.overlayBg))
}

function header(c: Canvas, input: SaverInput): void {
  const t = input.theme
  const d = new Date(input.now)
  const clock = d.toLocaleTimeString('en-GB')
  const left = ` ${clock}  ${input.server}  ·  ${input.profile}`
  const right = `${input.brand} `
  c.put(0, 0, pad(left, input.width), { fg: t.fg, bold: true })
  if (left.length + right.length + 2 <= input.width) c.put(input.width - right.length, 0, right, { fg: t.acc })
  c.put(1, 0, clock, { fg: t.acc2, bold: true })
}

function footer(c: Canvas, input: SaverInput): void {
  const t = input.theme
  const hint = input.preview
    ? `preview: ${input.style} · any key returns · :saver bounce | starfield | flip | big`
    : input.locked ? 'locked · any key to unlock' : 'any key returns'
  const text = trunc(hint, input.width - 2)
  c.put(Math.max(0, Math.floor((input.width - text.length) / 2)), input.height - 1, text, { fg: t.dim })
}

function drawPin(c: Canvas, input: SaverInput): void {
  if (!input.pin) return
  const t = input.theme
  const w = Math.min(40, input.width - 4)
  const h = 5
  const x = Math.floor((input.width - w) / 2)
  const y = Math.max(1, Math.floor((input.height - h) / 2))
  const inner = c.box(x, y, w, h, { bg: t.overlayBg, fg: t.fg, border: t.focusBorder, title: 'Unlock' }, input.ascii)
  const dots = (input.ascii ? '*' : '•').repeat(input.pin.length)
  c.put(inner.x + 1, inner.y, trunc(`PIN: ${dots}${input.ascii ? '_' : '▏'}`, inner.w - 2), { fg: t.fg, bg: t.overlayBg })
  c.put(inner.x + 1, inner.y + 1, trunc(input.pin.message || 'Enter unlocks · Esc returns to saver', inner.w - 2), { fg: input.pin.message ? t.err : t.dim, bg: t.overlayBg })
}

function palette(t: ThemeTokens): string[] {
  return [t.acc, t.acc2, t.ok, t.warn, t.markFg, t.err]
}

/** Query and, when there is room, the qqq logo: the sprite the Bounce style drifts. */
function bounceSprite(bodyH: number, width: number): { w: number; h: number; size: 'large' | 'small'; logo: 'block' | 'line' | 'none' } {
  const large = querySize('large')
  const small = querySize('small')
  const logoW = blockWidth('qqq')
  if (bodyH >= large.height + 1 + FONT_HEIGHT && width >= large.width + 4) return { w: large.width, h: large.height + 1 + FONT_HEIGHT, size: 'large', logo: 'block' }
  if (bodyH >= large.height + 1 && width >= large.width + 4) return { w: large.width, h: large.height + 1, size: 'large', logo: 'line' }
  if (bodyH >= FONT_HEIGHT + 1 + small.height) return { w: Math.max(small.width, logoW), h: small.height + 1 + FONT_HEIGHT, size: 'small', logo: 'block' }
  return { w: small.width, h: small.height, size: 'small', logo: 'none' }
}

function drawQuery(c: Canvas, x: number, y: number, size: 'large' | 'small', pose: QueryPose, input: SaverInput, color: string): void {
  c.block(x, y, queryFrame(size, pose, input.ascii), { fg: color, bold: true })
}

function paintBounce(c: Canvas, input: SaverInput): void {
  const t = input.theme
  const top = 1
  const bodyH = input.height - 2
  const sprite = bounceSprite(bodyH, input.width)
  const maxX = Math.max(0, input.width - sprite.w)
  const maxY = Math.max(0, bodyH - sprite.h)
  const step = Math.floor(input.now / FRAME_MILLIS)
  const ystep = Math.floor(step / 2)
  const x = bounce(step, maxX)
  const y = top + bounce(ystep, maxY)
  const dx = direction(step, maxX)
  const dy = direction(ystep, maxY)
  // a new colour at each wall, as the DVD logo did
  const walls = (maxX ? Math.floor(step / maxX) : 0) + (maxY ? Math.floor(ystep / maxY) : 0)
  const colors = palette(t)
  const color = colors[walls % colors.length]!
  const pose = queryPoseAt(input.now, { dx, dy })
  const q = querySize(sprite.size)
  const qx = x + Math.floor((sprite.w - q.width) / 2)
  const qy = y + (pose.dy < 0 && y > top ? -1 : 0)
  drawQuery(c, qx, qy, sprite.size, pose, input, color)
  if (pose.action) {
    const bubble = 'woof!'
    const bx = pose.facing === 'right' ? qx + q.width - 2 : qx - bubble.length + 2
    c.put(Math.min(Math.max(0, bx), input.width - bubble.length), Math.max(top, qy - 1), bubble, { fg: t.acc2, bold: true })
  }
  const logoY = y + q.height + 1
  if (sprite.logo === 'block') {
    const logo = blockText('qqq', input.ascii)
    c.block(x + Math.floor((sprite.w - blockWidth('qqq')) / 2), logoY, logo, { fg: color })
  } else if (sprite.logo === 'line') {
    const name = 'q q q'
    c.put(x + Math.floor((sprite.w - name.length) / 2), y + q.height, name, { fg: color, bold: true })
  }
  const hud = hudSize(input, input.width - 2, bodyH)
  drawHud(c, input.width - hud.w - 1, top + bodyH - hud.h, hud.w, hud.h, input)
}

/** A deterministic 0…1 value for a seed (the star field). */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

function paintStarfield(c: Canvas, input: SaverInput): void {
  const t = input.theme
  const bodyH = input.height - 2
  const cx = input.width / 2
  const cy = 1 + bodyH / 2
  const count = Math.min(140, Math.floor((input.width * bodyH) / 22))
  const seconds = input.now / 1000
  const chars = input.ascii ? ['.', '.', '+', '*'] : ['·', '∙', '+', '*']
  for (let i = 0; i < count; i++) {
    const angle = rand(i) * Math.PI * 2
    const speed = 0.12 + rand(i + 500) * 0.3
    const z = (seconds * speed + rand(i + 1000)) % 1
    // newborn stars sit on the centre cell: skip them, or the centre becomes a streak
    if (z < 0.15) continue
    const r = z * z * 1.1
    const sx = Math.round(cx + Math.cos(angle) * r * input.width * 0.62)
    const sy = Math.round(cy + Math.sin(angle) * r * bodyH * 0.62)
    if (sy < 1 || sy > bodyH) continue
    const level = Math.min(3, Math.floor(z * 4))
    c.put(sx, sy, chars[level]!, { fg: level >= 3 ? t.acc2 : level >= 2 ? t.fg : t.dim })
  }
  // Query drifts through left to right, bobbing
  const q = querySize('small')
  const step = Math.floor(input.now / FRAME_MILLIS)
  const span = input.width + q.width * 2
  const qx = (step % span) - q.width
  const qy = Math.round(1 + bodyH * 0.25 + Math.sin(input.now / 1500) * 2)
  const pose = queryPoseAt(input.now, { dx: 1, dy: Math.cos(input.now / 1500) > 0 ? 1 : -1 })
  drawQuery(c, qx, Math.max(1, qy + pose.dy), 'small', pose, input, t.acc2)
  // the tiles float in the middle
  const hud = hudSize(input, input.width - 4, bodyH - 2)
  const ox = Math.round(Math.sin(input.now / 4000) * 2)
  const oy = Math.round(Math.sin(input.now / 5300))
  const hx = Math.max(0, Math.min(input.width - hud.w, Math.floor((input.width - hud.w) / 2) + ox))
  const hy = Math.max(1, Math.min(bodyH - hud.h + 1, Math.floor(1 + bodyH * 0.55 - hud.h / 2) + oy + 2))
  drawHud(c, hx, hy, hud.w, hud.h, input)
}

/** Whether the flip clock is mid-flip (the first 500 ms of a minute). */
function flipping(now: number): boolean {
  return now % 60_000 < 500
}

function hhmm(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
}

function paintFlip(c: Canvas, input: SaverInput): void {
  const t = input.theme
  const bodyH = input.height - 2
  const now = hhmm(input.now)
  const before = hhmm(input.now - (input.now % 60_000) - 1)
  const half = flipping(input.now) && input.now % 60_000 < 250
  const columns = input.width >= 100 ? 2 : 1
  const tileRows = Math.ceil(input.tiles.length / columns)
  // double-size digits when the screen has room for them and the tiles
  const scale = input.width >= 80 && bodyH >= FONT_HEIGHT * 2 + 2 + 5 + tileRows ? 2 : 1
  const glyphW = 4 * scale
  const cardW = glyphW + 2
  const cardH = FONT_HEIGHT * scale + 2
  const gap = 1
  const colonW = 1 + 2 * scale
  const total = cardW * 4 + gap * 2 + colonW
  const x0 = Math.max(0, Math.floor((input.width - total) / 2))
  const y0 = 1 + Math.max(0, Math.floor((bodyH - (cardH + 4 + tileRows)) / 2))
  const positions = [x0, x0 + cardW + gap, x0 + cardW * 2 + gap + colonW, x0 + cardW * 3 + gap * 2 + colonW]
  const big = (ch: string) => blockText(ch, input.ascii).flatMap((r) => new Array<string>(scale).fill([...r].map((x) => x.repeat(scale)).join('')))
  for (let i = 0; i < 4; i++) {
    const cx = positions[i]!
    c.fill(cx, y0, cardW, cardH, { bg: t.inputBg })
    const glyphNew = big(now[i]!)
    const glyphOld = big(before[i]!)
    const changed = now[i] !== before[i]
    const hingeRow = Math.floor(cardH / 2)
    for (let r = 0; r < glyphNew.length; r++) {
      // mid-flip: the top half already shows the new digit, the bottom half still the old one
      const g = changed && half && 1 + r >= hingeRow ? glyphOld : glyphNew
      c.put(cx + 1, y0 + 1 + r, g[r]!, { fg: t.fg, bg: t.inputBg, bold: true }, true)
    }
    const hinge = input.ascii ? ['-', '-'] : ['▸', '◂']
    c.put(cx, y0 + hingeRow, hinge[0]!, { fg: t.overlayBg, bg: t.inputBg })
    c.put(cx + cardW - 1, y0 + hingeRow, hinge[1]!, { fg: t.overlayBg, bg: t.inputBg })
  }
  const colonX = x0 + cardW * 2 + gap + scale
  const dot = (input.ascii ? '#' : '█').repeat(scale)
  for (let k = 0; k < scale; k++) {
    c.put(colonX, y0 + 1 + 1 * scale + k, dot, { fg: t.acc2 })
    c.put(colonX, y0 + 1 + 3 * scale + k, dot, { fg: t.acc2 })
  }
  const seconds = String(new Date(input.now).getSeconds()).padStart(2, '0')
  c.put(x0 + total + 1, y0 + cardH - 1, seconds, { fg: t.dim })
  const date = new Date(input.now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  let y = y0 + cardH + 1
  for (const [text, style] of [[date, { fg: t.acc, bold: true }], [`${input.server} · ${input.profile}`, { fg: t.dim }]] as Array<[string, Style]>) {
    const s = trunc(text, input.width - 2)
    c.put(Math.floor((input.width - s.length) / 2), y++, s, style)
  }
  y++
  // the tiles beneath (two columns when wide); the right edge stays clear for Query
  const colW = Math.floor((input.width - 4 - querySize('small').width - 2 - (columns - 1) * 3) / columns)
  const rows = Math.max(0, input.height - 1 - y)
  input.tiles.slice(0, rows * columns).forEach((tile, i) => {
    const col = columns === 2 ? i % 2 : 0
    const row = columns === 2 ? Math.floor(i / 2) : i
    tileLine(c, 2 + col * (colW + 3), y + row, colW, tile, input)
  })
  // Query peeks up from the bottom-right corner: ears and eyes, all of him when he hops
  const q = querySize('small')
  const pose = queryPoseAt(input.now, { dx: -1 })
  const shown = pose.action ? q.height : 3
  const frame = queryFrame('small', pose, input.ascii).slice(0, shown)
  const qx = input.width - q.width - 1
  c.fill(qx, input.height - 1 - shown, q.width, shown, {})
  c.block(qx, input.height - 1 - shown, frame, { fg: t.acc2, bold: true })
}

function paintBig(c: Canvas, input: SaverInput): void {
  const t = input.theme
  const bodyH = input.height - 2
  const candidates = input.tiles
    .filter((x) => x.state.value?.big !== undefined)
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (b.x.state.value!.interest ?? 0) - (a.x.state.value!.interest ?? 0) || a.i - b.i)
    .map((e) => e.x)
  const q = querySize('small')
  const y0 = 1 + Math.max(1, Math.floor((bodyH - 14) / 2))
  if (!candidates.length) {
    const pose = queryPoseAt(input.now)
    drawQuery(c, Math.floor((input.width - q.width) / 2), y0, 'small', pose, input, t.acc2)
    const msg = input.tiles.length ? 'fetching the numbers…' : 'nothing to count on this server'
    c.put(Math.floor((input.width - msg.length) / 2), y0 + q.height + 1, msg, { fg: t.dim })
    return
  }
  const index = Math.floor(input.now / 8000) % candidates.length
  const tile = candidates[index]!
  const v = tile.state.value!
  const big = v.big!
  const color = levelColor(t, tile) === t.fg ? t.acc2 : levelColor(t, tile)
  const label = trunc(tile.state.label.toUpperCase(), input.width - 4)
  c.put(Math.floor((input.width - label.length) / 2), y0, label, { fg: t.acc, bold: true })
  const drawBlock = canDraw(big) && blockWidth(big) + q.width + 3 <= input.width - 4
  const numW = drawBlock ? blockWidth(big) : big.length
  const groupW = q.width + 3 + numW
  const gx = Math.max(0, Math.floor((input.width - groupW) / 2))
  const asleep = big === '0'
  const pose: QueryPose = { ...queryPoseAt(input.now, { dx: 1 }), ...(asleep ? { blink: true, wag: false } : {}) }
  drawQuery(c, gx, y0 + 2, 'small', pose, input, t.acc2)
  if (asleep) c.put(gx + q.width - 1, y0 + 1, input.now % 2000 < 1000 ? 'z' : 'zZ', { fg: t.dim })
  if (drawBlock) c.block(gx + q.width + 3, y0 + 2, blockText(big, input.ascii), { fg: color, bold: true })
  else c.put(gx + q.width + 3, y0 + 4, big, { fg: color, bold: true })
  const detail = trunc(`${v.value}${v.detail ? ` · ${v.detail}` : ''}${tile.stale ? ' (stale)' : ''}`, input.width - 4)
  c.put(Math.floor((input.width - detail.length) / 2), y0 + 2 + q.height + 1, detail, { fg: t.dim })
  const dots = candidates.map((_, i) => (i === index ? (input.ascii ? '*' : '●') : (input.ascii ? '.' : '○'))).join(' ')
  c.put(Math.floor((input.width - dots.length) / 2), y0 + 2 + q.height + 2, trunc(dots, input.width - 2), { fg: t.dim })
  // everything else on the lines beneath
  const y = y0 + 2 + q.height + 4
  const others = input.tiles.filter((x) => x !== tile)
  const colW = input.width >= 100 ? Math.floor((input.width - 7) / 2) : input.width - 4
  const columns = input.width >= 100 ? 2 : 1
  others.slice(0, Math.max(0, (input.height - 1 - y) * columns)).forEach((o, i) => {
    tileLine(c, 2 + (columns === 2 ? (i % 2) * (colW + 3) : 0), y + (columns === 2 ? Math.floor(i / 2) : i), colW, o, input)
  })
}

/** One frame of the saver. */
export function paintSaver(input: SaverInput): Canvas {
  const t = input.theme
  const c = new Canvas(input.width, input.height, { bg: t.overlayBg, fg: t.fg })
  if (input.width < 20 || input.height < 6) {
    c.put(0, 0, trunc(new Date(input.now).toLocaleTimeString('en-GB'), input.width), { fg: t.acc2 })
    return c
  }
  if (input.style === 'bounce') paintBounce(c, input)
  else if (input.style === 'starfield') paintStarfield(c, input)
  else if (input.style === 'flip') paintFlip(c, input)
  else paintBig(c, input)
  header(c, input)
  footer(c, input)
  drawPin(c, input)
  return c
}
