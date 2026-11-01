/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The collaboration views of a record: comments (list, add, reply), attachments (list, download
 * through the file navigator, upload, delete), the timeline, tasks (list, add, done), plus
 * follow/unfollow and the share preview (who could read the record before it is shared).
 */

import { displayDateTime, formatSize, saveDownload, type PersonEntry } from '@qrun-io/qqq-core'
import { commentLines, noteUploadFailure, uploadBlocked, type RecordCollaboration } from '../collab'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { ChoiceOverlay, PromptOverlay } from '../overlays/basic'
import { openFile, saveFile } from '../overlays/files-helpers'
import type { AppStore } from '../store'
import { theme } from '../theme'
import type { MenuEntry } from '../types'
import type { Row } from './list'
import { LinesScreen } from './lines'

export type CollabView = 'comments' | 'attachments' | 'timeline' | 'tasks'

const TITLES: Record<CollabView, string> = { comments: 'Comments', attachments: 'Attachments', timeline: 'Timeline', tasks: 'Tasks' }
const when = (iso: string | undefined | null) => (iso ? displayDateTime(iso) : '')

/** A record's comments, attachments, timeline or tasks; `n` adds (a comment, an upload, a task). */
export class CollabScreen extends LinesScreen {
  readonly kind = 'collab'

  constructor(store: AppStore, readonly collab: RecordCollaboration, readonly view: CollabView, readonly recordLabel: string, private changed?: () => void) {
    super(store, `${TITLES[view]} · ${store.meta?.tables?.[collab.table]?.label ?? collab.table} ${recordLabel}`)
    this.refresh()
  }

  refresh(): void {
    const t = theme()
    const c = this.collab
    this.start(async () => {
      const rows: Row[] = []
      if (this.view === 'comments') {
        const threads = await c.comments()
        rows.push({ text: `${threads.length} thread${threads.length === 1 ? '' : 's'}, latest first · n adds a comment · Enter replies`, fg: t.dim })
        rows.push({ text: `  + Add a comment`, fg: t.acc, key: 'add', action: () => this.add() })
        for (const th of threads) {
          rows.push({ text: '' })
          commentLines(th, when).forEach((line, i) => rows.push(i === 0 ? { text: line, fg: t.fg, bold: true, key: `c:${th.id}`, action: () => this.reply(th.id, th.authorDisplayName ?? '') } : { text: line, fg: t.dim }))
        }
      } else if (this.view === 'attachments') {
        const items = await c.attachments()
        rows.push({ text: `${items.length} attachment${items.length === 1 ? '' : 's'}, newest first · Enter downloads · n uploads`, fg: t.dim })
        const blocked = uploadBlocked(this.store.client!.server, this.store.extensions.all().map((e) => e.name))
        rows.push(blocked ? { text: `  + Upload a file (${blocked})`, fg: t.dim, key: 'add', action: () => this.store.flash(blocked) } : { text: `  + Upload a file`, fg: t.acc, key: 'add', action: () => this.add() })
        for (const a of items) {
          rows.push({ text: `  ${a.fileName ?? `attachment ${a.id}`}   ${a.sizeBytes !== undefined ? formatSize(a.sizeBytes) : ''}   ${a.createdByDisplayName ?? ''} · ${when(a.createDate)}${a.description ? ` · ${a.description}` : ''}`, key: `a:${a.id}`, action: () => this.attachmentActions(a.id!, a.fileName ?? `attachment-${a.id}`, Boolean(a.canDelete)) })
        }
      } else if (this.view === 'timeline') {
        const items = await c.timeline()
        rows.push({ text: `${items.length} event${items.length === 1 ? '' : 's'}, newest first (changes, comments, activity)`, fg: t.dim })
        for (const e of items) {
          rows.push({ text: `${when(e.at)}  ${e.actorName ?? ''}  ${e.summary ?? e.kind ?? ''}`, fg: t.acc, key: `e:${e.kind}:${e.id}`, action: () => undefined })
          for (const d of e.details ?? []) rows.push({ text: `    ${d.message ?? `${d.fieldName}: ${String(d.oldValue ?? '')} → ${String(d.newValue ?? '')}`}`, fg: t.dim })
        }
      } else {
        const items = await c.tasks(true)
        rows.push({ text: `${items.length} task${items.length === 1 ? '' : 's'} · n adds a task · Enter marks done or reopens`, fg: t.dim })
        rows.push({ text: `  + Add a task`, fg: t.acc, key: 'add', action: () => this.add() })
        for (const k of items) {
          const done = /^(DONE|COMPLETE|COMPLETED|CLOSED)$/i.test(k.status ?? '')
          rows.push({ text: `  ${done ? '[x]' : '[ ]'} ${k.title ?? `task ${k.id}`}${k.dueAt ? ` · due ${when(k.dueAt)}` : ''}${k.assigneeDisplayName ? ` · ${k.assigneeDisplayName}` : ''} · ${k.status ?? ''}`, fg: done ? t.dim : t.fg, key: `k:${k.id}`, action: () => this.toggleTask(k.id!, done) })
        }
      }
      return rows
    })
  }

  private done(note: string): void {
    this.store.flash(note)
    this.changed?.()
    this.refresh()
  }

  /** n: add a comment, upload a file or add a task. */
  add(): void {
    const s = this.store
    const c = this.collab
    if (this.view === 'comments') return s.open(new PromptOverlay(s, 'Add a comment', 'Enter posts it on the record; followers are notified.', (body) => { if (body.trim()) s.run(c.addComment(body.trim()), () => this.done('comment added')) }))
    if (this.view === 'attachments') return uploadAttachment(s, c, () => this.done('uploaded'))
    if (this.view === 'tasks') return s.open(new PromptOverlay(s, 'Add a task', 'The task title; it is assigned to no one and has no due date.', (title) => { if (title.trim()) s.run(c.addTask(title.trim()), () => this.done('task added')) }))
  }

  reply(id: number | undefined, author: string): void {
    if (id === undefined) return
    const s = this.store
    s.open(new PromptOverlay(s, `Reply to ${author || 'the comment'}`, 'Enter posts the reply.', (body) => { if (body.trim()) s.run(this.collab.addComment(body.trim(), id), () => this.done('reply added')) }))
  }

  attachmentActions(id: number, fileName: string, canDelete: boolean): void {
    const s = this.store
    type A = 'download' | 'delete'
    s.open(new ChoiceOverlay<A>(s, fileName, [
      { label: 'Download…', value: 'download', detail: 'choose where to save it' },
      { label: 'Delete', value: 'delete', disabled: canDelete ? undefined : 'you may not delete this attachment' },
    ], (a) => {
      if (a === 'download') return downloadAttachment(s, this.collab, id, fileName)
      s.confirm(`Delete the attachment ${fileName}?`, () => s.run(this.collab.deleteAttachment(id), () => this.done('attachment deleted')))
    }))
  }

  toggleTask(id: number, done: boolean): void {
    this.store.run(this.collab.setTaskStatus(id, done ? 'OPEN' : 'DONE'), () => this.done(done ? 'task reopened' : 'task done'))
  }

  onKey(key: Key): boolean {
    if (this.store.singleKeys && charOf(key) === 'n' && this.view !== 'timeline') {
      this.add()
      return true
    }
    return super.onKey(key)
  }

  menu(): MenuEntry[] {
    const add: Record<CollabView, string | undefined> = { comments: 'Add a comment', attachments: 'Upload a file', timeline: undefined, tasks: 'Add a task' }
    return [
      ...(add[this.view] ? [{ section: 'Context' as const, label: `${add[this.view]}…`, key: 'n', run: () => this.add() }] : []),
      { section: 'Context', label: 'Refresh', key: 'F5', run: () => this.refresh() },
    ]
  }

  hint(): string {
    return this.view === 'timeline' ? 'PgUp PgDn page · F5 refresh · Esc back' : 'Enter opens · n adds · PgUp PgDn page · F5 refresh · Esc back'
  }
}

/** Downloads an attachment to a place chosen in the file navigator (or the download folder when downloads are silent). */
export function downloadAttachment(store: AppStore, collab: RecordCollaboration, id: number, fileName: string): void {
  saveFile(store, `Save ${fileName}`, fileName, (path) => {
    store.run(collab.download(id), ({ bytes }) => store.message(`Saved ${saveDownload(path, bytes, { explicit: true })} (${formatSize(bytes.length)}).`, 'info', 'Download'))
  })
}

/** Uploads a file chosen in the file navigator as an attachment. */
export function uploadAttachment(store: AppStore, collab: RecordCollaboration, then: () => void): void {
  const server = store.client!.server
  const blocked = uploadBlocked(server, store.extensions.all().map((e) => e.name))
  if (blocked) return store.flash(blocked, 'error')
  openFile(store, 'Upload an attachment', (path) => {
    collab.upload(path).then(() => { then(); store.bump() }).catch((e) => {
      // no Object Storage QBit: one plain line, and the upload row is dimmed from now on
      const plain = noteUploadFailure(server, e)
      if (plain) store.message(plain, 'error', 'Upload')
      else store.error(e)
      store.screen?.refresh?.()
    })
  })
}

/**
 * The share preview: find people, pick them (Enter toggles, Esc ends the picking), then see which
 * of them could read the record; sending the share is offered after the preview.
 */
export function sharePreview(store: AppStore, collab: RecordCollaboration, recordLabel: string): void {
  const picked = new Map<string, string>()
  const find = () => store.open(new PromptOverlay(store, `Share ${recordLabel} with`, 'A name or email to find people (empty lists everyone you may share with).', (q) => {
    store.run(collab.people(q.trim()), (people) => {
      if (people.length) return pick(people)
      // an empty people directory (or no match): user ids can still be previewed
      store.open(new PromptOverlay(store, 'User ids to preview', `No one in the people directory matches${q.trim() ? ` "${q.trim()}"` : ''}. Type user ids, separated by commas.`, (ids) => {
        for (const id of ids.split(',').map((x) => x.trim()).filter(Boolean)) picked.set(id, id)
        preview()
      }))
    })
  }))
  const pick = (people: PersonEntry[]) => {
    const choices = people.map((p) => ({ label: `${picked.has(String(p.userId)) ? '[x]' : '[ ]'} ${p.displayName ?? p.userId}`, value: String(p.userId ?? ''), detail: p.email ?? undefined }))
    store.open(new ChoiceOverlay(store, `Share ${recordLabel} · ${picked.size} picked · Enter toggles · Esc previews`, choices, (id) => {
      const person = people.find((p) => String(p.userId) === id)
      if (picked.has(id)) picked.delete(id)
      else picked.set(id, person?.displayName ?? id)
      pick(people)
    }, '', 0, () => preview()))
  }
  const preview = () => {
    if (!picked.size) return store.flash('no one picked: nothing to preview')
    const ids = [...picked.keys()]
    store.run(collab.sharePreview(ids), (recipients) => {
      const lines = recipients.map((r) => `${r.canRead ? '✓ can read  ' : '✗ cannot read'}  ${r.displayName ?? r.userId}`)
      const blocked = recipients.filter((r) => !r.canRead).length
      store.open(new ChoiceOverlay<'send' | 'cancel'>(store, `Share preview · ${recordLabel}`, [
        ...lines.map((l) => ({ label: l, value: 'cancel' as const, disabled: 'preview only' })),
        { label: `Send the share to ${ids.length} ${ids.length === 1 ? 'person' : 'people'}…`, value: 'send', detail: blocked ? `${blocked} cannot read it` : 'everyone can read it' },
        { label: 'Cancel', value: 'cancel' },
      ], (choice) => {
        if (choice !== 'send') return
        store.open(new PromptOverlay(store, 'Message (optional)', 'Sent with the share; Enter sends.', (message) => store.run(collab.share(ids, message.trim() || undefined), () => store.flash(`shared with ${[...picked.values()].join(', ')}`))))
      }, '', lines.length))
    })
  }
  find()
}

/** Follow or stop following; `then` gets the new state. */
export function toggleFollow(store: AppStore, collab: RecordCollaboration, following: boolean, then: (following: boolean) => void): void {
  store.run(collab.toggleFollow(following), (state) => {
    store.flash(state.following ? 'following: changes and comments notify you' : 'not following any more')
    then(state.following)
  })
}

