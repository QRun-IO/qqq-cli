/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * One record's collaboration (the collaboration extension): comments, following, attachments,
 * the timeline, tasks and share previews. Comments, following and people go through the kernel's
 * Collaboration module; the rest are the extension's operations by id, as the CLI's generated
 * `collab` subcommands call them.
 */

import { basename } from 'node:path'
import { readFileSync } from 'node:fs'
import { Collaboration, NO_OBJECT_STORAGE, missingQBitMessage, type CommentEntry, type ExtensionRegistry, type FollowState, type PersonEntry } from '@qrun-io/qqq-core'
import type { CallInput, CallResult } from '@qrun-io/qqq-core'

type J = Record<string, unknown>

export interface AttachmentEntry {
  id?: number
  fileName?: string
  contentType?: string
  sizeBytes?: number
  description?: string | null
  createDate?: string
  createdByDisplayName?: string
  canDelete?: boolean
}

export interface TimelineEntry {
  kind?: string
  id?: number
  at?: string
  actorName?: string
  summary?: string
  details?: Array<{ message?: string; fieldName?: string; oldValue?: unknown; newValue?: unknown }>
}

export interface TaskEntry {
  id?: number
  title?: string
  status?: string
  dueAt?: string | null
  notes?: string | null
  assigneeDisplayName?: string | null
  completedAt?: string | null
}

export interface ShareRecipient {
  userId?: string
  displayName?: string
  canRead?: boolean
}

/** A summary for the record header: counts and the follow state (undefined parts are still loading or failed). */
export interface CollabSummary {
  comments?: number
  attachments?: number
  tasks?: number
  following?: boolean
  /** The newest comment threads (newest first, at most two) for the collaboration panel. */
  latest?: Array<{ author: string; at?: string; text: string }>
  /** Earliest due date of the open tasks. */
  nextDue?: string
  /** Display names of the record's followers. */
  followers?: string[]
}

export interface CollabClient {
  call(id: string, input?: CallInput): Promise<CallResult>
  fetch: typeof fetch
  server: string
}

/** Servers known (this session) to have no Object Storage QBit: uploads are not offered there. */
const noStorage = new Set<string>()

/**
 * Why uploads cannot work on this server, when that is known before trying: an earlier upload
 * answered that the Object Storage QBit is missing, or GET /version lists the extensions and none
 * is object storage while it names one for storage elsewhere. Undefined when an upload may work.
 */
export function uploadBlocked(server: string, extensions: string[] = []): string | undefined {
  if (extensions.some((e) => /object.?storage/i.test(e))) return undefined
  return noStorage.has(server) ? NO_OBJECT_STORAGE : undefined
}

/** Remembers a failed upload's reason when it is the missing Object Storage QBit; returns the plain line. */
export function noteUploadFailure(server: string, error: unknown): string | undefined {
  const missing = missingQBitMessage(error)
  if (missing === NO_OBJECT_STORAGE) noStorage.add(server)
  return missing
}

export class RecordCollaboration {
  readonly kernel: Collaboration

  constructor(registry: ExtensionRegistry, private client: CollabClient, readonly table: string, readonly pk: string) {
    this.kernel = new Collaboration(registry, { call: (id, input) => client.call(id, input) })
  }

  get available(): boolean {
    return this.kernel.available
  }

  private get path() {
    return { table: this.table, pk: this.pk }
  }

  private async data<T>(id: string, input: CallInput = {}): Promise<T> {
    return (await this.client.call(id, input)).data as T
  }

  comments(): Promise<CommentEntry[]> {
    return this.kernel.comments(this.table, this.pk, { limit: 50 }).then((p) => p.threads)
  }

  addComment(body: string, parentCommentId?: number): Promise<CommentEntry> {
    return this.kernel.addComment(this.table, this.pk, body, parentCommentId === undefined ? {} : { parentCommentId })
  }

  followState(): Promise<FollowState> {
    return this.kernel.followState(this.table, this.pk)
  }

  /** Follows when not following, stops when following; returns the new state. */
  async toggleFollow(following: boolean): Promise<FollowState> {
    return following ? this.kernel.unfollow(this.table, this.pk) : this.kernel.follow(this.table, this.pk, { notifyOnChange: true, notifyOnComment: true })
  }

  async attachments(): Promise<AttachmentEntry[]> {
    return (await this.data<{ items?: AttachmentEntry[] }>('getQbitCollaborationRecordsByTableByPkAttachments', { path: this.path, query: { limit: '100' } })).items ?? []
  }

  /** An attachment's bytes: the server hands out a temporary URL; credentials go only to the server itself. */
  async download(id: number): Promise<{ bytes: Uint8Array; url: string }> {
    const link = await this.data<{ url?: string }>('getQbitCollaborationAttachmentsByIdDownload', { path: { id: String(id) } })
    if (!link.url) throw new Error('the server gave no download address for this attachment')
    const url = new URL(link.url, this.client.server)
    const own = url.origin === new URL(this.client.server).origin
    const response = await (own ? this.client.fetch : fetch)(url.toString())
    if (!response.ok) throw new Error(`downloading the attachment answered ${response.status}`)
    return { bytes: new Uint8Array(await response.arrayBuffer()), url: url.toString() }
  }

  /** Uploads a file from disk as an attachment of the record. */
  async upload(file: string, description?: string): Promise<AttachmentEntry> {
    const bytes = readFileSync(file)
    const form: Record<string, string | Blob> = { file: new File([bytes], basename(file)) }
    if (description) form.description = description
    return this.data<AttachmentEntry>('postQbitCollaborationRecordsByTableByPkAttachments', { path: this.path, form })
  }

  async deleteAttachment(id: number): Promise<void> {
    await this.client.call('deleteQbitCollaborationAttachmentsById', { path: { id: String(id) } })
  }

  async timeline(): Promise<TimelineEntry[]> {
    return (await this.data<{ items?: TimelineEntry[] }>('getQbitCollaborationRecordsByTableByPkTimeline', { path: this.path, query: { limit: '100' } })).items ?? []
  }

  async tasks(includeDone = true): Promise<TaskEntry[]> {
    return (await this.data<{ items?: TaskEntry[] }>('getQbitCollaborationRecordsByTableByPkTasks', { path: this.path, query: { includeDone: String(includeDone), limit: '100' } })).items ?? []
  }

  addTask(title: string, dueAt?: string): Promise<TaskEntry> {
    return this.data<TaskEntry>('postQbitCollaborationRecordsByTableByPkTasks', { path: this.path, json: { title, ...(dueAt ? { dueAt } : {}) } })
  }

  setTaskStatus(id: number, status: string): Promise<TaskEntry> {
    return this.data<TaskEntry>('patchQbitCollaborationTasksById', { path: { id: String(id) }, json: { status } })
  }

  people(q: string): Promise<PersonEntry[]> {
    return this.kernel.people(q || undefined, 25)
  }

  /** Who of these people could read the record if it were shared with them. */
  async sharePreview(userIds: string[]): Promise<ShareRecipient[]> {
    return (await this.data<{ recipients?: ShareRecipient[] }>('postQbitCollaborationRecordsByTableByPkSharesPreview', { path: this.path, json: { toUserIds: userIds } })).recipients ?? []
  }

  async share(userIds: string[], message?: string): Promise<J> {
    return this.data<J>('postQbitCollaborationRecordsByTableByPkShares', { path: this.path, json: { toUserIds: userIds, ...(message ? { message } : {}) } })
  }

  /** Display names of the record's followers. */
  async followers(): Promise<string[]> {
    const items = (await this.data<{ items?: Array<{ userDisplayName?: string; userId?: string }> }>('getQbitCollaborationRecordsByTableByPkFollowers', { path: this.path, query: { limit: '50' } })).items ?? []
    return items.map((f) => f.userDisplayName ?? f.userId ?? 'someone')
  }

  /** Counts, follow state and the panel's details for the record view; each part fails on its own. */
  async summary(): Promise<CollabSummary> {
    const [comments, attachments, tasks, follow, followers] = await Promise.allSettled([this.comments(), this.attachments(), this.tasks(false), this.followState(), this.followers()])
    const threads = comments.status === 'fulfilled' ? comments.value : undefined
    const open = tasks.status === 'fulfilled' ? tasks.value : undefined
    const due = (open ?? []).map((k) => k.dueAt).filter((d): d is string => Boolean(d)).sort()
    return {
      comments: threads?.length,
      attachments: attachments.status === 'fulfilled' ? attachments.value.length : undefined,
      tasks: open?.length,
      following: follow.status === 'fulfilled' ? follow.value.following : undefined,
      latest: threads && [...threads].filter((c) => !c.deleted).sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))).slice(0, 2).map((c) => ({ author: c.authorDisplayName ?? c.authorUserId ?? 'someone', at: c.createdAt, text: commentBody(c) })),
      nextDue: due[0],
      followers: followers.status === 'fulfilled' ? followers.value : undefined,
    }
  }
}

/** Who is on the record (the actions entry): everyone the server reports, this user marked "(you)". */
export function viewingText(everyone: Array<{ name: string; self?: boolean }> | undefined): string {
  if (!everyone) return 'Viewing now: …'
  if (!everyone.length) return 'Viewing now: no one else'
  const names = everyone.map((p) => (p.self ? `${p.name} (you)` : p.name))
  const others = everyone.filter((p) => !p.self).length
  return `Viewing now: ${names.slice(0, 3).join(', ')}${names.length > 3 ? ` +${names.length - 3}` : ''}${others ? ` · ${others} other${others === 1 ? '' : 's'}` : ''}`
}

/** One comment thread as lines (the comment, then its replies indented). */
export function commentLines(c: CommentEntry, when: (iso: string | undefined) => string): string[] {
  const head = (x: CommentEntry) => `${x.authorDisplayName ?? x.authorUserId ?? 'someone'} · ${when(x.createdAt)}${x.editedAt ? ' (edited)' : ''}${(x as { resolved?: boolean }).resolved ? ' · resolved' : ''}`
  return [`${head(c)}: ${commentBody(c)}`, ...(c.replies ?? []).map((r) => `    ↳ ${head(r)}: ${commentBody(r)}`)]
}

/** A comment's text with mentions as @Name ("(deleted)" for a deleted one). */
export function commentBody(x: CommentEntry): string {
  return x.deleted ? '(deleted)' : String(x.body ?? '').replace(/@\[([^\]]+)\]\(user:[^)]+\)/g, '@$1')
}
