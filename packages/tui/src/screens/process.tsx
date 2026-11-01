/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { FormSession, ProcessError, runProcess, type FieldMeta, type FieldValues, type ProcessMeta, type ProcessStep, type QueryFilter } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { charOf } from '../keys'
import type { AppStore } from '../store'
import { glyphs, theme } from '../theme'
import type { FKeyLabels, MenuEntry, Screen } from '../types'
import { wrap } from '../overlays/basic'
import { cell, errorText, pad, trunc } from '../util/text'
import { FormEditor } from './form'
import { Panel } from './list'

class Cancelled extends Error {
  constructor() {
    super('cancelled')
  }
}

export interface ProcessOptions {
  recordIds?: string[]
  filter?: QueryFilter
  values?: FieldValues
}

type Phase = 'starting' | 'form' | 'review' | 'running' | 'done' | 'error' | 'cancelled'

/**
 * A process wizard over the kernel's runProcess: each step's form through a FormSession (the
 * provider waits for Ctrl+S), the validation review choice, progress with N/M and elapsed time,
 * summary results, and Esc to cancel (POST cancel on the server).
 */
export class ProcessScreen implements Screen {
  readonly kind = 'process'
  readonly id: string
  meta?: ProcessMeta
  phase: Phase = 'starting'
  step?: ProcessStep
  stepValues: FieldValues = {}
  editor?: FormEditor
  reviewChoice = 0
  progress: { message?: string; current?: number; total?: number } = {}
  stepStarted = Date.now()
  started = Date.now()
  finished?: number
  result?: { values: FieldValues; lastStep?: ProcessStep }
  error?: string
  log: string[] = []
  processUUID?: string
  private cancelled = false
  /** Files chosen in a step's form, handed to the kernel runner (sent with that step). */
  private stepFiles: Record<string, { name: string; bytes: Uint8Array }> = {}
  private pending?: { resolve: (v: FieldValues) => void; reject: (e: Error) => void }

  constructor(private store: AppStore, readonly processName: string, readonly options: ProcessOptions = {}) {
    this.id = `process:${processName}:${Date.now()}`
    this.start()
  }

  title(): string {
    return this.meta?.label ?? (this.store.meta?.processes?.[this.processName]?.label ?? this.processName)
  }

  helpTopic() {
    return { kind: 'process' as const, name: this.processName }
  }

  cliEquivalent(): string {
    return `process run ${this.processName}${this.options.recordIds?.length ? ` -r ${this.options.recordIds.join(',')}` : ''}`
  }

  busy(): boolean {
    return this.phase === 'running' || this.phase === 'starting'
  }

  dirty(): boolean {
    return this.phase === 'form' && (this.editor?.dirty() ?? false)
  }

  capturesText(): boolean {
    return this.phase === 'form'
  }

  /** A fetch that stops when cancelled and notes the processUUID for the cancel call. */
  private fetchFor(): typeof fetch {
    const base = this.store.client!.fetch
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (this.cancelled) throw new Cancelled()
      const response = await base(input, init)
      if (!this.processUUID && /\/processes\//.test(String(input instanceof Request ? input.url : input))) {
        try {
          const body = await response.clone().json() as { processUUID?: string }
          if (body.processUUID) this.processUUID = body.processUUID
        } catch {
          // not JSON
        }
      }
      return response
    }) as typeof fetch
  }

  start(): void {
    this.phase = 'starting'
    this.cancelled = false
    this.processUUID = undefined
    this.result = undefined
    this.error = undefined
    this.log = []
    this.started = Date.now()
    this.finished = undefined
    const client = this.store.client!
    const work = async () => {
      this.meta = await client.processMeta(this.processName)
      this.store.remember({ kind: 'process', name: this.processName, label: this.meta.label ?? this.processName })
      return runProcess({
        baseUrl: client.server,
        fetch: this.fetchFor(),
        meta: this.meta,
        values: this.options.values,
        records: this.options.recordIds?.length ? { ids: this.options.recordIds } : this.options.filter ? { filter: this.options.filter } : undefined,
        stepFiles: this.stepFiles,
        stepTimeoutMillis: 0,
        pollMillis: 250,
        always: true,
        onProgress: (e) => {
          if (e.phase === 'init') this.note('starting')
          else if (e.phase === 'step') {
            this.phase = 'running'
            this.stepStarted = Date.now()
            this.progress = {}
            this.note(`step ${e.step}`)
          } else if (e.phase === 'running') {
            this.phase = 'running'
            this.progress = { message: e.message, current: e.current, total: e.total }
          }
          this.store.bump()
        },
        provide: (context) => this.provide(context.step, context.fields, context.values, context.response.values ?? {}),
      })
    }
    work().then((outcome) => {
      this.result = { values: outcome.values, lastStep: outcome.lastStep }
      this.phase = 'done'
      this.finished = Date.now()
      this.note('complete')
      this.store.bump()
    }).catch((e) => {
      if (e instanceof Cancelled || this.cancelled) {
        this.phase = 'cancelled'
      } else {
        this.phase = 'error'
        this.error = e instanceof ProcessError ? e.message : errorText(e)
      }
      this.finished = Date.now()
      this.store.bump()
    })
  }

  note(text: string): void {
    this.log.push(`${new Date().toLocaleTimeString('en-GB')} ${text}`)
    if (this.log.length > 50) this.log.shift()
  }

  /** The runner's provider: shows the step and resolves when the person submits it. */
  private provide(step: ProcessStep, fields: FieldMeta[], values: FieldValues, serverValues: FieldValues): Promise<FieldValues> {
    this.step = step
    this.stepValues = { ...serverValues, ...values }
    const types = (step.components ?? []).map((c) => c.type)
    if (types.includes('VALIDATION_REVIEW_SCREEN') && !fields.length) {
      this.phase = 'review'
      this.reviewChoice = this.stepValues.validationSummary ? 1 : 0
    } else if (fields.length) {
      const client = this.store.client!
      const session = new FormSession({ baseUrl: client.server, fetch: this.fetchFor(), scope: { process: this.processName }, fields, initialValues: values })
      this.editor = new FormEditor(this.store, session, session.promptOrder(fields.map((f) => f.name)), { bulkEdit: types.includes('BULK_EDIT_FORM') })
      this.phase = 'form'
    } else {
      // nothing to ask (a view step that is not the last): continue
      return Promise.resolve({})
    }
    this.store.bump()
    return new Promise<FieldValues>((resolve, reject) => {
      this.pending = { resolve, reject }
    })
  }

  submit(): void {
    const pending = this.pending
    if (!pending) return
    if (this.phase === 'review') {
      this.pending = undefined
      this.phase = 'running'
      pending.resolve({ doFullValidation: this.reviewChoice === 0 ? 'true' : 'false' })
      return
    }
    const editor = this.editor
    if (!editor || editor.saving) return
    editor.saving = true
    editor.check().then((problems) => {
      editor.saving = false
      if (Object.keys(problems).length) {
        editor.formError = `${Object.keys(problems).length} field(s) need attention`
        editor.index = Math.max(0, editor.names.findIndex((n) => problems[n]))
        return
      }
      const out: FieldValues = {}
      const enabled = editor.options.bulkEdit ? editor.enabled : undefined
      for (const n of editor.names) if (editor.session.values[n] !== undefined && (!enabled || enabled.has(n))) out[n] = editor.session.values[n]
      if (enabled) out.bulkEditEnabledFields = [...enabled].join(',')
      for (const [name, file] of editor.files) {
        this.stepFiles[name] = { name: file.name, bytes: file.bytes }
        out[name] = file.name
      }
      this.pending = undefined
      this.phase = 'running'
      this.stepStarted = Date.now()
      pending.resolve(out)
    }).finally(() => this.store.bump())
  }

  cancel(): void {
    if (this.phase === 'done' || this.phase === 'error' || this.phase === 'cancelled') return this.store.back()
    this.store.confirm('Cancel this process?', () => {
      this.cancelled = true
      this.pending?.reject(new Cancelled())
      this.pending = undefined
      this.phase = 'cancelled'
      const uuid = this.processUUID
      if (uuid) this.store.client!.call('cancelProcess', { path: { processName: this.processName, processUUID: uuid } }).then(() => this.note('cancelled on the server')).catch((e) => this.note(`cancel: ${errorText(e)}`)).finally(() => this.store.bump())
    })
  }

  fkeys(): FKeyLabels {
    return { 3: null, 4: null, 6: null, 7: null, 8: null, 5: this.phase === 'done' || this.phase === 'error' || this.phase === 'cancelled' ? 'Re-run' : null }
  }

  onKey(key: Key): boolean {
    if (key.name === 'escape') {
      this.cancel()
      return true
    }
    if (this.phase === 'form') {
      if ((key.ctrl && key.name === 's')) {
        this.submit()
        return true
      }
      return this.editor?.onKey(key) ?? true
    }
    if (this.phase === 'review') {
      if (key.name === 'up' || key.name === 'down' || key.name === 'tab') this.reviewChoice = 1 - this.reviewChoice
      else if (key.name === 'return' || (key.ctrl && key.name === 's')) this.submit()
      return true
    }
    if ((this.phase === 'done' || this.phase === 'error' || this.phase === 'cancelled') && (key.name === 'f5' || charOf(key) === 'r')) {
      this.start()
      return true
    }
    if (this.phase === 'done' && key.name === 'return') {
      this.store.back()
      return true
    }
    return false
  }

  menu(): MenuEntry[] {
    const finished = this.phase === 'done' || this.phase === 'error' || this.phase === 'cancelled'
    return [
      { section: 'Context', label: 'Cancel the process', key: 'Esc', disabled: finished ? 'finished' : undefined, run: () => this.cancel() },
      { section: 'Context', label: 'Run it again', key: 'F5 r', disabled: finished ? undefined : 'still running', run: () => this.start() },
      { section: 'Context', label: 'Copy as a CLI command', detail: `qqq ${this.cliEquivalent()}`, run: () => this.store.message(`qqq ${this.cliEquivalent()}`, 'info', 'CLI equivalent') },
    ]
  }

  private elapsed(from: number): string {
    const s = Math.max(0, Math.round(((this.finished ?? Date.now()) - from) / 1000))
    return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
  }

  private summaryLines(width: number): Array<{ text: string; fg?: string }> {
    const t = theme()
    const out: Array<{ text: string; fg?: string }> = []
    const values = this.result?.values ?? {}
    const lines = (values.processResults ?? values.recordListSummary) as Array<{ status?: string; count?: number; message?: string }> | undefined
    if (Array.isArray(lines) && lines.length) {
      for (const l of lines) {
        const status = String(l.status ?? 'INFO')
        out.push({ text: trunc(`${pad(status, 8)} ${l.count !== undefined && l.count !== null ? String(l.count).padStart(6) : '      '}  ${String(l.message ?? '').replace(/\s+/g, ' ').trim()}`, width), fg: status === 'OK' ? t.ok : status === 'ERROR' ? t.err : status === 'WARNING' ? t.warn : t.fg })
      }
      return out
    }
    const viewFields = (this.result?.lastStep?.viewFields ?? []) as FieldMeta[]
    const names = viewFields.length ? viewFields.map((f) => f.name) : Object.keys(values).filter((k) => values[k] !== null && typeof values[k] !== 'object').slice(0, 30)
    const labelWidth = Math.min(30, Math.max(6, ...names.map((n) => (viewFields.find((f) => f.name === n)?.label ?? n).length)))
    for (const n of names) out.push({ text: trunc(`${pad(viewFields.find((f) => f.name === n)?.label ?? n, labelWidth)}  ${cell({ values }, n)}`, width) })
    if (!out.length) out.push({ text: 'Done.' })
    return out
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    const g = glyphs()
    const inner = width - 2
    const steps = (this.meta?.frontendSteps ?? []) as ProcessStep[]
    const currentIdx = steps.findIndex((s) => s.name === this.step?.name)
    const stepper = steps.map((s, i) => `${i < currentIdx || this.phase === 'done' ? g.check : i === currentIdx ? g.pointer + ' ' : g.uncheck} ${s.label ?? s.name}`).join('   ')
    const body: React.ReactNode[] = []
    const lines: Array<{ text: string; fg?: string; bold?: boolean }> = []
    const help = (this.step?.components ?? []).filter((c) => c.type === 'HELP_TEXT' || c.type === 'HTML').map((c) => String(c.values?.text ?? c.values?.html ?? '').replace(/<[^>]+>/g, ''))
    if (this.phase === 'starting') lines.push({ text: 'starting…', fg: t.dim })
    if (this.phase === 'running') {
      const p = this.progress
      const determinate = p.total !== undefined && p.total > 0 && p.current !== undefined
      const barWidth = Math.max(10, Math.min(60, inner - 30))
      const filled = determinate ? Math.round((p.current! / p.total!) * barWidth) : (Math.floor(Date.now() / 250) % barWidth)
      const bar = determinate ? g.bar.repeat(filled).padEnd(barWidth, '·') : '·'.repeat(filled) + g.bar.repeat(3) + '·'.repeat(Math.max(0, barWidth - filled - 3))
      lines.push({ text: `Running ${this.step?.label ?? this.step?.name ?? ''}`, fg: t.acc, bold: true })
      lines.push({ text: `${bar.slice(0, barWidth)}  ${determinate ? `${p.current}/${p.total}` : 'working'}  · ${this.elapsed(this.stepStarted)} elapsed` })
      if (p.message) lines.push({ text: p.message, fg: t.dim })
      lines.push({ text: 'Esc cancels', fg: t.dim })
    }
    if (this.phase === 'review') {
      const v = this.stepValues
      lines.push({ text: this.step?.label ?? 'Review', fg: t.acc, bold: true })
      if (v.recordCount !== undefined) lines.push({ text: `${String(v.recordCount)} record(s) will be processed.` })
      const summary = v.validationSummary as Array<{ status?: string; count?: number; message?: string }> | undefined
      for (const l of summary ?? []) lines.push({ text: `${pad(String(l.status ?? ''), 8)} ${String(l.count ?? '').padStart(5)}  ${String(l.message ?? '')}`, fg: l.status === 'ERROR' ? t.err : l.status === 'OK' ? t.ok : t.fg })
      lines.push({ text: '' })
      const opts = v.validationSummary ? ['Validate again', 'Run with these results'] : ['Validate first (check every record before running)', 'Skip validation and run']
      opts.forEach((o, i) => lines.push({ text: `${i === this.reviewChoice ? g.radioOn : g.radioOff} ${o}`, fg: i === this.reviewChoice ? t.acc2 : t.fg }))
      lines.push({ text: '' })
      lines.push({ text: '↑↓ choose · Enter continues · Esc cancels', fg: t.dim })
    }
    if (this.phase === 'done') {
      lines.push({ text: `Finished in ${this.elapsed(this.started)}`, fg: t.ok, bold: true })
      lines.push(...this.summaryLines(inner))
      lines.push({ text: '' })
      lines.push({ text: 'Enter or Esc closes · F5 or r runs it again', fg: t.dim })
    }
    if (this.phase === 'error') {
      lines.push({ text: 'The process failed', fg: t.err, bold: true })
      for (const l of wrap(this.error ?? '', inner)) lines.push({ text: l, fg: t.err })
      lines.push({ text: '' })
      lines.push({ text: 'Esc closes · F5 or r runs it again', fg: t.dim })
    }
    if (this.phase === 'cancelled') {
      lines.push({ text: 'Cancelled', fg: t.warn, bold: true })
      lines.push({ text: 'Esc closes · F5 or r runs it again', fg: t.dim })
    }
    body.push(<text flexShrink={0} wrapMode="none" key="stepper" fg={t.dim}>{pad(` ${trunc(stepper, inner - 1)}`, inner)}</text>)
    body.push(<text flexShrink={0} wrapMode="none" key="sp">{pad('', inner)}</text>)
    for (const h of help) for (const l of wrap(h, inner - 2)) body.push(<text flexShrink={0} wrapMode="none" key={`h${body.length}`} fg={t.dim}>{pad(` ${l}`, inner)}</text>)
    let used = body.length
    if (this.phase === 'form' && this.editor) {
      body.push(<text flexShrink={0} wrapMode="none" key="title" fg={t.acc}><strong>{pad(` ${this.step?.label ?? this.step?.name ?? ''}${this.editor.options.bulkEdit ? '  (Ctrl+T marks a field to apply)' : ''}`, inner)}</strong></text>)
      used++
      const formHeight = Math.max(3, height - 2 - used - 1)
      body.push(<box key="form" flexDirection="column" height={formHeight}>{this.editor.render(inner, formHeight, focused)}</box>)
      body.push(<text flexShrink={0} wrapMode="none" key="ft" fg={t.dim}>{pad(this.editor.saving ? ' sending…' : ' Ctrl+S continues · Esc cancels · Tab ↓ next · Enter or typing opens a picker', inner)}</text>)
    } else {
      for (const l of lines.slice(0, Math.max(0, height - 2 - used - 4))) body.push(<text flexShrink={0} wrapMode="none" key={`l${body.length}`} fg={l.fg ?? t.fg}>{l.bold ? <strong>{pad(` ${l.text}`, inner)}</strong> : pad(` ${l.text}`, inner)}</text>)
      const logRows = Math.max(0, Math.min(this.log.length, height - 2 - body.length - 1))
      const pad2 = height - 2 - body.length - logRows
      for (let i = 0; i < pad2; i++) body.push(<text flexShrink={0} wrapMode="none" key={`p${i}`}>{pad('', inner)}</text>)
      for (const l of this.log.slice(-logRows)) body.push(<text flexShrink={0} wrapMode="none" key={`g${body.length}`} fg={t.dim}>{pad(` ${l}`, inner)}</text>)
    }
    return <Panel title={this.title()} width={width} height={height} focused={focused}>{body}</Panel>
  }
}
