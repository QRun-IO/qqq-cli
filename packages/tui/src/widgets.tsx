/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Draws the kernel's widget render model (RenderBlock) as styled terminal lines: stat boxes, bar
 * charts in block characters, sparklines for lines, percentage bars for pies, aligned tables,
 * steppers, alerts. New widget types are handled once in the kernel; this only draws blocks.
 */

import type { RenderBlock } from '@qrun-io/qqq-core'
import { wrap } from './overlays/basic'
import { structuredLines } from './structured'
import { glyphs, theme } from './theme'
import { pad, padLeft, trunc } from './util/text'

export interface StyledLine {
  text: string
  fg?: string
  bg?: string
  bold?: boolean
  /** A link the line opens on Enter (a web path, `esb:destination`, `:command`), read by links.ts. */
  href?: string
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(n)
}

/**
 * Aligned table lines that fit a width (columns shrink from the widest). `hrefs` gives a row its
 * link. A table whose headers are all empty is a layout of aligned columns (no header, no rule):
 * the last column takes the remaining width and wraps under itself.
 */
export function tableLines(headers: string[], rows: string[][], width: number, hrefs: Array<string | undefined> = []): StyledLine[] {
  const t = theme()
  if (!headers.length) return []
  const headerless = headers.every((h) => !h)
  const last = headers.length - 1
  const widths = headers.map((h, i) => Math.min(headerless && i === last ? 1000 : 40, Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length))))
  const total = () => widths.reduce((a, b) => a + b + 2, 0) - 2
  if (headerless && last > 0) {
    // the leading columns keep their width; the last one gets what is left
    widths[last] = Math.max(10, width - widths.slice(0, last).reduce((a, b) => a + b + 2, 0))
    while (total() > width && Math.max(...widths.slice(0, last)) > 4) widths[widths.indexOf(Math.max(...widths.slice(0, last)))]!--
    const lead = widths.slice(0, last).reduce((a, b) => a + b + 2, 0)
    const out: StyledLine[] = []
    rows.forEach((r, k) => {
      const wrapped = wrap(r[last] ?? '', widths[last]!)
      wrapped.forEach((part, j) => {
        const leading = j === 0 ? r.slice(0, last).map((c, i) => pad(c, widths[i]!)).join('  ') + '  ' : ' '.repeat(lead)
        out.push({ text: leading + part, ...(hrefs[k] ? { href: hrefs[k] } : {}) })
      })
    })
    return out
  }
  while (total() > width && Math.max(...widths) > 4) widths[widths.indexOf(Math.max(...widths))]!--
  const line = (cells: string[]) => cells.map((c, i) => pad(c, widths[i]!)).join('  ')
  return [
    { text: line(headers), fg: t.acc, bold: true },
    { text: widths.map((w) => glyphs().rule.repeat(w)).join('  '), fg: t.dim },
    ...rows.map((r, k) => ({ text: line(r), ...(hrefs[k] ? { href: hrefs[k] } : {}) })),
  ]
}

/** Turns blocks into lines for a width. */
export function blockLines(blocks: RenderBlock[], width: number): StyledLine[] {
  const t = theme()
  const g = glyphs()
  const out: StyledLine[] = []
  for (const b of blocks) {
    switch (b.kind) {
      case 'heading':
        out.push({ text: trunc(b.text, width), fg: t.acc, bold: true })
        if (b.sub) out.push(...wrap(b.sub, width).map((text) => ({ text, fg: t.dim })))
        break
      case 'text':
        out.push(...wrap(b.text, width).map((text) => ({ text })))
        break
      case 'stat': {
        const delta = b.delta ? `  ${b.delta.amount >= 0 ? '+' : ''}${b.delta.amount}%${b.delta.label ? ` ${b.delta.label}` : ''}` : ''
        // a statistic that links somewhere shows its label and count; Enter opens the link
        const href = (b as { href?: string }).href ?? (/^<(.+)>$/.exec(b.context ?? '')?.[1])
        const context = href ? '' : b.context
        out.push({ text: trunc(`${b.label ? `${b.label}: ` : ''}${b.value}${context ? `  ${context}` : ''}`, width), fg: t.fg, bold: true, ...(href ? { href } : {}) })
        if (delta) out.push({ text: trunc(delta.trim(), width), fg: b.delta?.good === true ? t.ok : b.delta?.good === false ? t.err : t.dim })
        break
      }
      case 'table':
        out.push(...tableLines(b.headers, b.rows.map((r) => b.columns.map((c) => String(r[c] ?? ''))), width, b.rows.map((r) => (typeof r.__href === 'string' ? r.__href : undefined))))
        if (!b.rows.length) out.push({ text: '(no rows)', fg: t.dim })
        break
      case 'series': {
        const labelWidth = Math.min(18, Math.max(4, ...b.labels.map((l) => l.length)))
        if (b.chart === 'line' && b.datasets.length) {
          for (const d of b.datasets) {
            const max = Math.max(...d.data, 0)
            const min = Math.min(...d.data, 0)
            const spark = d.data.map((n) => g.spark[Math.round(((n - min) / ((max - min) || 1)) * (g.spark.length - 1))]).join('')
            out.push({ text: trunc(`${pad(d.label || 'value', labelWidth)}  ${spark}  ${fmt(min)} … ${fmt(max)}`, width), fg: t.acc2 })
          }
          out.push(...tableLines(['', ...b.datasets.map((d) => d.label || 'value')], b.labels.map((l, i) => [l, ...b.datasets.map((d) => fmt(d.data[i] ?? 0))]), width))
        } else if (b.chart === 'pie' && b.datasets[0]) {
          const d = b.datasets[0]
          const sum = d.data.reduce((a, n) => a + Math.abs(n), 0) || 1
          const barWidth = Math.max(10, width - labelWidth - 14)
          b.labels.forEach((l, i) => {
            const pct = (Math.abs(d.data[i] ?? 0) / sum) * 100
            out.push({ text: `${pad(l, labelWidth)}  ${pad(g.bar.repeat(Math.round((pct / 100) * barWidth)), barWidth)} ${padLeft(pct.toFixed(1) + '%', 6)}`, fg: i % 2 ? t.acc : t.acc2 })
          })
        } else {
          const values = b.labels.map((_, i) => b.datasets.reduce((a, d) => a + (d.data[i] ?? 0), 0))
          const max = Math.max(...values.map(Math.abs), 1)
          const numWidth = Math.max(...values.map((v) => fmt(v).length), 1)
          const barWidth = Math.max(6, width - labelWidth - numWidth - 4)
          const hasNegative = values.some((v) => v < 0)
          if (hasNegative) {
            // a zero axis in the middle: negative values extend left of it, positive ones right
            const half = Math.max(3, Math.floor(barWidth / 2))
            b.labels.forEach((l, i) => {
              const v = values[i]!
              const n = Math.round((Math.abs(v) / max) * half)
              const left = v < 0 ? padLeft(g.bar.repeat(n), half) : ' '.repeat(half)
              const right = v > 0 ? pad(g.bar.repeat(n), half) : ' '.repeat(half)
              out.push({ text: `${pad(l, labelWidth)}  ${left}│${right}  ${padLeft(fmt(v), numWidth)}`, fg: v < 0 ? t.err : t.acc })
            })
            if (b.datasets.length > 1) out.push({ text: trunc(b.datasets.map((d) => d.label).join(' + '), width), fg: t.dim })
            break
          }
          b.labels.forEach((l, i) => {
            if (b.datasets.length > 1 && b.chart === 'stackedBar') {
              // one segment per dataset, alternating accents
              let line = ''
              b.datasets.forEach((d, k) => { line += (k % 2 ? '▓' : g.bar).repeat(Math.round((Math.abs(d.data[i] ?? 0) / max) * barWidth)) })
              out.push({ text: `${pad(l, labelWidth)}  ${pad(line, barWidth)}  ${padLeft(fmt(values[i]!), numWidth)}`, fg: t.acc })
            } else {
              out.push({ text: `${pad(l, labelWidth)}  ${pad(g.bar.repeat(Math.round((Math.abs(values[i]!) / max) * barWidth)), barWidth)}  ${padLeft(fmt(values[i]!), numWidth)}`, fg: t.acc })
            }
          })
          if (b.datasets.length > 1) out.push({ text: trunc(b.datasets.map((d, k) => `${k % 2 ? '▓' : g.bar} ${d.label}`).join('   '), width), fg: t.dim })
        }
        break
      }
      case 'pairs': {
        const w = Math.min(28, Math.max(...b.pairs.map((p) => p.label.length), 1))
        for (const p of b.pairs) out.push({ text: trunc(`${pad(p.label, w)}  ${p.value}`, width) })
        break
      }
      case 'steps':
        for (const s of b.steps) out.push({ text: trunc(`${s.state === 'done' ? g.check : s.state === 'active' ? g.pointer + '  ' : g.uncheck} ${s.label}`, width), fg: s.state === 'active' ? t.acc2 : s.state === 'done' ? t.ok : t.dim })
        break
      case 'alert':
        out.push(...wrap(`[${b.level.toUpperCase()}] ${b.text}`, width).map((text) => ({ text, fg: b.level === 'error' ? t.err : b.level === 'warning' ? t.warn : b.level === 'success' ? t.ok : t.acc })))
        break
      case 'link':
        out.push({ text: trunc(`${g.link} ${b.label}`, width), fg: t.acc, href: b.href })
        break
      case 'rule':
        out.push({ text: g.rule.repeat(Math.min(width, 60)), fg: t.dim })
        break
      case 'children':
        b.blocks.forEach((child, i) => {
          if (i) out.push({ text: '' })
          out.push(...blockLines(child, width))
        })
        break
      case 'raw':
        // a payload the kernel has no block for: its data as key/value rows and sub-tables
        if (b.data && typeof b.data === 'object' && Object.keys(b.data as object).some((k) => k !== 'type')) {
          const { type: _type, ...rest } = b.data as Record<string, unknown>
          out.push(...structuredLines(rest, width))
        } else out.push({ text: trunc(`(${b.type}: nothing to draw in a terminal)`, width), fg: t.dim })
        break
    }
  }
  return out
}

/** Draws lines as <text flexShrink={0} wrapMode="none"> rows, padded to the width. */
export function Lines({ lines, width }: { lines: StyledLine[]; width: number }) {
  return (
    <>
      {lines.map((l, i) => <text flexShrink={0} wrapMode="none" key={i} fg={l.fg ?? theme().fg} bg={l.bg}>{l.bold ? <strong>{pad(l.text, width)}</strong> : pad(l.text, width)}</text>)}
    </>
  )
}
