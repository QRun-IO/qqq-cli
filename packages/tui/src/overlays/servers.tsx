/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The Servers dialog (Ctrl+O, `:servers`, F9 › Connection › Servers): every saved profile in two
 * lines (name, short name, server, status, last used; then who is signed in, the sign-in and the
 * description). Enter switches (the stored sign-in is reused, else the sign-in runs) and Home opens
 * on the new server; n adds, e edits, d removes, * makes the default, r probes again, typing filters.
 */

import { AUTH_MODES, defaultShortName, probeServer, type AuthMode } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { LineEditor } from '../line-editor'
import { ServersModel, ago, statusText, type ProfileInput, type ServerRow } from '../servers'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { Overlay } from '../types'
import { errorText, pad, trunc } from '../util/text'
import { ConfirmOverlay, EditorLine, overlayId } from './basic'
import { Frame, Line } from './frame'

/** Lays out key hints in one line of `width` cells, dropping the tokens with the highest `drop` first. */
function hint(tokens: Array<{ text: string; drop?: number }>, width: number): string {
  let kept = tokens.filter((t) => t.text)
  const join = (list: typeof kept) => list.map((t) => t.text).join(' · ')
  while (kept.length > 1 && join(kept).length > width) {
    const victim = kept.reduce((worst, t) => ((t.drop ?? 0) >= (worst.drop ?? 0) ? t : worst))
    kept = kept.filter((t) => t !== victim)
  }
  return trunc(join(kept), width)
}

/** Command keys while the filter is empty; any other character starts the filter (/ starts it too). */
const COMMAND_KEYS = new Set(['n', 'e', 'd', '*', 'r', '/'])

export class ServersOverlay implements Overlay {
  readonly id = overlayId('servers')
  readonly filter = new LineEditor('')
  readonly model: ServersModel
  index = 0
  private scroll = 0
  /** A line under the list: what just happened, or why something was refused. */
  note = ''
  noteKind: 'info' | 'error' = 'info'
  /** `/` was pressed: every character goes to the filter. */
  private filtering = false

  constructor(private store: AppStore, private switchTo: (row: ServerRow) => void, model?: ServersModel) {
    this.model = model ?? new ServersModel({ current: store.target?.name, secrets: store.signInDeps?.secrets, probe: (server) => probeServer(server, { fetch: store.signInDeps?.fetch }), onChange: () => store.bump() })
    const at = this.model.rows.findIndex((r) => r.isCurrent)
    this.index = Math.max(0, at)
    void this.model.probeAll()
    void this.model.readSignIns()
  }

  list(): ServerRow[] {
    return this.model.visible(this.filter.value)
  }

  selected(): ServerRow | undefined {
    return this.list()[this.index]
  }

  private say(text: string, kind: 'info' | 'error' = 'info'): void {
    this.note = text
    this.noteKind = kind
    this.store.bump()
  }

  paste(text: string): void {
    this.filter.insert(text.replace(/[\r\n]+/g, ' '))
    this.index = 0
  }

  onKey(key: Key): void {
    const list = this.list()
    const ch = charOf(key)
    const commands = !this.filter.value && !this.filtering
    if (key.name === 'escape') {
      if (this.filter.value || this.filtering) {
        this.filter.set('')
        this.filtering = false
        this.index = 0
      } else this.store.closeOverlay(this)
    } else if (key.name === 'down') this.index = Math.min(Math.max(0, list.length - 1), this.index + 1)
    else if (key.name === 'up') this.index = Math.max(0, this.index - 1)
    else if (key.name === 'pagedown') this.index = Math.min(Math.max(0, list.length - 1), this.index + 5)
    else if (key.name === 'pageup') this.index = Math.max(0, this.index - 5)
    else if (key.name === 'return') this.switchSelected()
    else if (key.name === 'f7' || (commands && ch === 'n')) this.openForm()
    else if (key.name === 'f4' || (commands && ch === 'e')) {
      const row = this.selected()
      if (row) this.openForm(row.name)
    } else if (key.name === 'f8' || (commands && ch === 'd')) this.removeSelected()
    else if (commands && ch === '*') this.defaultSelected()
    else if (key.name === 'f5' || (commands && ch === 'r')) {
      this.say('probing every server…')
      void this.model.probeAll().then(() => this.say('probed'))
    } else if (commands && ch === '/') this.filtering = true
    else if (this.filter.handle(key)) {
      this.index = 0
      if (!this.filter.value) this.filtering = false
    }
  }

  switchSelected(): void {
    const row = this.selected()
    if (!row) return
    if (row.isCurrent) {
      this.store.closeOverlay(this)
      this.store.flash(`already on ${row.name} (${row.server})`)
      return
    }
    this.store.closeOverlay(this)
    this.switchTo(row)
  }

  private removeSelected(): void {
    const row = this.selected()
    if (!row) return
    if (row.isCurrent) return this.say(`${row.name} is in use; switch to another server first`, 'error')
    this.store.open(new ConfirmOverlay(this.store, `Remove the profile "${row.name}" (${row.server}) and its stored sign-in?`, () => {
      this.model.remove(row.name).then(() => {
        this.index = Math.min(this.index, Math.max(0, this.list().length - 1))
        this.say(`removed ${row.name}`)
      }).catch((e) => this.say(errorText(e), 'error'))
    }))
  }

  private defaultSelected(): void {
    const row = this.selected()
    if (!row) return
    try {
      this.model.setDefault(row.name)
      this.say(`${row.name} is the default profile (qqq and qqq ui use it without --profile)`)
    } catch (e) {
      this.say(errorText(e), 'error')
    }
  }

  openForm(name?: string): void {
    this.store.open(new ProfileFormOverlay(this.store, this.model, name, (saved, message) => {
      const at = this.list().findIndex((r) => r.name === saved)
      if (at >= 0) this.index = at
      this.say(message)
      void this.model.probeAll()
      void this.model.readSignIns()
    }))
  }

  render(sw: number, sh: number) {
    const t = theme()
    const g = glyphs()
    const width = Math.max(30, Math.min(sw - 2, 120))
    const height = Math.max(10, Math.min(sh - 2, 30))
    const inner = width - 2
    const list = this.list()
    if (this.index >= list.length) this.index = Math.max(0, list.length - 1)
    // name, short, server, status, last used; the rest of the line is room for the server
    const nameW = Math.min(16, Math.max(8, ...this.model.rows.map((r) => r.name.length + 1)))
    const shortW = 7
    const statusW = 13
    const lastW = inner >= 90 ? 12 : 10
    const serverW = Math.min(40, Math.max(10, inner - 4 - nameW - shortW - statusW - lastW))
    const lineOne = (r: ServerRow) => `${pad(r.name, nameW)}${pad(r.short, shortW)}${pad(r.server.replace(/^https?:\/\//, (m) => (serverW < 30 ? '' : m)), serverW)}${pad(statusText(this.model.probes.get(r.server)), statusW)}${pad(ago(r.lastUsedAt), lastW)}`
    const listHeight = Math.max(2, height - 2 - 4)
    const perRow = 2
    const visibleRows = Math.max(1, Math.floor(listHeight / perRow))
    if (this.index < this.scroll) this.scroll = this.index
    if (this.index >= this.scroll + visibleRows) this.scroll = this.index - visibleRows + 1
    const lines: React.ReactNode[] = []
    list.slice(this.scroll, this.scroll + visibleRows).forEach((r, k) => {
      const i = this.scroll + k
      const sel = i === this.index
      const mark = `${sel ? g.pointer : ' '}${r.isDefault ? '*' : ' '}${r.isCurrent ? g.mark : ' '} `
      const second = [r.user || (r.signIn ? '' : 'not signed in'), this.model.authText(r), r.description].filter(Boolean).join(' · ')
      const probe = this.model.probes.get(r.server)
      const fg = sel ? t.selFg : probe?.state === 'down' ? t.dim : t.fg
      lines.push(<Line key={`${r.name}1`} text={mark + lineOne(r)} width={inner} fg={fg} bg={sel ? t.selBg : undefined} bold={r.isCurrent} />)
      lines.push(<Line key={`${r.name}2`} text={`     ${second}`} width={inner} fg={sel ? t.selFg : t.dim} bg={sel ? t.selBg : undefined} />)
    })
    if (!list.length) lines.push(<Line key="none" text={this.model.rows.length ? `   no profile matches "${this.filter.value}"` : '   no profiles yet: n adds one'} width={inner} fg={t.dim} />)
    while (lines.length < listHeight) lines.push(<Line key={`pad${lines.length}`} text="" width={inner} />)
    const more = list.length > visibleRows ? ` ${this.scroll > 0 ? g.up : ' '}${this.scroll + visibleRows < list.length ? g.down : ' '}` : ''
    const header = `    ${pad('Name', nameW)}${pad('Short', shortW)}${pad('Server', serverW)}${pad('Status', statusW)}${pad('Last used', lastW)}`
    const commands = !this.filter.value && !this.filtering
    const keys = commands
      ? [{ text: 'Enter switches' }, { text: 'n add' }, { text: 'e edit' }, { text: 'd remove', drop: 1 }, { text: '* default', drop: 1 }, { text: 'r probe', drop: 3 }, { text: 'type to filter', drop: 2 }, { text: 'Esc closes' }]
      : [{ text: `${list.length} of ${this.model.rows.length}` }, { text: 'Enter switches' }, { text: 'F7 add', drop: 2 }, { text: 'F4 edit', drop: 2 }, { text: 'F8 remove', drop: 3 }, { text: 'Esc clears' }]
    const legend = `* default  ${g.mark} in use`
    return (
      <Frame title="Servers  (Ctrl+O)" width={width} height={height} screenWidth={sw} screenHeight={sh} top={1}>
        <box paddingLeft={1}><EditorLine editor={this.filter} width={inner - 2} focused={!commands || undefined} placeholder="type to filter by name, short name, description or server · / then any letter" /></box>
        <Line text={pad(header, inner - more.length) + more} width={inner} fg={t.acc} />
        {lines}
        <Line text={` ${this.note || legend}`} width={inner} fg={this.note ? (this.noteKind === 'error' ? t.err : t.acc2) : t.dim} />
        <Line text={` ${hint(keys, inner - 2)}`} width={inner} fg={t.dim} />
      </Frame>
    )
  }
}

type FieldName = 'name' | 'short' | 'description' | 'server' | 'authMode'
const FIELDS: Array<{ name: FieldName; label: string }> = [
  { name: 'name', label: 'Name' }, { name: 'short', label: 'Short name' }, { name: 'description', label: 'Description' }, { name: 'server', label: 'Server' }, { name: 'authMode', label: 'Sign-in' },
]
const AUTH_HELP: Record<AuthMode, string> = { auto: 'the server decides; an OAuth2 server asks browser or device', browser: 'OAuth2: in the browser (PKCE)', device: 'OAuth2: a code on another device' }

/** Adds or edits one profile: name, short name, description, server, sign-in mode; checks the server answers. */
export class ProfileFormOverlay implements Overlay {
  readonly id = overlayId('profile-form')
  readonly editors: Record<Exclude<FieldName, 'authMode'>, LineEditor>
  authMode: AuthMode
  field = 0
  status = ''
  statusKind: 'info' | 'error' = 'info'
  busy = false
  /** The last save found the server unreachable: the next save keeps it anyway. */
  private force = false

  constructor(private store: AppStore, private model: ServersModel, readonly editing: string | undefined, private onSaved: (name: string, message: string) => void) {
    const input = model.inputOf(editing)
    this.editors = { name: new LineEditor(input.name), short: new LineEditor(input.short), description: new LineEditor(input.description), server: new LineEditor(input.server || (editing ? '' : 'http://')) }
    this.authMode = input.authMode
  }

  input(): ProfileInput {
    return { name: this.editors.name.value, short: this.editors.short.value, description: this.editors.description.value, server: this.editors.server.value, authMode: this.authMode }
  }

  paste(text: string): void {
    const f = FIELDS[this.field]!.name
    if (f !== 'authMode') this.editors[f].insert(text.replace(/[\r\n]+/g, ' '))
  }

  onKey(key: Key): void {
    if (this.busy) return
    const f = FIELDS[this.field]!.name
    if (key.name === 'escape') return this.store.closeOverlay(this)
    if ((key.ctrl && key.name === 's') || (key.name === 'return' && this.field === FIELDS.length - 1)) return void this.save()
    if (key.name === 'down' || key.name === 'return' || (key.name === 'tab' && !key.shift)) this.field = Math.min(FIELDS.length - 1, this.field + 1)
    else if (key.name === 'up' || (key.name === 'tab' && key.shift)) this.field = Math.max(0, this.field - 1)
    else if (f === 'authMode') {
      if (key.name === 'left' || key.name === 'right' || charOf(key) === ' ') {
        const i = AUTH_MODES.indexOf(this.authMode)
        this.authMode = AUTH_MODES[(i + (key.name === 'left' ? AUTH_MODES.length - 1 : 1)) % AUTH_MODES.length]!
      }
    } else if (this.editors[f].handle(key)) {
      this.force = false
      if (f === 'server' || f === 'name') this.status = ''
    }
  }

  async save(): Promise<void> {
    const input = this.input()
    this.busy = true
    this.status = this.force ? 'saving…' : `checking ${input.server.trim()}/qqq/v1/version…`
    this.statusKind = 'info'
    this.store.bump()
    try {
      const result = await this.model.check(input, this.editing, this.force)
      if (!result.ok) {
        this.status = result.unreachable ? `${result.error}; Ctrl+S again saves anyway` : result.error
        this.statusKind = 'error'
        this.force = Boolean(result.unreachable)
        return
      }
      let name = input.name.trim()
      if (this.editing) name = await this.model.edit(this.editing, input)
      else this.model.add(input)
      if (this.editing && this.store.target?.name === this.editing) {
        // the profile in use was renamed (or its short name changed): the footer follows
        this.store.target = { ...this.store.target, name }
        this.store.status.profile = name
        this.store.status.short = this.model.rows.find((r) => r.name === name)?.short ?? name
      }
      const version = result.probe?.apiVersion ? ` (UI API ${result.probe.apiVersion})` : ''
      this.store.closeOverlay(this)
      this.onSaved(name, `${this.editing ? 'saved' : 'added'} ${name}${version}`)
    } catch (e) {
      this.status = errorText(e)
      this.statusKind = 'error'
    } finally {
      this.busy = false
      this.store.bump()
    }
  }

  render(sw: number, sh: number) {
    const t = theme()
    const width = Math.max(30, Math.min(sw - 4, 84))
    const inner = width - 2
    const labelW = 15
    const fieldW = Math.max(8, inner - labelW - 3)
    const rows = FIELDS.map((f, i) => {
      const focused = i === this.field
      const label = <span fg={focused ? t.acc : t.fg}>{pad(` ${focused ? glyphs().pointer : ' '} ${f.label}`, labelW + 1)}</span>
      if (f.name === 'authMode') {
        const text = AUTH_MODES.map((m) => (m === this.authMode ? `[${m}]` : ` ${m} `)).join(' ')
        return <text key={f.name} flexShrink={0} wrapMode="none">{label}<span fg={focused ? t.inputFg : t.fg} bg={focused ? t.inputBg : undefined}>{pad(text, fieldW)}</span></text>
      }
      const placeholder = f.name === 'short' ? `2 to 6 characters; empty: ${this.editors.name.value ? defaultShortName(this.editors.name.value) : 'from the name'}` : f.name === 'description' ? 'what the server is (optional)' : f.name === 'server' ? 'http://localhost:8077' : 'letters, digits, . - _'
      return <box key={f.name} flexDirection="row">{<text flexShrink={0} wrapMode="none">{label}</text>}<EditorLine editor={this.editors[f.name]} width={fieldW} focused={focused} placeholder={placeholder} /></box>
    })
    const help = FIELDS[this.field]!.name === 'authMode' ? `← → or Space: ${AUTH_HELP[this.authMode]}` : FIELDS[this.field]!.name === 'short' ? 'shown in the footer, the Home header and the F9 Connection line' : FIELDS[this.field]!.name === 'server' ? 'the server is checked (GET /qqq/v1/version) when you save' : ''
    return (
      <Frame title={this.editing ? `Edit server profile ${this.editing}` : 'Add a server profile'} width={width} height={FIELDS.length + 6} screenWidth={sw} screenHeight={sh}>
        <Line text="" width={inner} />
        {rows}
        <Line text="" width={inner} />
        <Line text={` ${this.status || help}`} width={inner} fg={this.status ? (this.statusKind === 'error' ? t.err : t.acc2) : t.dim} />
        <Line text={` ${hint([{ text: '↑↓ Tab fields' }, { text: 'Ctrl+S or Enter on Sign-in saves' }, { text: 'Esc cancels' }], inner - 2)}`} width={inner} fg={t.dim} />
      </Frame>
    )
  }
}
