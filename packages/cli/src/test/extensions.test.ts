/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Command } from 'commander'
import { ExtensionNotInstalledError, ExtensionRegistry, KNOWN_EXTENSIONS, operationsOf } from '@qrun-io/qqq-core'
import { EXIT, describeError } from '../context.js'
import { nounOf, registerExtensions, subcommandNames } from '../commands/extensions.js'
import { presenceLine } from '../commands/collab.js'

test('every operation of every extension is a uniquely named subcommand of its noun', () => {
  const program = new Command()
  registerExtensions(program, () => { throw new Error('not called') })
  for (const e of KNOWN_EXTENSIONS) {
    const names = subcommandNames(e.name, e.pathPrefix, operationsOf(e.name))
    assert.equal(names.size, operationsOf(e.name).length, `${e.name}: one name per operation`)
    const noun = program.commands.find((c) => c.name() === nounOf(e.name))!
    assert.ok(noun, `noun for ${e.name}`)
    for (const name of names.keys()) assert.ok(noun.commands.some((c) => c.name() === name), `${nounOf(e.name)} ${name}`)
  }
  const esb = subcommandNames('esb', '/esb', operationsOf('esb'))
  assert.deepEqual([...esb.keys()].sort(), ['get-dead-letters', 'get-messages', 'get-overview', 'get-process', 'get-table'])
  const collab = subcommandNames('collaboration', '/qbit/collaboration', operationsOf('collaboration'))
  assert.equal(collab.get('get-records-comments')?.id, 'getQbitCollaborationRecordsByTableByPkComments')
  assert.equal(collab.get('get-people-by-user-id')?.id, 'getQbitCollaborationPeopleByUserId')
  const collabNoun = program.commands.find((c) => c.name() === 'collab')!
  assert.deepEqual(collabNoun.aliases(), ['collaboration'])
  for (const verb of ['presence', 'comments', 'favorites', 'recents', 'follow', 'unfollow', 'my-work', 'people']) assert.ok(collabNoun.commands.some((c) => c.name() === verb), verb)
})

test('a missing extension maps to exit 5 with the installed list', () => {
  const error = new ExtensionNotInstalledError('collaboration', ExtensionRegistry.fromVersion({ extensions: [{ name: 'esb', version: '1.1.0' }] }).installed)
  assert.deepEqual(describeError(error), { code: EXIT.notFound, text: 'Error: extension collaboration is not installed on this server (installed: esb 1.1.0)' })
})

test('presence lines say who is there and since when', () => {
  const since = new Date(2026, 9, 31, 17, 50, 1)
  assert.equal(presenceLine({ available: true, scope: { table: 'person', pk: '1' }, count: 0, people: [], live: true }), 'nobody on person 1')
  assert.equal(presenceLine({ available: true, scope: { table: 'person' }, count: 2, people: [{ userId: 'a', name: 'Alice', mode: 'VIEWING', since }, { userId: 'b', name: 'Bob', mode: 'EDITING', fieldName: 'email', since }], live: true }), '2 on person: Alice (viewing since 17:50:01), Bob (editing email since 17:50:01)')
  assert.match(presenceLine({ available: false, scope: { table: 'person' }, count: 0, people: [], live: false }), /not installed/)
  assert.equal(presenceLine({ available: true, scope: { table: 'person', pk: '1' }, count: 1, connections: 2, people: [{ userId: 'admin', name: 'Admin', mode: 'VIEWING', since, connections: 2 }], live: true }), '1 on person 1 (2 connections): Admin ×2 (viewing since 17:50:01)')
})
