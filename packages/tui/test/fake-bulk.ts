/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * A table with the bulk processes the sample offers, plus a possible-value field for value
 * mapping and the saved bulk load profile processes (the sample has none): bulk insert (upload,
 * file mapping, value mapping, review, result), bulk edit and bulk delete (review, result).
 */

type J = Record<string, unknown>
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } })

export const blkMeta = {
  name: 'blk', label: 'Blk', primaryKeyField: 'id', insertPermission: true, editPermission: true, deletePermission: true, capabilities: ['TABLE_QUERY'],
  clientCapabilities: { bulkInsert: { available: true, processName: 'blk.bulkInsert' }, bulkEdit: { available: true, processName: 'blk.bulkEdit' }, bulkDelete: { available: true, processName: 'blk.bulkDelete' }, bulkEditWithFile: { available: true, processName: 'blk.bulkEditWithFile' } },
  fields: {
    id: { name: 'id', label: 'Id', type: 'INTEGER', isEditable: false },
    name: { name: 'name', label: 'Name', type: 'STRING', isRequired: true },
    colorId: { name: 'colorId', label: 'Color', type: 'INTEGER', possibleValueSourceName: 'color' },
  },
}

const structure = { isMain: true, isMany: false, tableName: 'blk', label: 'Blk', associationPath: null, fields: [blkMeta.fields.name, blkMeta.fields.colorId] }
const shape = { tableStructure: structure, headerValues: ['name', 'color'], headerLetters: ['A', 'B'], bodyValuesPreview: [['One', 'Two'], ['Red', 'Blue']], fileBaseName: 'b.csv', suggestedBulkLoadProfile: { version: 'v1', layout: 'FLAT', hasHeaderRow: true, isBulkEdit: false, keyFields: null, fieldList: [{ fieldName: 'name', columnIndex: 0, headerName: 'name' }] } }
const COLORS = [{ id: 1, label: 'Red' }, { id: 2, label: 'Blue' }]

const insertMeta = { name: 'blk.bulkInsert', label: 'Blk Bulk Insert', tableName: 'blk', frontendSteps: [
  { name: 'upload', label: 'Upload File', components: [{ type: 'HTML' }, { type: 'EDIT_FORM' }], formFields: [{ name: 'theFile', label: 'File', type: 'BLOB', isRequired: true }] },
  { name: 'fileMapping', label: 'File Mapping', components: [{ type: 'BULK_LOAD_FILE_MAPPING_FORM' }] },
  { name: 'valueMapping', label: 'Value Mapping', components: [{ type: 'BULK_LOAD_VALUE_MAPPING_FORM' }] },
  { name: 'review', label: 'Review', components: [{ type: 'VALIDATION_REVIEW_SCREEN' }] },
  { name: 'result', label: 'Result', components: [{ type: 'PROCESS_SUMMARY_RESULTS' }] },
] }
const editMeta = { name: 'blk.bulkEdit', label: 'Blk Bulk Edit', tableName: 'blk', frontendSteps: [
  { name: 'edit', label: 'Edit Values', components: [{ type: 'BULK_EDIT_FORM' }], formFields: [blkMeta.fields.name, blkMeta.fields.colorId] },
  { name: 'review', label: 'Review', components: [{ type: 'VALIDATION_REVIEW_SCREEN' }] },
  { name: 'result', label: 'Result', components: [{ type: 'PROCESS_SUMMARY_RESULTS' }] },
] }
const deleteMeta = { name: 'blk.bulkDelete', label: 'Blk Bulk Delete', tableName: 'blk', frontendSteps: [
  { name: 'review', label: 'Review', components: [{ type: 'VALIDATION_REVIEW_SCREEN' }] },
  { name: 'result', label: 'Result', components: [{ type: 'PROCESS_SUMMARY_RESULTS' }] },
] }

const editFileMeta = { ...insertMeta, name: 'blk.bulkEditWithFile', label: 'Blk Bulk Edit With File', frontendSteps: insertMeta.frontendSteps.filter((st) => st.name !== 'valueMapping') }
const editShape = { ...shape, tableStructure: { ...structure, isBulkEdit: true, possibleKeyFields: ['id', 'name'], fields: [blkMeta.fields.id, ...structure.fields] }, headerValues: ['id', 'name'], bodyValuesPreview: [['1', '2'], ['Uno', 'Dos']], suggestedBulkLoadProfile: { version: 'v1', layout: 'FLAT', hasHeaderRow: true, isBulkEdit: true, keyFields: null, fieldList: [{ fieldName: 'id', columnIndex: 0, headerName: 'id' }, { fieldName: 'name', columnIndex: 1, headerName: 'name' }] } }

export const bulkProcessesMeta = {
  'blk.bulkEditWithFile': { name: 'blk.bulkEditWithFile', label: 'Blk Bulk Edit With File', tableName: 'blk', isHidden: true },
  'blk.bulkInsert': { name: 'blk.bulkInsert', label: 'Blk Bulk Insert', tableName: 'blk', isHidden: true },
  'blk.bulkEdit': { name: 'blk.bulkEdit', label: 'Blk Bulk Edit', tableName: 'blk', isHidden: true },
  'blk.bulkDelete': { name: 'blk.bulkDelete', label: 'Blk Bulk Delete', tableName: 'blk', isHidden: true },
  querySavedBulkLoadProfile: { name: 'querySavedBulkLoadProfile', label: 'q', isHidden: true },
  storeSavedBulkLoadProfile: { name: 'storeSavedBulkLoadProfile', label: 's', isHidden: true },
  deleteSavedBulkLoadProfile: { name: 'deleteSavedBulkLoadProfile', label: 'd', isHidden: true },
}

const profiles: J[] = []
let validated = false

function parse(body: unknown): J {
  const b = (body ?? {}) as J
  if (typeof b.values === 'string') return { ...JSON.parse(b.values) as J, ...Object.fromEntries(Object.entries(b).filter(([k]) => k !== 'values')) }
  return { ...((b.values ?? {}) as J), ...b }
}

const step = (uuid: string, nextStep: string, values: J, backStep?: string) => json({ type: 'COMPLETE', processUUID: uuid, nextStep, ...(backStep ? { backStep } : {}), values })

export async function bulkRoute(path: string, method: string, body: unknown): Promise<Response | undefined> {
  if (path === '/metaData/table/blk') return json(blkMeta)
  if (path === '/table/blk/query') return json({ records: [{ values: { id: 1, name: 'One', colorId: 1 }, displayValues: { colorId: 'Red' } }, { values: { id: 2, name: 'Two', colorId: 2 }, displayValues: { colorId: 'Blue' } }] })
  if (path === '/table/blk/count') return json({ count: 2 })
  if (path === '/metaData/process/blk.bulkInsert') return json(insertMeta)
  if (path === '/metaData/process/blk.bulkEdit') return json(editMeta)
  if (path === '/metaData/process/blk.bulkDelete') return json(deleteMeta)
  if (/^\/(table\/blk|processes\/[^/]+)\/possibleValues\/colorId$/.test(path) || path === '/possibleValues/color') {
    const term = String(((body ?? {}) as J).searchTerm ?? '').toLowerCase()
    return json({ options: COLORS.filter((c) => !term || c.label.toLowerCase().includes(term)) })
  }
  // bulk insert
  if (path === '/processes/blk.bulkInsert/init') {
    validated = false
    return step('bi', 'upload', { tableName: 'blk' })
  }
  if (path === '/processes/bi/step/upload' || path === '/processes/blk.bulkInsert/bi/step/upload') return step('bi', 'fileMapping', shape, 'prepareFileUpload')
  if (/\/bi\/step\/fileMapping$/.test(path)) return step('bi', 'valueMapping', { ...shape, valueMappingFullFieldName: 'colorId', valueMappingField: blkMeta.fields.colorId, valueMappingFieldTableName: 'blk', fileValues: ['Red', 'Blue'], valueMapping: {}, valueMappingFieldIndex: 0, fieldNamesToDoValueMapping: ['colorId'], echo: parse(body) }, 'prepareFileMapping')
  if (/\/bi\/step\/valueMapping$/.test(path)) return step('bi', 'review', { supportsFullValidation: true }, 'prepareFileMapping')
  if (/\/bi\/step\/review$/.test(path)) {
    const v = parse(body)
    if (v.doFullValidation === 'true' && !validated) {
      validated = true
      return step('bi', 'review', { supportsFullValidation: true, validationSummary: [{ status: 'OK', count: 2, message: 'Blk records will be inserted' }] }, 'prepareFileMapping')
    }
    return step('bi', 'result', { processResults: [{ status: 'OK', count: 2, message: 'Blk records were inserted' }] })
  }
  // bulk edit with a file
  if (path === '/metaData/process/blk.bulkEditWithFile') return json(editFileMeta)
  if (path === '/processes/blk.bulkEditWithFile/init') return step('bf', 'upload', { tableName: 'blk' })
  if (/\/bf\/step\/upload$/.test(path)) return step('bf', 'fileMapping', editShape, 'prepareFileUpload')
  if (/\/bf\/step\/fileMapping$/.test(path)) return step('bf', 'review', { supportsFullValidation: false }, 'prepareFileMapping')
  if (/\/bf\/step\/review$/.test(path)) return step('bf', 'result', { processResults: [{ status: 'OK', count: 2, message: 'Blk records were updated from the file' }] })
  if (path === '/processes/blk.bulkEditWithFile/possibleValues/tableKeyFields') return json({ options: [{ id: 'id', label: 'Id' }, { id: 'name', label: 'Name' }] })
  // bulk edit and delete
  if (path === '/processes/blk.bulkEdit/init') return step('be', 'edit', {})
  if (/\/be\/step\/edit$/.test(path)) return step('be', 'review', { supportsFullValidation: false })
  if (/\/be\/step\/review$/.test(path)) return step('be', 'result', { processResults: [{ status: 'OK', count: 2, message: 'Blk records were edited' }] })
  if (path === '/processes/blk.bulkDelete/init') return step('bd', 'review', { supportsFullValidation: false })
  if (/\/bd\/step\/review$/.test(path)) return step('bd', 'result', { processResults: [{ status: 'OK', count: 2, message: 'Blk records were deleted' }] })
  if (/\/(bi|be|bd|bf)\/cancel$/.test(path)) return json({})
  if (/\/(bi|be|bd|bf)\/records$/.test(path)) return json({ records: [], totalRecords: 0 })
  // saved bulk load profiles
  if (path === '/processes/querySavedBulkLoadProfile/init') return step('q', 'done', { savedBulkLoadProfileList: profiles })
  if (path === '/processes/storeSavedBulkLoadProfile/init') {
    const v = parse(body)
    const record = { values: { id: profiles.length + 1, label: v.label, tableName: v.tableName, isBulkEdit: v.isBulkEdit ?? false, mappingJson: v.mappingJson ?? v.bulkLoadProfileJson ?? JSON.stringify(v), userId: 'me' } }
    profiles.push(record)
    return step('s', 'done', { savedBulkLoadProfileList: [record] })
  }
  return undefined
}

export function addProfile(label: string, userId: string, fieldList: J[]): void {
  profiles.push({ values: { id: profiles.length + 1, label, tableName: 'blk', isBulkEdit: false, userId, mappingJson: JSON.stringify({ version: 'v1', layout: 'FLAT', hasHeaderRow: true, isBulkEdit: false, keyFields: null, fieldList }) } })
}

export function bulkLog(): J[] {
  return profiles
}
