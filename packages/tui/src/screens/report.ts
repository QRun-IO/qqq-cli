/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { writeFileSync } from 'node:fs'
import { searchPossibleValues, type FieldValues } from '@qrun-io/qqq-core'
import { openProcess } from '../nav'
import { ChoiceOverlay } from '../overlays/basic'
import { saveFile } from '../overlays/files-helpers'
import type { AppStore } from '../store'
import { errorText, num } from '../util/text'

interface ReportMeta {
  name: string
  label?: string
  processName?: string
  hasPermission?: boolean
}

const DEFAULT_FORMATS = ['XLSX', 'CSV', 'JSON']

/** The formats a report can be written in: the server's reportFormat possible values, else XLSX, CSV, JSON. */
async function formats(store: AppStore): Promise<Array<{ id: string; label: string }>> {
  try {
    const c = store.client!
    const r = await c.data<{ options?: Array<{ id: unknown; label?: string }> }>('searchPossibleValues', { path: { possibleValueSourceName: 'reportFormat' }, json: { searchTerm: '' } })
    const list = (r.options ?? []).map((o) => ({ id: String(o.id), label: String(o.label ?? o.id) }))
    if (list.length) return list
  } catch {
    // fall back
  }
  void searchPossibleValues
  return DEFAULT_FORMATS.map((f) => ({ id: f, label: f }))
}

/**
 * Runs a report, as the web UI does: a report with a process runs through the process screens (its
 * input fields, then its file, saved with w or automatically); the output format is asked first
 * unless the process asks for it on a screen; a report without a process streams from
 * GET /reports/{name} into the save dialog.
 */
export function openReport(store: AppStore, name: string, values: FieldValues = {}): void {
  const meta = (store.meta?.reports as Record<string, ReportMeta> | undefined)?.[name]
  if (!meta) return store.flash(`no report named "${name}"`, 'error')
  if (meta.hasPermission === false) return store.flash(`you may not run ${meta.label ?? name}`, 'error')
  const c = store.client!
  const chooseFormat = (then: (format: string) => void) => {
    store.run(formats(store), (list) => store.open(new ChoiceOverlay(store, `${meta.label ?? name}: format`, list.map((f) => ({ label: f.label, value: f.id })), then)))
  }
  if (meta.processName) {
    const processName = meta.processName
    store.run(c.processMeta(processName), (pm) => {
      const asksFormat = (pm.frontendSteps ?? []).some((s) => (s.formFields ?? []).some((f) => f.name === 'reportFormat'))
      if (asksFormat) return openProcess(store, processName, { values: { ...values }, autoDownload: true })
      chooseFormat((format) => openProcess(store, processName, { values: { ...values, reportFormat: format }, autoDownload: true }))
    })
    return
  }
  chooseFormat((format) => {
    store.run(c.call('runReport', { path: { reportName: name }, query: { format: format.toLowerCase() } }), (r) => {
      const bytes = r.bytes ?? new TextEncoder().encode(typeof r.data === 'string' ? r.data : JSON.stringify(r.data ?? ''))
      saveFile(store, `Save ${meta.label ?? name}`, `${name}.${format.toLowerCase()}`, (path) => {
        try {
          writeFileSync(path, bytes)
          store.message(`Wrote ${path} (${num(bytes.length)} bytes).`)
        } catch (e) {
          store.error(errorText(e))
        }
      })
    })
  })
}
