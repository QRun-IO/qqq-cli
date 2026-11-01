/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeEntities, findReferences, replaceReferences, stripTags, trimChar, trimEndChar, trimStartChar } from '../render/text.js'
import { htmlToText } from '../widgets/render-model.js'
import { uploadTemplates } from '../bulk/mapping.js'
import { callTableApi } from '../records/developer.js'
import { valueText } from '../records/record-view.js'
import { getDependencies, type FieldMeta } from '../forms/fields.js'
import { locateFilterError } from '../filter/complete.js'
import { FilterSyntaxError, isEscapedAt, parseFilter, parseValue, printFilter, printValue, quoteValue } from '../filter/grammar.js'
import { parseRootBindings } from '../env/doctor.js'

const BIG = 100_000

/** Runs `f` and fails when it takes longer than `ms` (the quadratic versions took many seconds on these inputs). */
function fast<T>(f: () => T, ms = 500): T {
  const start = performance.now()
  const result = f()
  const took = performance.now() - start
  assert.ok(took < ms, `took ${Math.round(took)} ms`)
  return result
}

test('trim helpers drop runs of one character at the ends only', () => {
  assert.equal(trimStartChar('//a/b//', '/'), 'a/b//')
  assert.equal(trimEndChar('//a/b//', '/'), '//a/b')
  assert.equal(trimChar('//a/b//', '/'), 'a/b')
  assert.equal(trimChar('////', '/'), '')
  assert.equal(trimEndChar('QUJD==', '='), 'QUJD')
  assert.equal(fast(() => trimChar(`${'/'.repeat(BIG)}x${'/'.repeat(BIG)}`, '/')), 'x')
  assert.equal(fast(() => trimEndChar(`${'/'.repeat(BIG)}x`, '/')).length, BIG + 1)
})

test('references are replaced like /\\$\\{([^}]+)\\}/g, in linear time', () => {
  const values: Record<string, string> = { a: 'A', 'b c': 'BC' }
  const viaRegex = (text: string) => text.replace(/\$\{([^}]+)\}/g, (p, n: string) => values[n] ?? p)
  const viaScan = (text: string) => replaceReferences(text, '', (n, p) => values[n] ?? p)
  for (const text of ['x ${a} y ${b c} ${zz} ${} ${a', '${${a}', '$${a}}', '${a}${a}', 'no refs', '${\n}', '${}${a}']) {
    assert.equal(viaScan(text), viaRegex(text), text)
  }
  assert.deepEqual(findReferences('${input.x} and ${input.y z} not ${other} ${input.}', 'input.'), ['x', 'y z'])
  assert.equal(fast(() => replaceReferences('${{'.repeat(BIG), '', () => 'X')), '${{'.repeat(BIG))
  assert.deepEqual(fast(() => findReferences(`\${{input.${'${{input.'.repeat(BIG)}`, 'input.')), [])
})

test('tags are stripped in one linear pass; entities are decoded once', () => {
  assert.equal(stripTags('<b>bold</b> and <i class="x">it</i>'), 'bold and it')
  assert.equal(stripTags('a < b stays'), 'a < b stays')
  assert.equal(stripTags('<> stays'), '<> stays')
  // the same results as the regular expression /<[^>]+>/g had
  const cases: Array<[string, string]> = [['a < b and <> c', 'a  c'], ['<<b>>', '>'], ['<a<b>c>', 'c>'], ['x<>y<z>', 'x<>y'], ['<', '<'], ['>', '>'], ['<p>a</p', 'a</p']]
  for (const [html, text] of cases) assert.equal(stripTags(html), text, html)
  assert.equal(stripTags('<scr<script>ipt>alert(1)'), 'ipt>alert(1)') // same as /<[^>]+>/g; terminal text, never HTML
  assert.equal(stripTags('<p>x</p>', (inner) => `[${inner}]`), '[p]x[/p]')
  assert.equal(fast(() => stripTags('<'.repeat(BIG))), '<'.repeat(BIG))
  assert.equal(decodeEntities('&amp;lt;b&amp;gt; &lt;i&gt; &quot;q&quot; &#39;s&#39; a&nbsp;b'), '&lt;b&gt; <i> "q" \'s\' a b')
})

test('htmlToText keeps line breaks and bullets and does not double-decode entities', () => {
  assert.equal(htmlToText('<p>One &amp; two</p><ul><li>a</li><li class="x">b</li></ul>line<br/>break'), 'One & two\n• a\n• b\nline\nbreak')
  assert.equal(htmlToText('Write &amp;lt;b&amp;gt; for bold'), 'Write &lt;b&gt; for bold')
  assert.equal(htmlToText('<link rel="x">text'), 'text')
  fast(() => htmlToText(`<li${'<li'.repeat(BIG)}`))
  fast(() => htmlToText('<br'.repeat(BIG)))
})

test('upload template names decode &amp; once', () => {
  const t = uploadTemplates('<a download="A &amp;lt; B.csv" href="data:text/csv,x">T</a>')
  assert.deepEqual(t.map((x) => x.name), ['A &lt; B.csv'])
})

test('callTableApi joins base, API path and subpath without repeated slashes, in linear time', async () => {
  const seen: string[] = []
  const fetchImpl = (async (url: URL | string) => {
    seen.push(String(url))
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  await callTableApi('http://h:1//', fetchImpl, { path: '//api/v1//' }, '2026.Q1', 'get', '//person/query')
  assert.deepEqual(seen, ['http://h:1/api/v1/2026.Q1/person/query'])
  const slashes = '/'.repeat(BIG)
  await fast(() => callTableApi(`http://h:1${slashes}`, fetchImpl, { path: `${slashes}a${slashes}` }, 'v', 'get', `${slashes}x`))
  assert.equal(seen[1], 'http://h:1/a/v/x')
})

test('a BLOB value shows its size; a long run of = is quick', () => {
  const field = { name: 'data', label: 'Data', type: 'BLOB' } as FieldMeta
  assert.equal(valueText(field, { values: { data: 'QUJD' } }).text, '<file, 3 bytes>')
  assert.equal(valueText(field, { values: { data: 'QQ==' } }).text, '<file, 1 bytes>')
  assert.equal(fast(() => valueText(field, { values: { data: `${'='.repeat(BIG)}x` } }).text), `<file, ${Math.floor((BIG + 1) * 3 / 4)} bytes>`)
})

test('dependencies come from ${input.x} references in the filter; a long run of ${input. is quick', () => {
  const field = (values: unknown[]) => ({ name: 'f', label: 'F', type: 'INTEGER', possibleValueSourceFilter: { criteria: [{ values }] } }) as unknown as FieldMeta
  assert.deepEqual(getDependencies(field(['${input.storeId}', 'x ${input.region} ${input.storeId}'])), ['storeId', 'region'])
  assert.deepEqual(fast(() => getDependencies(field([`\${input.${'${input.'.repeat(BIG)}`]))), [])
})

test('locateFilterError finds the fragment after ": "; a long message is quick', () => {
  assert.equal(locateFilterError('a EQUALS 1 junk', new FilterSyntaxError('Unexpected text: junk')), 11)
  fast(() => locateFilterError('x', new FilterSyntaxError(`: ${': a'.repeat(BIG)}\n`)))
})

test('parseRootBindings reads key and command; a line of many spaces is quick', () => {
  assert.deepEqual(parseRootBindings('bind-key  -T root F12     set-option   prefix None\nbind-key -r -T root \\; send-keys -M  '), [
    { key: 'F12', command: 'set-option   prefix None' }, { key: ';', command: 'send-keys -M' },
  ])
  assert.deepEqual(parseRootBindings('bind-key -T root F12'), [])
  assert.deepEqual(fast(() => parseRootBindings(`bind-key -T root ! ${'  '.repeat(BIG)}\rx`)), [{ key: '!', command: `${'  '.repeat(BIG)}\rx`.trim() }])
})

test('filter values escape backslashes and quotes, and read back the same', () => {
  assert.equal(quoteValue('a"b\\c'), '"a\\"b\\\\c"')
  assert.equal(printValue('C:\\dir with space\\'), '"C:\\\\dir with space\\\\"')
  for (const value of ['plain', 'two words', 'say "hi"', 'ends with \\', '\\"', 'C:\\dir with space\\', 'a,b']) {
    assert.equal(parseValue(printValue(value)), value, value)
    const filter = parseFilter(`name IN ${printValue(value)},other AND x EQUALS 1`)
    assert.deepEqual(filter.criteria[0]!.values, [value, 'other'], value)
    assert.equal(printFilter(parseFilter(printFilter(filter))), printFilter(filter))
  }
  assert.equal(parseValue('"C:\\path"'), 'C:\\path') // a lone backslash before another character stays
  assert.equal(isEscapedAt('a\\"', 2), true)
  assert.equal(isEscapedAt('a\\\\"', 3), false)
})
