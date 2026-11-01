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
import { assistantContextFor, describeAssistantConfig, type AssistantAnswer } from '@qrun-io/qqq-core'
import { io, type Context, UsageError } from '../context.js'
import { positiveInt, type Json } from './shared.js'

/** The answer's markdown as plain terminal text (bold and code markers dropped). */
export function plainAnswer(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/^#{1,6}\s+/gm, '')
}

/** Rows for the links table: kind, label, table, id, the app path and the qqq command that opens it. */
export function linkRows(answer: AssistantAnswer): Json[] {
  return answer.links.map((link) => ({
    kind: link.kind,
    label: link.label,
    table: link.tableName ?? '',
    id: link.recordId ?? '',
    href: link.href,
    open: link.kind === 'record' ? `qqq table get ${link.tableName} ${link.recordId}` : link.kind === 'table' ? `qqq table query ${link.tableName}` : '',
  }))
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
      let streamed = false
      const answer = await assistant.ask(question, {
        conversationId,
        context: assistantContextFor({ tableName: options.table, recordId: options.record }),
        onEvent: (event) => {
          if (!human) return
          if (event.type === 'text.delta' && typeof event.text === 'string') {
            io.out(plainAnswer(event.text))
            streamed = true
          } else if (event.type === 'tool.start' && typeof event.summary === 'string' && event.summary) {
            c.note(`… ${event.summary}`)
          }
        },
      })
      if (answer.status === 'ERROR') {
        if (streamed) io.out('\n')
        throw new UiApiError(502, { code: answer.error?.code ?? 'INTERNAL', message: answer.error?.message ?? 'The assistant could not answer.' })
      }
      if (!human) {
        c.print({ data: answer })
        return
      }
      if (!streamed) io.out(plainAnswer(answer.text))
      io.out('\n')
      for (const notice of answer.notices) c.note(`${notice.level}: ${notice.text}`)
      if (answer.numbers.length) {
        io.out('\n')
        c.print({ data: answer.numbers, rows: answer.numbers.map((n) => ({ number: n.label, value: n.value, href: n.href ?? '' })), columns: ['number', 'value', 'href'] })
      }
      if (answer.links.length) {
        io.out('\n')
        c.print({ data: answer.links, rows: linkRows(answer), columns: ['kind', 'label', 'table', 'id', 'open'] })
      }
      const seconds = answer.elapsedMs === undefined ? '' : `${(answer.elapsedMs / 1000).toFixed(1)} s, `
      c.note(`(${seconds}conversation ${answer.conversationId}; continue with: qqq assistant ask -c ${answer.conversationId} "...")`)
    })
}
