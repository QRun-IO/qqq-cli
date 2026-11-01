/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A form over fields that are not a table's own (a dynamicForm widget's fields): the same
 * editors as record forms (FormEditor on FormSession), required and type checks, then a save
 * callback; a server refusal stays on the form with its message.
 */

import type { FormSession } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import type { AppStore } from '../store'
import { theme } from '../theme'
import type { FKeyLabels, Screen } from '../types'
import { pad } from '../util/text'
import { FormEditor } from './form'
import { Panel } from './list'

export class FieldsFormScreen implements Screen {
  readonly kind = 'fields-form'
  readonly id: string
  readonly editor: FormEditor

  constructor(private store: AppStore, readonly heading: string, session: FormSession, private onSave: (values: Record<string, unknown>) => Promise<string | void>, private extraCheck?: (values: Record<string, unknown>) => string[]) {
    this.id = `fields:${heading}:${Date.now()}`
    this.editor = new FormEditor(store, session, session.promptOrder())
  }

  title(): string {
    return this.heading
  }

  capturesText(): boolean {
    return true
  }

  claimsKey(key: Key): boolean {
    return this.editor.claimsKey(key)
  }

  paste(text: string): void {
    this.editor.paste(text)
  }

  dirty(): boolean {
    return this.editor.dirty()
  }

  fkeys(): FKeyLabels {
    return { 3: null, 4: null, 5: null, 6: null, 7: null, 8: null }
  }

  save(): void {
    const editor = this.editor
    if (editor.saving) return
    editor.saving = true
    editor.formError = undefined
    const work = async () => {
      const problems = await editor.check()
      const extra = this.extraCheck?.(editor.session.values) ?? []
      if (Object.keys(problems).length || extra.length) {
        editor.formError = extra.length ? `needs ${extra.join(', ')}` : `${Object.keys(problems).length} field(s) need attention`
        editor.index = Math.max(0, editor.names.findIndex((n) => problems[n]))
        return
      }
      const note = await this.onSave(editor.session.values)
      this.store.flash(note || 'saved')
      this.store.back()
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
      if (this.dirty()) this.store.confirm('Discard your changes?', () => this.store.back())
      else this.store.back()
      return true
    }
    return this.editor.onKey(key)
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    return (
      <Panel title={this.heading} width={width} height={height} focused={focused}>
        {this.editor.render(width - 2, height - 3, focused)}
        <text flexShrink={0} wrapMode="none" fg={t.dim}>{pad(this.editor.saving ? ' saving…' : ' Ctrl+S save · Esc cancel · Tab ↓ next · ↑ previous · * required', width - 2)}</text>
      </Panel>
    )
  }
}
