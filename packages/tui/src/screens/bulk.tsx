/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The bulk wizard: bulk insert and bulk edit with a file (upload, column mapping, value mapping,
 * review), bulk edit (switched-on fields) and bulk delete (review). The steps are the kernel's
 * `runBulkProcess`; each of its callbacks becomes a phase of this screen that resolves when the
 * person submits it (Ctrl+S), goes back (F4) or cancels (Esc).
 */

import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import {
  BACK, BulkDeclinedError, BulkMappingError, FormSession, ProcessCancelledError, ProcessError, blocksToText, checkMapping, diffMappings, columnName, columnPreview, deleteSavedBulkLoadProfile,
  displayDateTime, helpEntryText, selectHelpContent, formatTable, formatValue, hasChildTables, isProfileOwner, splitProfilesByOwner, listSavedBulkLoadProfiles, mappingFromProfile, profileFromMapping, runBulkProcess, savedBulkLoadProfilesAvailable,
  screenToText, setHasHeaderRow, storeSavedBulkLoadProfile, structureFields, type BulkLoadTableStructure, type BulkMapping, type FieldMeta, type FieldValues, type FileDescription,
  type MappedField, type MappingContext, type ProcessMeta, type QueryFilter, type ReviewContext, type ReviewDecision, type SavedBulkLoadProfile, type ScreenBlock, type ValueMappingContext,
} from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { ChoiceOverlay, PromptOverlay } from '../overlays/basic'
import { PickerOverlay } from '../overlays/picker'
import { DatePromptOverlay } from '../controls/date-picker'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { FKeyLabels, MenuEntry, Screen } from '../types'
import { errorText, pad, trunc, hintLine } from '../util/text'
import { ListModel, Panel, type Row } from './list'

export type BulkKind = 'insert' | 'editWithFile' | 'edit' | 'delete'

export interface BulkOptions {
  kind: BulkKind
  /** Edit and delete: the records (checked ids or the query filter). */
  records?: { ids: string[] } | { filter: QueryFilter }
  /** Insert and edit with a file: the file to load. */
  filePath?: string
  savedProfile?: SavedBulkLoadProfile
  tableVariant?: string
  /** Called when the run completed (the grid refreshes and drops a deleted selection). */
  onDone?: () => void
}

type Phase = 'starting' | 'edit' | 'mapping' | 'values' | 'review' | 'other' | 'running' | 'done' | 'error' | 'cancelled'

const CONTENT_TYPES: Record<string, string> = { '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.json': 'application/json', '.txt': 'text/plain' }

const KIND_LABEL: Record<BulkKind, string> = { insert: 'Bulk insert', editWithFile: 'Bulk edit with a file', edit: 'Bulk edit', delete: 'Bulk delete' }

function screenText(blocks: ScreenBlock[]): string {
  return screenToText(blocks.filter((b) => b.kind !== 'form'), { table: (rows, columns, headers) => formatTable(rows, columns, headers, 40), widget: (b) => blocksToText(b) })
}

export class BulkScreen implements Screen {
  readonly kind = 'bulk'
  readonly id: string
  readonly list = new ListModel()
  phase: Phase = 'starting'
  error?: string
  /** Problems the last Ctrl+S found (mapping check, missing values). */
  problems: string[] = []
  progress = ''
  resultText = ''
  stepLabel = ''
  canGoBack = false
  private abort = new AbortController()
  private resolve?: (value: unknown) => void
  // edit form
  private session?: FormSession
  private enabled = new Set<string>()
  // file mapping
  private mappingContext?: MappingContext
  mapping?: BulkMapping
  private savedProfile?: SavedBulkLoadProfile
  private profiles?: SavedBulkLoadProfile[]
  // value mapping
  private valueContext?: ValueMappingContext
  private valueMap: Record<string, unknown> = {}
  private valueLabels: Record<string, string> = {}
  /** Labels of possible-value defaults chosen in the picker, by field. */
  private defaultLabels: Record<string, string> = {}
  // review
  private reviewContext?: ReviewContext
  private screenLines: string[] = []

  constructor(private store: AppStore, readonly tableName: string, readonly processName: string, readonly options: BulkOptions) {
    this.id = `bulk:${processName}:${Date.now()}`
    this.savedProfile = options.savedProfile
    this.start()
  }

  title(): string {
    return `${KIND_LABEL[this.options.kind]}: ${this.store.meta?.tables?.[this.tableName]?.label ?? this.tableName}`
  }

  fkeys(): FKeyLabels {
    return { 3: null, 4: this.canGoBack && this.waiting() ? 'Back' : null, 6: null, 7: null, 8: null }
  }

  busy(): boolean {
    return !['done', 'error', 'cancelled'].includes(this.phase)
  }

  waiting(): boolean {
    return ['edit', 'mapping', 'values', 'review', 'other'].includes(this.phase)
  }

  dispose(): void {
    this.abort.abort()
  }

  private answer(value: unknown): void {
    const r = this.resolve
    this.resolve = undefined
    this.problems = []
    this.phase = 'running'
    this.build()
    this.store.bump()
    r?.(value)
  }

  private wait<T>(phase: Phase): Promise<T> {
    this.phase = phase
    this.problems = []
    this.build()
    this.store.bump()
    return new Promise<T>((resolve) => { this.resolve = resolve as (v: unknown) => void })
  }

  private start(): void {
    const c = this.store.client!
    const { kind } = this.options
    let file: { name: string; bytes: Uint8Array; type?: string } | undefined
    if (this.options.filePath) {
      try {
        file = { name: basename(this.options.filePath), bytes: new Uint8Array(readFileSync(this.options.filePath)), type: CONTENT_TYPES[extname(this.options.filePath).toLowerCase()] }
      } catch (e) {
        this.phase = 'error'
        this.error = `cannot read ${this.options.filePath}: ${errorText(e)}`
        this.build()
        return
      }
    }
    const work = async () => {
      const meta = await c.processMeta(this.processName) as unknown as ProcessMeta
      return runBulkProcess({
        baseUrl: c.server,
        fetch: c.fetch,
        meta,
        signal: this.abort.signal,
        tableVariant: this.options.tableVariant,
        stepTimeoutMillis: 0,
        records: this.options.records,
        file,
        values: file ? { tableName: this.tableName } : undefined,
        savedProfile: this.savedProfile,
        screen: { recordLimit: 20, previewLimit: 20, format: (field, value, shown) => (field.type === 'DATE_TIME' ? displayDateTime(value, shown) : formatValue(field, value)) },
        onProgress: (e) => {
          this.progress = e.phase === 'running' ? `running${e.current !== undefined ? ` ${e.current}/${e.total ?? '?'}` : ''}${e.message ? ` ${e.message}` : ''}` : e.phase === 'back' ? 'going back' : e.phase === 'cancel' ? 'cancelling' : e.step ? `step ${e.step}` : e.phase
          this.build()
          this.store.bump()
        },
        present: ({ step, screen, isLast }) => {
          this.stepLabel = step.label ?? step.name
          if (isLast) this.resultText = screenText(screen)
        },
        editForm: kind === 'edit' ? async ({ step, fields, values, canGoBack }) => {
          this.stepLabel = step.label ?? step.name
          this.canGoBack = canGoBack
          this.session = new FormSession({ baseUrl: c.server, fetch: c.fetch, scope: { process: this.processName }, fields, initialValues: values })
          return this.wait('edit')
        } : undefined,
        chooseMapping: async (ctx) => {
          this.stepLabel = ctx.step.label ?? ctx.step.name
          this.canGoBack = ctx.canGoBack
          this.mappingContext = ctx
          this.mapping = structuredClone(ctx.previous ?? ctx.suggestion)
          if (this.mapping.isBulkEdit && !this.mapping.keyFields) {
            const options = await ctx.keyFieldOptions().catch(() => [])
            if (options.length === 1) this.mapping.keyFields = options[0]!.id
          }
          return this.wait('mapping')
        },
        mapValues: async (ctx) => {
          this.stepLabel = `${ctx.step.label ?? ctx.step.name}: ${ctx.field.label ?? ctx.fieldName} (${ctx.index + 1} of ${ctx.count})`
          this.canGoBack = ctx.canGoBack
          this.valueContext = ctx
          this.valueMap = { ...ctx.mapped }
          this.valueLabels = { ...ctx.labels }
          return this.wait('values')
        },
        review: async (ctx) => {
          this.stepLabel = ctx.step.label ?? ctx.step.name
          this.canGoBack = ctx.canGoBack
          this.reviewContext = ctx
          this.screenLines = screenText(ctx.screen).split('\n')
          return this.wait<ReviewDecision | typeof BACK>('review')
        },
        other: async ({ step, fields, values, screen }) => {
          this.stepLabel = step.label ?? step.name
          this.screenLines = screenText(screen).split('\n')
          if (!fields.length) return {}
          this.session = new FormSession({ baseUrl: c.server, fetch: c.fetch, scope: { process: this.processName }, fields, initialValues: values })
          return this.wait('other')
        },
      })
    }
    work().then((outcome) => {
      this.phase = 'done'
      if (!this.resultText && outcome.lastScreen) this.resultText = screenText(outcome.lastScreen)
      this.options.onDone?.()
      this.build()
      this.store.bump()
    }).catch((e) => {
      if (e instanceof BulkDeclinedError) {
        this.phase = 'cancelled'
        this.resultText = 'Not submitted; nothing was changed.'
      } else if (e instanceof ProcessCancelledError || this.abort.signal.aborted) {
        this.phase = 'cancelled'
        this.resultText = `Cancelled. ${e instanceof Error ? e.message : ''}`.trim()
      } else {
        this.phase = 'error'
        this.error = e instanceof BulkMappingError ? `${e.message}: ${(e as BulkMappingError & { problems?: string[] }).problems?.join('; ') ?? ''}` : e instanceof ProcessError ? e.message : errorText(e)
      }
      this.build()
      this.store.bump()
    })
  }

  // ---- edit form -------------------------------------------------------------------------

  private fieldValueText(session: FormSession, f: FieldMeta): string {
    const v = session.values[f.name]
    if (v === null || v === undefined || v === '') return ''
    return session.displayValues[f.name] ?? String(v)
  }

  private editField(f: FieldMeta, then?: () => void): void {
    const session = this.session!
    const set = (value: unknown) => {
      this.store.run(session.set(f.name, value), () => {
        this.enabled.add(f.name)
        this.build()
        then?.()
      })
    }
    if (session.hasChoices(f.name)) {
      this.store.open(new PickerOverlay(this.store, session, f.name, (o) => {
        if (o) session.displayValues[f.name] = o.label
        set(o ? o.id : null)
      }))
    } else if (f.type === 'DATE' || f.type === 'DATE_TIME') {
      this.store.open(new DatePromptOverlay(this.store, f.label ?? f.name, f.type, session.values[f.name], (v) => set(v), { utc: true }))
    } else if (f.type === 'BOOLEAN') {
      this.store.open(new ChoiceOverlay(this.store, f.label ?? f.name, [{ label: 'Yes', value: true }, { label: 'No', value: false }, { label: '(empty)', value: null as boolean | null }], (v) => set(v)))
    } else {
      this.store.open(new PromptOverlay(this.store, f.label ?? f.name, `${f.type ?? 'STRING'}; an empty value clears the field.`, (text) => set(text === '' ? null : text), this.fieldValueText(session, f)))
    }
  }

  private submitEdit(): void {
    if (!this.enabled.size) {
      this.problems = ['switch on at least one field (Space), or Esc to cancel']
      return this.build()
    }
    const errors = this.session!.validate(this.enabled)
    if (Object.keys(errors).length) {
      this.problems = Object.entries(errors).map(([k, v]) => `${this.session!.fields[k]?.label ?? k}: ${v}`)
      return this.build()
    }
    this.answer({ values: this.session!.submission(), enabled: [...this.enabled] })
  }

  // ---- file mapping ----------------------------------------------------------------------

  private get structure(): BulkLoadTableStructure | undefined {
    return this.mappingContext?.structure
  }

  private get file(): FileDescription | undefined {
    return this.mappingContext?.file
  }

  private mappedOf(name: string): MappedField | undefined {
    return this.mapping?.fields.find((f) => f.name === name)
  }

  private sourceText(f: MappedField | undefined): string {
    if (!f) return '—'
    if (f.column !== undefined) return `column ${columnName(this.file!, f.column, this.mapping!.hasHeaderRow)}`
    if (f.defaultValue !== undefined && f.defaultValue !== null && f.defaultValue !== '') return `default ${this.defaultLabels[f.name] ?? String(f.defaultValue)}`
    return '(choose a column or a default)'
  }

  /** The choices for one field: a column, a default value, value mapping, clear if empty, not loaded. */
  private chooseSource(name: string): void {
    const mapping = this.mapping!
    const file = this.file!
    const sf = structureFields(this.structure!).find((s) => s.name === name.split(',')[0])
    const label = sf?.label ?? name
    type Choice = { kind: 'column'; index: number } | { kind: 'default' } | { kind: 'values' } | { kind: 'clear' } | { kind: 'remove' }
    const columns = Math.max(file.headers.length, file.preview.length)
    const current = this.mappedOf(name)
    const choices: Array<{ label: string; value: Choice; detail?: string }> = []
    for (let i = 0; i < columns; i++) choices.push({ label: `Column ${columnName(file, i, mapping.hasHeaderRow)}${mapping.hasHeaderRow ? ` (${file.letters[i] ?? ''})` : ''}`, value: { kind: 'column', index: i }, detail: trunc(columnPreview(file, i, mapping.hasHeaderRow).slice(0, 3).join(', '), 30) })
    choices.push({ label: 'A default value for every row…', value: { kind: 'default' } })
    if (current?.column !== undefined && sf?.field.possibleValueSourceName) choices.push({ label: `${current.doValueMapping ? 'Stop mapping' : 'Map'} file values to ${sf.field.label ?? name} values`, value: { kind: 'values' } })
    if (mapping.isBulkEdit && current) choices.push({ label: `${current.clearIfEmpty ? 'Keep' : 'Clear'} the value when the file cell is empty`, value: { kind: 'clear' } })
    if (current) choices.push({ label: 'Do not load this field', value: { kind: 'remove' } })
    const ensure = (): MappedField => {
      let f = this.mappedOf(name)
      if (!f) {
        f = { name }
        mapping.fields.push(f)
      }
      return f
    }
    this.store.open(new ChoiceOverlay<Choice>(this.store, `${label}: load from`, choices, (choice) => {
      if (choice.kind === 'column') {
        const f = ensure()
        f.column = choice.index
        delete f.defaultValue
        if (mapping.hasHeaderRow) f.header = file.headers[choice.index]
      } else if (choice.kind === 'default') {
        const setDefault = (value: unknown, shown?: string) => {
          const f = ensure()
          delete f.column
          delete f.header
          f.defaultValue = value
          if (shown !== undefined) this.defaultLabels[name] = shown
          this.build()
          this.store.bump()
        }
        const field = sf?.field
        if (field?.possibleValueSourceName) {
          const c = this.store.client!
          const session = new FormSession({ baseUrl: c.server, fetch: c.fetch, scope: { table: sf!.tableName }, fields: [field] })
          return this.store.open(new PickerOverlay(this.store, session, field.name, (o) => { if (o) setDefault(o.id, o.label) }))
        }
        if (field?.type === 'BOOLEAN') return this.store.open(new ChoiceOverlay(this.store, `${label}: default value`, [{ label: 'Yes', value: true }, { label: 'No', value: false }], (v) => setDefault(v, v ? 'Yes' : 'No')))
        return this.store.open(new PromptOverlay(this.store, `${label}: default value`, `Used for every row (${field?.type ?? 'STRING'}).`, (text) => setDefault(text), current?.defaultValue !== undefined ? String(current.defaultValue) : ''))
      } else if (choice.kind === 'values') {
        const f = ensure()
        f.doValueMapping = !f.doValueMapping
      } else if (choice.kind === 'clear') {
        const f = ensure()
        f.clearIfEmpty = !f.clearIfEmpty
      } else {
        mapping.fields = mapping.fields.filter((f) => f.name !== name)
      }
      this.build()
    }, '', Math.max(0, current?.column ?? 0)))
  }

  private toggleHeader(): void {
    const warnings = setHasHeaderRow(this.mapping!, !this.mapping!.hasHeaderRow, this.file!)
    this.problems = warnings
    this.build()
  }

  private chooseLayout(): void {
    if (!hasChildTables(this.structure!)) return this.store.flash(`${this.structure!.label} has no child tables: the layout is FLAT`)
    const layouts = [{ label: 'FLAT: one row per record', value: 'FLAT' as const }, { label: 'TALL: one row per child record, parent fields repeated', value: 'TALL' as const }, { label: 'WIDE: child records side by side in columns', value: 'WIDE' as const }]
    this.store.open(new ChoiceOverlay(this.store, 'File layout', layouts, (layout) => {
      this.mapping!.layout = layout
      this.build()
    }))
  }

  private chooseKeys(): void {
    const ctx = this.mappingContext!
    this.store.run(ctx.keyFieldOptions(), (options) => {
      if (!options.length) return this.store.flash('the server offers no key fields')
      this.store.open(new ChoiceOverlay(this.store, 'Key fields that find each record', options.map((o) => ({ label: o.label, value: o.id })), (id) => {
        this.mapping!.keyFields = id
        this.build()
      }))
    })
  }

  private submitMapping(): void {
    const { errors, warnings } = checkMapping(this.mapping!, this.structure!, this.file!)
    if (errors.length) {
      this.problems = errors
      return this.build()
    }
    if (warnings.length) this.store.flash(warnings.join('; '))
    this.answer(this.mapping)
  }

  /** Saved bulk load profiles: use one, save this mapping as one, delete one. */
  savedProfiles(): void {
    const c = this.store.client!
    if (!savedBulkLoadProfilesAvailable(this.store.meta as never)) return this.store.flash('this server offers no saved bulk load profiles')
    const isBulkEdit = this.options.kind === 'editWithFile'
    this.store.run(listSavedBulkLoadProfiles(c.server, c.fetch, this.tableName, isBulkEdit), (profiles) => {
      this.profiles = profiles
      type Pick = { kind: 'use' | 'delete'; profile: SavedBulkLoadProfile } | { kind: 'save' | 'update' }
      const userId = this.store.status.userId
      const { yours, shared } = splitProfilesByOwner(profiles, userId)
      const notOwner = (p: SavedBulkLoadProfile) => (isProfileOwner(p, userId) ? undefined : `only its owner${p.userId ? ` (${p.userId})` : ''} may change it`)
      const onMapping = this.phase === 'mapping' ? undefined : 'on the mapping screen'
      const choices: Array<{ label: string; value: Pick; detail?: string; disabled?: string }> = [
        ...yours.map((p) => ({ label: `Use ${p.label}`, value: { kind: 'use' as const, profile: p }, detail: 'yours', disabled: onMapping })),
        ...shared.map((p) => ({ label: `Use ${p.label}`, value: { kind: 'use' as const, profile: p }, detail: p.userId ? `shared by ${p.userId}` : 'shared', disabled: onMapping })),
        { label: 'Save this mapping as a new profile…', value: { kind: 'save' }, disabled: this.mapping ? undefined : 'on the mapping screen' },
        ...(this.savedProfile ? [{ label: `Update ${this.savedProfile.label} with this mapping`, value: { kind: 'update' as const }, disabled: notOwner(this.savedProfile) ?? (this.mapping ? undefined : 'on the mapping screen') }] : []),
        ...profiles.map((p) => ({ label: `Delete ${p.label}…`, value: { kind: 'delete' as const, profile: p }, disabled: notOwner(p) })),
      ]
      this.store.open(new ChoiceOverlay<Pick>(this.store, `Saved bulk load profiles · ${profiles.length}`, choices, (pick) => {
        if (pick.kind === 'use') {
          this.savedProfile = pick.profile
          this.mapping = mappingFromProfile(pick.profile.profile, this.structure!)
          this.mapping.isBulkEdit = isBulkEdit
          this.build()
          this.store.flash(`using ${pick.profile.label}`)
        } else if (pick.kind === 'delete') {
          this.store.confirm(`Delete the saved profile ${pick.profile.label}?`, () => this.store.run(deleteSavedBulkLoadProfile(c.server, c.fetch, pick.profile.id), () => {
            if (this.savedProfile?.id === pick.profile.id) this.savedProfile = undefined
            this.store.flash(`deleted ${pick.profile.label}`)
          }))
        } else if (pick.kind === 'update') {
          const saved = this.savedProfile!
          const changes = diffMappings(mappingFromProfile(saved.profile, this.structure!), this.mapping!, this.structure!, this.file!)
          if (!changes.length) return this.store.flash(`${saved.label} already has this mapping`)
          this.store.confirm(`Update ${saved.label}?\n${changes.map((c) => `• ${c}`).join('\n')}`, () => this.store.run(storeSavedBulkLoadProfile(c.server, c.fetch, { table: this.tableName, label: saved.label, isBulkEdit, profile: profileFromMapping(this.mapping!), id: saved.id }), (p) => {
            this.savedProfile = p
            this.store.flash(`updated ${p.label}`)
          }))
        } else {
          this.store.open(new PromptOverlay(this.store, 'Save the mapping as', 'A name for the saved profile.', (label) => {
            if (!label.trim()) return
            this.store.run(storeSavedBulkLoadProfile(c.server, c.fetch, { table: this.tableName, label: label.trim(), isBulkEdit, profile: profileFromMapping(this.mapping!) }), (p) => {
              this.savedProfile = p
              this.store.flash(`saved ${p.label}`)
            })
          }))
        }
      }))
    })
  }

  // ---- value mapping ---------------------------------------------------------------------

  private mapValue(fileValue: string): void {
    const ctx = this.valueContext!
    const c = this.store.client!
    const field = { ...ctx.field, name: ctx.field.name ?? ctx.fieldName.split('.').pop()!.split(',')[0]! }
    const set = (id: unknown, label?: string) => {
      if (id === null || id === undefined || id === '') delete this.valueMap[fileValue]
      else this.valueMap[fileValue] = id
      if (label !== undefined && id !== null && id !== undefined) this.valueLabels[String(id)] = label
      this.build()
      this.store.bump()
    }
    if (field.possibleValueSourceName) {
      const session = new FormSession({ baseUrl: c.server, fetch: c.fetch, scope: { table: ctx.tableName }, fields: [field] })
      this.store.open(new PickerOverlay(this.store, session, field.name, (o) => set(o?.id ?? null, o?.label), fileValue))
    } else {
      this.store.open(new PromptOverlay(this.store, `${fileValue} becomes`, 'The table value for this file value.', (text) => set(text), String(this.valueMap[fileValue] ?? fileValue)))
    }
  }

  private submitValues(): void {
    const ctx = this.valueContext!
    const missing = ctx.fileValues.filter((v) => this.valueMap[v] === undefined && v !== '')
    if (missing.length && ctx.field.isRequired) {
      this.problems = [`map every value of a required field: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`]
      return this.build()
    }
    this.answer(this.valueMap)
  }

  // ---- rows ------------------------------------------------------------------------------

  build(): void {
    const t = theme()
    const g = glyphs()
    const rows: Row[] = []
    const add = (text: string, fg?: string, bold?: boolean) => rows.push({ text, fg, bold })
    if (this.stepLabel) add(this.stepLabel, t.acc, true)
    switch (this.phase) {
      case 'starting':
      case 'running':
        add(this.progress || 'working…', t.dim)
        break
      case 'edit':
      case 'other': {
        const session = this.session!
        if (this.phase === 'other') for (const l of this.screenLines.filter(Boolean)) add(l)
        if (this.phase === 'edit') {
          add('Switch on the fields to change (Space); Enter sets the value.', t.dim)
          add('Fields left off keep their values.', t.dim)
        }
        for (const name of session.order) {
          const f = session.fields[name]!
          const on = this.phase === 'other' || this.enabled.has(name)
          rows.push({ text: `${this.phase === 'edit' ? (on ? g.check : g.uncheck) + ' ' : ''}${pad(f.label ?? name, 28)} ${this.fieldValueText(session, f) || (on && this.phase === 'edit' ? '(empty: the field is cleared)' : '')}${session.errors[name] ? `  ${session.errors[name]}` : ''}`, key: `f:${name}`, fg: on ? t.fg : t.dim, action: () => this.editField(f) })
        }
        break
      }
      case 'mapping': {
        const mapping = this.mapping!
        const file = this.file!
        add(`File ${file.name ?? ''} · ${Math.max(file.headers.length, file.preview.length)} columns · layout ${mapping.layout} · header row ${mapping.hasHeaderRow ? 'yes' : 'no'}${mapping.isBulkEdit ? ` · key ${mapping.keyFields ?? '(choose with k)'}` : ''}${this.savedProfile ? ` · profile ${this.savedProfile.label}` : ''}`, t.dim)
        add(`${pad('Field', 30)} ${pad('Loaded from', 30)} Preview`, t.acc, true)
        const fields = structureFields(this.structure!)
        const names = [...fields.map((f) => f.name), ...mapping.fields.map((f) => f.name).filter((n) => !fields.some((f) => f.name === n))]
        for (const name of names) {
          const sf = fields.find((f) => f.name === name.split(',')[0])
          const m = this.mappedOf(name)
          const preview = m?.column !== undefined ? columnPreview(file, m.column, mapping.hasHeaderRow).slice(0, 3).join(', ') : ''
          const opts = [m?.doValueMapping ? 'map values' : '', m?.clearIfEmpty ? 'clear if empty' : ''].filter(Boolean).join(', ')
          rows.push({ text: `${pad(`${sf?.label ?? name}${sf?.field.isRequired ? ' *' : ''}${name.includes(',') ? ` #${Number(name.split(',')[1]) + 1}` : ''}`, 30)} ${pad(this.sourceText(m), 30)} ${trunc(preview, 30)}${opts ? `  [${opts}]` : ''}`, key: `m:${name}`, fg: m ? t.fg : t.dim, action: () => this.chooseSource(name) })
        }
        break
      }
      case 'values': {
        const ctx = this.valueContext!
        add(`Map each value in the file to a ${ctx.field.label ?? ctx.fieldName} value (Enter picks).`, t.dim)
        add(`${pad('In the file', 30)} Becomes`, t.acc, true)
        for (const v of ctx.fileValues) {
          const id = this.valueMap[v]
          rows.push({ text: `${pad(v || '(empty)', 30)} ${id === undefined ? '(not mapped)' : this.valueLabels[String(id)] ? `${this.valueLabels[String(id)]} (${String(id)})` : String(id)}`, key: `v:${v}`, fg: id === undefined ? t.warn : t.fg, action: () => this.mapValue(v) })
        }
        break
      }
      case 'review': {
        const ctx = this.reviewContext!
        for (const l of this.screenLines) add(l)
        add('')
        if (!ctx.validated && ctx.supportsFullValidation) rows.push({ text: `${g.pointer} Validate every record first`, key: 'r:validate', fg: t.acc, action: () => this.answer('validate') })
        rows.push({ text: `${g.pointer} ${this.options.kind === 'delete' ? 'Delete the records' : this.options.kind === 'insert' ? 'Load the file' : 'Update the records'} now${!ctx.validated && ctx.supportsFullValidation ? ' (without full validation)' : ''}`, key: 'r:submit', fg: t.acc, action: () => this.store.confirm(`${KIND_LABEL[this.options.kind]}: submit?`, () => this.answer(ctx.validated || !ctx.supportsFullValidation ? 'submit' : 'skip')) })
        if (ctx.canGoBack) rows.push({ text: `${g.pointer} Go back`, key: 'r:back', action: () => this.answer(BACK) })
        rows.push({ text: `${g.pointer} Cancel: change nothing`, key: 'r:cancel', action: () => this.answer('cancel') })
        break
      }
      case 'done':
      case 'cancelled':
        for (const l of (this.resultText || (this.phase === 'done' ? 'Done.' : 'Cancelled.')).split('\n')) add(l, this.phase === 'cancelled' ? t.warn : undefined)
        break
      case 'error':
        add(this.error ?? 'failed', t.err)
        break
    }
    if (this.problems.length) {
      add('')
      for (const p of this.problems) add(`${"!"} ${p}`, t.err)
    }
    this.list.setRows(rows)
  }

  hint(): string {
    switch (this.phase) {
      case 'edit': return 'Space switch on · Enter set value · Ctrl+S next · F4 back · Esc cancel'
      case 'other': return 'Enter set value · Ctrl+S next · Esc cancel'
      case 'mapping': return `Enter choose source · h header row · l layout${this.mapping?.isBulkEdit ? ' · k key fields' : ''} · P saved profiles · Ctrl+S next · F4 back · Esc cancel`
      case 'values': return 'Enter map value · Ctrl+S next · F4 back · Esc cancel'
      case 'review': return 'Enter choose · v validate · Ctrl+S submit · F4 back · Esc cancel'
      case 'running': case 'starting': return 'Esc cancel the run'
      default: return 'Esc back'
    }
  }

  menu(): MenuEntry[] {
    const out: MenuEntry[] = []
    if (this.phase === 'mapping') {
      out.push({ section: 'Context', label: 'Toggle the header row', key: 'h', run: () => this.toggleHeader() })
      out.push({ section: 'Context', label: 'File layout (FLAT, TALL, WIDE)', key: 'l', run: () => this.chooseLayout() })
      if (this.mapping?.isBulkEdit) out.push({ section: 'Context', label: 'Key fields', key: 'k', run: () => this.chooseKeys() })
    }
    if (this.options.kind === 'insert' || this.options.kind === 'editWithFile') out.push({ section: 'Context', label: 'Saved bulk load profiles: use, save, delete', key: 'P', run: () => this.savedProfiles() })
    if (this.waiting()) {
      out.push({ section: 'Context', label: 'Next', key: 'Ctrl+S', run: () => this.next() })
      if (this.canGoBack) out.push({ section: 'Context', label: 'Back', key: 'F4', run: () => this.answer(BACK) })
      out.push({ section: 'Context', label: 'Cancel the run', key: 'Esc', run: () => this.cancel() })
    }
    return out
  }

  private next(): void {
    if (this.phase === 'edit') this.submitEdit()
    else if (this.phase === 'other') this.answer(this.session!.submission())
    else if (this.phase === 'mapping') this.submitMapping()
    else if (this.phase === 'values') this.submitValues()
    else if (this.phase === 'review') this.list.rows.find((r) => r.key === 'r:submit')?.action?.()
    this.store.bump()
  }

  private cancel(): void {
    if (this.phase === 'review') return this.answer('cancel')
    this.store.confirm('Cancel the run? Nothing is changed.', () => {
      this.abort.abort()
      if (this.resolve) this.answer(BACK)
    })
  }

  onKey(key: Key): boolean {
    if (key.name === 'escape') {
      if (!this.busy()) return false
      this.cancel()
      return true
    }
    if (!this.waiting()) return this.list.onKey(key)
    if (key.ctrl && key.name === 's') {
      this.next()
      return true
    }
    if (key.name === 'f4' && this.canGoBack) {
      this.answer(BACK)
      return true
    }
    if (this.phase === 'edit' && key.name === 'space') {
      const name = this.list.current?.key?.slice(2)
      if (name) {
        if (this.enabled.has(name)) this.enabled.delete(name)
        else this.enabled.add(name)
        this.build()
      }
      return true
    }
    if (this.phase === 'mapping') {
      if (key.sequence === 'h') { this.toggleHeader(); return true }
      if (key.sequence === 'l') { this.chooseLayout(); return true }
      if (key.sequence === 'k' && this.mapping?.isBulkEdit) { this.chooseKeys(); return true }
      if (key.sequence === 'P') { this.savedProfiles(); return true }
    }
    if (this.phase === 'review' && key.sequence === 'v' && this.reviewContext?.supportsFullValidation && !this.reviewContext.validated) {
      this.answer('validate')
      return true
    }
    if (key.name === 'return' || key.name === 'f3') {
      this.list.current?.action?.()
      return true
    }
    return this.list.onKey(key)
  }

  /** The field under the cursor's help (mapping and edit screens), shown above the key hint. */
  helpLine(): string {
    const key = this.list.current?.key ?? ''
    let field: FieldMeta | undefined
    if (key.startsWith('m:') && this.structure) field = structureFields(this.structure).find((f) => f.name === key.slice(2).split(',')[0])?.field
    else if (key.startsWith('f:') && this.session) field = this.session.fields[key.slice(2)]
    return field ? helpEntryText(selectHelpContent((field as { helpContents?: unknown }).helpContents, ['EDIT_SCREEN', 'WRITE_SCREENS', 'ALL_SCREENS'])) : ''
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    const help = this.helpLine()
    return (
      <Panel title={this.title()} width={width} height={height} focused={focused}>
        {this.list.view(width - 2, height - (help ? 4 : 3), focused)}
        {help ? <text flexShrink={0} wrapMode="none" fg={t.acc2}>{pad(` ${trunc(help, width - 4)}`, width - 2)}</text> : null}
        <text flexShrink={0} wrapMode="none" fg={t.dim}>{hintLine(this.hint(), width - 2)}</text>
      </Panel>
    )
  }
}

/** The table's bulk actions and processes, for the `a` actions list and the F9 menu. */
export function startBulk(store: AppStore, tableName: string, processName: string, options: BulkOptions): void {
  const needsFile = options.kind === 'insert' || options.kind === 'editWithFile'
  if (needsFile && !options.filePath) {
    void import('../overlays/files-helpers').then(({ openFile }) => openFile(store, `${KIND_LABEL[options.kind]}: the file to load (CSV, XLSX)`, (path) => store.push(new BulkScreen(store, tableName, processName, { ...options, filePath: path }))))
    return
  }
  store.push(new BulkScreen(store, tableName, processName, options))
}

