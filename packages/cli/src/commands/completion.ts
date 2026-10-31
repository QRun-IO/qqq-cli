/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Shell completion. The shell scripts are static and small; they call the hidden `qqq __complete`
 * with the words typed so far, which answers from the command tree and the cached metadata
 * (tables, processes, widgets, fields, operation ids) without touching the network.
 */

import type { Command } from 'commander'
import { OPERATIONS, clearMetaDataCache, getMetaData, readCachedMetaData, readCachedTableMeta } from '@qrun-io/qqq-core'
import { UsageError, type Context } from '../context.js'
import { authenticatedFetch, target } from '../session.js'

const SCRIPTS: Record<string, string> = {
  bash: `# qqq bash completion: eval "$(qqq completion bash)"
_qqq_complete() {
  local IFS=$'\\n'
  COMPREPLY=( $(qqq __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD}" 2>/dev/null) )
}
complete -o default -F _qqq_complete qqq
`,
  zsh: `# qqq zsh completion: eval "$(qqq completion zsh)"
_qqq() {
  local -a candidates
  candidates=("\${(@f)$(qqq __complete -- "\${words[@]:1:$CURRENT-1}" 2>/dev/null)}")
  compadd -- "\${candidates[@]}"
}
compdef _qqq qqq
`,
  fish: `# qqq fish completion: qqq completion fish | source
complete -c qqq -f -a '(qqq __complete -- (commandline -opc)[2..-1] (commandline -ct))'
`,
  pwsh: `# qqq PowerShell completion: qqq completion pwsh | Out-String | Invoke-Expression
Register-ArgumentCompleter -Native -CommandName qqq -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)
  $words = $commandAst.CommandElements | Select-Object -Skip 1 | ForEach-Object { $_.ToString() }
  if ($wordToComplete -eq '') { $words += '' }
  qqq __complete -- @words 2>$null | ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`,
}

/** The subcommand a word list points at, and the words after it. */
function locate(root: Command, words: string[]): { command: Command; rest: string[] } {
  let command = root
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (w.startsWith('-')) {
      const option = command.options.find((o) => o.long === w || o.short === w) ?? root.options.find((o) => o.long === w || o.short === w)
      i += option && option.required ? 2 : 1
      continue
    }
    const next = command.commands.find((c) => c.name() === w || c.aliases().includes(w))
    if (!next) break
    command = next
    i++
  }
  return { command, rest: words.slice(i) }
}

export function registerCompletion(program: Command, ctx: () => Context): void {
  program.command('completion <shell>')
    .description('Print a completion script for bash, zsh, fish or pwsh (PowerShell).')
    .action((shell: string) => {
      const script = SCRIPTS[shell]
      if (!script) throw new UsageError(`Unknown shell "${shell}"; use bash, zsh, fish or pwsh.`)
      process.stdout.write(script)
    })

  const cache = program.command('cache').description('The local metadata cache (what completion and listings read).')
  cache.command('show').description('Where the cache is and how old it is.').action(() => {
    const c = ctx()
    const entry = readCachedMetaData(c.server)
    c.print({ data: entry ? { server: c.server, fetchedAt: entry.fetchedAt, apiVersion: entry.apiVersion, metaDataGeneration: entry.metaDataGeneration, tables: Object.keys(entry.metaData.tables ?? {}).length, processes: Object.keys(entry.metaData.processes ?? {}).length } : { server: c.server, cached: false } })
  })
  cache.command('clear').description('Forget the cached metadata (of this server, or --all).').option('--all', 'every server').action((options: { all?: boolean }) => {
    const c = ctx()
    clearMetaDataCache(options.all ? undefined : c.server)
    c.note(options.all ? 'Cleared the metadata cache.' : `Cleared the metadata cache of ${c.server}.`)
  })
  cache.command('refresh').description('Fetch the metadata again now.').action(async () => {
    const c = ctx()
    const m = await getMetaData(c.server, authenticatedFetch(c.target), { refresh: true })
    c.note(`Cached ${Object.keys(m.tables ?? {}).length} tables, ${Object.keys(m.processes ?? {}).length} processes, ${Object.keys(m.widgets ?? {}).length} widgets for ${c.server}.`)
  })

  program.command('__complete', { hidden: true })
    .description('Completion candidates for the words typed so far.')
    .allowUnknownOption()
    .allowExcessArguments()
    .argument('[words...]')
    .action(async (wordsIn: string[]) => {
      const words = wordsIn.filter((w) => w !== '--')
      const current = words.length ? words[words.length - 1]! : ''
      const before = words.slice(0, -1)
      const { command, rest } = locate(program, before)
      const out = new Set<string>()
      const add = (items: Iterable<string>) => { for (const item of items) if (item.startsWith(current)) out.add(item) }
      const previous = before[before.length - 1] ?? ''
      const meta = () => {
        try {
          return readCachedMetaData(target().server)?.metaData
        } catch {
          return undefined
        }
      }
      const tableInWords = () => rest.find((w) => !w.startsWith('-')) ?? before.find((w, i) => i > 0 && !w.startsWith('-') && (before[i - 1] === 'query' || before[i - 1] === 'get' || before[i - 1] === 'create' || before[i - 1] === 'update' || before[i - 1] === 'count' || before[i - 1] === 'describe' || before[i - 1] === 'delete' || before[i - 1] === 'export'))
      if (current.startsWith('-')) {
        add(command.options.flatMap((o) => [o.long, o.short].filter(Boolean) as string[]))
        add(program.options.flatMap((o) => [o.long].filter(Boolean) as string[]))
      } else if (['--where', '-w', '--order', '-o', '--fields', '-f', '--set', '-s', '--values', '-v'].includes(previous) || (previous === '-f' && command.name() === 'query')) {
        const table = tableInWords()
        let fields: string[] = []
        try {
          if (table) fields = Object.keys((readCachedTableMeta<{ fields?: Record<string, unknown> }>(target().server, table)?.fields) ?? {})
        } catch {
          fields = []
        }
        add(previous === '-o' || previous === '--order' ? fields.flatMap((f) => [f, `-${f}`]) : fields)
      } else if (previous === '--output' || previous === '-O') {
        add(['json', 'table', 'text', 'csv', 'yaml'])
      } else if (command.name() === 'api' && rest.length === 0) {
        add(OPERATIONS.map((o) => o.id))
      } else if (command.commands.length && rest.length === 0) {
        add(command.commands.filter((c) => !(c as unknown as { _hidden?: boolean })._hidden).map((c) => c.name()))
      } else {
        const m = meta()
        const parent = command.parent?.name()
        const verb = command.name()
        if (parent === 'table' || ['query', 'get'].includes(verb)) add(Object.keys(m?.tables ?? {}))
        else if (parent === 'process' || verb === 'run') add(Object.keys(m?.processes ?? {}))
        else if (parent === 'widget') add(Object.keys(m?.widgets ?? {}))
        else if (parent === 'report') add(Object.keys(m?.reports ?? {}))
        else if (verb === 'tables' && previous === '--app') add(Object.keys(m?.apps ?? {}))
        else if (verb === 'completion') add(['bash', 'zsh', 'fish', 'pwsh'])
      }
      process.stdout.write([...out].sort().join('\n') + (out.size ? '\n' : ''))
    })
}
