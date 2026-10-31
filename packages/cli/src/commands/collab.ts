/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * First-class commands of `qqq collab` (the collaboration extension): presence, comments,
 * favorites, recents, follow, my work and people. The kernel's Collaboration module does the
 * calls; every command requires the extension first (exit 5 with the installed list).
 */

import type { Command } from 'commander'
import { COLLABORATION, type CollaborationTarget, type CommentEntry, type FavoriteEntry, type PresenceState } from '@qrun-io/qqq-core'
import type { Context } from '../context.js'
import { UsageError } from '../context.js'
import { countFooter, instantText, positiveInt, type Json } from './shared.js'
import type { DisplayOptions } from '@qrun-io/qqq-core'

const TARGET_TYPES = ['TABLE', 'APP', 'RECORD', 'PROCESS', 'REPORT', 'SAVED_VIEW']

async function collab(c: Context) {
  ;(await c.extensions()).require(COLLABORATION)
  return c.collaboration()
}

function hhmmss(date: Date): string {
  return date.toTimeString().slice(0, 8)
}

/** `2 here: Alice Morgan (viewing since 17:50:01), Bob Chen (editing email since 17:51:10)`. */
export function presenceLine(state: PresenceState): string {
  if (!state.available) return 'presence: the collaboration extension is not installed'
  if (state.error) return `presence: ${state.error}`
  const where = state.scope.pk !== undefined ? `${state.scope.table} ${state.scope.pk}` : state.scope.table
  if (!state.count) return `nobody on ${where}`
  const people = state.people.map((p) => `${p.name} (${String(p.mode).toLowerCase()}${p.fieldName ? ` ${p.fieldName}` : ''} since ${hhmmss(p.since)})`)
  return `${state.count} on ${where}: ${people.join(', ')}`
}

function favoriteRows(items: FavoriteEntry[]): Json[] {
  return items.map((f) => ({ id: f.id ?? '', type: f.targetType ?? '', name: f.targetName ?? '', record: f.recordId ?? '', label: f.label ?? '', folder: f.folder ?? '', available: f.available ?? '', href: f.href ?? '' }))
}

function commentRows(threads: CommentEntry[], display?: DisplayOptions): Json[] {
  const rows: Json[] = []
  const add = (comment: CommentEntry, depth: number) => {
    rows.push({
      id: comment.id ?? '',
      author: comment.authorDisplayName ?? comment.authorUserId ?? '',
      at: instantText(comment.createdAt ?? '', display),
      state: comment.deleted ? 'deleted' : comment.resolvedAt ? 'resolved' : '',
      body: `${depth ? '  > ' : ''}${String(comment.body ?? '').replace(/\s+/g, ' ').slice(0, 100)}`,
    })
    for (const reply of comment.replies ?? []) add(reply, depth + 1)
  }
  for (const thread of threads) add(thread, 0)
  return rows
}

/** `favorites add person 1` is a RECORD; `favorites add person` a TABLE; --type for the rest. */
function targetOf(name: string, recordId: string | undefined, type: string | undefined): CollaborationTarget {
  const targetType = (type ?? (recordId !== undefined ? 'RECORD' : 'TABLE')).toUpperCase()
  if (!TARGET_TYPES.includes(targetType)) throw new UsageError(`--type must be one of ${TARGET_TYPES.join(', ')}`)
  if (targetType === 'RECORD' && recordId === undefined) throw new UsageError('A RECORD favorite needs the record id: favorites add <table> <id>')
  return { targetType: targetType as CollaborationTarget['targetType'], targetName: name, ...(targetType === 'RECORD' ? { recordId } : {}) }
}

export function registerCollab(noun: Command, ctx: () => Context): void {
  noun.command('presence <table> [pk]')
    .description('Who is on a table or record right now. --watch joins (you appear too) and prints each change until Ctrl+C; --observe watches without joining.')
    .option('--watch', 'join and follow changes (heartbeat every 20 s, leaves on exit)')
    .option('--observe', 'follow changes without joining')
    .option('--editing [field]', 'with --watch: join as EDITING, optionally on a field')
    .action(async (table: string, pk: string | undefined, options: { watch?: boolean; observe?: boolean; editing?: string | boolean }) => {
      const c = ctx()
      const collaboration = await collab(c)
      const scope = { table, pk }
      const json = c.format === 'json' || c.format === 'yaml'
      const emit = (state: PresenceState) => {
        if (json) process.stdout.write(JSON.stringify({ ...state, people: state.people.map((p) => ({ ...p, since: p.since.toISOString() })) }) + '\n')
        else process.stdout.write(`${hhmmss(new Date())}  ${presenceLine(state)}${state.live ? '' : '  (polling)'}\n`)
      }
      if (!options.watch && !options.observe) {
        const state = await collaboration.presenceSnapshot(scope)
        const rows = state.people.map((p) => ({ name: p.name, user: p.userId, mode: p.mode, field: p.fieldName ?? '' }))
        c.print({ data: { table, pk: pk ?? null, count: state.count, viewers: rows }, rows, columns: ['name', 'user', 'mode', 'field'], footer: countFooter(state.count, 'person', [`on ${pk !== undefined ? `${table} ${pk}` : table}`, '--watch to join and follow'], 'people') })
        return
      }
      let last = ''
      const handle = await collaboration.joinPresence(scope, {
        announce: Boolean(options.watch),
        mode: options.editing ? 'EDITING' : 'VIEWING',
        fieldName: typeof options.editing === 'string' ? options.editing : undefined,
        onChange: (state) => {
          const key = JSON.stringify([state.people.map((p) => [p.userId, p.mode, p.fieldName]), state.error, state.live])
          if (key !== last) {
            last = key
            emit(state)
          }
        },
      })
      if (handle.state.error) throw new Error(`presence on ${table}${pk !== undefined ? ` ${pk}` : ''}: ${handle.state.error}`)
      if (!json) c.note(options.watch ? 'Joined; Ctrl+C leaves.' : 'Observing; Ctrl+C stops.')
      await new Promise<void>((resolve) => {
        const leave = () => {
          void handle.stop().finally(resolve)
        }
        process.once('SIGINT', leave)
        process.once('SIGTERM', leave)
      })
    })

  const comments = noun.command('comments').description("A record's comment threads.")
  comments.command('list <table> <pk>')
    .description('Comment threads by latest activity, replies under their thread.')
    .option('-l, --limit <n>', 'threads per page (1-50)', '20')
    .option('--cursor <token>', 'continue from a previous page')
    .action(async (table: string, pk: string, options: { limit: string; cursor?: string }) => {
      const c = ctx()
      const page = await (await collab(c)).comments(table, pk, { limit: positiveInt(options.limit, '--limit'), cursor: options.cursor })
      c.print({ data: page, rows: commentRows(page.threads, c.dateTimeDisplay), columns: ['id', 'author', 'at', 'state', 'body'], footer: countFooter(page.threads.length, 'thread', [page.nextCursor && `more: --cursor ${page.nextCursor}`]) })
    })
  comments.command('add <table> <pk> <body...>')
    .description('Post a comment (mentions: @[Name](user:id)); --reply-to answers a thread.')
    .option('-r, --reply-to <commentId>', 'reply to this comment')
    .option('--field <name>', 'anchor the comment on a field')
    .action(async (table: string, pk: string, body: string[], options: { replyTo?: string; field?: string }) => {
      const c = ctx()
      const comment = await (await collab(c)).addComment(table, pk, body.join(' '), { parentCommentId: options.replyTo ? Number(options.replyTo) : undefined, fieldName: options.field })
      c.print({ data: comment, rows: commentRows([comment], c.dateTimeDisplay), columns: ['id', 'author', 'at', 'state', 'body'] })
    })

  const favorites = noun.command('favorites').description('Your favorites (starred tables, records, apps, processes, reports, saved views).')
  favorites.command('list').description('Your favorites in order.').action(async () => {
    const c = ctx()
    const items = await (await collab(c)).favorites()
    c.print({ data: items, rows: favoriteRows(items), columns: ['id', 'type', 'name', 'record', 'label', 'folder', 'available'] })
  })
  favorites.command('add <name> [recordId]')
    .description('Star a record (`add person 1`), a table (`add person`), or --type APP|PROCESS|REPORT|SAVED_VIEW.')
    .option('-t, --type <type>', TARGET_TYPES.join('|'))
    .action(async (name: string, recordId: string | undefined, options: { type?: string }) => {
      const c = ctx()
      const target = targetOf(name, recordId, options.type)
      await (await collab(c)).addFavorite(target)
      c.print({ data: { starred: target }, rows: [{ starred: `${target.targetType} ${name}${target.recordId ? ` ${target.recordId}` : ''}` }], columns: ['starred'] })
    })
  favorites.command('remove <name> [recordId]')
    .description('Unstar a target (same arguments as add).')
    .option('-t, --type <type>', TARGET_TYPES.join('|'))
    .action(async (name: string, recordId: string | undefined, options: { type?: string }) => {
      const c = ctx()
      const target = targetOf(name, recordId, options.type)
      await (await collab(c)).removeFavorite(target)
      c.print({ data: { unstarred: target }, rows: [{ unstarred: `${target.targetType} ${name}${target.recordId ? ` ${target.recordId}` : ''}` }], columns: ['unstarred'] })
    })

  noun.command('recents')
    .description('What you viewed recently, newest first.')
    .option('-l, --limit <n>', 'most entries (1-50)', '20')
    .action(async (options: { limit: string }) => {
      const c = ctx()
      const items = await (await collab(c)).recents(positiveInt(options.limit, '--limit'))
      c.print({ data: items, rows: favoriteRows(items), columns: ['type', 'name', 'record', 'label', 'available'] })
    })

  const followRows = (state: { following: boolean; follow?: Json | null }) => [{ following: state.following, notifyOnChange: state.follow?.notifyOnChange ?? '', notifyOnComment: state.follow?.notifyOnComment ?? '', reason: state.follow?.reason ?? '' }]
  noun.command('follow <table> <pk>')
    .description('Follow a record (notifications on changes and comments); --status only shows the state.')
    .option('--status', 'show whether you follow it, change nothing')
    .option('--changes <on|off>', 'notify on changes')
    .option('--comments <on|off>', 'notify on comments')
    .action(async (table: string, pk: string, options: { status?: boolean; changes?: string; comments?: string }) => {
      const c = ctx()
      const collaboration = await collab(c)
      const flag = (v: string | undefined, name: string) => {
        if (v === undefined) return undefined
        if (!/^(on|off|true|false)$/i.test(v)) throw new UsageError(`${name} takes on or off`)
        return /^(on|true)$/i.test(v)
      }
      const state = options.status ? await collaboration.followState(table, pk) : await collaboration.follow(table, pk, { notifyOnChange: flag(options.changes, '--changes'), notifyOnComment: flag(options.comments, '--comments') })
      c.print({ data: state, rows: followRows(state as never), columns: ['following', 'notifyOnChange', 'notifyOnComment', 'reason'] })
    })
  noun.command('unfollow <table> <pk>')
    .description('Stop following a record.')
    .action(async (table: string, pk: string) => {
      const c = ctx()
      const state = await (await collab(c)).unfollow(table, pk)
      c.print({ data: state, rows: followRows(state as never), columns: ['following', 'notifyOnChange', 'notifyOnComment', 'reason'] })
    })

  noun.command('my-work')
    .description('Your open tasks, records assigned to you per table, and unread mentions.')
    .action(async () => {
      const c = ctx()
      const work = await (await collab(c)).myWork()
      const rows: Json[] = [
        { item: 'open tasks', value: work.openTaskCount ?? 0 },
        { item: 'unread mentions', value: work.unreadMentionCount ?? 0 },
        ...Object.entries(work.assignedRecordsByTable ?? {}).map(([table, n]) => ({ item: `assigned: ${table}`, value: n })),
        ...(work.tasks ?? []).map((t) => ({ item: `task ${t.id ?? ''}${t.dueAt ? ` due ${instantText(t.dueAt, c.dateTimeDisplay)}` : ''}`, value: `${t.title ?? ''}${t.tableName ? ` (${t.tableName} ${t.recordId ?? ''})` : ''}` })),
      ]
      c.print({ data: work, rows, columns: ['item', 'value'] })
    })

  noun.command('people [query]')
    .description('Search the people directory by name or email.')
    .option('-l, --limit <n>', 'most people (1-100)', '20')
    .action(async (query: string | undefined, options: { limit: string }) => {
      const c = ctx()
      const people = await (await collab(c)).people(query, positiveInt(options.limit, '--limit'))
      c.print({ data: people, rows: people.map((p) => ({ user: p.userId ?? '', name: p.displayName ?? '', email: p.email ?? '', lastSeen: instantText(p.lastSeenAt ?? '', c.dateTimeDisplay) })), columns: ['user', 'name', 'email', 'lastSeen'] })
    })
}
