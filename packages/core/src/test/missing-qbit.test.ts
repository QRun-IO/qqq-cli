/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_OBJECT_STORAGE, missingQBitMessage } from '../api/missing-qbit.js'

test('a 5xx naming a missing QBit becomes one plain line; object storage gets the attachments wording', () => {
  assert.equal(missingQBitMessage({ status: 500, message: 'IllegalStateException (The Object Storage qbit is not installed)' }), NO_OBJECT_STORAGE)
  assert.equal(missingQBitMessage(new Error('The Object Storage qbit is not installed')), NO_OBJECT_STORAGE)
  assert.equal(missingQBitMessage({ status: 503, message: 'the printing extension is not installed' }), 'This server cannot do this: the Printing QBit is not installed.')
  assert.equal(missingQBitMessage({ status: 404, message: 'The Object Storage qbit is not installed' }), undefined)
  assert.equal(missingQBitMessage({ status: 500, message: 'NullPointerException' }), undefined)
  assert.equal(missingQBitMessage(undefined), undefined)
})
