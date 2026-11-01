/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Default columns for the lists the common extension operations return (the alerts inbox,
 * notebooks, SQL history, comments, tasks, favorites, recents), so their table output shows what a
 * person scans for rather than every key. Keys are operation ids; values map the list's key path
 * in the response to its columns (see DocumentLayout.columns). A `--columns` choice replaces them.
 */

const INBOX = ['id', 'severity', 'title', 'category', 'age', 'unread']
const TASKS = ['id', 'title', 'status', 'assigneeDisplayName', 'dueAt', 'tableName', 'recordId']
const TARGETS = ['id', 'targetType', 'targetName', 'recordId', 'label', 'folder', 'available']

export const DEFAULT_LIST_COLUMNS: Readonly<Record<string, Readonly<Record<string, string[]>>>> = {
  alertsInbox: { items: INBOX },
  alertsInboxSummary: { items: INBOX, banners: INBOX },
  sqlWorkbenchListNotebooks: { notebooks: ['id', 'title', 'visibility', 'ownerName', 'defaultBackendName', 'currentVersion', 'modifyDate'] },
  sqlWorkbenchGetHistory: { executions: ['startTime', 'backendName', 'status', 'durationMs', 'rowsReturned', 'sqlText'] },
  getQbitCollaborationRecordsByTableByPkComments: { threads: ['id', 'authorDisplayName', 'createdAt', 'resolved', 'body'] },
  getQbitCollaborationRecordsByTableByPkTasks: { items: TASKS },
  getQbitCollaborationTasksMine: { items: TASKS },
  getQbitCollaborationMyWork: { tasks: TASKS },
  getQbitCollaborationFavorites: { items: TARGETS },
  getQbitCollaborationRecents: { items: TARGETS },
}

/** The default list columns of an operation's response, or undefined (every key is shown). */
export function defaultListColumns(operationId: string): Record<string, string[]> | undefined {
  const columns = DEFAULT_LIST_COLUMNS[operationId]
  return columns ? { ...columns } : undefined
}

/** `a, b,c` as `['a', 'b', 'c']`; undefined for nothing. */
export function parseColumnList(text: string | undefined): string[] | undefined {
  const list = (text ?? '').split(',').map((c) => c.trim()).filter(Boolean)
  return list.length ? list : undefined
}
