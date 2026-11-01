/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The share dialog of a shareable record (saved reports, saved views): its shares with their
 * scope, add a user or group, change a scope, remove a share; only the owner may share. Built on
 * the kernel's records/sharing.ts; each change reopens the list with the server's answer.
 */

import { SHARE_SCOPES, addShare, audienceOptions, changeShare, isRecordOwner, listShares, removeShare, shareable, type RecordShare, type ShareScope } from '@qrun-io/qqq-core'
import type { AppStore } from '../store'
import { ChoiceOverlay } from './basic'

type J = Record<string, unknown>

/** Whether the record view offers Share, and why not when it is shown disabled. */
export function shareState(store: AppStore, tableMeta: J | undefined, record: { values?: J } | undefined): { offered: boolean; disabled?: string } {
  const sharing = tableMeta ? shareable(tableMeta) : undefined
  if (!sharing || !record) return { offered: false }
  return isRecordOwner(sharing, record, store.status.userId) ? { offered: true } : { offered: true, disabled: `only the owner of a ${String(tableMeta!.label ?? 'record')} may share it` }
}

export function openShareDialog(store: AppStore, tableMeta: J, recordId: string, recordLabel: string): void {
  const c = store.client!
  const sharing = shareable(tableMeta)
  if (!sharing) return store.flash('this table is not shareable')
  const scopeLabel = (id: string) => SHARE_SCOPES.find((s) => s.id === id)?.label ?? id
  const reopen = (note?: string) => {
    if (note) store.flash(note)
    openShareDialog(store, tableMeta, recordId, recordLabel)
  }
  store.run(listShares(c.server, c.fetch, tableMeta, recordId), (shares) => {
    type Pick = { kind: 'add' } | { kind: 'share'; share: RecordShare }
    const choices: Array<{ label: string; value: Pick; detail?: string; disabled?: string }> = [
      { label: 'Share with a user or group…', value: { kind: 'add' }, disabled: sharing.audiencePossibleValueSourceName ? undefined : 'the server names no audience source' },
      ...shares.map((s) => ({ label: s.audienceLabel, value: { kind: 'share' as const, share: s }, detail: `${s.audienceType} · ${scopeLabel(s.scopeId)}` })),
    ]
    store.open(new ChoiceOverlay<Pick>(store, `Share ${recordLabel} · ${shares.length} share${shares.length === 1 ? '' : 's'}`, choices, (pick) => {
      if (pick.kind === 'add') {
        store.run(audienceOptions(c.server, c.fetch, sharing), (options) => {
          if (!options.length) return store.flash('no users or groups to share with')
          store.open(new ChoiceOverlay(store, 'Share with', options.map((o) => ({ label: o.label, value: o.id, detail: o.id.split(':')[0] })), (audience) => {
            store.open(new ChoiceOverlay<ShareScope>(store, 'Scope', SHARE_SCOPES.map((s) => ({ label: s.label, value: s.id })), (scope) => {
              store.run(addShare(c.server, c.fetch, tableMeta, recordId, audience, scope), () => reopen('shared'))
            }))
          }))
        })
        return
      }
      const share = pick.share
      type Act = { kind: 'scope'; scope: ShareScope } | { kind: 'remove' }
      store.open(new ChoiceOverlay<Act>(store, `${share.audienceLabel} · ${scopeLabel(share.scopeId)}`, [
        ...SHARE_SCOPES.filter((s) => s.id !== share.scopeId).map((s) => ({ label: `Change to ${s.label}`, value: { kind: 'scope' as const, scope: s.id } })),
        { label: 'Remove this share', value: { kind: 'remove' } },
      ], (act) => {
        if (act.kind === 'scope') store.run(changeShare(c.server, c.fetch, tableMeta, recordId, share.shareId, act.scope), () => reopen(`${share.audienceLabel}: ${scopeLabel(act.scope)}`))
        else store.confirm(`Stop sharing with ${share.audienceLabel}?`, () => store.run(removeShare(c.server, c.fetch, tableMeta, recordId, share.shareId), () => reopen('share removed')))
      }))
    }, 'Enter changes a share'))
  })
}
