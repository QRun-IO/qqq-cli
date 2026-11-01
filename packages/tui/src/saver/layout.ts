/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Paints one frame of the screen saver into a Canvas. Pure: the same input (time, size, tiles)
 * gives the same frame, so every style is testable at 80×24 and 120×40. Every style shows the
 * clock, the server's short name and the profile in one row and the wake hint in another.
 *
 * Burn-in guard (on by default, `burnin off` restores the fixed layout): nothing stays put. The
 * header and the lock line change place every 30 s (a new x, the top and bottom rows swapping),
 * Bounce's tiles ride beside the logo, the flip clock drifts a cell every few seconds, Big numbers
 * moves to another corner at each rotation, and after the configured minutes everything dims.
 *
 * Styles: bounce (Query and the profile's name in block letters drift DVD-style and change colour at each wall, tiles in
 * a HUD beside them), starfield (stars fly out of the centre, Query drifts through, the tiles float),
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
  /** The profile's short name (the block-letter logo when it has 6 characters or fewer). */
  shortName?: string
  /** Burn-in guard: every element drifts. Off: the fixed layout. */
  burnin: boolean
  /** Draw everything dimmed (the saver has been up for the configured minutes). */
  dim: boolean
}

/** How often the header and the lock line change place. */
export const SHIFT_MILLIS = 30_000
/** The dim: how far every colour moves toward the background. */
export const DIM_AMOUNT = 0.45

/** Whether the saver has been up long enough to dim (`dimMinutes` 0: never). */
export function isDimmed(shownMillis: number, dimMinutes: number): boolean {
  return dimMinutes > 0 && shownMillis >= dimMinutes * 60_000
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

/** Cells a tile line takes at most: the label, the value and the detail, as `tileLine` draws them. */
function tileNaturalWidth(tile: SaverTile, ramp: string): number {
  const detail = tile.state.value?.detail ?? (tile.state.status === 'error' ? 'not answering, retrying' : '')
  return LABEL_WIDTH + 1 + tileValue(tile, ramp).length + (detail ? 2 + detail.length + (tile.stale ? 8 : 0) : 0)
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

/** Where the header and the lock line are drawn: fixed, or (burn-in guard) moved every 30 s. */
export interface ChromeLayout {
  headerRow: number
  headerX: number
  headerText: string
  footerRow: number
  footerX: number
  footerText: string
}

function footerText(input: SaverInput): string {
  const hint = input.preview
    ? `preview: ${input.style} · any key returns · :saver bounce | starfield | flip | big`
    : input.locked ? 'locked · any key to unlock' : 'any key returns'
  return trunc(hint, input.width - 2)
}

export function chromeLayout(input: SaverInput, group?: Box): ChromeLayout {
  const clock = new Date(input.now).toLocaleTimeString('en-GB')
  const last = input.height - 1
  if (!input.burnin) {
    return { headerRow: 0, headerX: 0, headerText: ` ${clock}  ${input.server}  ·  ${input.profile}`, footerRow: last, footerX: -1, footerText: footerText(input) }
  }
  const g = group ?? { x: 0, y: 1, w: input.width, h: input.height - 2 }
  const cycle = Math.floor(input.now / SHIFT_MILLIS)
  const headerText = trunc(`${clock}  ${input.server}  ·  ${input.profile}  ·  ${input.brand}`, input.width - 1)
  const text = footerText(input)
  // the two lines sit just above and just below the group, swapping every 30 s, a little off its centre by a new amount each time
  const above = Math.max(0, g.y - 1)
  const below = Math.min(last, g.y + g.h)
  const even = cycle % 2 === 0
  const place = (len: number, seed: number) => {
    const jitter = Math.round((rand(cycle * seed + seed) - 0.5) * 24)
    return Math.max(1, Math.min(input.width - len, Math.round(g.x + g.w / 2 - len / 2) + jitter))
  }
  return {
    headerRow: even ? above : below, headerX: place(headerText.length, 2.7), headerText,
    footerRow: even ? below : above, footerX: place(text.length, 3.1), footerText: text,
  }
}

function header(c: Canvas, input: SaverInput, at: ChromeLayout): void {
  const t = input.theme
  if (input.burnin) {
    c.put(at.headerX, at.headerRow, at.headerText, { fg: t.fg, bold: true })
    c.put(at.headerX, at.headerRow, at.headerText.slice(0, 8), { fg: t.acc2, bold: true })
    return
  }
  const clock = new Date(input.now).toLocaleTimeString('en-GB')
  const right = `${input.brand} `
  c.put(0, 0, pad(at.headerText, input.width), { fg: t.fg, bold: true })
  if (at.headerText.length + right.length + 2 <= input.width) c.put(input.width - right.length, 0, right, { fg: t.acc })
  c.put(1, 0, clock, { fg: t.acc2, bold: true })
}

function footer(c: Canvas, input: SaverInput, at: ChromeLayout): void {
  const x = input.burnin ? at.footerX : Math.max(0, Math.floor((input.width - at.footerText.length) / 2))
  c.put(x, at.footerRow, at.footerText, { fg: input.theme.dim })
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

/** The block-letter logo under Query: the profile's name, with the server host beneath. */
interface NameLogo {
  rows: string[]
  /** Drawn in block letters (else plain text). */
  block: boolean
  host: string
  w: number
}

/** The short name when it has 6 characters or fewer, else the profile name; block letters when the font covers it and it fits. */
export function logoName(input: SaverInput): string {
  const short = input.shortName
  return (short && short.length <= 6 ? short : input.profile) || short || 'qqq'
}

function nameLogo(input: SaverInput): NameLogo {
  const name = logoName(input)
  const block = canDraw(name) && blockWidth(name) <= input.width - 4
  const rows = block ? blockText(name, input.ascii) : [trunc(name, input.width - 4)]
  const host = trunc(input.server, input.width - 2)
  return { rows, block, host, w: Math.max(host.length, ...rows.map((r) => [...r].length)) }
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface BounceSprite {
  w: number
  h: number
  size: 'large' | 'small'
  logo: boolean
}

/** Query with the name logo under him when there is room (large Query only when it all fits). */
function bounceSprite(bodyH: number, width: number, logo: NameLogo): BounceSprite {
  const large = querySize('large')
  const small = querySize('small')
  const extra = 2 + logo.rows.length
  if (bodyH >= large.height + extra && width >= Math.max(large.width, logo.w) + 4) return { w: Math.max(large.width, logo.w), h: large.height + extra, size: 'large', logo: true }
  if (bodyH >= small.height + extra) return { w: Math.min(width, Math.max(small.width, logo.w)), h: small.height + extra, size: 'small', logo: true }
  return { w: small.width, h: small.height, size: 'small', logo: false }
}

/** The narrowest tile panel worth drawing beside the logo. */
const MIN_PANEL = 22
/** Too small for Query and the panel together: each shows for this long, alternating. */
export const ALTERNATE_MILLIS = 20_000

/**
 * The tile panel beside the sprite: full width on the side with room (right first); where neither
 * side has it, a compact one (a constant width, so its near edge always follows the logo). None when
 * even that is too narrow.
 */
function panelBeside(sprite: Box, hudW: number, hudH: number, width: number, top: number, bodyH: number): Box | undefined {
  const right = width - (sprite.x + sprite.w) - 1
  const left = sprite.x - 1
  const compact = Math.min(hudW, Math.floor((width - sprite.w - 2) / 2))
  if (compact < Math.min(MIN_PANEL, hudW)) return undefined
  const w = right >= hudW || left >= hudW ? hudW : compact
  const useRight = right >= w
  return { x: useRight ? sprite.x + sprite.w + 1 : sprite.x - 1 - w, y: Math.max(top, Math.min(sprite.y, top + bodyH - hudH)), w, h: hudH }
}

export interface BounceLayout {
  sprite: Box
  /** The sprite is drawn (false in the panel half of the alternation). */
  showSprite: boolean
  panel?: Box
  size: 'large' | 'small'
  showLogo: boolean
  dx: 1 | -1
  dy: 1 | -1
  walls: number
}

/** Where Bounce puts everything this frame (exported for the tests). */
export function bounceLayout(input: SaverInput): BounceLayout {
  const top = 1
  const bodyH = input.height - 2
  const sprite = bounceSprite(bodyH, input.width, nameLogo(input))
  const hud = hudSize(input, input.width - 2, bodyH)
  const step = Math.floor(input.now / FRAME_MILLIS)
  const ystep = Math.floor(step / 2)
  const maxX = Math.max(0, input.width - sprite.w)
  const maxY = Math.max(0, bodyH - sprite.h)
  const box: Box = { x: bounce(step, maxX), y: top + bounce(ystep, maxY), w: sprite.w, h: sprite.h }
  const base = {
    size: sprite.size, showLogo: sprite.logo, dx: direction(step, maxX), dy: direction(ystep, maxY),
    // a new colour at each wall, as the DVD logo did
    walls: (maxX ? Math.floor(step / maxX) : 0) + (maxY ? Math.floor(ystep / maxY) : 0),
  }
  const hasPanel = hud.h >= 3 && hud.w >= 12
  if (!input.burnin || !hasPanel) {
    return { ...base, sprite: box, showSprite: true, panel: hasPanel ? { x: input.width - hud.w - 1, y: top + bodyH - hud.h, w: hud.w, h: hud.h } : undefined }
  }
  if (Math.floor((input.width - sprite.w - 2) / 2) >= Math.min(MIN_PANEL, hud.w)) {
    const panel = panelBeside(box, hud.w, hud.h, input.width, top, bodyH)
    if (panel) return { ...base, sprite: box, showSprite: true, panel }
  }
  // tall and narrow: the panel under Query, the two drifting as one box
  if (hud.w <= input.width - 2 && sprite.h + 1 + hud.h <= bodyH) {
    const gw = Math.max(sprite.w, hud.w)
    const gh = sprite.h + 1 + hud.h
    const mx = Math.max(0, input.width - gw)
    const my = Math.max(0, bodyH - gh)
    const gx = bounce(step, mx)
    const gy = top + bounce(ystep, my)
    return {
      ...base, dx: direction(step, mx), dy: direction(ystep, my), walls: (mx ? Math.floor(step / mx) : 0) + (my ? Math.floor(ystep / my) : 0),
      sprite: { x: gx + Math.floor((gw - sprite.w) / 2), y: gy, w: sprite.w, h: sprite.h }, showSprite: true,
      panel: { x: gx + Math.floor((gw - hud.w) / 2), y: gy + sprite.h + 1, w: hud.w, h: hud.h },
    }
  }
  // too small for both: the panel for 20 s, then Query for 20 s, each drifting
  if (Math.floor(input.now / ALTERNATE_MILLIS) % 2 === 0) {
    const panel = { x: bounce(step, Math.max(0, input.width - hud.w)), y: top + bounce(ystep, Math.max(0, bodyH - hud.h)), w: hud.w, h: hud.h }
    return { ...base, sprite: box, showSprite: false, panel }
  }
  return { ...base, sprite: box, showSprite: true }
}

function drawQuery(c: Canvas, x: number, y: number, size: 'large' | 'small', pose: QueryPose, input: SaverInput, color: string): void {
  c.block(x, y, queryFrame(size, pose, input.ascii), { fg: color, bold: true })
}

function paintBounce(c: Canvas, input: SaverInput): Box {
  const t = input.theme
  const top = 1
  const layout = bounceLayout(input)
  const { sprite: box } = layout
  if (layout.showSprite) {
    const colors = palette(t)
    const color = colors[layout.walls % colors.length]!
    const pose = queryPoseAt(input.now, { dx: layout.dx, dy: layout.dy })
    const q = querySize(layout.size)
    const qx = box.x + Math.floor((box.w - q.width) / 2)
    const qy = box.y + (pose.dy < 0 && box.y > top ? -1 : 0)
    drawQuery(c, qx, qy, layout.size, pose, input, color)
    if (pose.action) {
      const bubble = 'woof!'
      const bx = pose.facing === 'right' ? qx + q.width - 2 : qx - bubble.length + 2
      c.put(Math.min(Math.max(0, bx), input.width - bubble.length), Math.max(top, qy - 1), bubble, { fg: t.acc2, bold: true })
    }
    if (layout.showLogo) {
      const logo = nameLogo(input)
      const ly = box.y + q.height + 1
      const rowsW = Math.max(...logo.rows.map((r) => [...r].length))
      c.block(box.x + Math.floor((box.w - rowsW) / 2), ly, logo.rows, { fg: color, bold: !logo.block })
      c.put(box.x + Math.floor((box.w - logo.host.length) / 2), ly + logo.rows.length, logo.host, { fg: t.dim })
    }
  }
  if (layout.panel) drawHud(c, layout.panel.x, layout.panel.y, layout.panel.w, layout.panel.h, input)
  // everything drawn, for the lines that sit just above and below it (a row more above for the hop and the bubble)
  const parts = [layout.showSprite ? { ...box, y: Math.max(top, box.y - 1), h: box.h + (box.y > top ? 1 : 0) } : undefined, layout.panel].filter((b): b is Box => Boolean(b))
  const x0 = Math.min(...parts.map((b) => b.x))
  const y0 = Math.min(...parts.map((b) => b.y))
  return { x: x0, y: y0, w: Math.max(...parts.map((b) => b.x + b.w)) - x0, h: Math.max(...parts.map((b) => b.y + b.h)) - y0 }
}

/** A deterministic 0…1 value for a seed (the star field). */
function rand(seed: number): number {
  const x = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

function paintStarfield(c: Canvas, input: SaverInput): Box {
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
  return { x: hx, y: hy, w: hud.w, h: hud.h }
}

/** Whether the flip clock is mid-flip (the first 500 ms of a minute). */
function flipping(now: number): boolean {
  return now % 60_000 < 500
}

function hhmm(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`
}

/** A slow drift: one cell every `periodMs`, back and forth over −r…r (0 when the guard is off or there is no slack). */
function drift(input: SaverInput, periodMs: number, r: number): number {
  return input.burnin && r > 0 ? bounce(Math.floor(input.now / periodMs), 2 * r) - r : 0
}

/** Tile lines in columns from (x, y), each `colW` wide; returns the rows used. */
function tileBlock(c: Canvas, x: number, y: number, tiles: SaverTile[], columns: number, colW: number, rows: number, input: SaverInput): void {
  tiles.slice(0, rows * columns).forEach((tile, i) => {
    const col = columns === 2 ? i % 2 : 0
    const row = columns === 2 ? Math.floor(i / 2) : i
    tileLine(c, x + col * (colW + 3), y + row, colW, tile, input)
  })
}

/**
 * Flip clock: the cards, the date and server, the tiles beneath and Query beside them are one
 * group, centred (and, guarded, drifting a cell every few seconds inside the room that is left).
 */
function paintFlip(c: Canvas, input: SaverInput): Box {
  const t = input.theme
  const bodyH = input.height - 2
  const now = hhmm(input.now)
  const before = hhmm(input.now - (input.now % 60_000) - 1)
  const half = flipping(input.now) && input.now % 60_000 < 250
  const q = querySize('small')
  const columns = input.tiles.length > 1 && input.width >= 100 ? 2 : 1
  const wantRows = Math.ceil(input.tiles.length / columns)
  // double-size digits when the screen has room for them and the tiles
  // Query sits beside a single column of tiles and under two columns
  const queryBeside = columns === 1
  const reserve = queryBeside ? Math.max(wantRows, q.height) : wantRows + 1 + q.height
  const scale = input.width >= 80 && bodyH >= FONT_HEIGHT * 2 + 2 + 5 + reserve ? 2 : 1
  const glyphW = 4 * scale
  const cardW = glyphW + 2
  const cardH = FONT_HEIGHT * scale + 2
  const gap = 1
  const colonW = 1 + 2 * scale
  const total = cardW * 4 + gap * 2 + colonW
  const date = trunc(new Date(input.now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), input.width - 4)
  const host = trunc(`${input.server} · ${input.profile}`, input.width - 4)
  // the tiles with Query beside them, bottom-aligned
  const colW = Math.max(0, Math.min(columns === 2 ? 43 : 56, Math.floor((input.width - 6 - q.width - 3 - (columns - 1) * 3) / columns)))
  const tilesW = input.tiles.length ? columns * colW + (columns - 1) * 3 : 0
  const blockW = input.tiles.length ? (queryBeside ? tilesW + 3 + q.width : Math.max(tilesW, q.width)) : q.width
  const rowsCap = Math.max(1, bodyH - (cardH + 4) - (queryBeside ? 0 : q.height + 1))
  const tileRows = Math.min(wantRows, rowsCap)
  const blockH = queryBeside ? Math.min(Math.max(tileRows, q.height), rowsCap) : tileRows + 1 + q.height
  const groupW = Math.min(input.width, Math.max(total + 3, date.length, host.length, blockW))
  const groupH = Math.min(bodyH, cardH + 4 + blockH)
  const slackX = input.width - groupW
  const slackY = bodyH - groupH
  const gx = Math.max(0, Math.floor(slackX / 2) + drift(input, 4000, Math.min(4, Math.floor(slackX / 2))))
  const gy = 1 + Math.max(0, Math.floor(slackY / 2) + drift(input, 7000, slackY >= 2 ? 1 : 0))
  const x0 = gx + Math.floor((groupW - total) / 2)
  const y0 = gy
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
  let y = y0 + cardH + 1
  for (const [text, style] of [[date, { fg: t.acc, bold: true }], [host, { fg: t.dim }]] as Array<[string, Style]>) {
    c.put(gx + Math.floor((groupW - text.length) / 2), y++, text, style)
  }
  y++
  const bx = gx + Math.floor((groupW - blockW) / 2)
  if (input.tiles.length) tileBlock(c, bx, y, input.tiles, columns, colW, tileRows, input)
  // Query peeks up beside the tiles: ears and eyes, all of him when he hops
  const pose = queryPoseAt(input.now, { dx: -1 })
  const shown = Math.min(blockH, pose.action ? q.height : 3)
  const frame = queryFrame('small', pose, input.ascii).slice(0, shown)
  const qx = input.tiles.length && queryBeside ? bx + tilesW + 3 : bx + Math.floor((blockW - q.width) / 2)
  const qy = y + blockH - shown
  c.fill(qx, qy, q.width, shown, {})
  c.block(qx, qy, frame, { fg: t.acc2, bold: true })
  return { x: gx, y: gy, w: groupW, h: groupH }
}

/**
 * Big numbers: the metric's name, the number in block digits with Query beside it (below it when the
 * screen is too narrow for both), the caption, the page dots and the other tiles beneath are ONE group,
 * laid out together and centred; guarded, the group moves as a unit between four spots around the
 * centre, one per 8 s rotation, always fully on screen.
 */
const BIG_OFFSETS: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, 1], [1, -1], [-1, 1]]

function paintBig(c: Canvas, input: SaverInput): Box {
  const t = input.theme
  const bodyH = input.height - 2
  const candidates = input.tiles
    .filter((x) => x.state.value?.big !== undefined)
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (b.x.state.value!.interest ?? 0) - (a.x.state.value!.interest ?? 0) || a.i - b.i)
    .map((e) => e.x)
  const q = querySize('small')
  const rotation = Math.floor(input.now / 8000)
  // compact: the stack is at most about 90 columns wide, however wide the screen
  const avail = Math.min(input.width - 4, 90)
  const pose0 = queryPoseAt(input.now, { dx: 1 })
  const tile = candidates.length ? candidates[rotation % candidates.length]! : undefined
  const others = tile ? input.tiles.filter((x) => x !== tile) : []
  const columns = others.length > 1 && input.width >= 100 ? 2 : 1
  // the tile block is as wide as its longest line (so one tile sits centred under the number)
  const natural = Math.max(24, ...others.map((o) => tileNaturalWidth(o, input.ramp)))
  const colW = Math.max(0, Math.min(natural, columns === 2 ? 43 : 56, Math.floor((avail - (columns - 1) * 3) / columns)))
  const tilesW = others.length ? columns * colW + (columns - 1) * 3 : 0

  // the parts, top to bottom, each with its own width
  const label = tile ? trunc(tile.state.label.toUpperCase(), avail) : ''
  const v = tile?.state.value
  const big = v?.big ?? ''
  const asleep = big === '0'
  const msg = input.tiles.length ? 'fetching the numbers…' : 'nothing to count on this server'
  const drawBlock = Boolean(tile) && canDraw(big) && blockWidth(big) <= avail
  const numW = tile ? (drawBlock ? blockWidth(big) : big.length) : 0
  const numH = drawBlock ? FONT_HEIGHT : 1
  // Query beside the number when both fit, else below it
  const beside = !tile || q.width + 3 + numW <= avail
  const heroW = !tile ? q.width : beside ? q.width + 3 + numW : Math.max(q.width, numW)
  const heroH = !tile ? q.height : beside ? Math.max(q.height, numH) : numH + 1 + q.height
  const caption = tile ? trunc(`${v!.value}${v!.detail ? ` · ${v!.detail}` : ''}${tile.stale ? ' (stale)' : ''}`, avail) : trunc(msg, avail)
  const dots = candidates.length > 1 ? trunc(candidates.map((_, i) => (i === rotation % candidates.length ? (input.ascii ? '*' : '●') : (input.ascii ? '.' : '○'))).join(' '), avail) : ''
  const fixedH = (tile ? 2 : 0) + heroH + 1 + 1 + (dots ? 1 : 0)
  const rowsCap = Math.max(0, bodyH - fixedH - 1)
  const tileRows = others.length ? Math.min(Math.ceil(others.length / columns), rowsCap) : 0
  const groupW = Math.min(input.width, Math.max(label.length, heroW, caption.length, dots.length, tileRows ? tilesW : 0))
  const groupH = Math.min(bodyH, fixedH + (tileRows ? 1 + tileRows : 0))

  // where: centred; guarded, offset by up to a tenth of the width and an eighth of the height, never off the screen
  const slackX = input.width - groupW
  const slackY = bodyH - groupH
  const [sx, sy] = input.burnin ? BIG_OFFSETS[rotation % BIG_OFFSETS.length]! : [0, 0]
  const rx = Math.min(Math.floor(slackX / 2), Math.floor(input.width / 10))
  const ry = Math.min(Math.floor(slackY / 2), Math.floor(bodyH / 8))
  const gx = Math.max(0, Math.floor(slackX / 2) + sx * rx)
  const gy = 1 + Math.max(0, Math.floor(slackY / 2) + sy * ry)
  const centred = (width: number) => gx + Math.floor((groupW - width) / 2)

  let y = gy
  if (tile) {
    c.put(centred(label.length), y, label, { fg: t.acc, bold: true })
    y += 2
  }
  const color = tile ? (levelColor(t, tile) === t.fg ? t.acc2 : levelColor(t, tile)) : t.acc2
  const heroX = centred(heroW)
  if (!tile) {
    drawQuery(c, heroX, y, 'small', queryPoseAt(input.now), input, t.acc2)
  } else {
    const pose: QueryPose = { ...pose0, ...(asleep ? { blink: true, wag: false } : {}) }
    const numberAt = (x: number, ny: number) => {
      if (drawBlock) c.block(x, ny, blockText(big, input.ascii), { fg: color, bold: true })
      else c.put(x, ny, big, { fg: color, bold: true })
    }
    if (beside) {
      drawQuery(c, heroX, y, 'small', pose, input, t.acc2)
      if (asleep) c.put(heroX + q.width - 1, y - 1, input.now % 2000 < 1000 ? 'z' : 'zZ', { fg: t.dim })
      numberAt(heroX + q.width + 3, y + Math.floor((heroH - numH) / 2))
    } else {
      numberAt(heroX + Math.floor((heroW - numW) / 2), y)
      drawQuery(c, heroX + Math.floor((heroW - q.width) / 2), y + numH + 1, 'small', pose, input, t.acc2)
      if (asleep) c.put(heroX + Math.floor((heroW + q.width) / 2) - 1, y + numH, input.now % 2000 < 1000 ? 'z' : 'zZ', { fg: t.dim })
    }
  }
  y += heroH + 1
  c.put(centred(caption.length), y++, caption, { fg: t.dim })
  if (dots) c.put(centred(dots.length), y++, dots, { fg: t.dim })
  if (tileRows) tileBlock(c, centred(tilesW), y + 1, others, columns, colW, tileRows, input)
  return { x: gx, y: gy, w: groupW, h: groupH }
}

export interface SaverFrame {
  canvas: Canvas
  /** What the style drew as one group (the header and lock line sit just above and below it). */
  group: Box
  chrome: ChromeLayout
}

/** One frame with its group box and where the header and lock line went (the tests read these). */
export function saverFrame(input: SaverInput): SaverFrame {
  const t = input.theme
  const c = new Canvas(input.width, input.height, { bg: t.overlayBg, fg: t.fg })
  if (input.width < 20 || input.height < 6) {
    c.put(0, 0, trunc(new Date(input.now).toLocaleTimeString('en-GB'), input.width), { fg: t.acc2 })
    return { canvas: c, group: { x: 0, y: 0, w: input.width, h: 1 }, chrome: chromeLayout({ ...input, burnin: false }) }
  }
  const group = input.style === 'bounce' ? paintBounce(c, input) : input.style === 'starfield' ? paintStarfield(c, input) : input.style === 'flip' ? paintFlip(c, input) : paintBig(c, input)
  const chrome = chromeLayout(input, group)
  header(c, input, chrome)
  footer(c, input, chrome)
  drawPin(c, input)
  if (input.dim) c.dim(DIM_AMOUNT)
  return { canvas: c, group, chrome }
}

/** One frame of the saver. */
export function paintSaver(input: SaverInput): Canvas {
  return saverFrame(input).canvas
}
