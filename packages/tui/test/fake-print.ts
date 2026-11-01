/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The printing extension for the fake server (off unless a test turns it on): /version lists
 * printing 2.0.0, person gets the Print process, the printing tables answer, Print queues one job
 * per record, and each read of a job moves it one state on (QUEUED, RECEIVED, SPOOLER_COMPLETED).
 */

type J = Record<string, unknown>
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

export const printing = {
  enabled: false,
  /** Print runs: the values and record ids each one finished with. */
  runs: [] as Array<{ values: J; recordIds: string }>,
  jobs: new Map<string, { title: string; states: string[]; reads: number }>(),
  reset(): void {
    this.enabled = false
    this.runs = []
    this.jobs.clear()
  },
}

const PRINTERS = [
  { values: { id: 'p1', name: 'Virtual PDF printer', device_id: 'd1', status: 'READY', enabled: 1, available: 1, formats: '["PDF","ZPL"]' }, displayValues: { device_id: 'Virtual print agent' } },
  { values: { id: 'p2', name: 'Zebra', device_id: 'd1', status: 'READY', enabled: 1, available: 1, formats: '["ZPL"]' }, displayValues: { device_id: 'Virtual print agent' } },
  { values: { id: 'p3', name: 'Back office laser', device_id: 'd1', status: 'READY', enabled: 1, available: 1, formats: '["PDF"]' }, displayValues: { device_id: 'Virtual print agent' } },
]

/** The Print process in the metadata's process list (none while printing is off). */
export function printProcessesMeta(): J {
  return printing.enabled ? { printingPrintRecords_person: { name: 'printingPrintRecords_person', label: 'Print', tableName: 'person' } } : {}
}

const run: { values: J; recordIds: string } = { values: {}, recordIds: '' }

export async function printRoute(path: string, method: string, body: unknown): Promise<Response | undefined> {
  if (!printing.enabled) return undefined
  const form = (body ?? {}) as J
  const values = () => JSON.parse(String(form.values ?? '{}')) as J
  if (path === '/version') return json({ apiVersion: '1.8.0', features: ['metaData', 'tables', 'processes'], extensions: [{ name: 'printing', version: '2.0.0', pathPrefix: '/qbit/printing', description: 'Native current-user printing' }] })
  if (path === '/metaData/process/printingPrintRecords_person') {
    return json({ name: 'printingPrintRecords_person', label: 'Print', tableName: 'person', frontendSteps: [
      { name: 'printer', label: 'Choose a printer', components: [{ type: 'EDIT_FORM' }], formFields: [{ name: 'printingPrinterId', label: 'Printer', type: 'STRING', isRequired: true }, { name: 'printingCopies', label: 'Copies', type: 'INTEGER', isRequired: true }] },
      { name: 'review', label: 'Review', components: [{ type: 'VALIDATION_REVIEW_SCREEN' }] },
      { name: 'result', label: 'Result', components: [{ type: 'PROCESS_SUMMARY_RESULTS' }] },
    ] })
  }
  if (path === '/processes/printingPrintRecords_person/init') {
    Object.assign(run, { values: values(), recordIds: String(form.recordIds ?? '') })
    return json({ type: 'COMPLETE', processUUID: 'pr', nextStep: 'printer', values: {} })
  }
  if (path === '/processes/printingPrintRecords_person/pr/step/printer') {
    Object.assign(run.values, values())
    return json({ type: 'COMPLETE', processUUID: 'pr', nextStep: 'review', values: {} })
  }
  if (path === '/processes/printingPrintRecords_person/pr/step/review') {
    printing.runs.push({ values: { ...run.values }, recordIds: run.recordIds })
    const ids = run.recordIds.split(',').map((pk) => {
      const id = `job-${printing.jobs.size + 1}`
      printing.jobs.set(id, { title: `Person: ${pk}`, states: ['QUEUED', 'RECEIVED', 'SPOOLER_COMPLETED'], reads: 0 })
      return id
    })
    return json({ type: 'COMPLETE', processUUID: 'pr', nextStep: 'result', values: { printingJobIds: ids.join(',') } })
  }
  if (path === '/table/printing_printer/query' && method === 'POST') return json({ records: PRINTERS })
  if (path === '/table/printing_job/query' && method === 'POST') {
    const criteria = ((((body as J).filter ?? {}) as J).criteria ?? []) as J[]
    const wanted = (criteria.find((c) => c.fieldName === 'id')?.values as string[] | undefined) ?? [...printing.jobs.keys()].reverse()
    return json({ records: wanted.filter((id) => printing.jobs.has(id)).map((id) => {
      const job = printing.jobs.get(id)!
      const status = job.states[Math.min(job.reads++, job.states.length - 1)]
      return { values: { id, title: job.title, status, printer_row_id: 'p1' }, displayValues: { printer_row_id: 'Virtual PDF printer' }, recordLabel: job.title }
    }) })
  }
  return undefined
}
