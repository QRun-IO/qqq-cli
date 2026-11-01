/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * `qqq assistant ask` and `qqq assistant config`: the first-class assistant commands, next to the
 * generated operation subcommands (`get-config`, `post-conversations-turns`, ...).
 *
 * `ask` streams the answer as the model writes it (table and text output), then prints the numbers
 * and the records and tables the answer refers to; `--json` prints the whole folded answer.
 */

import type { Command } from 'commander'
import { UiApiError } from '@qrun-io/qqq-ui-api-client'
import { answerDocument, assistantContextFor, describeAssistantConfig, linkTargetKey, markdownText, parseAppHref, parseMarkdown, type AssistantAnswer, type MdInline } from '@qrun-io/qqq-core'
import { io, type Context, UsageError } from '../context.js'
import { positiveInt, type Json } from './shared.js'

/** The answer's markdown as plain terminal text (bold and code markers dropped). */
export function plainAnswer(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^#{1,6}\s+/gm, '')
}

/** The qqq command that opens a link's target (`qqq table get t 4`, `qqq table query t --filter-json '…'`), or '' for other pages. */
export function linkCommand(href: string): string {
  const target = parseAppHref(href)
  if (!target?.tableName) return ''
  const key = linkTargetKey(href)
  const record = /^record:[^:]+:(.*)$/.exec(key)
  if (record) return `qqq table get ${target.tableName} ${shellQuote(record[1]!)}`
  if (key === `table:${target.tableName}:` || !target.filter) return `qqq table query ${target.tableName}`
  return `qqq table query ${target.tableName} --filter-json ${shellQuote(JSON.stringify(target.filter))}`
}

function shellQuote(text: string): string {
  return /^[A-Za-z0-9_.:@%+=,/-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

/**
 * Renders an answer's markdown for the terminal, block by block (so it can print while the model
 * writes): entities decoded, tables as sub-tables, each link as `label (qqq table get …)` when that
 * is short, else `label [n]` with the command listed under Links (numbered once per target).
 */
export class AnswerRenderer {
  readonly footnotes: Array<{ n: number; label: string; open: string }> = []
  private readonly noted = new Map<string, number>()
  private printed = 0

  constructor(private readonly width = 100) {}

  private note(label: string, href: string): number {
    const key = linkTargetKey(href)
    let n = this.noted.get(key)
    if (n === undefined) {
      n = this.noted.size + 1
      this.noted.set(key, n)
      this.footnotes.push({ n, label, open: linkCommand(href) || href })
    }
    return n
  }

  /** Text for the blocks completed since the last call (all of them when `done`), '' when none. */
  next(text: string, done: boolean): string {
    const doc = parseMarkdown(text)
    const complete = done ? doc.blocks.length : Math.max(0, doc.blocks.length - 1)
    const out: string[] = []
    for (; this.printed < complete; this.printed++) {
      const block = doc.blocks[this.printed]!
      const inTable = block.kind === 'table'
      out.push(markdownText({ blocks: [block], links: doc.links }, this.width, (part: MdInline) => {
        const open = linkCommand(part.href ?? '')
        if (!inTable && open && !open.includes('--filter-json') && open.length <= 48) return `${part.text} (${open})`
        return `${part.text} [${this.note(part.text, part.href ?? '')}]`
      }))
    }
    return out.join('\n\n')
  }

  /** Numbers the answer's other links (tool results) the text did not show, once per target. */
  extra(answer: { text: string; links: Array<{ label: string; href: string }> }): void {
    for (const link of answerDocument(answer).extraLinks) this.note(link.label, link.href)
  }
}

/** The whole answer rendered at once (tests, and output that is not streamed). */
export function renderAnswer(answer: { text: string; links: Array<{ label: string; href: string }> }, width = 100): { text: string; links: Array<{ n: number; label: string; open: string }> } {
  const renderer = new AnswerRenderer(width)
  const text = renderer.next(answer.text, true)
  renderer.extra(answer)
  return { text, links: renderer.footnotes }
}

export function registerAssistant(noun: Command, ctx: () => Context): void {
  noun.command('config')
    .description('Whether the assistant answers on this server, with which model, or why not (reason and what to configure).')
    .action(async () => {
      const c = ctx()
      const view = await (await c.assistant()).config()
      const { raw: _raw, ...data } = view
      const rows: Json[] = [
        { setting: 'status', value: describeAssistantConfig(view) },
        ...(view.model ? [{ setting: 'model', value: view.model }] : []),
        ...(view.displayName ? [{ setting: 'name', value: view.displayName }] : []),
        ...(view.shortcut ? [{ setting: 'web shortcut', value: view.shortcut }] : []),
        ...(view.limits ? Object.entries(view.limits).map(([k, v]) => ({ setting: k, value: Array.isArray(v) ? v.join(', ') : String(v) })) : []),
        ...view.starterPrompts.map((p, i) => ({ setting: i === 0 ? 'try asking' : '', value: p })),
      ]
      c.print({ data, rows, columns: ['setting', 'value'] })
    })

  noun.command('ask <question...>')
    .description('Ask the assistant (read-only, with your permissions). Streams the answer, then prints its numbers and the records and tables it refers to.')
    .option('-t, --table <table>', 'ask about a table: sent as the page context, as the web UI does')
    .option('-r, --record <id>', 'with --table: ask about this record')
    .option('-c, --conversation <id>', 'continue a conversation (the id is printed after each answer)')
    .addHelpText('after', '\nExamples:\n  qqq assistant ask "how many customers are there"\n  qqq assistant ask --table order --record 42 "what changed on this order?"\n  qqq assistant ask -c 3 "and how many orders?"\n  qqq assistant ask --json "top 5 customers by orders"')
    .action(async (words: string[], options: { table?: string; record?: string; conversation?: string }) => {
      const c = ctx()
      const question = words.join(' ').trim()
      if (!question) throw new UsageError('give a question')
      if (options.record && !options.table) throw new UsageError('--record needs --table')
      const conversationId = options.conversation ? positiveInt(options.conversation, '--conversation') : undefined
      const assistant = await c.assistant()
      const human = c.format === 'table' || c.format === 'text'
      const renderer = new AnswerRenderer(Math.max(40, io.width() ?? 100))
      let printedAny = false
      const emit = (text: string) => {
        if (!text) return
        io.out(`${printedAny ? '\n\n' : ''}${text}`)
        printedAny = true
      }
      const answer = await assistant.ask(question, {
        conversationId,
        context: assistantContextFor({ tableName: options.table, recordId: options.record }),
        onEvent: (event, partial) => {
          if (!human) return
          // whole blocks as the model completes them, rendered (a table prints once it is complete)
          if (event.type === 'text.delta') emit(renderer.next(partial.text, false))
          else if (event.type === 'tool.start' && typeof event.summary === 'string' && event.summary) c.note(`… ${event.summary}`)
        },
      })
      if (answer.status === 'ERROR') {
        if (printedAny) io.out('\n')
        throw new UiApiError(502, { code: answer.error?.code ?? 'INTERNAL', message: answer.error?.message ?? 'The assistant could not answer.' })
      }
      if (!human) {
        c.print({ data: answer })
        return
      }
      emit(renderer.next(answer.text, true))
      io.out('\n')
      for (const notice of answer.notices) c.note(`${notice.level}: ${notice.text}`)
      if (answer.numbers.length) {
        io.out('\n')
        c.print({ data: answer.numbers, rows: answer.numbers.map((n) => ({ number: n.label, value: n.value })), columns: ['number', 'value'] })
      }
      renderer.extra(answer)
      if (renderer.footnotes.length) {
        io.out('\nLinks\n')
        c.print({ data: renderer.footnotes, rows: renderer.footnotes.map((f) => ({ n: `[${f.n}]`, label: f.label, open: f.open })), columns: ['n', 'label', 'open'] })
      }
      const seconds = answer.elapsedMs === undefined ? '' : `${(answer.elapsedMs / 1000).toFixed(1)} s, `
      c.note(`(${seconds}conversation ${answer.conversationId}; continue with: qqq assistant ask -c ${answer.conversationId} "...")`)
    })
}
