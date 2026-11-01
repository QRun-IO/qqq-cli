/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { FormInputError, FormSession, ResultCursor, copyRecordValues, dateTimesToUtc, formatSize, helpEntryText, selectHelpContent, defaultTimeZone, isInstant, isMissingValue, utcToLocalInput, validateValue, type FieldMeta, type FieldValues } from '@qrun-io/qqq-core'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { openFile } from '../overlays/files-helpers'
import type { TableMetaData } from '../client'
import type { Key } from '../keys'
import { charOf, isPrintable } from '../keys'
import { LineEditor } from '../line-editor'
import { replaceWithRecord } from '../nav'
import { EditorLine } from '../overlays/basic'
import { PickerOverlay } from '../overlays/picker'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { FKeyLabels, Screen } from '../types'
import { errorText, pad, trunc } from '../util/text'
import { Panel } from './list'
import { orderedSections } from './record'

const TEXT_TYPES = new Set(['STRING', 'TEXT', 'HTML', 'PASSWORD', 'INTEGER', 'LONG', 'DECIMAL', 'DATE', 'DATE_TIME', 'TIME', 'BLOB'])

function hintFor(f: FieldMeta): string {
  switch (f.type) {
    case 'DATE': return 'YYYY-MM-DD'
    case 'DATE_TIME': return `YYYY-MM-DD HH:MM (${defaultTimeZone()})`
    case 'TIME': return 'HH:MM'
    case 'INTEGER': case 'LONG': return 'whole number'
    case 'DECIMAL': return 'number'
    case 'BOOLEAN': return 'Space toggles'
    case 'TEXT': case 'HTML': return 'Ctrl+E opens $EDITOR'
    case 'BLOB': return 'file path'
    default: return ''
  }
}

/** A field that takes a file: BLOB, or a FILE_UPLOAD adornment. */
export function isFileField(f: FieldMeta): boolean {
  return f.type === 'BLOB' || Boolean(f.adornments?.some((a) => a.type === 'FILE_UPLOAD'))
}

/** The multipart record body (as the web UI's recordFormData): text values as strings, null as empty, files as parts. */
export function multipartRecord(values: FieldValues, files: Map<string, { name: string; bytes: Uint8Array }>): Record<string, string | Blob> {
  const form: Record<string, string | Blob> = {}
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || files.has(k)) continue
    form[k] = v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  }
  for (const [k, f] of files) form[k] = new File([f.bytes as BlobPart], f.name)
  return form
}

function textOf(value: unknown): string {
  return value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
}

/**
 * A form over a kernel FormSession: one editor per field type, a possible-value picker that narrows
 * for contingent fields, local validation shown by the field, server fieldErrors mapped back to
 * fields. Keys are read from the object's state (no React closures), so a burst of keys lands in
 * the field that had focus when each key was read. Used by table forms and process steps.
 */
/** A primary key the server makes (a number, or not editable): not asked on create; a text key is typed in. */
function generatedKey(f: { type?: string; isEditable?: boolean | null } | undefined): boolean {
  return !f || f.isEditable === false || f.type === 'INTEGER' || f.type === 'LONG'
}

export class FormEditor {
  index = 0
  top = 0
  editors = new Map<string, LineEditor>()
  /** Bulk edit: the fields that will be applied. */
  enabled = new Set<string>()
  formError?: string
  saving = false
  readonly initial: FieldValues
  /** Files chosen for BLOB and FILE_UPLOAD fields (sent as multipart parts). */
  files = new Map<string, { name: string; bytes: Uint8Array; path: string }>()

  constructor(private store: AppStore, readonly session: FormSession, readonly order: string[], readonly options: { bulkEdit?: boolean; readOnly?: string[]; submitOnEnter?: () => void } = {}) {
    this.initial = { ...session.values }
    for (const name of order) {
      const f = session.fields[name]
      if (f && TEXT_TYPES.has(f.type) && !session.hasChoices(name) && !isFileField(f)) this.editors.set(name, new LineEditor(textOf(session.values[name]), { masked: f.type === 'PASSWORD' }))
    }
  }

  get names(): string[] {
    return this.order.filter((n) => this.session.fields[n] && !this.session.fields[n]!.isHidden)
  }

  get current(): string | undefined {
    return this.names[this.index]
  }

  dirty(): boolean {
    return this.files.size > 0 || this.names.some((n) => textOf(this.valueFor(n)) !== textOf(this.initial[n]))
  }

  /** Chooses a file for a file field through the file navigator. */
  chooseFile(name: string): void {
    const f = this.session.fields[name]!
    openFile(this.store, `File for ${f.label}`, (path) => {
      try {
        const bytes = new Uint8Array(readFileSync(path))
        const fileName = basename(path)
        this.files.set(name, { name: fileName, bytes, path })
        this.session.values[name] = fileName
        delete this.session.errors[name]
        if (this.options.bulkEdit) this.enabled.add(name)
        this.store.bump()
      } catch (e) {
        this.session.errors[name] = errorText(e)
      }
    })
  }

  /** The value a field has now (the editor text for text fields not yet committed). */
  valueFor(name: string): unknown {
    const ed = this.editors.get(name)
    return ed ? ed.value : this.session.values[name]
  }

  /** Writes a text editor's value into the session (behaviors, adjusters, local check). */
  async commit(name: string | undefined): Promise<void> {
    if (!name) return
    const ed = this.editors.get(name)
    if (!ed) return
    const f = this.session.fields[name]!
    if (textOf(this.session.values[name]) === ed.value && !(name in this.session.errors)) return
    if (this.session.state(name).disabledBecause) return
    try {
      const result = await this.session.set(name, ed.value === '' ? null : ed.value)
      for (const n of result.cleared) this.editors.get(n)?.set('')
      if (this.options.bulkEdit && ed.value !== textOf(this.initial[name])) this.enabled.add(name)
      const problem = validateValue(f, ed.value)
      if (problem) this.session.errors[name] = `${problem}`
      for (const [n, v] of Object.entries(this.session.values)) {
        const other = this.editors.get(n)
        if (other && n !== name && other.value !== textOf(v)) other.set(textOf(v))
      }
    } catch (e) {
      this.session.errors[name] = e instanceof FormInputError ? e.message.replace(`${f.label}: `, '') : errorText(e)
    }
  }

  move(delta: number): void {
    const from = this.current
    void this.commit(from).then(() => this.store.bump())
    this.index = Math.max(0, Math.min(this.names.length - 1, this.index + delta))
  }

  /** Commits everything and validates; returns the problems (empty when the form can be sent). */
  async check(): Promise<Record<string, string>> {
    for (const n of this.names) await this.commit(n)
    const only = this.options.bulkEdit ? [...this.enabled] : undefined
    const problems = this.session.validate(only)
    return problems
  }

  /** Maps a server validation error onto fields. */
  absorbServerError(error: unknown): void {
    if (error instanceof UiApiError && error.fieldErrors.length) {
      for (const fe of error.fieldErrors) if (fe.field && this.session.fields[fe.field]) this.session.errors[fe.field] = fe.message
      this.formError = error.message
      const first = this.names.findIndex((n) => this.session.errors[n])
      if (first >= 0) this.index = first
    } else {
      this.formError = errorText(error)
    }
  }

  openPicker(name: string, initial = ''): void {
    if (this.session.state(name).disabledBecause) return this.store.flash(`${this.session.fields[name]!.label}: ${this.session.state(name).disabledBecause}`)
    this.store.open(new PickerOverlay(this.store, this.session, name, (option) => {
      this.store.run(this.session.set(name, option === null ? null : String(option.id)).then((r) => {
        if (option) this.session.displayValues[name] = option.label
        for (const n of r.cleared) this.editors.get(n)?.set('')
        delete this.session.errors[name]
        if (this.options.bulkEdit) this.enabled.add(name)
        if (option && this.current === name) this.index = Math.min(this.names.length - 1, this.index + 1)
      }))
    }, initial))
  }

  /** Pasted text goes into the text field that has focus. */
  paste(text: string): void {
    const name = this.current
    const ed = name ? this.editors.get(name) : undefined
    if (ed) ed.insert(text)
  }

  /** Handles a key; returns true when the form used it. Ctrl+S and Esc are left to the owner. */
  /** A field adorned with a filterAndColumnsSetup WIDGET: its value is a filter set up in the filter dialog. */
  setupWidgetOf(name: string): string | undefined {
    const f = this.session.fields[name] as { adornments?: Array<{ type?: string; values?: Record<string, unknown> }> } | undefined
    const w = f?.adornments?.find((a) => a.type === 'WIDGET')?.values?.widgetName
    if (typeof w !== 'string') return undefined
    const type = (this.store.meta?.widgets as Record<string, { type?: string }> | undefined)?.[w]?.type
    return type === 'filterAndColumnsSetup' ? w : undefined
  }

  /** Opens the filter dialog for the form's table (its tableName value) and writes the filter JSON into the field. */
  editSetupField(name: string): void {
    const table = String(this.session.values.tableName ?? (this.session.fields[name] as { defaultValue?: unknown }).defaultValue ?? '')
    if (!table) return this.store.flash('choose the table first: the filter is for its fields', 'error')
    let current: unknown
    try {
      current = typeof this.session.values[name] === 'string' && this.session.values[name] ? JSON.parse(String(this.session.values[name])) : this.session.values[name]
    } catch {
      current = undefined
    }
    const filter = (current && typeof current === 'object' ? current : { criteria: [], booleanOperator: 'AND' }) as { criteria: never[]; booleanOperator: 'AND'; orderBys?: Array<{ fieldName: string; isAscending?: boolean }> }
    this.store.run(this.store.client!.tableMeta(table), (meta) => void import('../overlays/filter').then(({ FilterOverlay }) => {
      const ob = filter.orderBys?.[0]
      this.store.open(new FilterOverlay(this.store, meta, filter as never, ob ? { field: ob.fieldName, asc: ob.isAscending !== false } : undefined, (f, sort) => {
        const value = JSON.stringify({ ...f, orderBys: sort ? [{ fieldName: sort.field, isAscending: sort.asc }] : [] })
        this.store.run(this.session.set(name, value), () => this.editors.get(name)?.set(value))
      }))
    }))
  }

  onKey(key: Key): boolean {
    const name = this.current
    if (!name) return false
    const f = this.session.fields[name]!
    const readOnly = this.options.readOnly?.includes(name) || f.isEditable === false
    if (key.name === 'tab') {
      this.move(key.shift ? -1 : 1)
      return true
    }
    switch (key.name) {
      case 'down': this.move(1); return true
      case 'up': this.move(-1); return true
      case 'pagedown': this.move(8); return true
      case 'pageup': this.move(-8); return true
      default: break
    }
    if (key.ctrl && key.name === 't' && this.options.bulkEdit) {
      if (this.enabled.has(name)) this.enabled.delete(name)
      else this.enabled.add(name)
      return true
    }
    if (readOnly) return key.name === 'return' ? (this.move(1), true) : false
    if (key.name === 'return' && this.setupWidgetOf(name)) {
      this.editSetupField(name)
      return true
    }
    if (isFileField(f)) {
      if (key.name === 'return' || key.name === 'space') {
        this.chooseFile(name)
        return true
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        this.files.delete(name)
        this.session.values[name] = null
        return true
      }
      return false
    }
    if (this.session.hasChoices(name)) {
      if (key.name === 'return' || key.name === 'space') {
        this.openPicker(name)
        return true
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        this.store.run(this.session.set(name, null).then((r) => { for (const n of r.cleared) this.editors.get(n)?.set('') }))
        return true
      }
      if (isPrintable(key)) {
        this.openPicker(name, charOf(key))
        return true
      }
      return false
    }
    if (f.type === 'BOOLEAN') {
      if (key.name === 'space' || key.name === 'return' || /^[yntf01]$/i.test(charOf(key))) {
        const ch = charOf(key).toLowerCase()
        const next = ch === 'y' || ch === 't' || ch === '1' ? true : ch === 'n' || ch === 'f' || ch === '0' ? false : !(this.session.values[name] === true)
        this.store.run(this.session.set(name, next).then(() => { if (this.options.bulkEdit) this.enabled.add(name) }))
        if (key.name === 'return') this.move(1)
        return true
      }
      return false
    }
    const ed = this.editors.get(name)
    if (!ed) return false
    if (key.ctrl && key.name === 'e' && (f.type === 'TEXT' || f.type === 'HTML')) {
      this.store.run(this.store.editExternal(ed.value), (text) => { ed.set(text.replace(/\n$/, '')); void this.commit(name) })
      return true
    }
    if (key.name === 'return') {
      // scanner screens: Enter in an input submits the step (hand-held stations)
      if (this.options.submitOnEnter) {
        void this.commit(name).then(() => this.options.submitOnEnter!())
        return true
      }
      this.move(1)
      return true
    }
    if (ed.handle(key)) {
      delete this.session.errors[name]
      return true
    }
    return false
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    const g = glyphs()
    const names = this.names
    const labelWidth = Math.min(28, Math.max(8, ...names.map((n) => this.session.fields[n]!.label.length + 2)))
    const editorWidth = Math.max(10, Math.min(60, width - labelWidth - 6 - (this.options.bulkEdit ? 4 : 0) - Math.min(36, Math.floor(width / 3))))
    const msgWidth = Math.max(0, width - labelWidth - editorWidth - 6 - (this.options.bulkEdit ? 4 : 0))
    const rows = Math.max(1, height - (this.formError ? 1 : 0))
    if (this.index < this.top) this.top = this.index
    if (this.index >= this.top + rows) this.top = this.index - rows + 1
    const lines = names.slice(this.top, this.top + rows).map((name, i) => {
      const f = this.session.fields[name]!
      const idx = this.top + i
      const sel = idx === this.index && focused
      const state = this.session.state(name)
      const error = this.session.errors[name]
      const required = f.isRequired || f.validation?.required ? '*' : ' '
      const disabled = Boolean(state.disabledBecause) || f.isEditable === false || this.options.readOnly?.includes(name)
      const bulk = this.options.bulkEdit ? (this.enabled.has(name) ? g.check : g.uncheck) + ' ' : ''
      const ed = this.editors.get(name)
      let editor: React.ReactNode
      if (ed && !disabled) editor = <EditorLine editor={ed} width={editorWidth} focused={sel} />
      else {
        let shown: string
        if (isFileField(f)) shown = this.files.get(name) ? `${this.files.get(name)!.name} (${formatSize(this.files.get(name)!.bytes.length)})` : isMissingValue(this.session.values[name]) ? '(choose a file…)' : '(stored file; Enter replaces)'
        else if (f.type === 'BOOLEAN') shown = this.session.values[name] === true ? `${g.check} yes` : this.session.values[name] === false ? `${g.uncheck} no` : `${g.uncheck} (not set)`
        else if (this.session.hasChoices(name)) shown = isMissingValue(this.session.values[name]) ? (state.disabledBecause ? '' : '(choose…)') : `${this.session.displayValues[name] ?? textOf(this.session.values[name])}`
        else shown = ed ? ed.value : textOf(this.session.values[name])
        const pickGlyph = (this.session.hasChoices(name) || isFileField(f)) && !disabled ? ' ▾' : ''
        editor = <text flexShrink={0} wrapMode="none" fg={disabled ? t.dim : sel ? t.selFg : t.inputFg} bg={disabled ? undefined : sel ? t.selBg : t.inputBg}>{pad(trunc(shown, editorWidth - pickGlyph.length) + pickGlyph, editorWidth)}</text>
      }
      const fieldHelp = idx === this.index ? helpEntryText(selectHelpContent(f.helpContents, ['INSERT_SCREEN', 'EDIT_SCREEN', 'WRITE_SCREENS', 'ALL_SCREENS'])) : ''
      const msg = error ? `! ${error}` : state.disabledBecause ? state.disabledBecause : fieldHelp ? fieldHelp : idx === this.index ? (isFileField(f) ? 'Enter chooses a file · Backspace clears' : this.session.hasChoices(name) ? 'Enter or type to choose · Backspace clears' : hintFor(f)) : ''
      return (
        <box key={name} flexDirection="row" height={1}>
          <text flexShrink={0} wrapMode="none" fg={sel ? t.acc2 : disabled ? t.dim : t.fg}>{`${sel ? g.pointer : ' '}${bulk}${pad(f.label, labelWidth - 1)}${required} `}</text>
          {editor}
          <text flexShrink={0} wrapMode="none" fg={error ? t.err : t.dim}>{pad(msgWidth > 2 ? ' ' + trunc(msg, msgWidth - 1) : '', msgWidth + 1)}</text>
        </box>
      )
    })
    return (
      <>
        {lines}
        {Array.from({ length: Math.max(0, rows - lines.length) }, (_, i) => <text flexShrink={0} wrapMode="none" key={`e${i}`}>{pad('', width)}</text>)}
        {this.formError ? <text flexShrink={0} wrapMode="none" fg={t.err}>{pad(` ${this.formError}`, width)}</text> : null}
      </>
    )
  }
}

export interface FormOptions {
  mode: 'create' | 'edit' | 'copy'
  primaryKey?: string
  initial?: FieldValues
  /** The result the record came from (edit from a grid): saving returns there. */
  cursor?: ResultCursor
  /** The grid's table variant: the record is read with it (v1 writes ignore it, server finding #19). */
  tableVariant?: string
}

/** Create, edit or copy a table record. Ctrl+S saves; Esc cancels and asks when there are unsaved changes. */
export class FormScreen implements Screen {
  readonly kind = 'form'
  readonly id: string
  meta?: TableMetaData
  editor?: FormEditor
  error?: string
  originals: FieldValues = {}

  constructor(private store: AppStore, readonly tableName: string, readonly options: FormOptions) {
    this.id = `form:${tableName}:${options.mode}:${Date.now()}`
    store.run(this.init())
  }

  async init(): Promise<void> {
    const client = this.store.client!
    try {
      const meta = await client.tableMeta(this.tableName)
      this.meta = meta
      let initial: FieldValues = { ...(this.options.initial ?? {}) }
      const display: Record<string, string> = {}
      if (this.options.mode !== 'create' && this.options.primaryKey !== undefined) {
        const rec = await client.record(this.tableName, this.options.primaryKey, false, this.options.tableVariant)
        initial = this.options.mode === 'copy' ? copyRecordValues(meta, rec) as FieldValues : { ...rec.values }
        Object.assign(display, rec.displayValues ?? {})
      }
      // DATE_TIME values are edited in the local zone and sent back as UTC
      this.originals = { ...initial }
      for (const f of Object.values(meta.fields)) if (f.type === 'DATE_TIME' && isInstant(initial[f.name])) initial[f.name] = utcToLocalInput(String(initial[f.name]), defaultTimeZone())
      const fields = Object.values(meta.fields) as FieldMeta[]
      const session = new FormSession({ baseUrl: client.server, fetch: client.fetch, scope: { table: this.tableName }, fields, initialValues: initial, tableMeta: meta as never, exclude: this.options.mode === 'edit' || !generatedKey(meta.fields[meta.primaryKeyField]) ? [] : [meta.primaryKeyField] })
      for (const [k, v] of Object.entries(display)) if (session.hasChoices(k) && !isMissingValue(initial[k])) session.displayValues[k] = v
      // labels for prefilled possible values (create child: the parent's id)
      for (const [k, v] of Object.entries(this.options.initial ?? {})) {
        if (session.hasChoices(k) && !isMissingValue(v) && !session.displayValues[k]) {
          try {
            session.displayValues[k] = (await session.resolveChoice(k, String(v))).label
          } catch {
            // keep the id
          }
        }
      }
      await session.load()
      const editable = new Set(session.editable.map((f) => f.name))
      const order: string[] = []
      for (const s of orderedSections(meta)) for (const n of s.fieldNames ?? []) if (editable.has(n) && !order.includes(n)) order.push(n)
      for (const n of session.order) if (editable.has(n) && !order.includes(n)) order.push(n)
      this.editor = new FormEditor(this.store, session, order)
    } catch (e) {
      this.error = errorText(e)
    }
  }

  title(): string {
    const verb = this.options.mode === 'create' ? 'New' : this.options.mode === 'edit' ? 'Edit' : 'Copy'
    return `${verb} ${this.meta?.label ?? this.tableName}${this.options.mode === 'edit' ? ` ${this.options.primaryKey}` : ''}`
  }

  helpTopic() {
    return { kind: 'table' as const, name: this.tableName }
  }

  presenceScope(): string | undefined {
    return this.options.mode === 'edit' ? `record:${this.tableName}:${this.options.primaryKey}` : undefined
  }

  capturesText(): boolean {
    return true
  }

  paste(text: string): void {
    this.editor?.paste(text)
  }

  dirty(): boolean {
    return this.editor?.dirty() ?? false
  }

  fkeys(): FKeyLabels {
    return { 3: null, 4: null, 6: null, 7: null, 8: null, 5: null }
  }

  cancel(): void {
    if (this.dirty()) this.store.confirm('Discard your changes?', () => this.store.back())
    else this.store.back()
  }

  save(): void {
    const editor = this.editor
    const meta = this.meta
    if (!editor || !meta || editor.saving) return
    editor.saving = true
    editor.formError = undefined
    const client = this.store.client!
    const work = async () => {
      const problems = await editor.check()
      if (Object.keys(problems).length) {
        editor.formError = `${Object.keys(problems).length} field${Object.keys(problems).length === 1 ? '' : 's'} need attention`
        editor.index = Math.max(0, editor.names.findIndex((n) => problems[n]))
        return
      }
      try {
        if (this.options.mode === 'edit') {
          const changed = editor.names.filter((n) => editor.files.has(n) || textOf(editor.session.values[n]) !== textOf(editor.initial[n]))
          if (!changed.length) {
            this.store.flash('nothing changed')
            this.store.back()
            return
          }
          const values = dateTimesToUtc(Object.values(editor.session.fields), Object.fromEntries(changed.map((n) => [n, editor.session.values[n] ?? null])), { originals: this.originals })
          if (editor.files.size) await client.call('updateRecord', { path: { tableName: this.tableName, primaryKey: String(this.options.primaryKey) }, form: multipartRecord(values, editor.files) })
          else await client.update(this.tableName, this.options.primaryKey, values)
          this.store.flash(`saved ${meta.label} ${this.options.primaryKey}`)
          this.store.back()
        } else {
          const values = dateTimesToUtc(Object.values(editor.session.fields), editor.session.submission())
          const record = editor.files.size
            ? ((await client.data<Record<string, unknown>>('insertRecord', { path: { tableName: this.tableName }, form: multipartRecord(values, editor.files) })).record ?? {}) as { values?: Record<string, unknown> }
            : await client.insert(this.tableName, values)
          const pk = record.values?.[meta.primaryKeyField]
          this.store.flash(`created ${meta.label} ${String(pk ?? '')}`)
          replaceWithRecord(this.store, this.tableName, String(pk))
        }
      } catch (e) {
        editor.absorbServerError(e)
      }
    }
    work().catch((e) => editor.absorbServerError(e)).finally(() => {
      editor.saving = false
      this.store.bump()
    })
  }

  onKey(key: Key): boolean {
    if (key.ctrl && key.name === 's') {
      this.save()
      return true
    }
    if (key.name === 'escape') {
      this.cancel()
      return true
    }
    if (key.name === 'f5') return true
    return this.editor?.onKey(key) ?? true
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    const footer = this.editor?.saving ? ' saving…' : ' Ctrl+S save · Esc cancel · Tab ↓ next · ↑ previous · Enter or typing opens a picker · * required'
    return (
      <Panel title={this.title()} width={width} height={height} focused={focused}>
        {this.error ? <text flexShrink={0} wrapMode="none" fg={t.err}>{pad(` ${this.error}`, width - 2)}</text> : this.editor ? this.editor.render(width - 2, height - 3, focused) : <text flexShrink={0} wrapMode="none" fg={t.dim}>{pad(' loading…', width - 2)}</text>}
        {this.error || !this.editor ? Array.from({ length: Math.max(0, height - 4) }, (_, i) => <text flexShrink={0} wrapMode="none" key={i}>{''}</text>) : null}
        <text flexShrink={0} wrapMode="none" fg={t.dim}>{pad(footer, width - 2)}</text>
      </Panel>
    )
  }
}
