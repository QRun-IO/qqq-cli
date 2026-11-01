/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * One dashboard or record widget with its controls, as the web's connected widget: loads from
 * the v1 widget route with the given parameters and the dropdown selections (stored per widget
 * when the widget asks, stale ones dropped), skips widgets the user may not see, loads a parent
 * widget's children (grid or tabs), and offers the widget's actions: reload, each dropdown,
 * export CSV, run a process widget, data bag versions, script revisions, and the saved report
 * setup editors. Screens draw `blocks` and open `actionsMenu()` on Enter.
 */

import { writeFileSync } from 'node:fs'
import { exportFileName, htmlToText, datePickerValue, readViewSettings, reconcileSelections, resolveDropdowns, safeFileName, widgetCsv, widgetParams, widgetToBlocks, writeViewSettings, type QueryFilter, type RenderBlock, type WidgetContext, type WidgetControlMeta } from '@qrun-io/qqq-core'
import { esbOverviewBlocks } from './esb'
import { htmlRowBlocks } from './html-rows'
import { ChoiceOverlay, PromptOverlay } from './overlays/basic'
import { saveFile } from './overlays/files-helpers'
import type { AppStore } from './store'
import { errorText, num } from './util/text'

type J = Record<string, unknown>

interface WidgetMeta extends WidgetControlMeta {
  type?: string
  defaultValues?: J
  gridColumns?: number
}

export interface WidgetViewOptions {
  params?: Record<string, string>
  /** A record-view section: the record (cronUI, setup widgets) and where its setup edits are saved. */
  record?: { tableName: string; primaryKey: string; values?: J; displayValues?: J; fields?: Record<string, { label?: string }>; editable?: boolean; refresh?: () => void }
  signal?: AbortSignal
  /** The parent widget (stored selections may belong to it). */
  parent?: WidgetMeta
  /** Called after every load (a dropdown, tab or reload changed what to draw). */
  onChange?: () => void
}

export class WidgetView {
  data?: J
  blocks?: RenderBlock[]
  error?: string
  loading = false
  selections: Record<string, string | null> = {}
  children: WidgetView[] = []
  tab = 0

  constructor(private store: AppStore, readonly name: string, private options: WidgetViewOptions = {}) {
    const owner = this.storeOwner()
    if (owner) this.selections = { ...((readViewSettings(`widget:${owner.name}`).dropdowns ?? {}) as Record<string, string | null>) }
  }

  get meta(): WidgetMeta {
    return ((this.store.meta?.widgets as Record<string, WidgetMeta> | undefined)?.[this.name]) ?? { name: this.name }
  }

  get label(): string {
    return String(this.meta.label ?? this.data?.label ?? this.name)
  }

  /** Where stored selections live: this widget, else its parent (storeDropdownSelections). */
  private storeOwner(): WidgetMeta | undefined {
    const m = this.meta
    if (m.storeDropdownSelections) return m
    if (this.options.parent?.storeDropdownSelections) return this.options.parent
    return undefined
  }

  private persist(): void {
    const owner = this.storeOwner()
    if (!owner) return
    const key = `widget:${owner.name}`
    writeViewSettings(key, { ...readViewSettings(key), dropdowns: this.selections })
  }

  /** Nothing to draw (an alert that hides itself). */
  get hidden(): boolean {
    return Boolean(this.blocks && this.blocks.length === 0 && !this.error)
  }

  context(): WidgetContext {
    const r = this.options.record
    return { meta: this.meta, record: r ? { values: r.values, displayValues: r.displayValues } : undefined, fields: r?.fields }
  }

  async load(): Promise<void> {
    const client = this.store.client
    if (!client) return
    if (this.meta.hasPermission === false) {
      // a denied widget shows its permission state without asking for data
      this.blocks = [{ kind: 'heading', text: this.label }, { kind: 'alert', level: 'warning', text: 'You do not have permission to view this data.' }]
      return
    }
    this.loading = true
    try {
      const c = this.options.signal ? client.withSignal(this.options.signal) : client
      let data = await c.widget(this.name, widgetParams(this.options.params ?? {}, this.selections))
      const r = reconcileSelections(data, this.meta, this.selections)
      const changed = JSON.stringify(r.selections) !== JSON.stringify(this.selections)
      this.selections = r.selections
      if (changed) {
        this.persist()
        if (r.dropped.length || Object.values(r.selections).some((v) => v)) data = await c.widget(this.name, widgetParams(this.options.params ?? {}, this.selections))
      }
      this.data = data
      this.error = undefined
      const blocks = await this.terminalBlocks(widgetToBlocks(data, this.context()), data, c)
      if (typeof data.dropdownNeedsSelectedText === 'string' && data.dropdownNeedsSelectedText) {
        // required dropdowns: the server waits for a choice
        const head = blocks[0]?.kind === 'heading' ? [blocks[0]] : []
        this.blocks = [...head, { kind: 'alert', level: 'info', text: `${data.dropdownNeedsSelectedText} (Enter on the widget chooses)` }]
      } else this.blocks = blocks
      await this.loadChildren()
    } catch (e) {
      this.error = errorText(e)
    } finally {
      this.loading = false
      this.options.onChange?.()
    }
  }

  /**
   * Blocks the kernel leaves for the terminal client: the ESB overview (drawn from the ESB
   * extension, as `:esb overview`), and row-shaped HTML as aligned columns.
   */
  private async terminalBlocks(blocks: RenderBlock[], data: J, c: { data: <T>(id: string, input?: Record<string, unknown>) => Promise<T> }): Promise<RenderBlock[]> {
    const type = String(data.type ?? this.meta.type ?? '')
    if (type === 'ESB_OVERVIEW') {
      const at = blocks.findIndex((b) => b.kind === 'raw')
      let replacement: RenderBlock[]
      if (!this.store.extensions.has('esb')) replacement = [{ kind: 'alert', level: 'info', text: 'This widget needs the esb extension, which is not installed on this server.' }]
      else {
        try {
          replacement = esbOverviewBlocks(await c.data<J>('getEsbOverview'))
        } catch (e) {
          replacement = [{ kind: 'alert', level: 'error', text: errorText(e) }]
        }
      }
      return at >= 0 ? [...blocks.slice(0, at), ...replacement, ...blocks.slice(at + 1)] : [...blocks, ...replacement]
    }
    if (type === 'html' && typeof data.html === 'string') {
      const rows = htmlRowBlocks(data.html)
      if (!rows) return blocks
      const text = typeof data.text === 'string' ? data.text : htmlToText(data.html)
      const at = blocks.findIndex((b) => b.kind === 'text' && b.text === text)
      if (at >= 0) return [...blocks.slice(0, at), ...rows, ...blocks.slice(at + 1)]
    }
    return blocks
  }

  /** A parent widget's children: those the metadata knows and the user may see, with the parent's selections. */
  private async loadChildren(): Promise<void> {
    const names = Array.isArray(this.data?.childWidgetNameList) ? (this.data!.childWidgetNameList as unknown[]).filter((n): n is string => typeof n === 'string') : []
    if (!names.length || (this.data?.type ?? this.meta.type) !== 'parentWidget') return
    const known = (this.store.meta?.widgets ?? {}) as Record<string, WidgetMeta>
    const params = widgetParams(this.options.params ?? {}, this.selections)
    this.children = names.filter((n) => known[n] && known[n]!.hasPermission !== false).map((n) => new WidgetView(this.store, n, { ...this.options, onChange: undefined, params, parent: this.meta }))
    const tabs = String(this.data?.layoutType ?? '').toUpperCase() === 'TABS'
    if (tabs) {
      this.tab = Math.min(this.tab, Math.max(0, this.children.length - 1))
      if (this.children[this.tab]) await this.children[this.tab]!.load()
    } else await Promise.all(this.children.map((c) => c.load()))
    const head = this.blocks?.[0]?.kind === 'heading' ? [this.blocks[0]] : []
    if (!this.children.length) {
      this.blocks = [...head, { kind: 'text', text: 'No child widgets to show' }]
      return
    }
    const shown = tabs ? [this.children[this.tab]!] : this.children
    const tabLine: RenderBlock[] = tabs ? [{ kind: 'text', text: this.children.map((c, i) => (i === this.tab ? `[${c.label}]` : ` ${c.label} `)).join(' ') + '   (Enter: switch tab)' }] : []
    this.blocks = [...head, ...tabLine, { kind: 'children', blocks: shown.map((c) => [{ kind: 'heading', text: c.label } as RenderBlock, ...(c.error ? [{ kind: 'alert', level: 'error', text: c.error } as RenderBlock] : (c.blocks ?? []).filter((b) => b.kind !== 'heading'))]) }]
  }

  /** The widget's actions for a menu (Enter on its heading). */
  actions(): Array<{ label: string; detail?: string; disabled?: string; run: () => void }> {
    const s = this.store
    const after = (then: () => void) => () => {
      then()
      this.load().finally(() => s.bump())
    }
    const out: Array<{ label: string; detail?: string; disabled?: string; run: () => void }> = []
    out.push({ label: 'Reload', run: after(() => undefined) })
    for (const d of resolveDropdowns(this.data, this.meta, this.selections)) {
      const current = d.type === 'DATE_PICKER' ? d.value ?? '(none)' : d.options.find((o) => o.id === d.value)?.label ?? d.labelForNullValue ?? '(none)'
      out.push({
        label: `${d.label}: ${current}`, detail: d.type === 'DATE_PICKER' ? 'date' : `${d.options.length} choices`,
        run: () => {
          const set = (value: string | null) => {
            this.selections = { ...this.selections, [d.paramName]: value }
            this.persist()
            this.load().finally(() => s.bump())
          }
          if (d.type === 'DATE_PICKER') {
            s.open(new PromptOverlay(s, d.label, 'A date as YYYY-MM-DD (empty clears).', (text) => {
              if (!text.trim()) return set(null)
              const v = datePickerValue(text)
              if (!v) return s.flash('a date as YYYY-MM-DD', 'error')
              set(v)
            }))
          } else {
            const choices = [...(d.isRequired ? [] : [{ label: d.labelForNullValue ?? '(none)', value: null as string | null }]), ...d.options.map((o) => ({ label: o.label, value: o.id as string | null }))]
            s.open(new ChoiceOverlay(s, d.label, choices, set, '', Math.max(0, choices.findIndex((c) => c.value === d.value))))
          }
        },
      })
    }
    if (this.children.length && String(this.data?.layoutType ?? '').toUpperCase() === 'TABS') {
      out.push({ label: 'Switch tab', detail: this.children.map((c) => c.label).join(' · '), run: () => s.open(new ChoiceOverlay(s, 'Tab', this.children.map((c, i) => ({ label: c.label, value: i })), (i) => { this.tab = i; this.load().finally(() => s.bump()) }, '', this.tab)) })
    }
    const type = String(this.data?.type ?? this.meta.type ?? '')
    if (type !== 'multiTable' && type !== 'childRecordList' && type !== 'parentWidget') {
      out.push({ label: 'Export as CSV', run: () => this.exportCsv() })
    }
    if (type === 'process') {
      const pm = (this.data?.processMetaData ?? {}) as J
      const allowed = (this.store.meta?.processes as Record<string, { hasPermission?: boolean }> | undefined)?.[String(pm.name)]
      if (pm.name && (!allowed || allowed.hasPermission === false)) out.push({ label: `Run ${String(pm.label ?? pm.name)}`, disabled: 'This process is not available to you.', run: () => undefined })
      else if (pm.name) out.push({ label: `Run ${String(pm.label ?? pm.name)}`, run: () => void import('./nav').then(({ openProcess }) => openProcess(s, String(pm.name), { values: (this.data?.defaultValues ?? {}) as J })) })
    }
    if (type === 'dataBagViewer') {
      const id = String((this.data?.queryParams as J | undefined)?.id ?? this.options.record?.primaryKey ?? '')
      if (id) out.push({ label: 'Versions and contents', run: () => void import('./screens/data-bag').then(({ DataBagScreen }) => s.push(new DataBagScreen(s, id))) })
    }
    if (type === 'scriptViewer') {
      const id = String((this.data?.queryParams as J | undefined)?.id ?? this.options.record?.primaryKey ?? '')
      if (id) out.push({ label: 'Revisions, files and logs', run: () => void import('./screens/developer').then(({ DeveloperScreen }) => s.push(new DeveloperScreen(s, 'script', id))) })
    }
    if ((type === 'filterAndColumnsSetup' || type === 'pivotTableSetup') && this.options.record) {
      const editable = this.options.record.editable !== false && this.data?.overrideIsEditable !== false
      out.push(...setupActions(s, this, type).map((a) => (editable || a.label.startsWith('Preview') ? a : { ...a, disabled: 'you may not edit this record' })))
    }
    return out
  }

  actionsMenu(): void {
    this.store.open(new ChoiceOverlay(this.store, this.label, this.actions().map((a) => ({ label: a.label, value: a.run, detail: a.detail, disabled: a.disabled })), (run) => run()))
  }

  exportCsv(): void {
    const csv = widgetCsv(this.data)
    if (csv === undefined) return this.store.flash('There is no data available to export.')
    saveFile(this.store, `Export ${this.label}`, exportFileName(this.label, 'csv'), (path) => {
      try {
        writeFileSync(path, csv)
        this.store.message(`Wrote ${path} (${num(csv.length)} bytes).`)
      } catch (e) {
        this.store.error(e)
      }
    })
  }

  get record() {
    return this.options.record
  }
}

function parseJson(value: unknown): J | undefined {
  if (value && typeof value === 'object') return value as J
  if (typeof value !== 'string' || !value.trim()) return undefined
  try {
    const v = JSON.parse(value) as unknown
    return v && typeof v === 'object' ? v as J : undefined
  } catch {
    return undefined
  }
}

/**
 * The saved report setup editors (filterAndColumnsSetup, pivotTableSetup) on the report record:
 * the filter and sort in the TUI's filter dialog, the columns in a chooser, the pivot rows,
 * columns and values from the report's columns; each change is saved to the record.
 */
function setupActions(store: AppStore, view: WidgetView, type: string): Array<{ label: string; run: () => void }> {
  const r = view.record!
  const values = r.values ?? {}
  const tableName = String((view.data?.tableName as string | undefined) ?? values.tableName ?? '')
  const filterField = String(view.data?.filterFieldName ?? 'queryFilterJson')
  const columnsField = String(view.data?.columnsFieldName ?? view.data?.columnFieldName ?? 'columnsJson')
  const c = store.client!
  const save = (patch: J, note: string) => store.run(c.update(r.tableName, r.primaryKey, patch), () => {
    store.flash(note)
    r.refresh?.()
  })
  if (!tableName) return [{ label: 'Choose the report\'s table first (the setup needs it)', run: () => store.flash('the record names no table') }]
  // an API-versioned setup reads the table through the application API (its version's fields)
  const api = view.data?.isApiVersioned && view.data.apiPath && view.data.apiVersion ? `/qqq/v1/${String(view.data.apiPath).replace(/^\/+|\/+$/g, '')}/${encodeURIComponent(String(view.data.apiVersion))}` : undefined
  const tableMeta = async () => {
    if (!api) return c.tableMeta(tableName)
    const response = await c.fetch(`${c.server}${api}/metaData/table/${encodeURIComponent(tableName)}`)
    if (!response.ok) throw new Error(`the ${String(view.data?.apiName ?? 'application')} API answered ${response.status} for ${tableName}`)
    const body = await response.json() as Record<string, unknown>
    return (body.table ?? body) as Awaited<ReturnType<typeof c.tableMeta>>
  }
  if (type === 'filterAndColumnsSetup') {
    const filter = (parseJson(values[filterField]) ?? { criteria: [], booleanOperator: 'AND' }) as unknown as QueryFilter & { orderBys?: Array<{ fieldName: string; isAscending?: boolean }> }
    const columns = parseJson(values[columnsField]) as { columns?: Array<{ name: string; isVisible?: boolean }> } | undefined
    return [
      {
        label: 'Edit the filter and sort', run: () => store.run(tableMeta(), (meta) => void import('./overlays/filter').then(({ FilterOverlay }) => {
          const ob = filter.orderBys?.[0]
          store.open(new FilterOverlay(store, meta, filter, ob ? { field: ob.fieldName, asc: ob.isAscending !== false } : undefined, (f, sort) => {
            const next = { ...f, orderBys: sort ? [{ fieldName: sort.field, isAscending: sort.asc }] : (sort === null ? [] : filter.orderBys ?? []) }
            save({ [filterField]: JSON.stringify(next) }, 'saved the report filter')
          }))
        })),
      },
      ...(view.data?.hideColumns ? [] : [{
        label: 'Choose the columns', run: () => store.run(tableMeta(), (meta) => {
          const all = Object.values(meta.fields)
          const visible = new Set((columns?.columns ?? []).filter((x) => x.isVisible !== false).map((x) => x.name))
          const pick = () => store.open(new ChoiceOverlay(store, `Columns · ${visible.size} shown · Enter toggles · Esc saves`, all.map((f) => ({ label: `${visible.has(f.name) ? '[x]' : '[ ]'} ${f.label}`, value: f.name })), (name) => {
            if (visible.has(name)) visible.delete(name)
            else visible.add(name)
            pick()
          }, '', 0, () => save({ [columnsField]: JSON.stringify({ columns: all.map((f) => ({ name: f.name, isVisible: visible.has(f.name) })) }) }, `saved ${visible.size} columns`)))
          pick()
        }),
      }]),
      {
        label: 'Preview the report rows in a grid', run: () => {
          if (!api) return void import('./nav').then(({ openTable }) => openTable(store, tableName, filter))
          // API-versioned: the rows come through the application API's query
          void import('./screens/api-preview').then(({ ApiPreviewScreen }) => store.push(new ApiPreviewScreen(store, `${api}/table/${encodeURIComponent(tableName)}`, tableName, filter)))
        },
      },
    ]
  }
  const pivot = (parseJson(values.pivotTableJson) ?? { rows: [], columns: [], values: [] }) as { rows?: Array<{ fieldName: string }>; columns?: Array<{ fieldName: string }>; values?: Array<{ fieldName: string; function?: string }> }
  const reportColumns = ((parseJson(values.columnsJson) as { columns?: Array<{ name: string; isVisible?: boolean }> } | undefined)?.columns ?? []).filter((x) => x.isVisible !== false).map((x) => x.name)
  const add = (part: 'rows' | 'columns' | 'values') => () => {
    if (!reportColumns.length) return store.flash('choose the report columns first: the pivot uses them', 'error')
    store.open(new ChoiceOverlay(store, `Add to the pivot ${part}`, reportColumns.map((n) => ({ label: n, value: n })), (fieldName) => {
      const then = (fn?: string) => {
        const next = { ...pivot, [part]: [...(pivot[part] ?? []), { fieldName, ...(fn ? { function: fn } : {}) }] }
        save({ pivotTableJson: JSON.stringify(next) }, `pivot ${part}: added ${fieldName}`)
      }
      if (part !== 'values') return then()
      store.open(new ChoiceOverlay(store, 'Summarize by', ['SUM', 'COUNT', 'AVERAGE', 'MIN', 'MAX', 'COUNT_NUMS', 'PRODUCT', 'STD_DEV', 'STD_DEVP', 'VAR', 'VARP'].map((f) => ({ label: f, value: f })), then))
    }))
  }
  return [
    { label: 'Add a pivot row', run: add('rows') },
    { label: 'Add a pivot column', run: add('columns') },
    { label: 'Add a pivot value', run: add('values') },
    { label: 'Clear the pivot table', run: () => store.confirm('Clear the pivot table definition?', () => save({ pivotTableJson: null }, 'cleared the pivot table')) },
  ]
}
