/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { completePath, createFolder, expandPath, formatSize, listDirectory, safeFileName, writeFilePreferences, type DirEntry } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { LineEditor } from '../line-editor'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { Overlay } from '../types'
import { errorText, pad, trunc } from '../util/text'
import { ConfirmOverlay, EditorLine, PromptOverlay, overlayId } from './basic'
import { Frame, Line } from './frame'

export interface FileDialogOptions {
  /** open: pick an existing file; save: choose a folder and a file name; folder: pick a directory. */
  mode: 'open' | 'save' | 'folder'
  title: string
  startDir: string
  /** Save: the suggested name (sanitized with the kernel's safeFileName). */
  fileName?: string
  onPick: (path: string) => void
}

/**
 * A keyboard file navigator: directories first with sizes and dates, typing filters, Backspace or
 * `..` goes up, a path line with Tab completion, `h` hidden files, `~` home, Ctrl+N new folder,
 * and for saves a file name line that warns before overwriting. The listing and completion come
 * from the kernel (files/navigator), so this is only drawing and keys.
 */
export class FileDialog implements Overlay {
  readonly id = overlayId('files')
  dir: string
  entries: DirEntry[] = []
  index = 0
  hidden = false
  focus: 'list' | 'path' | 'name' = 'list'
  readonly filter = new LineEditor('')
  readonly path: LineEditor
  readonly name: LineEditor
  error?: string
  candidates: string[] = []

  constructor(private store: AppStore, readonly options: FileDialogOptions) {
    this.dir = existsSync(options.startDir) ? options.startDir : process.cwd()
    this.path = new LineEditor(this.dir)
    this.name = new LineEditor(options.fileName ? safeFileName(options.fileName) : '')
    if (options.mode === 'save') this.focus = 'name'
    this.load()
  }

  load(): void {
    try {
      this.entries = listDirectory(this.dir, { hidden: this.hidden })
      this.error = undefined
    } catch (e) {
      this.entries = []
      this.error = errorText(e)
    }
    this.path.set(this.dir)
    this.index = 0
  }

  rows(): Array<DirEntry | { name: '..'; up: true } | { name: string; select: true }> {
    const needle = this.filter.value.toLowerCase()
    const list = this.entries.filter((e) => (this.options.mode !== 'folder' || e.isDir) && (!needle || e.name.toLowerCase().includes(needle)))
    const head: Array<{ name: '..'; up: true } | { name: string; select: true }> = []
    if (this.options.mode === 'folder' && !needle) head.push({ name: '[ select this folder ]', select: true })
    if (dirname(this.dir) !== this.dir && !needle) head.push({ name: '..', up: true })
    return [...head, ...list]
  }

  go(dir: string): void {
    this.dir = dir
    this.filter.set('')
    this.load()
  }

  pick(path: string): void {
    const remember = this.options.mode === 'open' ? { lastUploadDir: dirname(path) } : { lastDownloadDir: this.options.mode === 'folder' ? path : dirname(path) }
    try {
      writeFilePreferences(remember)
    } catch {
      // not critical
    }
    this.store.closeOverlay(this)
    this.options.onPick(path)
  }

  save(): void {
    const name = this.name.value.trim()
    if (!name) {
      this.error = 'type a file name'
      return
    }
    let target: string
    try {
      target = join(this.dir, safeFileName(name))
    } catch (e) {
      this.error = errorText(e)
      return
    }
    if (existsSync(target)) this.store.open(new ConfirmOverlay(this.store, `${target} exists. Overwrite it?`, () => this.pick(target)))
    else this.pick(target)
  }

  onKey(key: Key): void {
    if (key.name === 'escape') return this.store.closeOverlay(this)
    if (key.name === 'tab') {
      if (this.focus === 'path' && !key.shift) {
        const r = completePath(this.path.value, { hidden: this.hidden, directoriesOnly: this.options.mode === 'folder' })
        this.path.set(r.text)
        this.candidates = r.candidates.length > 1 ? r.candidates : []
        if (r.candidates.length === 1 && r.text.endsWith('/') && existsSync(expandPath(r.text))) this.go(expandPath(r.text))
        return
      }
      const order: Array<'list' | 'path' | 'name'> = this.options.mode === 'save' ? ['name', 'list', 'path'] : ['list', 'path']
      this.focus = order[(order.indexOf(this.focus) + (key.shift ? order.length - 1 : 1)) % order.length]!
      return
    }
    if (key.ctrl && key.name === 'n' && this.options.mode !== 'open') {
      this.store.open(new PromptOverlay(this.store, 'New folder', `In ${this.dir}`, (name) => {
        try {
          this.go(createFolder(this.dir, name))
        } catch (e) {
          this.error = errorText(e)
        }
      }))
      return
    }
    if (this.focus === 'path') {
      if (key.name === 'return') {
        const p = expandPath(this.path.value)
        if (existsSync(p) && statSync(p).isDirectory()) {
          this.go(p)
          this.focus = this.options.mode === 'save' ? 'name' : 'list'
        } else if (existsSync(p) && this.options.mode === 'open') this.pick(p)
        else if (this.options.mode === 'save' && existsSync(dirname(p))) {
          this.go(dirname(p))
          this.name.set(p.slice(dirname(p).length + 1))
          this.focus = 'name'
        } else this.error = `no such file or folder: ${p}`
        return
      }
      this.path.handle(key)
      return
    }
    if (this.focus === 'name') {
      if (key.name === 'return') return this.save()
      this.name.handle(key)
      return
    }
    const rows = this.rows()
    const ch = charOf(key)
    switch (key.name) {
      case 'down': this.index = Math.min(rows.length - 1, this.index + 1); return
      case 'up': this.index = Math.max(0, this.index - 1); return
      case 'pagedown': this.index = Math.min(rows.length - 1, this.index + 10); return
      case 'pageup': this.index = Math.max(0, this.index - 10); return
      case 'home': this.index = 0; return
      case 'end': this.index = rows.length - 1; return
      case 'return': {
        const r = rows[this.index]
        if (!r) return
        if ('up' in r) return this.go(dirname(this.dir))
        if ('select' in r) return this.pick(this.dir)
        if (r.isDir) return this.go(r.path)
        if (this.options.mode === 'open') return this.pick(r.path)
        if (this.options.mode === 'save') {
          this.name.set(r.name)
          this.focus = 'name'
        }
        return
      }
      case 'backspace':
        if (!this.filter.value) return this.go(dirname(this.dir))
        break
      default:
        break
    }
    if (!this.filter.value && ch === 'h') {
      this.hidden = !this.hidden
      return this.load()
    }
    if (!this.filter.value && ch === '~') return this.go(homedir())
    if (this.filter.handle(key)) this.index = 0
  }

  render(sw: number, sh: number) {
    const t = theme()
    const g = glyphs()
    const width = Math.min(sw - 2, 110)
    const inner = width - 2
    const rows = this.rows()
    const listRows = Math.max(4, Math.min(sh - 12, 24))
    const top = Math.max(0, Math.min(this.index - Math.floor(listRows / 2), rows.length - listRows))
    const dateWidth = inner >= 70 ? 17 : 0
    const sizeWidth = 9
    const nameWidth = inner - 3 - sizeWidth - dateWidth
    const lines = rows.slice(top, top + listRows).map((r, i) => {
      const sel = top + i === this.index && this.focus === 'list'
      let text: string
      let fg = t.fg
      if ('up' in r) {
        text = ` ${pad('../', nameWidth)}`
        fg = t.acc
      } else if ('select' in r) {
        text = ` ${pad(r.name, nameWidth)}`
        fg = t.acc2
      } else {
        const date = dateWidth ? ' ' + r.modified.toISOString().slice(0, 16).replace('T', ' ') : ''
        text = ` ${pad(r.name + (r.isDir ? '/' : ''), nameWidth)} ${r.isDir ? pad('', sizeWidth - 1) : pad(formatSize(r.size), sizeWidth - 1)}${date}`
        fg = r.isDir ? t.acc : r.hidden ? t.dim : t.fg
      }
      return <text flexShrink={0} wrapMode="none" key={i} fg={sel ? t.selFg : fg} bg={sel ? t.selBg : undefined}>{pad(text, inner)}</text>
    })
    while (lines.length < listRows) lines.push(<text flexShrink={0} wrapMode="none" key={`e${lines.length}`}>{pad(lines.length === 0 && this.filter.value ? ' (nothing matches)' : '', inner)}</text>)
    const label = (f: 'list' | 'path' | 'name', text: string) => <span fg={this.focus === f ? t.acc2 : t.dim}>{text}</span>
    return (
      <Frame title={this.options.title} width={width} height={listRows + (this.options.mode === 'save' ? 9 : 8)} screenWidth={sw} screenHeight={sh} top={1}>
        <box flexDirection="row" height={1}><text flexShrink={0} wrapMode="none">{label('path', ' Path ')}</text><EditorLine editor={this.path} width={inner - 7} focused={this.focus === 'path'} /></box>
        {this.options.mode === 'save' ? <box flexDirection="row" height={1}><text flexShrink={0} wrapMode="none">{label('name', ' Name ')}</text><EditorLine editor={this.name} width={inner - 7} focused={this.focus === 'name'} /></box> : null}
        <box flexDirection="row" height={1}><text flexShrink={0} wrapMode="none">{label('list', ' Find ')}</text><EditorLine editor={this.filter} width={inner - 7} focused={this.focus === 'list'} placeholder="type to filter this folder" /></box>
        <Line text={this.candidates.length ? ` ${trunc(this.candidates.join('  '), inner - 2)}` : ''} width={inner} fg={t.dim} />
        {lines}
        <Line text={this.error ? ` ${this.error}` : ` ${rows.filter((r) => 'isDir' in r).length} entries${this.hidden ? ' (hidden shown)' : ''}`} width={inner} fg={this.error ? t.err : t.dim} />
        <Line text={` Enter open/pick · Backspace up · Tab ${this.options.mode === 'save' ? 'name/list/path' : 'list/path'} · h hidden · ~ home${this.options.mode !== 'open' ? ' · Ctrl+N folder' : ''} · Esc`} width={inner} fg={t.dim} />
        <Line text={` ${g.sep} ${trunc(this.dir, inner - 4)}`} width={inner} fg={t.dim} />
      </Frame>
    )
  }
}
