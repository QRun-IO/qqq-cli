/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The grid's mouse handling (screens/table.tsx registers its header and rows with these): a click
 * puts the cursor on the row and cell, a double-click opens the record, a right click opens the
 * actions at that row, Shift+wheel moves across the columns, and on the header a drag at a column's
 * right edge resizes it while a drag elsewhere moves it. Widths and order are saved as the view
 * settings save them.
 */

import { readViewSettings, writeViewSettings, type ViewSettings } from '@qrun-io/qqq-core'
import type { AppStore } from '../store'
import { boundaryAt, columnAt, moved, resizedWidth } from './hit'
import type { ZoneEvent, ZoneHandlers } from './registry'

/** What the grid screen exposes to its mouse handling. */
export interface GridHost {
  readonly tableName: string
  view: ViewSettings
  colCursor: number
  rowsPage: number
  cursor?: { pageSize: number }
  fields(): Array<{ name: string; label: string }>
  moveTo(index: number): void
  openCurrent(): void
}

/** A column as drawn on this repaint. */
export interface ShownColumn {
  name: string
  label: string
  width: number
}

type Drag = { mode: 'resize'; name: string; base: number } | { mode: 'move'; name: string } | { mode: 'none' }

export class GridMouse {
  private drag?: Drag

  constructor(private grid: GridHost, private store: AppStore) {}

  private viewKey(): string {
    return `table:${this.grid.tableName}`
  }

  /** Puts the column cursor on the drawn column under local x. */
  private pickColumn(x: number, shown: ShownColumn[], all: ShownColumn[]): void {
    const i = columnAt(x, shown)
    if (i === undefined) return
    const at = all.findIndex((c) => c.name === shown[i]!.name)
    if (at >= 0) this.grid.colCursor = at
  }

  /** Shift+wheel (or a sideways wheel): three columns left or right. */
  private sideways(e: ZoneEvent, all: ShownColumn[]): boolean {
    if (e.direction !== 'left' && e.direction !== 'right') return false
    const step = e.direction === 'left' ? -e.lines : e.lines
    this.grid.colCursor = Math.max(0, Math.min(all.length - 1, this.grid.colCursor + step))
    return true
  }

  /** Handlers for data row `i` of the page on screen. */
  row(i: number, shown: ShownColumn[], all: ShownColumn[]): ZoneHandlers {
    const select = (e: ZoneEvent) => {
      const page = Math.max(0, this.grid.rowsPage)
      this.grid.moveTo(page * (this.grid.cursor?.pageSize ?? 0) + i)
      this.pickColumn(e.x, shown, all)
    }
    return {
      // the pane zone below focuses the grid
      onClick: (e) => {
        select(e)
        return false
      },
      onDouble: (e) => {
        select(e)
        this.grid.openCurrent()
      },
      // the pane zone below opens the actions, now at this row
      onRight: (e) => {
        select(e)
        return false
      },
      onWheel: (e) => this.sideways(e, all),
    }
  }

  /** Handlers for the header line. */
  header(shown: ShownColumn[], all: ShownColumn[]): ZoneHandlers {
    return {
      onClick: (e) => {
        this.drag = undefined
        this.pickColumn(e.x, shown, all)
        return false
      },
      onWheel: (e) => this.sideways(e, all),
      onDrag: (e) => {
        if (!this.drag) {
          const edge = boundaryAt(e.startX, shown)
          const under = columnAt(e.startX, shown)
          this.drag = edge !== undefined ? { mode: 'resize', name: shown[edge]!.name, base: shown[edge]!.width }
            : under !== undefined ? { mode: 'move', name: shown[under]!.name } : { mode: 'none' }
        }
        const d = this.drag
        if (d.mode === 'resize') {
          // live: the grid lays its columns out again from the view on the next repaint
          this.grid.view = { ...this.grid.view, widths: { ...(this.grid.view.widths ?? {}), [d.name]: resizedWidth(d.base, e.x - e.startX) } }
        }
      },
      onDrop: (e) => {
        const d = this.drag
        this.drag = undefined
        if (!d || d.mode === 'none') return
        if (d.mode === 'resize') {
          const width = this.grid.view.widths?.[d.name]
          if (width === undefined) return
          this.save({ widths: { ...(readViewSettings(this.viewKey()).widths ?? {}), [d.name]: width } })
          this.store.flash(`column ${label(all, d.name)}: width ${width} (saved in the view settings)`)
          return
        }
        const target = columnAt(e.x, shown)
        if (target === undefined || shown[target]!.name === d.name) return
        const order = this.grid.fields().map((f) => f.name)
        const from = order.indexOf(d.name)
        const to = order.indexOf(shown[target]!.name)
        if (from < 0 || to < 0) return
        const columns = moved(order, from, to)
        this.grid.view = { ...this.grid.view, columns }
        this.grid.colCursor = to
        this.save({ columns })
        this.store.flash(`column ${label(all, d.name)} moved (saved in the view settings)`)
      },
    }
  }

  private save(patch: Partial<ViewSettings>): void {
    writeViewSettings(this.viewKey(), { ...readViewSettings(this.viewKey()), ...patch })
  }
}

function label(cols: ShownColumn[], name: string): string {
  return cols.find((c) => c.name === name)?.label ?? name
}
