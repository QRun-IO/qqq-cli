/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Golden-output tests for the CLI as a whole: the built CLI (dist/main.js) against a fake server
 * answering with recorded sample-server responses (see harness.ts). Each case's stdout, stderr
 * and exit code are compared with src/test/golden/<case>.txt; UPDATE_GOLDEN=1 rewrites them.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { TEST_SOURCE, runCli, sandbox, startFakeServer, type CliResult, type FakeServer } from './harness.js'

const GOLDEN = join(TEST_SOURCE, 'golden')
const UPDATE = process.env.UPDATE_GOLDEN === '1'

let server: FakeServer
let box: ReturnType<typeof sandbox>

before(async () => {
  server = await startFakeServer()
  box = sandbox()
})
after(async () => {
  await server.close()
  box.dispose()
})

/** Runs the CLI against the fake server, signed in with a bearer token. */
function qqq(args: string[], env: Record<string, string> = {}, input?: string): Promise<CliResult> {
  return runCli(['--server', server.url, ...args], { QQQ_TOKEN: 'test-token', ...box.env, ...env }, input)
}

function normalize(text: string): string {
  // paths under the sandbox home are compared with / separators, so the golden files hold on Windows too
  return text.split(server.url).join('http://fake').split(box.env.HOME!).join('<home>').replace(/<home>[^\s"']*/g, (path) => path.replace(/\\/g, '/')).replace(/_\d{4}-\d{2}-\d{2}_\d{6}/g, '_<stamp>').replace(/\r\n/g, '\n')
}

/** Compares a run with its golden file (or writes it with UPDATE_GOLDEN=1). */
function golden(name: string, result: CliResult): void {
  const actual = `${normalize(result.stdout)}--- stderr ---\n${normalize(result.stderr)}--- exit ${result.code}\n`
  const file = join(GOLDEN, `${name}.txt`)
  if (UPDATE || !existsSync(file)) {
    mkdirSync(GOLDEN, { recursive: true })
    writeFileSync(file, actual)
    if (!UPDATE) assert.fail(`wrote missing golden ${name}.txt; check it and run again`)
    return
  }
  assert.equal(actual, readFileSync(file, 'utf8'), `golden ${name}.txt (UPDATE_GOLDEN=1 rewrites it)`)
}

/** The last request to a path. */
function lastRequest(method: string, path: RegExp) {
  return [...server.requests].reverse().find((r) => r.method === method && path.test(r.path))
}

describe('tables', { concurrency: true }, () => {
  test('table list', async () => golden('table-list', await qqq(['table', 'list', '-O', 'table'])))
  test('table describe', async () => golden('table-describe', await qqq(['table', 'describe', 'person', '-O', 'table'])))
  test('table query as a table', async () => golden('query-table', await qqq(['table', 'query', 'person', '-O', 'table'])))
  test('table query as json', async () => golden('query-json', await qqq(['table', 'query', 'person', '-l', '2', '-O', 'json'])))
  test('table query as csv, with --fields and a page that may continue', async () => golden('query-csv', await qqq(['table', 'query', 'person', '--fields', 'id,firstName,createDate', '-l', '2', '-O', 'csv'])))
  test('table query as text', async () => golden('query-text', await qqq(['table', 'query', 'person', '-f', 'id,lastName', '-O', 'text'])))
  test('table query as yaml with --query', async () => golden('query-yaml', await qqq(['table', 'query', 'person', '-O', 'yaml', '-Q', '[].{id: values.id, name: recordLabel}'])))
  test('table query --utc shows raw instants', async () => golden('query-utc', await qqq(['--utc', 'table', 'query', 'person', '--fields', 'id,createDate', '-O', 'table'])))
  test('table count', async () => golden('table-count', await qqq(['table', 'count', 'person', '-O', 'table'])))
  test('table get as the record view', async () => golden('get-table', await qqq(['table', 'get', 'person', '1', '-O', 'table'])))
  test('table get as json', async () => golden('get-json', await qqq(['table', 'get', 'person', '1', '-O', 'json'])))
  test('flat alias get', async () => golden('get-alias', await qqq(['get', 'person', '1', '-O', 'json', '-Q', 'values.firstName'])))
  test('-V is --view on table query, never the version', async () => {
    const result = await qqq(['table', 'query', 'person', '-V', 'mine'])
    assert.doesNotMatch(result.stdout, /UI API client/)
    golden('query-view-short', result)
  })
})

describe('writes', () => {
  test('table create with -s (short --set, no longer --server)', async () => {
    golden('create', await qqq(['table', 'create', 'pet', '-s', 'name=Pixel', '-s', 'personId=1', '-s', 'speciesId=Cat', '-O', 'table']))
    assert.deepEqual(JSON.parse(lastRequest('POST', /^\/table\/pet$/)!.body), { name: 'Pixel', personId: 1, speciesId: 2 })
  })
  test('table update of a contingent field uses the record\'s current dependencies', async () => {
    golden('update-contingent', await qqq(['table', 'update', 'placeAddress', '1', '--set', 'cityId=Springfield', '-O', 'table']))
    assert.deepEqual(JSON.parse(lastRequest('PATCH', /^\/table\/placeAddress\/1$/)!.body), { cityId: 2 })
  })
  test('table update of a dependency sends the dependents it cleared', async () => {
    golden('update-clears', await qqq(['table', 'update', 'placeAddress', '1', '--set', 'stateId=Missouri', '-O', 'table']))
    assert.deepEqual(JSON.parse(lastRequest('PATCH', /^\/table\/placeAddress\/1$/)!.body), { stateId: 2, cityId: null })
  })
  test('table delete without a terminal and without --yes refuses (exit 2), sends nothing', async () => {
    const before = server.requests.filter((r) => r.method === 'DELETE').length
    golden('delete-no-tty', await qqq(['table', 'delete', 'pet', '7']))
    assert.equal(server.requests.filter((r) => r.method === 'DELETE').length, before)
  })
  test('table delete --yes', async () => golden('delete-yes', await qqq(['table', 'delete', 'pet', '7', '--yes', '-O', 'table'])))
  test('table create -i without a terminal is a usage error', async () => golden('create-interactive-no-tty', await qqq(['table', 'create', 'pet', '-i'])))
  test('table export goes to the download directory', async () => {
    const dir = join(box.env.HOME!, 'downloads')
    const set = await qqq(['config', 'set', 'download-dir', dir])
    assert.equal(set.code, 0, set.stderr)
    const get = await qqq(['config', 'get', 'download-dir', '-O', 'json'])
    assert.equal(JSON.parse(get.stdout), dir)
    golden('export-download-dir', await qqq(['table', 'export', 'person']))
    const [first] = readdirSync(dir)
    assert.match(first!, /^person_\d{4}-\d{2}-\d{2}_\d{6}\.csv$/)
    assert.equal(readFileSync(join(dir, first!), 'utf8'), 'id,firstName\n1,Avery\n2,Blair\n')
    // a second export in the same second takes the next free name; a later one has its own stamp
    const again = await qqq(['table', 'export', 'person'])
    assert.match(again.stderr, /person_\d{4}-\d{2}-\d{2}_\d{6}(-1)?\.csv/)
    assert.equal(readdirSync(dir).length, 2)
    // an explicit --out is left exactly as given
    await qqq(['table', 'export', 'person', '-o', join(dir, 'person.csv')])
    assert.ok(readdirSync(dir).includes('person.csv'))
    await qqq(['config', 'set', 'download-dir', ''])
  })
})

describe('processes', () => {
  test('process describe', async () => golden('process-describe', await qqq(['process', 'describe', 'sleepInteractive', '-O', 'table'])))
  test('process run, synchronous step', async () => golden('process-run-sync', await qqq(['process', 'run', 'sleepInteractive', '-v', 'sleepMillis=100', '--timeout', '60000', '-O', 'table'])))
  test('process run, asynchronous job polled to the end', async () => golden('process-run-async', await qqq(['process', 'run', 'sleepInteractive', '-v', 'sleepMillis=100', '-O', 'json', '-Q', 'values'])))
  test('process run with a bad --timeout is a usage error before anything runs', async () => golden('process-run-bad-timeout', await qqq(['process', 'run', 'sleepInteractive', '--timeout', 'soon'])))
})

describe('widgets, api, extensions', { concurrency: true }, () => {
  test('widget get as bars', async () => golden('widget-get', await qqq(['widget', 'get', 'SampleLineChartWidget', '--ascii', '-O', 'table'], { COLUMNS: '80' })))
  test('widget get --csv', async () => golden('widget-csv', await qqq(['widget', 'get', 'SampleLineChartWidget', '--csv'])))
  test('api by operation id with --query', async () => golden('api-call', await qqq(['api', 'getTableMetaData', '--path', 'tableName=person', '-Q', 'label'])))
  test('api with a missing path parameter is a usage error', async () => golden('api-missing-path', await qqq(['api', 'getTableMetaData'])))
  test('extensions', async () => golden('extensions', await qqq(['extensions', '-O', 'table'])))
  test('an installed extension noun', async () => golden('esb-overview', await qqq(['esb', 'overview', '-O', 'table'])))
  test('an extension the server does not list exits 5', async () => golden('collab-not-installed', await qqq(['collab', 'favorites', 'list'])))
})

describe('exit codes', { concurrency: true }, () => {
  for (const [status, code] of [[400, 6], [401, 3], [403, 3], [404, 5], [500, 70], [503, 4]] as const) {
    test(`HTTP ${status} exits ${code}`, async () => {
      const result = await qqq(['table', 'describe', `err${status}`])
      assert.equal(result.code, code, result.stderr)
      golden(`exit-${status}`, result)
    })
  }
  test('a refused token exits 3', async () => {
    // a sandbox of its own: the shared one holds metadata cached by other tests
    const local = sandbox()
    try {
      golden('exit-expired-token', await runCli(['--server', server.url, 'table', 'list'], { ...local.env, QQQ_TOKEN: 'expired' }))
    } finally {
      local.dispose()
    }
  })
  test('an unreachable server exits 4', async () => {
    const result = await runCli(['--server', 'http://127.0.0.1:59999', 'table', 'list'], { QQQ_TOKEN: 't', ...box.env })
    assert.equal(result.code, 4, result.stderr)
    assert.match(result.stderr, /cannot reach the server/)
  })
  test('an unknown command exits 2', async () => {
    const result = await qqq(['tabel', 'list'])
    assert.equal(result.code, 2)
  })
  test('a bad --limit exits 2 before any request', async () => golden('bad-limit', await qqq(['table', 'query', 'person', '-l', 'many'])))
})

describe('doctor', () => {
  test('doctor passes against a healthy server', async () => {
    const result = await qqq(['doctor', '-O', 'json'])
    assert.equal(result.code, 0, result.stdout + result.stderr)
    const report = JSON.parse(result.stdout) as { ok: boolean; checks: Array<{ area: string; check: string; status: string; detail: string }> }
    assert.equal(report.ok, true)
    assert.match(report.checks[0]!.detail, /^qqq \S+; npm package or source checkout; Node \d+\.\d+\.\d+; \w+ \S+ \w+$/)
    assert.deepEqual(report.checks.filter((x) => x.area !== 'terminal').map((x) => [x.check, x.status]).slice(0, 7), [['build', 'ok'], ['profile', 'ok'], ['reachable', 'ok'], ['UI API version', 'ok'], ['authentication', 'ok'], ['signed in', 'ok'], ['extensions', 'ok']])
  })
  test('doctor without a sign-in exits 1 and says what to do', async () => {
    const local = sandbox()
    try {
      const result = await runCli(['--server', server.url, 'doctor', '-O', 'table'], local.env)
      assert.equal(result.code, 1)
      assert.match(result.stdout, /signed in\s+fail\s+no sign-in for profile/)
      assert.match(result.stdout, /checks failed: signed in/)
    } finally {
      local.dispose()
    }
  })
  test('doctor on an unreachable server exits 1', async () => {
    const result = await runCli(['--server', 'http://127.0.0.1:59999', 'doctor', '-O', 'json'], box.env)
    assert.equal(result.code, 1)
    assert.equal((JSON.parse(result.stdout) as { checks: Array<{ check: string; status: string }> }).checks.find((x) => x.check === 'reachable')?.status, 'fail')
  })
  test('UI API version support', async () => {
    const { versionSupport } = await import('../commands/doctor.js')
    assert.equal(versionSupport('1.8.0', [1]).status, 'ok')
    assert.equal(versionSupport('1.5.2', [1]).status, 'fail')
    assert.equal(versionSupport('1.9.0', [1]).status, 'warn')
    assert.equal(versionSupport('2.0.0', [2]).status, 'fail')
  })
  test('doctor words the supported UI API range exactly as --version does', async () => {
    const { versionSupport } = await import('../commands/doctor.js')
    const { UI_API_RANGE } = await import('../version.js')
    assert.equal(UI_API_RANGE, '>=1.6.0 <2.0.0')
    const version = await runCli(['--version'], box.env)
    assert.match(version.stdout, new RegExp(`servers UI API ${UI_API_RANGE}`))
    for (const [server, status] of [['1.6.0', 'ok'], ['1.8.0', 'ok'], ['1.9.0', 'warn'], ['1.5.2', 'fail']] as const) {
      const result = versionSupport(server, [1])
      assert.equal(result.status, status, server)
      assert.ok(result.detail.includes(UI_API_RANGE), `${server}: ${result.detail}`)
      assert.ok(!/supports \d+\.\d+\.\d+ to /.test(result.detail), `${server}: ${result.detail}`)
    }
    assert.match(versionSupport('1.9.0', [1]).detail, /^1\.9\.0; supported \(/)
  })
})

describe('merged with the TUI stream', () => {
  test('config set|get theme and download-mode use the TUI\'s ui helpers', async () => {
    const local = sandbox()
    try {
      assert.equal((await runCli(['config', 'set', 'theme', 'classic'], local.env)).code, 0)
      assert.equal(JSON.parse((await runCli(['config', 'get', 'theme', '-O', 'json'], local.env)).stdout), 'classic')
      assert.equal((await runCli(['config', 'set', 'download-mode', 'loud'], local.env)).code, 2)
      assert.equal((await runCli(['config', 'set', 'download-mode', 'silent'], local.env)).code, 0)
      assert.equal((await runCli(['config', 'set', 'download-dir', join(local.env.HOME!, 'dl')], local.env)).code, 0)
      const ui = (JSON.parse(readFileSync(join(local.env.QQQ_CONFIG_DIR!, 'config.json'), 'utf8')) as { ui: unknown }).ui
      assert.deepEqual(ui, { theme: 'classic', files: { downloadMode: 'silent', downloadDir: join(local.env.HOME!, 'dl') } })
    } finally {
      local.dispose()
    }
  })
  test('doctor reports the terminal through the kernel check', async () => {
    const result = await qqq(['doctor', '-O', 'json'])
    const checks = (JSON.parse(result.stdout) as { checks: Array<{ area: string; status: string }> }).checks.filter((x) => x.area === 'terminal')
    assert.ok(checks.length > 0)
    assert.ok(checks.every((x) => x.status !== 'skip'))
  })
  test('runCli captures what commands write straight to stdout (export --out -) for the TUI pane', async () => {
    // in a child process: capturing process.stdout inside the test runner would eat its own reports
    const script = `
      import { runCli } from ${JSON.stringify(new URL('../program.js', import.meta.url).href)}
      let out = '', err = ''
      const io = { stdout: (t) => (out += t), stderr: (t) => (err += t) }
      const exported = await runCli(['--server', process.argv[1], 'table', 'export', 'person', '--out', '-'], io)
      const exportOut = out
      out = ''
      const refused = await runCli(['--server', process.argv[1], 'table', 'delete', 'pet', '7'], io)
      process.stdout.write(JSON.stringify({ exported, exportOut, refused, err }))`
    const result = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, server.url], { env: { ...process.env, ...box.env, QQQ_TOKEN: 'test-token' } })
      let text = ''
      child.stdout.on('data', (d: Buffer) => (text += d.toString('utf8')))
      child.on('error', reject)
      child.on('close', () => resolve(text))
    })
    const r = JSON.parse(result) as { exported: number; exportOut: string; refused: number; err: string }
    assert.equal(r.exported, 0, r.err)
    assert.equal(r.exportOut, 'id,firstName\n1,Avery\n2,Blair\n')
    assert.equal(r.refused, 2)
    assert.match(r.err, /Pass --yes/)
  })
})

describe('local state', () => {
  test('a corrupt config.json is reported and left alone', async () => {
    const local = sandbox()
    try {
      mkdirSync(local.env.QQQ_CONFIG_DIR!, { recursive: true })
      writeFileSync(join(local.env.QQQ_CONFIG_DIR!, 'config.json'), '{"profiles": {')
      const result = await runCli(['config', 'profile', 'add', 'x', 'http://localhost:1'], local.env)
      assert.equal(result.code, 1)
      assert.match(result.stderr, /not valid JSON/)
      assert.equal(readFileSync(join(local.env.QQQ_CONFIG_DIR!, 'config.json'), 'utf8'), '{"profiles": {')
    } finally {
      local.dispose()
    }
  })
  test('0.1 sign-ins are imported into a profile and the file renamed', async () => {
    const local = sandbox()
    try {
      mkdirSync(local.env.QQQ_CLI_HOME!, { recursive: true })
      const legacy = { defaultServer: server.url, servers: { [server.url]: { kind: 'session', authType: 'MOCK', sessionUUID: 'abc', createdAt: '2026-01-01T00:00:00Z' } } }
      writeFileSync(join(local.env.QQQ_CLI_HOME!, 'credentials.json'), JSON.stringify(legacy))
      const result = await runCli(['config', 'profile', 'list', '-O', 'json'], local.env)
      assert.equal(result.code, 0, result.stderr)
      assert.match(result.stderr, /Imported the 0\.1 sign-ins/)
      assert.deepEqual((JSON.parse(result.stdout) as Array<{ signedIn: string }>).map((p) => p.signedIn), ['session'])
      assert.ok(existsSync(join(local.env.QQQ_CLI_HOME!, 'credentials.json.imported')))
    } finally {
      local.dispose()
    }
  })
  test('qqq profile add|edit|list|use|remove agree with the Servers dialog: short name, description, sign-in mode', async () => {
    const local = sandbox()
    try {
      const file = join(local.env.QQQ_CONFIG_DIR!, 'config.json')
      // a 1.0.0-rc.1 file (with a note) loads and keeps what it had
      mkdirSync(local.env.QQQ_CONFIG_DIR!, { recursive: true })
      writeFileSync(file, JSON.stringify({ defaultProfile: 'old', profiles: { old: { server: 'http://old.test', note: 'from rc.1', createdAt: '2026-10-31T00:00:00Z', ui: { theme: 'light' } } }, ui: { theme: 'dark' } }))
      let r = await runCli(['profile', 'add', 'sample', server.url, '--short', 'smp', '--description', 'The sample server', '--check'], local.env)
      assert.equal(r.code, 0, r.stderr)
      assert.match(r.stderr, /UI API 1\.\d+\.\d+/)
      r = await runCli(['profile', 'add', 'down', 'http://127.0.0.1:9', '--check'], local.env)
      assert.equal(r.code, 2)
      assert.match(r.stderr, /did not answer/)
      r = await runCli(['profile', 'add', 'bad', server.url, '--short', 'x'], local.env)
      assert.equal(r.code, 2)
      assert.match(r.stderr, /2 to 6 characters/)
      r = await runCli(['profile', 'edit', 'sample', '--auth-mode', 'device', '--description', 'Sample, edited', '--rename', 'samp'], local.env)
      assert.equal(r.code, 0, r.stderr)
      r = await runCli(['config', 'profile', 'use', 'samp'], local.env)
      assert.equal(r.code, 0, r.stderr)
      r = await runCli(['profile', 'list', '-O', 'json', '--probe'], local.env)
      assert.equal(r.code, 0, r.stderr)
      const rows = JSON.parse(r.stdout) as Array<Record<string, string>>
      assert.deepEqual(rows.map((p) => [p.name, p.short, p.default, p.authMode, p.description]), [['old', 'old', '', 'auto', 'from rc.1'], ['samp', 'smp', '*', 'device', 'Sample, edited']])
      assert.match(rows[1]!.status!, /^UI API /)
      const cfg = JSON.parse(readFileSync(file, 'utf8')) as { defaultProfile: string; profiles: Record<string, Record<string, unknown>>; ui: unknown }
      assert.deepEqual(cfg.profiles.old, { server: 'http://old.test', note: 'from rc.1', createdAt: '2026-10-31T00:00:00Z', ui: { theme: 'light' } })
      assert.deepEqual(cfg.ui, { theme: 'dark' })
      assert.equal(cfg.profiles.samp!.short, 'smp')
      r = await runCli(['profile', 'edit', 'samp', '--short', ''], local.env)
      assert.equal(r.code, 0, r.stderr)
      assert.equal((JSON.parse(readFileSync(file, 'utf8')) as typeof cfg).profiles.samp!.short, undefined)
      r = await runCli(['profile', 'remove', 'old'], local.env)
      assert.equal(r.code, 0, r.stderr)
      assert.deepEqual(Object.keys((JSON.parse(readFileSync(file, 'utf8')) as typeof cfg).profiles), ['samp'])
    } finally {
      local.dispose()
    }
  })
  test('--version prints the version', async () => {
    const result = await runCli(['--version'], box.env)
    assert.equal(result.code, 0)
    assert.match(result.stdout, /UI API client/)
  })
})
