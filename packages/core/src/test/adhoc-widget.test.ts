/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { adHocControls, hasInputs, inputFields, type ProcessStep } from '../process/runner.js'
import { buildScreen, screenToText } from '../process/screen.js'
import { blocksToText } from '../widgets/render-model.js'

const step: ProcessStep = {
  name: 'scan', label: 'Scan',
  components: [{ type: 'WIDGET', values: { isAdHocWidget: true, blocks: [
    { blockTypeName: 'TEXT', values: { text: 'Order ${orderNo}' } },
    { blockTypeName: 'TEXT', conditional: 'showHint', values: { text: 'Hint: scan the label' } },
    { blockTypeName: 'INPUT_FIELD', values: { fieldMetaData: { name: 'barcode', label: 'Barcode', type: 'STRING', isRequired: true }, submitOnEnter: true } },
    { blockTypeName: 'COMPOSITE', values: { blocks: [{ blockTypeName: 'BUTTON', values: { label: 'Skip', actionCode: 'skip' } }, { blockTypeName: 'BUTTON', values: { label: 'Help', controlCode: 'showModal:help' } }] } },
    { blockTypeName: 'BUTTON', conditional: 'canFinish', values: { label: 'Finish', actionCode: 'finish' } },
  ] } }],
}

test('ad hoc composite inputs and buttons are the step\'s controls; conditionals hide blocks', () => {
  const all = adHocControls(step)
  assert.deepEqual(all.inputs.map((i) => [i.field.name, i.submitOnEnter]), [['barcode', true]])
  assert.deepEqual(all.buttons, [{ label: 'Skip', actionCode: 'skip' }, { label: 'Help', controlCode: 'showModal:help' }, { label: 'Finish', actionCode: 'finish' }])
  assert.deepEqual(adHocControls(step, { canFinish: false }).buttons.map((b) => b.label), ['Skip', 'Help'])
  assert.equal(hasInputs(step), true)
  assert.deepEqual(inputFields(step, { type: 'COMPLETE', processUUID: 'u' }).map((f) => f.name), ['barcode'])
})

test('the ad hoc widget renders interpolated, with conditional blocks left out, inputs and buttons shown', async () => {
  const screen = await buildScreen({ baseUrl: 'http://x', fetch: (async () => new Response('{}')) as typeof fetch, processName: 'p', processUUID: 'u', step, values: { orderNo: 'SO-1', showHint: false, canFinish: true } })
  const text = screenToText(screen, { table: () => '', widget: (blocks) => blocksToText(blocks) })
  assert.match(text, /Order SO-1/)
  assert.doesNotMatch(text, /Hint/)
  assert.match(text, /Barcode \*: \[string\] \(Enter submits\)/)
  assert.match(text, /\[ Skip \]/)
  assert.match(text, /\[ Finish \]/)
})
