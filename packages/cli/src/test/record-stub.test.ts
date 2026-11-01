/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** Record features the sample cannot exercise, against a stub: a dynamicForm widget on a record form. */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { runCli, sandbox } from './harness.js'
import { BASE_ROUTES, startStub, type J, type Stub } from './stub.js'

describe('record features against a stub', () => {
  let stub: Stub
  let box: ReturnType<typeof sandbox>
  let saved: J = { id: 7, settingsJson: '{"limit":3}' }
  const qqq = (args: string[]) => runCli(['--server', stub.url, ...args], { QQQ_TOKEN: 't', ...box.env })
  before(async () => {
    box = sandbox()
    stub = await startStub([...BASE_ROUTES,
      [/^GET \/metaData$/, () => ({ tables: { order: { name: 'order', label: 'Order' } }, processes: {}, widgets: { settingsForm: { name: 'settingsForm', type: 'dynamicForm' } }, apps: {} })],
      [/^GET \/metaData\/table\/order$/, () => ({ name: 'order', label: 'Order', primaryKeyField: 'id', fields: { id: { name: 'id', label: 'Id', type: 'INTEGER' }, settingsJson: { name: 'settingsJson', label: 'Settings', type: 'TEXT' } }, sections: [{ name: 's', label: 'Settings', widgetName: 'settingsForm', tier: 'T2' }] })],
      [/^POST \/widget\/settingsForm$/, () => ({ type: 'dynamicForm', mergedDynamicFormValuesIntoFieldName: 'settingsJson', fieldList: [{ name: 'limit', label: 'Limit', type: 'INTEGER', isRequired: true }, { name: 'note', label: 'Note', type: 'STRING' }] })],
      [/^GET \/table\/order\/7$/, () => ({ record: { values: saved } })],
      [/^PATCH \/table\/order\/7$/, (r) => { saved = { ...saved, ...(r.json as J) }; return { record: { values: saved } } }],
    ])
  })
  after(async () => {
    await stub.close()
    box.dispose()
  })

  test('widget-form validates the dynamicForm fields and saves them in the merged JSON field', async () => {
    const missing = await qqq(['table', 'widget-form', 'order', '7', 'settingsForm', '--set', 'limit=', '--set', 'note=x'])
    assert.equal(missing.code, 2)
    assert.match(missing.stderr, /settingsForm needs Limit/)
    const r = await qqq(['table', 'widget-form', 'order', '7', 'settingsForm', '--set', 'note=rush', '-O', 'table'])
    assert.equal(r.code, 0, r.stderr)
    assert.equal(saved.settingsJson, '{"limit":3,"note":"rush"}')
    assert.match(r.stdout, /saved in settingsJson of Order 7/)
  })
})
