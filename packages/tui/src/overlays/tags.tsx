/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { Collaboration, type TagEntry } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { LineEditor } from '../line-editor'
import type { AppStore } from '../store'
import { theme } from '../theme'
import type { Overlay } from '../types'
import { errorText, pad } from '../util/text'
import { EditorLine, overlayId } from './basic'
import { Frame, Line } from './frame'
import { pickRow } from '../mouse/keys'
import { Zone } from '../mouse/zone'

/** The collaboration client of the store's server (undefined without the extension). */
export function collaborationOf(store: AppStore): Collaboration | undefined {
  if (!store.client || !store.extensions.has('collaboration')) return undefined
  const client = store.client
  return new Collaboration(store.extensions.registry, { call: (id, input) => client.call(id, input) })
}

/**
 * The tag editor of a record (collaboration extension): the record's tags (Delete removes one),
 * the table's vocabulary searched as you type (Enter adds), and "create" for a new label (a
 * suggestion on tables that take approved tags only). Esc goes back to where it was opened.
 */
export class TagOverlay implements Overlay {
  readonly id = overlayId('tags')
  readonly search = new LineEditor('')
  applied: TagEntry[] = []
  vocabulary: TagEntry[] = []
  focus: 'applied' | 'vocabulary' = 'vocabulary'
  index = 0
  message = ''
  private timer?: ReturnType<typeof setTimeout>

  constructor(private store: AppStore, private collab: Collaboration, readonly table: string, readonly pk: string, private onChange: (tags: TagEntry[]) => void) {
    this.reload()
    this.find()
  }

  reload(): void {
    this.collab.recordTags(this.table, this.pk).then((t) => { this.applied = t }).catch((e) => { this.message = errorText(e) }).finally(() => this.store.bump())
  }

  find(): void {
    this.collab.tags(this.table, this.search.value || undefined, 50).then((t) => { this.vocabulary = t }).catch((e) => { this.message = errorText(e) }).finally(() => this.store.bump())
  }

  choices(): Array<{ label: string; tag?: TagEntry; create?: string }> {
    const appliedIds = new Set(this.applied.map((t) => t.id))
    const list: Array<{ label: string; tag?: TagEntry; create?: string }> = this.vocabulary.filter((t) => !appliedIds.has(t.id)).map((t) => ({ label: `${t.label ?? t.name}${t.approved === false ? '  (pending approval)' : ''}${t.tableName ? '' : '  (global)'}`, tag: t }))
    const text = this.search.value.trim()
    if (text && !this.vocabulary.some((t) => (t.label ?? '').toLowerCase() === text.toLowerCase())) list.push({ label: `+ Create tag "${text}"`, create: text })
    return list
  }

  change(add: number[], remove: number[]): void {
    this.collab.applyTags(this.table, this.pk, { add, remove }).then((t) => {
      this.applied = t
      this.onChange(t)
      this.message = add.length ? 'added' : 'removed'
    }).catch((e) => { this.message = errorText(e) }).finally(() => this.store.bump())
  }

  onKey(key: Key): void {
    if (key.name === 'escape') return this.store.closeOverlay(this)
    if (key.name === 'tab') {
      this.focus = this.focus === 'applied' ? 'vocabulary' : 'applied'
      this.index = 0
      return
    }
    const list = this.focus === 'applied' ? this.applied : this.choices()
    if (key.name === 'down') this.index = Math.min(list.length - 1, this.index + 1)
    else if (key.name === 'up') this.index = Math.max(0, this.index - 1)
    else if (this.focus === 'applied' && (key.name === 'delete' || key.name === 'backspace' || key.name === 'return')) {
      const t = this.applied[this.index]
      if (t?.id !== undefined) this.change([], [t.id])
    } else if (this.focus === 'vocabulary' && key.name === 'return') {
      const c = this.choices()[this.index]
      if (c?.tag?.id !== undefined) {
        if (c.tag.approved === false) this.message = 'a pending tag cannot be applied until it is approved'
        else this.change([c.tag.id], [])
      } else if (c?.create) {
        this.collab.createTag(this.table, c.create).then((t) => {
          if (t.approved === false) this.message = `"${c.create}" was suggested; it can be applied once approved`
          else if (t.id !== undefined) this.change([t.id], [])
          this.search.set('')
          this.find()
        }).catch((e) => { this.message = errorText(e) }).finally(() => this.store.bump())
      }
    } else if (this.focus === 'vocabulary' && this.search.handle(key)) {
      this.index = 0
      clearTimeout(this.timer)
      this.timer = setTimeout(() => this.find(), 200)
    }
  }

  render(sw: number, sh: number) {
    const t = theme()
    const width = Math.min(sw - 4, 80)
    const inner = width - 2
    const choices = this.choices()
    const rows = Math.max(3, Math.min(8, Math.floor((sh - 14) / 2)))
    const line = (text: string, sel: boolean, fg = t.fg) => <text flexShrink={0} wrapMode="none" fg={sel ? t.selFg : fg} bg={sel ? t.selBg : undefined}>{pad(` ${text}`, inner)}</text>
    return (
      <Frame title={`Tags · ${this.store.meta?.tables?.[this.table]?.label ?? this.table} ${this.pk}`} width={width} height={rows * 2 + 9} screenWidth={sw} screenHeight={sh}>
        <Line text={` On this record${this.focus === 'applied' ? '  (Delete or Enter removes)' : ''}`} width={inner} fg={t.acc} />
        {this.applied.length ? this.applied.slice(0, rows).map((tag, i) => <Zone key={`a${i}`} {...pickRow(() => { this.focus = 'applied'; this.index = i }, () => this.onKey({ name: 'return', sequence: '' }))}><box height={1}>{line(`${tag.label ?? tag.name}${tag.color ? `  [${tag.color}]` : ''}`, this.focus === 'applied' && i === this.index)}</box></Zone>) : <Line text="  (no tags)" width={inner} fg={t.dim} />}
        {Array.from({ length: Math.max(0, rows - Math.max(1, this.applied.length)) }, (_, i) => <Line key={`pa${i}`} text="" width={inner} />)}
        <Line text={' Add a tag  (type to search; Enter adds)'} width={inner} fg={t.acc} />
        <box paddingLeft={1}><EditorLine editor={this.search} width={inner - 2} focused={this.focus === 'vocabulary'} placeholder="search or name a new tag" /></box>
        {choices.slice(0, rows).map((c, i) => <Zone key={`v${i}`} {...pickRow(() => { this.focus = 'vocabulary'; this.index = i }, () => this.onKey({ name: 'return', sequence: '' }))}><box height={1}>{line(c.label, this.focus === 'vocabulary' && i === this.index, c.create ? t.acc2 : t.fg)}</box></Zone>)}
        {Array.from({ length: Math.max(0, rows - choices.length) }, (_, i) => <Line key={`pv${i}`} text="" width={inner} />)}
        <Line text={` ${this.message}`} width={inner} fg={/fail|cannot|denied|error|not /i.test(this.message) ? t.err : t.dim} />
        <Line text=" Tab switches lists · Esc back · renaming or deleting tags is not in the UI API" width={inner} fg={t.dim} />
      </Frame>
    )
  }
}
