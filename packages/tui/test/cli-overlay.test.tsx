/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { expect, test } from 'bun:test'
import { CliCommandOverlay } from '../src/overlays/basic'

function fakeStore(copyCli: boolean) {
  const copied: string[] = []
  const closed: unknown[] = []
  const store = {
    settings: { copyCli },
    copyText: (t: string) => { copied.push(t); return 'pbcopy' },
    closeOverlay: (o: unknown) => closed.push(o),
    bump: () => undefined,
  }
  return { store, copied, closed }
}
const key = (name: string, sequence = name) => ({ name, sequence, ctrl: false, meta: false, shift: false }) as never
const text = (o: CliCommandOverlay) => JSON.stringify(o.render(100, 30))

test('y copies, shows copied, and the next key closes', () => {
  const { store, copied, closed } = fakeStore(false)
  const o = new CliCommandOverlay(store as never, 'qqq table query petSpecies')
  expect(text(o)).toContain('y copies · Shift+drag selects text')
  o.onKey(key('y'))
  expect(copied).toEqual(['qqq table query petSpecies'])
  expect(text(o)).toContain('copied (pbcopy) · any key closes')
  expect(closed).toEqual([])
  o.onKey(key('x'))
  expect(closed).toEqual([o])
})

test('the preference copies on open', () => {
  const { store, copied } = fakeStore(true)
  const o = new CliCommandOverlay(store as never, 'qqq table query petSpecies')
  expect(copied).toEqual(['qqq table query petSpecies'])
  expect(text(o)).toContain('copied to the clipboard · any key closes')
})

test('Esc closes without copying', () => {
  const { store, copied, closed } = fakeStore(false)
  const o = new CliCommandOverlay(store as never, 'qqq table query petSpecies')
  o.onKey(key('escape'))
  expect(copied).toEqual([])
  expect(closed).toEqual([o])
})
