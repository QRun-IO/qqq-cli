/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Themes as token sets, and glyph sets (Unicode or ASCII). Every color the TUI draws comes from the
 * current token set; nothing else names a color. The choice is saved in ~/.config/qqq/config.json
 * through the kernel (readTheme / writeTheme).
 */

import type { BorderCharacters } from '@opentui/core'

export interface ThemeTokens {
  name: string
  label: string
  /** Normal text. */
  fg: string
  /** Inactive text (unfocused sidebar entries, hints): readable on the background, never dark grey on black. */
  dim: string
  /** Accent: headings, column headers. */
  acc: string
  /** Second accent: keys, highlights. */
  acc2: string
  ok: string
  warn: string
  err: string
  titleBg: string
  titleFg: string
  selBg: string
  selFg: string
  /** The selected row when its pane does not have focus. */
  selInactiveBg: string
  focusBorder: string
  border: string
  keyNum: string
  keyLabelBg: string
  keyLabelFg: string
  overlayBg: string
  statusBg: string
  statusFg: string
  zebraBg: string
  inputBg: string
  inputFg: string
  /** Marked (Space-selected) rows. */
  markFg: string
  /** Whether alternating rows are shaded unless the view settings say otherwise. */
  zebraByDefault: boolean
}

export const THEMES: Record<string, ThemeTokens> = {
  'high-contrast': {
    name: 'high-contrast', label: 'High contrast (bright text, strong accents)',
    fg: '#ffffff', dim: '#c6cbd1', acc: '#5fd7ff', acc2: '#ffd75f', ok: '#5fff87', warn: '#ffd75f', err: '#ff6b6b',
    titleBg: '#005f87', titleFg: '#ffffff', selBg: '#ffd75f', selFg: '#000000', selInactiveBg: '#4e4e4e',
    focusBorder: '#ffd75f', border: '#a8b0b8', keyNum: '#ffffff', keyLabelBg: '#005f87', keyLabelFg: '#ffff87',
    overlayBg: '#121212', statusBg: '#262626', statusFg: '#eeeeee', zebraBg: '#1c1c1c', inputBg: '#3a3a3a', inputFg: '#ffffff',
    markFg: '#5fff87', zebraByDefault: false,
  },
  classic: {
    name: 'classic', label: 'Classic (cyan title, yellow keys)',
    fg: '#d5dce5', dim: '#a0a8b0', acc: '#7cc2e8', acc2: '#ffd98a', ok: '#8bd49b', warn: '#f1c86e', err: '#ff9088',
    titleBg: '#1b6587', titleFg: '#ffffff', selBg: '#2d5f7c', selFg: '#ffffff', selInactiveBg: '#2a3540',
    focusBorder: '#7cc2e8', border: '#5a6a7a', keyNum: '#ffffff', keyLabelBg: '#1b6587', keyLabelFg: '#ffd98a',
    overlayBg: '#161d26', statusBg: '#10151b', statusFg: '#c0c8d0', zebraBg: '#18202a', inputBg: '#24313d', inputFg: '#ffffff',
    markFg: '#8bd49b', zebraByDefault: true,
  },
  light: {
    name: 'light', label: 'Light (for light terminal backgrounds)',
    fg: '#1a1a1a', dim: '#4e4e4e', acc: '#005f87', acc2: '#875f00', ok: '#1e7b34', warn: '#875f00', err: '#b00020',
    titleBg: '#005f87', titleFg: '#ffffff', selBg: '#005f87', selFg: '#ffffff', selInactiveBg: '#c6c6c6',
    focusBorder: '#005f87', border: '#6c6c6c', keyNum: '#000000', keyLabelBg: '#005f87', keyLabelFg: '#ffffff',
    overlayBg: '#f4f4f4', statusBg: '#dadada', statusFg: '#1a1a1a', zebraBg: '#ececec', inputBg: '#e0e0e0', inputFg: '#000000',
    markFg: '#1e7b34', zebraByDefault: true,
  },
}

export const DEFAULT_THEME = 'high-contrast'

export interface Glyphs {
  ellipsis: string
  up: string
  down: string
  bar: string
  spark: string
  pointer: string
  closed: string
  open: string
  mark: string
  unmark: string
  check: string
  uncheck: string
  radioOn: string
  radioOff: string
  sep: string
  rule: string
  process: string
  report: string
  app: string
  link: string
  border?: BorderCharacters
}

const UNICODE: Glyphs = {
  ellipsis: '…', up: '▲', down: '▼', bar: '█', spark: '▁▂▃▄▅▆▇█', pointer: '▶', closed: '▸', open: '▾', mark: '●', unmark: ' ',
  check: '[x]', uncheck: '[ ]', radioOn: '(•)', radioOff: '( )', sep: '│', rule: '─', process: '▷', report: '≡', app: '◆', link: '↗',
}

const ASCII_BORDER: BorderCharacters = { topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+', horizontal: '-', vertical: '|', topT: '+', bottomT: '+', leftT: '+', rightT: '+', cross: '+' }

const ASCII: Glyphs = {
  ellipsis: '~', up: '^', down: 'v', bar: '#', spark: ' .:-=+*#', pointer: '>', closed: '+', open: '-', mark: '*', unmark: ' ',
  check: '[x]', uncheck: '[ ]', radioOn: '(*)', radioOff: '( )', sep: '|', rule: '-', process: '>', report: '=', app: '*', link: '->', border: ASCII_BORDER,
}

let currentTheme: ThemeTokens = THEMES[DEFAULT_THEME]!
let currentGlyphs: Glyphs = UNICODE

export function theme(): ThemeTokens {
  return currentTheme
}

export function glyphs(): Glyphs {
  return currentGlyphs
}

/** Switches the theme; unknown names fall back to the default. Returns the theme in effect. */
export function setTheme(name: string | undefined): ThemeTokens {
  currentTheme = (name && THEMES[name]) || THEMES[DEFAULT_THEME]!
  return currentTheme
}

export function setAscii(ascii: boolean): void {
  currentGlyphs = ascii ? ASCII : UNICODE
}

export function isAscii(): boolean {
  return currentGlyphs === ASCII
}

/** Box border props for the current glyph set. */
export function borderProps(focused: boolean): { border: true; borderColor: string; customBorderChars?: BorderCharacters } {
  return { border: true, borderColor: focused ? currentTheme.focusBorder : currentTheme.border, ...(currentGlyphs.border ? { customBorderChars: currentGlyphs.border } : {}) }
}
