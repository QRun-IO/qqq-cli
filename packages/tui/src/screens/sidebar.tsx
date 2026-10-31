/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { AppTreeNode } from '../client'
import type { Key } from '../keys'
import { openNode } from '../nav'
import type { AppStore, SidebarLike } from '../store'
import { glyphs, theme } from '../theme'
import { pad } from '../util/text'
import { Panel } from './list'

export interface FlatNode {
  node: AppTreeNode
  depth: number
  expanded: boolean
  path: string
}

/** The visible nodes of the app tree, descending only into expanded nodes; order as the server gives it. */
export function flatten(nodes: AppTreeNode[], expanded: Set<string>, depth = 0, prefix = ''): FlatNode[] {
  const out: FlatNode[] = []
  for (const n of nodes) {
    const path = `${prefix}/${n.name}`
    const open = expanded.has(path)
    out.push({ node: n, depth, expanded: open, path })
    if (open && n.children?.length) out.push(...flatten(n.children, expanded, depth + 1, path))
  }
  return out
}

/** The Apps tree pane (left), from metadata appTree. */
export class Sidebar implements SidebarLike {
  expanded = new Set<string>()
  cursor = 0
  top = 0

  constructor(private store: AppStore) {
    for (const n of this.tree()) this.expanded.add(`/${n.name}`)
  }

  tree(): AppTreeNode[] {
    return (this.store.meta?.appTree ?? []) as AppTreeNode[]
  }

  onKey(key: Key): boolean {
    const flat = flatten(this.tree(), this.expanded)
    const cur = flat[this.cursor]
    switch (key.name) {
      case 'down': this.cursor = Math.min(flat.length - 1, this.cursor + 1); return true
      case 'up': this.cursor = Math.max(0, this.cursor - 1); return true
      case 'pagedown': this.cursor = Math.min(flat.length - 1, this.cursor + 10); return true
      case 'pageup': this.cursor = Math.max(0, this.cursor - 10); return true
      case 'home': this.cursor = 0; return true
      case 'end': this.cursor = flat.length - 1; return true
      case 'right':
        if (cur?.node.children?.length) this.expanded.add(cur.path)
        return true
      case 'left':
        if (cur?.expanded) this.expanded.delete(cur.path)
        else if (cur && cur.depth > 0) this.cursor = Math.max(0, flat.findIndex((f) => f.path === cur.path.slice(0, cur.path.lastIndexOf('/'))))
        return true
      case 'space':
        if (cur?.node.children?.length) {
          if (cur.expanded) this.expanded.delete(cur.path)
          else this.expanded.add(cur.path)
        }
        return true
      case 'return':
        if (!cur) return true
        openNode(this.store, cur.node)
        return true
      default:
        return false
    }
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    const g = glyphs()
    const flat = flatten(this.tree(), this.expanded)
    const inner = height - 2
    if (this.cursor < this.top) this.top = this.cursor
    if (this.cursor >= this.top + inner) this.top = this.cursor - inner + 1
    const current = (this.store.screen as { tableName?: string; processName?: string; appName?: string } | undefined)
    const here = current?.tableName ?? current?.processName ?? current?.appName
    const lines = flat.slice(this.top, this.top + inner).map((f, i) => {
      const idx = this.top + i
      const glyph = f.node.children?.length ? (f.expanded ? g.open : g.closed) + ' ' : '  '
      const marker = f.node.type === 'PROCESS' ? g.process + ' ' : f.node.type === 'REPORT' ? g.report + ' ' : ''
      const text = pad(' '.repeat(f.depth) + glyph + marker + f.node.label, width - 3) + (f.node.name === here ? '◂' : ' ')
      const sel = idx === this.cursor
      return <text key={f.path} fg={sel && focused ? t.selFg : f.node.type === 'APP' ? t.fg : t.dim} bg={sel ? (focused ? t.selBg : t.selInactiveBg) : undefined}>{text}</text>
    })
    while (lines.length < inner) lines.push(<text key={`p${lines.length}`}>{pad('', width - 2)}</text>)
    return <Panel title={focused ? 'Apps' : 'Apps (Tab)'} width={width} height={height} focused={focused}>{lines}</Panel>
  }
}
