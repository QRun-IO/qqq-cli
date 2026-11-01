/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { answerDocument, linkTargetKey, markdownText, parseMarkdown, wrapPlain } from '../render/markdown.js'

/** The answer to "what services are not healthy right now?" as 8078 gave it (qqq assistant ask --json). */
const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'test', 'fixtures', 'assistant-unhealthy.json'), 'utf8')) as { text: string; links: Array<{ label: string; href: string }> }

test('before: the raw answer has entities, a pipe table and URL-encoded link targets', () => {
  assert.match(fixture.text, /healthy&#58;/)
  assert.match(fixture.text, /\| --- \| --- \|/)
  assert.match(fixture.text, /\(\/app\/health_component\?filter=%7B/)
  assert.equal(fixture.links.length, 8)
})

test('after: entities decoded, the table laid out, links as label ↗ and never their URL', () => {
  const { doc, extraLinks } = answerDocument(fixture)
  const text = markdownText(doc, 100)
  assert.doesNotMatch(text, /&#|\/app\/|%7B|\| ---/)
  assert.match(text, /^3 services are not fully healthy: one degraded \(email\) and two with unknown status\. None are down\./)
  assert.match(text, /Service\s+Status\s+Since\s+Checks up\s+Degraded\s+Unknown/)
  assert.match(text, /db_performance ↗\s+UNKNOWN\s+2026-11-01 17:25 UTC/)
  assert.match(text, /- Open unhealthy components ↗/)
  assert.match(text, /- email is degraded\. Its only check is degraded\./)
  assert.ok(text.split('\n').every((l) => [...l].length <= 100))
  // four targets in reading order; the tool results' eight links are all the same four (records = id filters)
  assert.deepEqual(doc.links.map((l) => l.label), ['email', 'db_performance', 'esb', 'Open unhealthy components'])
  assert.deepEqual(extraLinks, [])
})

test('narrow: the table drops what does not fit and says so', () => {
  const text = markdownText(answerDocument(fixture).doc, 40)
  assert.ok(text.split('\n').every((l) => [...l].length <= 40))
  assert.match(text, /more columns? do not fit/)
})

test('duplicate paragraphs collapse; lists, headings, bold and code', () => {
  const doc = parseMarkdown('## Totals\n\nThere are **42** `customers`.\n\nThere are **42** `customers`.\n\n1. one\n2. two\n')
  assert.deepEqual(doc.blocks.map((b) => b.kind), ['heading', 'paragraph', 'list'])
  assert.deepEqual((doc.blocks[1] as { inlines: Array<{ style?: string }> }).inlines.map((i) => i.style ?? ''), ['', 'bold', '', 'code', ''])
  assert.equal(markdownText(doc, 80), 'Totals\n\nThere are 42 customers.\n\n1. one\n2. two')
})

test('link targets: records, id filters, JSON and base64 filters compare by content', () => {
  const json = '/app/t?filter=' + encodeURIComponent('{"booleanOperator":"AND","criteria":[{"fieldName":"s","operator":"EQUALS","values":["x"]}]}')
  const b64 = '/app/t?filter=' + encodeURIComponent(Buffer.from('{"criteria":[{"fieldName":"s","operator":"EQUALS","values":["x"]}],"booleanOperator":"AND"}').toString('base64'))
  assert.equal(linkTargetKey(json), linkTargetKey(b64))
  assert.equal(linkTargetKey('/app/t/4'), linkTargetKey('/app/t?filter=' + encodeURIComponent('{"criteria":[{"fieldName":"id","operator":"EQUALS","values":[4]}]}')))
  assert.notEqual(linkTargetKey('/app/t/4', () => 'code'), linkTargetKey('/app/t?filter=' + encodeURIComponent('{"criteria":[{"fieldName":"id","operator":"EQUALS","values":[4]}]}'), () => 'code'))
  assert.equal(linkTargetKey('/app/t'), 'table:t:')
})

test('wrapping keeps the prefix and cuts long words', () => {
  assert.deepEqual(wrapPlain('alpha beta gamma', 11, '- ', '  '), ['- alpha', '  beta', '  gamma'])
  assert.deepEqual(wrapPlain('abcdefghij', 6), ['abcdef', 'ghij'])
})
