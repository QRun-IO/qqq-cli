/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A dashboard app for widget controls the sample lacks: dropdowns (possible values and a date
 * picker, stored selections), required dropdowns, export, a process widget, a parent widget
 * (with a denied and an unknown child), negative horizontal bars and a hidden alert.
 */

type J = Record<string, unknown>
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

export const dashWidgets = {
  ddWidget: { name: 'ddWidget', label: 'Sales by region', helpContents: { help: [{ contentAsText: 'Totals by region for the chosen date.' }] }, type: 'table', storeDropdownSelections: true, dropdowns: [{ type: 'POSSIBLE_VALUE_SOURCE', label: 'Region' }, { type: 'DATE_PICKER', label: 'As of' }] },
  needsWidget: { name: 'needsWidget', label: 'Needs a choice', type: 'statistics', dropdowns: [{ type: 'POSSIBLE_VALUE_SOURCE', label: 'Store', isRequired: true }] },
  procWidget: { name: 'procWidget', label: 'Quick scan', type: 'process' },
  procDenied: { name: 'procDenied', label: 'Denied process widget', type: 'process' },
  parentW: { name: 'parentW', label: 'Parent', type: 'parentWidget' },
  deniedW: { name: 'deniedW', label: 'Secret', type: 'statistics', hasPermission: false },
  hbar: { name: 'hbar', label: 'Change', type: 'horizontalBarChart' },
  hiddenAlert: { name: 'hiddenAlert', label: 'Hidden', type: 'alert' },
}

export const dashApp = { name: 'dash', label: 'Dashboard', helpContents: { help: [{ contentAsText: 'The sales dashboard.' }] }, widgets: ['ddWidget', 'needsWidget', 'procWidget', 'parentW', 'deniedW', 'hbar', 'hiddenAlert'], children: [] }

export const widgetCalls: Array<{ name: string; body: J }> = []

export async function widgetRoute(path: string, body: unknown): Promise<Response | undefined> {
  const m = /^\/widget\/(ddWidget|needsWidget|procWidget|procDenied|parentW|deniedW|hbar|hiddenAlert)$/.exec(path)
  if (!m) return undefined
  const b = (body ?? {}) as J
  widgetCalls.push({ name: m[1]!, body: b })
  switch (m[1]) {
    case 'ddWidget': {
      const region = String(b.region ?? '')
      return json({ type: 'table', label: 'Sales by region', dropdownNameList: ['region', 'asOf'], dropdownLabelList: ['Region', 'As of'], dropdownDataList: [[{ id: 'n', label: 'North' }, { id: 's', label: 'South' }], []], dropdownDefaultValueList: ['n', null], columns: [{ accessor: 'region', header: 'Region' }, { accessor: 'total', header: 'Total' }], rows: [{ region: region === 's' ? 'South' : 'North', total: region === 's' ? 2000 : 1000 }], csvData: [['Region', 'Total', 'As of'], [region === 's' ? 'South' : 'North', region === 's' ? '2000' : '1000', String(b.asOf ?? '')]] })
    }
    case 'needsWidget':
      return b.store ? json({ type: 'statistics', label: 'Needs a choice', count: 5, countContext: `store ${String(b.store)}`, dropdownNameList: ['store'], dropdownDataList: [[{ id: 'a', label: 'Store A' }]] })
        : json({ type: 'statistics', label: 'Needs a choice', dropdownNameList: ['store'], dropdownDataList: [[{ id: 'a', label: 'Store A' }]], dropdownNeedsSelectedText: 'Please select a Store' })
    case 'procWidget':
      return json({ type: 'process', label: 'Quick scan', processMetaData: { name: 'scanner', label: 'Scanner' }, defaultValues: { barcode: 'PRE' } })
    case 'procDenied':
      return json({ type: 'process', label: 'Denied process widget', processMetaData: { name: 'denyProc', label: 'Deny Proc' } })
    case 'parentW':
      return json({ type: 'parentWidget', label: 'Parent', childWidgetNameList: ['hbar', 'deniedW', 'unknownW'] })
    case 'hbar':
      return json({ type: 'horizontalBarChart', label: 'Change', chartData: { labels: ['Up', 'Down'], datasets: [{ label: 'delta', data: [5, -3] }] } })
    case 'hiddenAlert':
      return json({ type: 'alert', label: 'Hidden', hideWidget: true, html: 'not shown' })
    default:
      return json({ type: 'statistics', count: 1 })
  }
}
