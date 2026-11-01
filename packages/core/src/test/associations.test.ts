/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AssociationError, associationGroups, associationLabel, childFilter, childListFields, childWidgetColumns, widgetAssociation, fetchChildren, findAssociation, parentLinkValues, relationshipValues, type RecordLike, type TableMetaLike } from '../records/associations.js'

const f = (name: string, extra: Record<string, unknown> = {}) => ({ name, label: name[0]!.toUpperCase() + name.slice(1), type: 'STRING', ...extra })

const person: TableMetaLike = {
  name: 'person', label: 'Person', primaryKeyField: 'id',
  fields: { id: f('id', { type: 'INTEGER' }), firstName: f('firstName') },
  associations: [{ name: 'pets', associatedTableName: 'pet', join: { name: 'personJoinPet', type: 'ONE_TO_MANY', leftTable: 'person', rightTable: 'pet', joinOns: [{ leftField: 'id', rightField: 'personId' }] } }],
}
const pet: TableMetaLike = {
  name: 'pet', label: 'Pet', primaryKeyField: 'id', readPermission: true,
  fields: { id: f('id', { type: 'INTEGER' }), name: f('name'), personId: f('personId', { type: 'INTEGER', possibleValueSourceName: 'person' }), secret: f('secret', { isHidden: true }), blob: f('blob', { isHeavy: true }) },
  associations: [{ name: 'notes', associatedTableName: 'petNote', join: { name: 'petJoinNote', leftTable: 'pet', rightTable: 'petNote', joinOns: [{ leftField: 'id', rightField: 'petId' }], orderBys: [{ fieldName: 'id', isAscending: false }] } }],
}
const petNote: TableMetaLike = { name: 'petNote', label: 'Pet Note', primaryKeyField: 'id', fields: { id: f('id'), petId: f('petId'), note: f('note') } }

const avery: RecordLike = {
  tableName: 'person', values: { id: 1, firstName: 'Avery' }, recordLabel: 'Avery Sample',
  associatedRecords: {
    pets: [
      { tableName: 'pet', values: { id: 1, name: 'Charlie', personId: 1 }, recordLabel: 'Charlie', associatedRecords: { notes: [{ tableName: 'petNote', values: { id: 1, petId: 1, note: 'Target note' }, recordLabel: 'Target note' }] } },
      { tableName: 'pet', values: { id: 2, name: 'Coco', personId: 1 }, recordLabel: 'Coco' },
    ],
  },
}

test('relationship values bind a child to its parent; composite joins give one value per pair', () => {
  assert.deepEqual(relationshipValues(person.associations![0]!, person, avery, pet), { values: { personId: 1 }, reverse: false })
  const order: TableMetaLike = { name: 'order', fields: { id: f('id'), clientId: f('clientId') }, associations: [{ name: 'lines', associatedTableName: 'line', join: { leftTable: 'order', rightTable: 'line', joinOns: [{ leftField: 'id', rightField: 'orderId' }, { leftField: 'clientId', rightField: 'clientId' }] } }] }
  const line: TableMetaLike = { name: 'line', fields: { id: f('id'), orderId: f('orderId'), clientId: f('clientId') } }
  assert.deepEqual(relationshipValues(order.associations![0]!, order, { values: { id: 7, clientId: 'acme' } }, line), { values: { orderId: 7, clientId: 'acme' }, reverse: false })
  assert.ok('error' in relationshipValues(order.associations![0]!, order, { values: { id: 7 } }, line), 'a missing join value is an error, not a wrong link')
  assert.ok('error' in relationshipValues(person.associations![0]!, person, avery, petNote), 'the wrong child table is refused')
})

test('the child filter is EQUALS on every binding field, ordered by the join, then by the child key', () => {
  assert.deepEqual(childFilter(person.associations![0]!, person, avery, pet, { limit: 10, skip: 20 }), {
    criteria: [{ fieldName: 'personId', operator: 'EQUALS', values: ['1'] }], booleanOperator: 'AND', orderBys: [{ fieldName: 'id', isAscending: true }], skip: 20, limit: 10,
  })
  assert.deepEqual(childFilter(pet.associations![0]!, pet, avery.associatedRecords!.pets![0]!, petNote).orderBys, [{ fieldName: 'id', isAscending: false }])
  const reverse = { name: 'owner', associatedTableName: 'person', join: { leftTable: 'person', rightTable: 'pet', joinOns: [{ leftField: 'id', rightField: 'personId' }] } }
  assert.throws(() => childFilter(reverse, pet, { values: { id: 1, personId: 1 } }, person), AssociationError)
})

test('association groups walk three levels and keep every declared association, empty or not', () => {
  const groups = associationGroups(avery, person, { person, pet, petNote })
  assert.deepEqual(groups.map((g) => [g.title, g.depth, g.records.length]), [
    ['Pet', 1, 2],
    ['Pet: Charlie: Pet Note', 2, 1],
    ['Pet: Coco: Pet Note', 2, 0],
  ])
  assert.equal(groups[1]!.records[0]!.values.note, 'Target note', 'each pet shows only its own notes')
})

test('a child table the user may not read, or without metadata, is unavailable without data', () => {
  const denied = associationGroups(avery, person, { person, pet: { ...pet, readPermission: false }, petNote })
  assert.equal(denied.length, 1)
  assert.match(denied[0]!.unavailable!, /may not read Pet/)
  assert.deepEqual(denied[0]!.records, [])
  assert.match(associationGroups(avery, person, { person })[0]!.unavailable!, /No metadata/)
})

test('labels come from the child-list widget section, then an exposed join, then the child table', () => {
  const salesOrder: TableMetaLike = { ...person, sections: [{ name: 'lines', label: 'Order Lines', widgetName: 'w' }] }
  assert.equal(associationLabel(salesOrder, person.associations![0]!, { widgets: { w: { type: 'childRecordList', defaultValues: { joinName: 'personJoinPet' } } }, childTable: pet }), 'Order Lines')
  assert.equal(associationLabel({ ...person, exposedJoins: [{ joinTable: 'pet', label: 'Animals' }] }, person.associations![0]!, { childTable: pet }), 'Animals')
  assert.equal(associationLabel(person, person.associations![0]!, { childTable: pet }), 'Pet')
  assert.equal(associationLabel(person, person.associations![0]!), 'pets')
})

test('find by association name or by child table; parent link values for a new child', () => {
  assert.equal(findAssociation(person, 'pets')?.name, 'pets')
  assert.equal(findAssociation(person, 'pet')?.name, 'pets')
  assert.equal(findAssociation(person, 'nope'), undefined)
  assert.deepEqual(parentLinkValues(person, avery, pet).values, { personId: 1 })
  assert.throws(() => parentLinkValues(person, avery, petNote), /no association to Pet Note/)
})

test('child list fields skip hidden, heavy and back-pointing fields', () => {
  assert.deepEqual(childListFields(pet, ['personId']), ['id', 'name'])
  const sectioned: TableMetaLike = { ...pet, fields: { ...pet.fields, a: f('a'), b: f('b'), c: f('c') }, sections: [{ name: 'x', tier: 'T2', fieldNames: ['b', 'a'] }, { name: 'y', tier: 'T1', fieldNames: ['id', 'name'] }, { name: 'z', isHidden: true, fieldNames: ['c'] }] }
  assert.deepEqual(childListFields(sectioned, ['personId']), ['id', 'name', 'b', 'a'], 'section order by tier; fields only in hidden sections left out')
})

test('fetchChildren queries one page and counts all children with the same criteria', async () => {
  const calls: Array<{ url: string; body: unknown }> = []
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input)
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    const body = url.includes('/count') ? { count: 4 } : { records: [{ values: { id: 3, name: 'Louie', personId: 1 } }] }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const page = await fetchChildren({ baseUrl: 'http://h', fetch: fetchImpl, parentTable: person, parent: avery, childTable: pet, association: person.associations![0]!, limit: 1, skip: 2 })
  assert.equal(page.count, 4)
  assert.equal(page.records[0]!.values.name, 'Louie')
  assert.match(calls[0]!.url, /\/qqq\/v1\/table\/pet\/query$/)
  assert.deepEqual((calls[0]!.body as { filter: { limit: number; skip: number } }).filter.limit, 1)
  assert.match(calls[1]!.url, /\/qqq\/v1\/table\/pet\/count\?includeDistinct=false$/)
  assert.deepEqual(calls[1]!.body, { filter: { criteria: [{ fieldName: 'personId', operator: 'EQUALS', values: ['1'] }], booleanOperator: 'AND' } })
})

test('a child-list widget section binds its association (manageAssociationName, associationName, or the join name), once', () => {
  const order: TableMetaLike = { name: 'order', fields: { id: f('id') }, associations: [
    { name: 'lines', associatedTableName: 'line', join: { name: 'orderJoinLine', leftTable: 'order', rightTable: 'line', joinOns: [{ leftField: 'id', rightField: 'orderId' }] } },
    { name: 'tags', associatedTableName: 'tag', join: { name: 'orderJoinTag', leftTable: 'order', rightTable: 'tag', joinOns: [{ leftField: 'id', rightField: 'orderId' }] } },
  ] }
  assert.equal(widgetAssociation({ type: 'childRecordList', defaultValues: { joinName: 'orderJoinLine' } }, order)?.name, 'lines', 'the sample binds by join name')
  assert.equal(widgetAssociation({ type: 'childRecordList', defaultValues: { manageAssociationName: 'tags', joinName: 'orderJoinLine' } }, order)?.name, 'tags', 'a managed association wins (Next)')
  assert.equal(widgetAssociation({ type: 'rowBuilder', defaultValues: { associationName: 'lines' } }, order)?.name, 'lines')
  assert.equal(widgetAssociation({ type: 'childRecordList', defaultValues: { joinName: 'elsewhere' } }, order), undefined, 'a join of another table lists other records: a distinct widget')
  assert.equal(widgetAssociation({ type: 'statistics', defaultValues: { joinName: 'orderJoinLine' } }, order), undefined, 'only child-list widgets bind')
  assert.equal(widgetAssociation(undefined, order), undefined)
})

test('a child-list widget shows the key first, fields in section order (T1 first), not the parent key, hidden, heavy or omitted fields', () => {
  const line: TableMetaLike = {
    name: 'line', primaryKeyField: 'id',
    fields: { id: f('id'), orderId: f('orderId'), sku: f('sku'), qty: f('qty'), note: f('note', { isHeavy: true }), secret: f('secret', { isHidden: true }), createDate: f('createDate') },
    sections: [{ name: 'd', tier: 'T3', fieldNames: ['createDate'] }, { name: 'i', tier: 'T1', fieldNames: ['orderId', 'sku', 'id', 'qty', 'note', 'secret'] }],
  }
  assert.deepEqual(childWidgetColumns(line, { bindingFields: ['orderId'] }), ['id', 'sku', 'qty', 'createDate'])
  assert.deepEqual(childWidgetColumns(line, { widget: { defaultValues: { omitFieldNames: ['qty'] } } }), ['id', 'orderId', 'sku', 'createDate'])
  assert.deepEqual(childWidgetColumns(line, { widget: { defaultValues: { onlyIncludeFieldNames: 'sku,id' } } }), ['id', 'sku'])
  assert.deepEqual(childWidgetColumns({ name: 'x', primaryKeyField: 'id', fields: { a: f('a'), id: f('id') } }), ['id', 'a'], 'no sections: every field, key first')
})
