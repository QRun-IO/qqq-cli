/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Record copy (the web UI's base copy): the source record's values prefill a new record; the
 * primary key, fields that are not editable, and file (BLOB) fields are dropped, so the insert
 * creates a separate record and the server assigns what it owns.
 */

type J = Record<string, unknown>

/** The values a copy starts from. */
export function copyRecordValues(tableMeta: J, record: J): J {
  const fields = (tableMeta.fields ?? {}) as Record<string, J>
  const pk = String(tableMeta.primaryKeyField ?? 'id')
  const values = (record.values ?? record) as J
  const out: J = {}
  for (const [name, value] of Object.entries(values)) {
    const field = fields[name]
    if (!field || name === pk || field.isEditable === false || field.type === 'BLOB') continue
    if (value === null || value === undefined) continue
    out[name] = value
  }
  return out
}
