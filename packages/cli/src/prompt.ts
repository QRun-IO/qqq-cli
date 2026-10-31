/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Terminal prompts for filling a FormSession: one question per field, choices listed for
 * possible-value fields (contingent ones only once their dependencies are set), local validation
 * before moving on. Used by `table create -i`, `table update -i` and `process run` on a terminal.
 */

import { createInterface, type Interface } from 'node:readline/promises'
import { ChoiceError, isMissingValue, type FieldMeta, type FormSession } from '@qrun-io/qqq-core'
import { UsageError } from './context.js'

export interface PromptOptions {
  /** Ask only for these fields (default: every editable field). */
  only?: string[]
  /** Skip fields that already have a value. */
  skipSet?: boolean
  /** Where prompts are written (default stderr, so stdout stays machine-readable). */
  out?: NodeJS.WritableStream
  /** Aborting stops the prompt (the question rejects with an AbortError). */
  signal?: AbortSignal
}

/**
 * A readline interface whose Ctrl-C is passed on as SIGINT to the process (readline takes the
 * terminal into raw mode, so the key would otherwise only reach the interface).
 */
function openInterface(out: NodeJS.WritableStream): Interface {
  const rl = createInterface({ input: process.stdin, output: out })
  rl.on('SIGINT', () => {
    if (process.listenerCount('SIGINT') > 0) process.emit('SIGINT', 'SIGINT')
    else process.exit(130)
  })
  return rl
}

/** Asks one question on the terminal; returns the trimmed answer. */
export async function ask(question: string, options: { out?: NodeJS.WritableStream; signal?: AbortSignal } = {}): Promise<string> {
  if (!process.stdin.isTTY) throw new UsageError('This question needs a terminal.')
  const rl = openInterface(options.out ?? process.stderr)
  try {
    return (await rl.question(question, { signal: options.signal })).trim()
  } finally {
    rl.close()
  }
}

/** Asks for each field in turn and sets it on the session; Ctrl-D or an empty required answer re-asks. */
export async function promptForm(session: FormSession, options: PromptOptions = {}): Promise<void> {
  if (!process.stdin.isTTY) throw new UsageError('Interactive prompts need a terminal; give values with --set, --values or --input-json.')
  const out = options.out ?? process.stderr
  const rl = openInterface(out)
  try {
    for (const name of session.promptOrder(options.only)) {
      const field = session.fields[name]!
      if (field.isEditable === false || field.isHidden) continue
      if (options.skipSet && !isMissingValue(session.values[field.name])) continue
      await promptField(rl, out, session, field, options.signal)
    }
  } finally {
    rl.close()
  }
}

async function promptField(rl: Interface, out: NodeJS.WritableStream, session: FormSession, field: FieldMeta, signal?: AbortSignal): Promise<void> {
  for (;;) {
    const state = session.state(field.name)
    if (state.disabledBecause) {
      out.write(`  ${field.label}: skipped (${state.disabledBecause})\n`)
      return
    }
    const current = state.displayValue ?? (isMissingValue(state.value) ? '' : String(state.value))
    let hint = field.type === 'DATE_TIME' ? `local date time YYYY-MM-DDTHH:MM, ${session.timeZone}` : field.type.toLowerCase().replace('_', ' ')
    if (session.hasChoices(field.name)) {
      const choices = await session.options(field.name, '', 12)
      if (choices.length) {
        out.write(`  ${field.label} choices: ${choices.map((c) => `${c.label} (${String(c.id)})`).join(', ')}${choices.length === 12 ? ', … (type part of a label to narrow)' : ''}\n`)
        hint = 'label or id'
      }
    }
    const answer = (await rl.question(`${field.label}${field.isRequired ? ' *' : ''} [${hint}]${current ? ` (${current})` : ''}: `, { signal })).trim()
    if (answer === '' && current) return
    if (answer === '' && !field.isRequired) {
      await session.set(field.name, null)
      return
    }
    if (answer === '' && field.isRequired) {
      out.write('  required\n')
      continue
    }
    try {
      const change = await session.set(field.name, answer)
      const problem = session.validate([field.name])[field.name]
      if (problem) {
        out.write(`  ${field.label} ${problem}\n`)
        continue
      }
      if (change.cleared.length) out.write(`  cleared ${change.cleared.map((n) => session.fields[n]?.label ?? n).join(', ')} (depends on ${field.label})\n`)
      if (change.disabled) out.write(`  the form is disabled: ${change.disabled.message ?? ''}\n`)
      return
    } catch (error) {
      if (error instanceof ChoiceError) {
        out.write(`  ${error.message}\n`)
        continue
      }
      throw error
    }
  }
}
