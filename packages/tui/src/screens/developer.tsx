/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { writeFileSync } from 'node:fs'
import { getRecordDeveloper, getScriptLogs, getScriptRevisionFiles, getTableApiDocument, listDeveloperPanels, listTableApis, panelToBlocks, scriptText, storeScript, type AssociatedScript } from '@qrun-io/qqq-core'
import { ChoiceOverlay, PromptOverlay } from '../overlays/basic'
import { saveFile } from '../overlays/files-helpers'
import type { AppStore } from '../store'
import { theme } from '../theme'
import { errorText } from '../util/text'
import { blockLines } from '../widgets'
import type { Row } from './list'
import { LinesScreen } from './lines'

type J = Record<string, unknown>

/** Text shown in a scrollable pane (a script revision, logs, an OpenAPI document). */
export class TextScreen extends LinesScreen {
  readonly kind = 'text'
  constructor(store: AppStore, heading: string, text: string) {
    super(store, heading)
    this.start(async () => text.split('\n').map((l) => ({ text: l })))
  }
}

/**
 * Developer mode for a record (REC-053, REC-054 through the kernel records/developer module): the
 * server's developer panels, and the record's associated scripts with their revisions; a revision
 * can be read, a new version stored from $EDITOR, and its run logs shown.
 */
export class DeveloperScreen extends LinesScreen {
  readonly kind = 'developer'

  constructor(store: AppStore, readonly tableName: string, readonly primaryKey: string) {
    super(store, `Developer · ${store.meta?.tables?.[tableName]?.label ?? tableName} ${primaryKey}`)
    this.refresh()
  }

  refresh(): void {
    const s = this.store
    const c = s.client!
    this.start(async () => {
      const t = theme()
      const rows: Row[] = []
      const [panels, developer] = await Promise.all([
        listDeveloperPanels(c.server, c.fetch, this.tableName, this.primaryKey).catch((e) => { rows.push({ text: `Panels: ${errorText(e)}`, fg: t.err }); return [] }),
        getRecordDeveloper(c.server, c.fetch, this.tableName, this.primaryKey).catch((e) => { rows.push({ text: `Scripts: ${errorText(e)}`, fg: t.err }); return undefined }),
      ])
      for (const p of panels) {
        rows.push(...blockLines(panelToBlocks(p), 100).map((l) => ({ ...l })))
        rows.push({ text: '' })
      }
      rows.push({ text: 'Associated scripts', fg: t.acc, bold: true })
      if (!developer?.scripts.length) rows.push({ text: '  this table has no associated script fields', fg: t.dim })
      for (const script of developer?.scripts ?? []) this.scriptRows(script, rows)
      return rows
    })
  }

  scriptRows(script: AssociatedScript, rows: Row[]): void {
    const t = theme()
    const name = String((script.script?.values as J | undefined)?.name ?? '(no script yet)')
    rows.push({ text: `  ${script.fieldName}: ${name}  ·  Enter stores a new version from $EDITOR`, key: `s:${script.fieldName}`, action: () => this.storeVersion(script) })
    for (const r of script.revisions.slice(0, 20)) {
      const v = (r.values ?? {}) as J
      const label = `    v${String(v.sequenceNo ?? '?')}  ${String(v.commitMessage ?? '')}  ${String(v.author ?? '')}  ${String(v.createDate ?? '')}`
      rows.push({ text: label, fg: t.fg, key: `r:${String(v.id)}`, action: () => this.revisionActions(script, String(v.id), label.trim()) })
    }
  }

  revisionActions(script: AssociatedScript, revisionId: string, label: string): void {
    const s = this.store
    const c = s.client!
    s.open(new ChoiceOverlay(s, label, [{ label: 'Show the code', value: 'code' }, { label: 'Show the run logs', value: 'logs' }], (what) => {
      if (what === 'code') {
        s.run(getScriptRevisionFiles(c.server, c.fetch, revisionId), (files) => s.push(new TextScreen(s, `${script.fieldName} · ${label}`, scriptText(script.revisions.find((r) => String((r.values as J).id) === revisionId), files))))
      } else {
        s.run(getScriptLogs(c.server, c.fetch, this.tableName, this.primaryKey, script.fieldName, revisionId), (logs) => {
          const text = logs.length ? logs.map((l) => [`${l.startTimestamp} → ${l.endTimestamp}${l.hadError ? `  ERROR ${l.error}` : ''}`, ...l.lines.map((x) => `  ${x.timestamp}  ${x.text}`)].join('\n')).join('\n\n') : '(no runs logged)'
          s.push(new TextScreen(s, `Logs · ${label}`, text))
        })
      }
    }))
  }

  storeVersion(script: AssociatedScript): void {
    const s = this.store
    const c = s.client!
    const latest = script.revisions[0]
    const load = latest ? getScriptRevisionFiles(c.server, c.fetch, String((latest.values as J).id)).then((files) => scriptText(latest, files)) : Promise.resolve('')
    s.run(load.then((text) => s.editExternal(text)), (edited) => {
      s.open(new PromptOverlay(s, 'Commit message', `A new version of ${script.fieldName} is stored with this message.`, (message) => {
        s.run(storeScript(c.server, c.fetch, this.tableName, this.primaryKey, script.fieldName, edited, message || undefined), (r) => {
          s.flash(`stored ${r.scriptName} version ${r.scriptRevisionSequenceNo}`)
          this.refresh()
        })
      }))
    })
  }
}

/** A table's application APIs (listTableApis) with their OpenAPI documents (getTableApiDocument). */
export class TableApisScreen extends LinesScreen {
  readonly kind = 'apis'

  constructor(store: AppStore, readonly tableName: string) {
    super(store, `APIs · ${store.meta?.tables?.[tableName]?.label ?? tableName}`)
    this.refresh()
  }

  refresh(): void {
    const s = this.store
    const c = s.client!
    this.start(async () => {
      const apis = await listTableApis(c.server, c.fetch, this.tableName)
      if (!apis.length) return [{ text: 'No application API exposes this table.', fg: theme().dim }]
      const rows: Row[] = []
      for (const a of apis) {
        rows.push({ text: `${a.label} (${a.name})  ${a.path}`, fg: theme().acc, bold: true })
        for (const v of a.versions) rows.push({ text: `  version ${v.version}${v.version === a.currentVersion ? '  (current)' : ''}`, key: `${a.name}:${v.version}`, action: () => this.document(a.name, v.version) })
      }
      return rows
    })
  }

  document(api: string, version: string): void {
    const s = this.store
    const c = s.client!
    s.run(getTableApiDocument(c.server, c.fetch, this.tableName, api, version), (doc) => {
      const text = JSON.stringify(doc, null, 2)
      s.open(new ChoiceOverlay(s, `${api} ${version} OpenAPI document`, [{ label: 'View it here', value: 'view' }, { label: 'Save it to a file', value: 'save' }], (what) => {
        if (what === 'view') s.push(new TextScreen(s, `${api} ${version} · ${this.tableName}`, text))
        else saveFile(s, 'Save the OpenAPI document', `${this.tableName}-${api}-${version}.json`, (path) => { writeFileSync(path, text); s.message(`Wrote ${path}.`) })
      }))
    })
  }
}
