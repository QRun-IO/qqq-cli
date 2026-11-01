/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The F1 / `?` keyboard reference: only keys, grouped by what they do, for the screen on top.
 * It lists no commands and no places to go: `/` searches everything (apps, tables, processes,
 * widgets, records, commands), F9 is the structured menu, `:` the command line.
 */

export type KeyRow = [keys: string, what: string]

export interface KeyGroup {
  title: string
  keys: KeyRow[]
}

/** The one line under the keys that points at the three ways to find and run things. */
export const HELP_POINTER = 'F2 search records · / find anything · F9 menu · : command line'

const ANYWHERE: KeyRow[] = [
  ['F1  ?', 'this keyboard reference'],
  ['F2', 'Search: records across tables (quick search); :search <text>'],
  ['/  .  Ctrl+K', 'find: apps, tables, processes, widgets, records, commands'],
  ['F9', 'menu: areas, then their actions'],
  ['Ctrl+O', 'servers: switch, add, edit'],
  [':', 'command line; Tab completes, ↑↓ history'],
  ['F10', 'quit, reset or cancel'],
  ['Ctrl+C', 'quit now'],
  ['Esc 1..0  Ctrl+1..0', 'F1..F10 when the terminal takes them'],
]

const MOVE: KeyRow[] = [
  ['↑↓  PgUp PgDn', 'move, page'],
  ['Ctrl+F  Ctrl+B', 'page (always works)'],
  ['Space  S+Space', 'page lists'],
  ['Home  End', 'first, last'],
  ['← →', 'columns, tree'],
  ['Tab', 'Apps tree / content'],
  ['Esc', 'back, cancel'],
]

/** The mouse, shown after the screen's help while the mouse is on (F9 › Settings › Mouse). */
export const MOUSE_KEYS: KeyGroup = {
  title: 'Mouse (F9 › Settings › Mouse: off for plain text selection)',
  keys: [
    ['Click', 'select, focus, F-key'],
    ['Double-click', 'open, run, fold'],
    ['Right click', 'actions at the row'],
    ['Wheel', '3 lines; Shift: columns'],
    ['Drag grid header', 'resize, move column'],
    ['Shift+drag', 'select text (Alt in some)'],
  ],
}

/** Whether a key only works with single-key shortcuts on (a bare letter or symbol). */
function singleKey(keys: string): boolean {
  const last = keys.trim().split(/\s+/).pop() ?? ''
  return /^[A-Za-z\]\[]$/.test(last) && !/F\d|Ctrl|Enter|Esc|Tab|Space|Home|PgUp|PgDn/.test(keys)
}

/**
 * The key groups for a screen kind. `screenKeys` are the screen's own shortcuts (from its actions:
 * label and key), shown as keys only; with single-key shortcuts off, bare-letter keys are left out.
 */
export function helpKeyGroups(kind: string | undefined, singleKeys: boolean, screenKeys: KeyRow[] = []): KeyGroup[] {
  const groups: KeyGroup[] = [{ title: 'Anywhere', keys: ANYWHERE }, { title: 'Move', keys: MOVE }]
  const change: KeyRow[] = []
  if (kind === 'table' || kind === 'record' || kind === 'app' || kind === 'home' || kind === 'output' || kind === 'search') change.push(['F3  Enter', 'open, view'])
  if (kind === 'table' || kind === 'record') change.push(['F4  e', 'edit'], ['F7  n', 'new record'], ['F8  d', 'delete (asks)'], ['c', 'copy into a new record'])
  if (kind === 'record') change.push([']  [  PgDn PgUp', 'next / previous record'])
  if (kind === 'form') change.push(['Ctrl+S', 'save'], ['Tab  ↑↓', 'next field'], ['Ctrl+E', 'edit a long value in $EDITOR'])
  if (kind === 'process') change.push(['Ctrl+S  F10', 'next step / submit'], ['Tab  ↑↓', 'next field'])
  if (kind === 'form' || kind === 'process' || kind === 'fields-form') change.push(['F2  Ctrl+Space', 'date field: calendar (t today, Tab time); :dates sets the format'])
  change.push(['F5  r', 'refresh'], ['a', 'actions here (the F9 Context section)'], ['v', 'view settings'])
  groups.push({ title: 'Open and change', keys: change })
  if (kind === 'table') {
    groups.push({ title: 'Find, sort and select', keys: [['F6  f', 'filter: rows of field, operator, value'], ['s', 'sort by the column'], ['g', 'go to a record by key'], ['Space', 'select the row'], ['b', 'run a process on the selection'], ['x', 'export']] })
  }
  // a screen key already listed above (F4, e, Space…) is not repeated
  const listed = new Set(groups.flatMap((g) => g.keys.flatMap(([k]) => k.split(/\s+/))))
  const seen = new Set<string>()
  const own = screenKeys.filter(([k]) => {
    const tokens = k.split(/\s+/).filter(Boolean)
    if (!tokens.length || tokens.every((x) => listed.has(x)) || seen.has(k)) return false
    seen.add(k)
    return true
  })
  if (own.length) groups.push({ title: 'On this screen', keys: own })
  return groups.map((g) => ({ ...g, keys: singleKeys ? g.keys : g.keys.filter(([k]) => !singleKey(k)) })).filter((g) => g.keys.length)
}
