/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The assistant panel's conversation as lines for a width: each question, the answer (wrapped,
 * markdown markers dropped), its numbers and its links. Links are numbered across the whole
 * conversation so the panel can move a cursor over them; every line fits the width it was built for.
 */

import type { AssistantAnswer, AssistantPageContext } from '@qrun-io/qqq-core'
import { cellWidth } from '../util/text'

/** One question and its answer (streaming until `answer.status` leaves RUNNING). */
export interface Exchange {
  question: string
  /** "Person #3" when the question was asked from a record or grid. */
  contextLabel?: string
  context?: AssistantPageContext
  answer?: AssistantAnswer
  /** What the assistant is doing while nothing is written yet (the last tool summary). */
  activity?: string
  /** A refusal or failure, shown in red. */
  error?: string
  startedAt: number
}

export type LineRole = 'question' | 'context' | 'text' | 'number' | 'link' | 'activity' | 'error' | 'meta' | 'blank'

export interface ChatLine {
  text: string
  role: LineRole
  /** Index into {@link chatLinks} for link lines. */
  link?: number
}

/** The answer's markdown as plain text (bold, code and heading markers dropped). */
export function plainText(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^#{1,6}\s+/gm, '')
}

/** Word-wraps text to a width in cells (long words are cut); keeps blank lines. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width)
  const out: string[] = []
  for (const paragraph of text.replace(/\r/g, '').split('\n')) {
    if (!paragraph.trim()) {
      out.push('')
      continue
    }
    let line = ''
    for (const word of paragraph.split(/(\s+)/)) {
      if (!word) continue
      const candidate = line + word
      if (cellWidth(candidate) <= w) {
        line = candidate
        continue
      }
      if (line.trim()) out.push(line.trimEnd())
      line = /^\s+$/.test(word) ? '' : word
      while (cellWidth(line) > w) {
        let cut = ''
        for (const ch of line) {
          if (cellWidth(cut + ch) > w) break
          cut += ch
        }
        out.push(cut)
        line = line.slice(cut.length)
      }
    }
    if (line.trim()) out.push(line.trimEnd())
  }
  return out
}

/** Every link of the conversation, in order (what the link cursor moves over). */
export function chatLinks(exchanges: Exchange[]): Array<{ label: string; href: string }> {
  return exchanges.flatMap((e) => e.answer?.links ?? [])
}

/** The conversation as lines for a width (the panel's inner width). */
export function chatLines(exchanges: Exchange[], width: number, now = Date.now()): ChatLine[] {
  const lines: ChatLine[] = []
  let linkIndex = 0
  const add = (text: string, role: LineRole, prefix = '', link?: number) => {
    const rest = ' '.repeat(cellWidth(prefix))
    wrap(text, width - cellWidth(prefix)).forEach((l, i) => lines.push({ text: (i === 0 ? prefix : rest) + l, role, ...(link !== undefined ? { link } : {}) }))
  }
  exchanges.forEach((e, n) => {
    if (n > 0) lines.push({ text: '', role: 'blank' })
    add(e.question, 'question', 'You: ')
    if (e.contextLabel) add(`on ${e.contextLabel}`, 'context', '     ')
    const answer = e.answer
    const running = !e.error && (!answer || answer.status === 'RUNNING')
    const text = plainText(answer?.text ?? '').trim()
    if (text) add(text, 'text')
    if (running && !text) add(`${e.activity ?? 'thinking'}… ${Math.max(0, Math.round((now - e.startedAt) / 1000))} s`, 'activity')
    for (const num of answer?.numbers ?? []) add(`${num.label}: ${num.value}`, 'number', '# ')
    for (const link of answer?.links ?? []) add(link.label, 'link', '→ ', linkIndex++)
    for (const notice of answer?.notices ?? []) add(notice.text, notice.level === 'error' ? 'error' : 'meta', `${notice.level}: `)
    if (e.error) add(e.error, 'error')
    else if (answer?.error) add(`${answer.error.message} (${answer.error.code})`, 'error')
    if (answer && !running && answer.elapsedMs !== undefined) {
      const tokens = answer.usage?.inputTokens !== undefined ? ` · ${answer.usage.inputTokens} in / ${answer.usage.outputTokens ?? 0} out tokens` : ''
      add(`${(answer.elapsedMs / 1000).toFixed(1)} s${tokens}${answer.status === 'CANCELLED' ? ' · stopped' : ''}`, 'meta')
    }
  })
  return lines
}

/** "Person #3" / "Person (filtered)" / "Person" for a page context and the table's label. */
export function contextLabel(context: AssistantPageContext | undefined, tableLabel?: string): string | undefined {
  if (!context?.tableName) return undefined
  const label = tableLabel ?? context.tableName
  if (context.recordId !== undefined) return `${label} #${String(context.recordId)}`
  return context.filter ? `${label} (filtered)` : label
}
