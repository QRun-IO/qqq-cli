/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

import type { Command } from 'commander'
import { helpToText, metaHelp, processHelp, tableHelp, type HelpEntry } from '@qrun-io/qqq-core'
import { UsageError, type Context } from '../context.js'
import type { Json } from './shared.js'

/**
 * `qqq help show …`: the help content the application's metadata carries, as text. `qqq help
 * [command]` still prints the CLI's own help.
 */
export function registerHelp(program: Command, ctx: () => Context): void {
  program.helpCommand(false)
  const help = program.command('help [command...]')
    .description('Help: `qqq help <command>` for the CLI, `qqq help show …` for the application\'s help content.')
    .action((words: string[]) => {
      let command: Command = program
      for (const word of words ?? []) {
        const next = command.commands.find((x) => x.name() === word || x.aliases().includes(word))
        if (!next) throw new UsageError(`No command "${words.join(' ')}"`)
        command = next
      }
      command.outputHelp()
    })
  help.command('show <kind> [name] [field]')
    .description('Application help content: `table <table> [field]`, `process <process>`, `app <app>`, `widget <widget>`, or `instance`. Text siblings when the server sent them, else HTML stripped.')
    .option('--role <role>', 'only entries for this screen role (READ_SCREENS, EDIT_SCREEN, …) and those for every screen')
    .action(async (kind: string, name: string | undefined, field: string | undefined, options: { role?: string }) => {
      const c = ctx()
      const need = () => {
        if (!name) throw new UsageError(`help show ${kind} needs a name`)
        return name
      }
      let entries: HelpEntry[]
      let subject: string
      if (kind === 'table') {
        const meta = await c.tableMeta<Json>(need())
        try {
          entries = tableHelp(meta, { field, role: options.role })
        } catch (error) {
          throw new UsageError(error instanceof Error ? error.message : String(error))
        }
        subject = `${meta.label}${field ? ` / ${String(((meta.fields ?? {}) as Record<string, Json>)[field]?.label ?? field)}` : ''}`
      } else if (kind === 'process') {
        const meta = await c.unwrap(c.client.GET('/qqq/v1/metaData/process/{processName}', { params: { path: { processName: need() } } })) as Json
        entries = processHelp(meta, { role: options.role })
        subject = String(meta.label ?? name)
      } else if (kind === 'app' || kind === 'widget' || kind === 'instance') {
        const metaData = await c.metaData() as unknown as Json
        const meta = kind === 'instance' ? metaData : ((metaData[kind === 'app' ? 'apps' : 'widgets'] ?? {}) as Record<string, Json>)[need()]
        if (!meta) throw new UsageError(`No ${kind} named ${name}`)
        entries = metaHelp(kind, meta, { role: options.role })
        subject = String(meta.label ?? name ?? 'instance')
      } else {
        throw new UsageError('help show takes table, process, app, widget or instance')
      }
      if (c.format === 'json' || c.format === 'yaml') {
        c.print({ data: entries })
        return
      }
      process.stdout.write((entries.length ? helpToText(entries) : `${subject}: no help content in the metadata.`) + '\n')
    })
}
