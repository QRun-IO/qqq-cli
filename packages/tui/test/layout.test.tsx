/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import { expect, test } from 'bun:test'
import { testRender } from '@opentui/react/test-utils'
import { Panel } from '../src/screens/list'

test('rows never vanish when a panel overflows: overlong lines are clipped, extra rows cut at the bottom', async () => {
  const rows = ['row-a', 'row-b', 'row-c', 'row-d', `${'x'.repeat(40)} overlong`, 'row-f', 'row-g']
  const s = await testRender(<Panel title="T" width={20} height={6} focused={false}>{rows.map((r, i) => <text key={i} flexShrink={0} wrapMode="none">{r}</text>)}</Panel>, { width: 20, height: 8 })
  try {
    await s.renderOnce()
    const frame = s.captureCharFrame()
    for (const r of ['row-a', 'row-b', 'row-c', 'row-d']) expect(frame).toContain(r)
    expect(frame.split('\n')[5]).toMatch(/^└─+┘/)
  } finally {
    s.renderer.destroy()
  }
})
