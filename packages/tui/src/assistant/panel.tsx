/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The Assistant panel (qbit-assistant): a chat pane on the right of the screen, or the whole body on
 * terminals narrower than {@link SIDE_MIN_WIDTH}. The question line is at the bottom, the conversation
 * above it with the answer's numbers and links; Tab moves to the links and Enter opens one (a record
 * or a grid, read from the app path the server built, through the same checks as widget links).
 *
 * Questions carry the page under the panel as context, the way the Next UI sends it: a record
 * (`/app/{table}/{id}`) or a grid with its filter. Ctrl+D drops (and restores) that context.
 * Questions are kept per profile (↑↓ on the question line). Without the extension the panel does not
 * open; when the assistant is off for this user it opens with the server's reason.
 */

import { Assistant, ASSISTANT, History, assistantContextFor, describeAssistantConfig, type AssistantConfigView, type AssistantPageContext } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import { LineEditor } from '../line-editor'
import { followLink } from '../links'
import { Zone } from '../mouse/zone'
import { wheelAsKeys } from '../mouse/keys'
import type { AppStore } from '../store'
import { borderProps, theme } from '../theme'
import type { FKeyLabels } from '../types'
import { cellWidth, errorText, hintLine, pad, trunc } from '../util/text'
import { chatLines, chatLinks, contextLabel, wrap, type ChatLine, type Exchange, type Seg } from './model'

/** Below this terminal width the panel takes the whole body instead of a right-hand pane. */
export const SIDE_MIN_WIDTH = 110

/** The pane's width beside the screen. */
export function sideWidth(total: number): number {
  return Math.max(40, Math.min(64, Math.floor(total * 0.4)))
}

export class AssistantPanel {
  readonly id = `assistant:${Date.now()}`
  readonly editor = new LineEditor('')
  exchanges: Exchange[] = []
  conversationId?: number
  config?: AssistantConfigView
  /** The link the cursor is on (Tab moves here from the question line), or -1. */
  linkCursor = -1
  /** Lines scrolled up from the bottom (0 follows the newest line). */
  scrollBack = 0
  /** Ctrl+D: send questions without the page context. */
  dropContext = false
  private abort?: AbortController
  private history: History
  private historyIndex = -1
  private lastHeight = 10
  private ticker?: ReturnType<typeof setInterval>

  constructor(private readonly store: AppStore) {
    this.history = new History(`assistant-${store.target?.name ?? 'default'}`, 500)
  }

  /** Whether the server has the extension at all. */
  get installed(): boolean {
    return this.store.extensions.has(ASSISTANT)
  }

  get streaming(): boolean {
    return Boolean(this.abort)
  }

  private assistant(): Assistant {
    const client = this.store.client
    if (!client) throw new Error('not connected')
    return new Assistant(this.store.extensions.registry, { call: (id, input) => client.call(id, input), fetch: client.fetch, baseUrl: client.server })
  }

  private configLoad?: Promise<void>

  /** Reads the feature probe (once per panel, again with F5). */
  loadConfig(force = false): Promise<void> {
    if (this.configLoad && !force) return this.configLoad
    this.configLoad = this.assistant().config().then((view) => {
      this.config = view
      this.store.bump()
    }).catch((e: unknown) => {
      this.configLoad = undefined
      this.store.error(e)
    })
    return this.configLoad
  }

  /** Asks once the feature probe has answered (`:ask <question>` right after opening). */
  askWhenReady(question: string): void {
    void this.loadConfig().then(() => this.ask(question))
  }

  /** The context questions carry: the screen the panel was shown over (kept while hidden). */
  private pinned?: AssistantPageContext

  /**
   * Takes the screen under the panel as the context: when the panel is shown, and while it is shown
   * beside the screen (a link opened from it becomes the context). A screen without one (Home)
   * keeps the context the panel had.
   */
  capturePageContext(): void {
    const context = this.screenContext()
    if (context) this.pinned = context
  }

  /** The context the next question carries (none after Ctrl+D). */
  pageContext(): AssistantPageContext | undefined {
    return this.dropContext ? undefined : this.pinned
  }

  /** The screen's context: a record, or a grid with its filter. */
  screenContext(): AssistantPageContext | undefined {
    const screen = this.store.screen as unknown as { kind?: string; tableName?: string; primaryKey?: string; filter?: Record<string, unknown> } | undefined
    if (screen?.kind === 'record' && screen.tableName && screen.primaryKey !== undefined) return assistantContextFor({ tableName: screen.tableName, recordId: screen.primaryKey })
    if (screen?.kind === 'table' && screen.tableName) return assistantContextFor({ tableName: screen.tableName, filter: screen.filter })
    return undefined
  }

  private label(context: AssistantPageContext | undefined): string | undefined {
    return contextLabel(context, context?.tableName ? this.store.meta?.tables?.[context.tableName]?.label : undefined)
  }

  /** Sends the question line (or `text`). */
  ask(text = this.editor.value): void {
    const question = text.trim()
    if (!question) return
    if (this.config && !this.config.enabled) {
      this.store.flash(`assistant ${describeAssistantConfig(this.config)}`, 'error')
      return
    }
    if (this.streaming) {
      this.store.flash('the assistant is still answering (Ctrl+X stops it)', 'error')
      return
    }
    this.history.add(question)
    this.historyIndex = -1
    this.editor.set('')
    this.linkCursor = -1
    this.scrollBack = 0
    const context = this.pageContext()
    const exchange: Exchange = { question, context, contextLabel: this.label(context), startedAt: Date.now() }
    this.exchanges.push(exchange)
    const abort = new AbortController()
    this.abort = abort
    this.ticker = setInterval(() => this.store.bump(), 1000)
    const done = () => {
      if (this.abort === abort) this.abort = undefined
      if (this.ticker) clearInterval(this.ticker)
      this.ticker = undefined
      this.store.bump()
    }
    this.assistant().ask(question, {
      conversationId: this.conversationId,
      context,
      signal: abort.signal,
      onEvent: (event, answer) => {
        exchange.answer = answer
        if (event.type === 'message.start') this.conversationId = answer.conversationId
        if (event.type === 'tool.start' && typeof event.summary === 'string') exchange.activity = event.summary
        this.store.bump()
      },
    }).then((answer) => {
      exchange.answer = answer
      this.conversationId = answer.conversationId
    }).catch((e: unknown) => {
      exchange.error = abort.signal.aborted ? 'stopped' : errorText(e)
    }).finally(done)
    this.store.bump()
  }

  /** Ctrl+X: stops the answer being written. */
  stop(): void {
    if (!this.abort) return
    this.abort.abort()
    this.store.flash('stopped the answer')
  }

  /** Ctrl+L: a new conversation (the questions stay in the history). */
  clear(): void {
    this.stop()
    this.exchanges = []
    this.conversationId = undefined
    this.linkCursor = -1
    this.scrollBack = 0
    this.store.bump()
  }

  /** A table's primary key field from the metadata (links that filter on it are that record). */
  readonly primaryKeyOf = (table: string): string | undefined => (this.store.meta?.tables?.[table] as { primaryKeyField?: string } | undefined)?.primaryKeyField

  /** Every link of the conversation, in reading order, once per target. */
  links(): Array<{ label: string; href: string }> {
    return chatLinks(this.exchanges, this.primaryKeyOf)
  }

  /** `u` on a link: its address, shown (never opened). */
  showUrl(index = this.linkCursor): void {
    const link = this.links()[index]
    if (link) this.store.message(`${link.label}\n${link.href}`, 'info', 'Link address')
  }

  /** Opens the link under the cursor in the screen beside (or, on a narrow terminal, under) the panel. */
  openLink(index = this.linkCursor): void {
    const link = this.links()[index]
    if (!link) return
    this.linkCursor = -1
    this.store.focus = 'content'
    if (this.store.width < SIDE_MIN_WIDTH) this.store.closeAssistant()
    followLink(this.store, link.href)
  }

  dispose(): void {
    this.abort?.abort()
    if (this.ticker) clearInterval(this.ticker)
  }

  fkeys(): FKeyLabels {
    return { 3: null, 4: null, 5: 'Refresh', 6: null, 7: null, 8: null }
  }

  helpKeys(): Array<[string, string]> {
    return [
      ['Enter', 'ask the question (on a link: open it)'],
      ['Tab  Shift+Tab', 'move over the answer\'s links; typing returns to the question'],
      ['↑ ↓', 'question history of this profile (on links: previous / next link)'],
      ['PgUp PgDn', 'scroll the conversation'],
      ['Ctrl+D', 'send without / with the page context'],
      ['Ctrl+L', 'new conversation'],
      ['Ctrl+X', 'stop the answer'],
      ['u', 'on a link: show its address'],
      ['F12  Ctrl+G', 'hide the panel (the conversation, context and draft are kept); again shows it'],
      ['Esc', 'hide the panel (on a link: back to the question line)'],
    ]
  }

  onKey(key: Key): boolean {
    const links = this.links().length
    if (key.ctrl && key.name === 'x') return this.stop(), true
    if (key.ctrl && key.name === 'l') return this.clear(), true
    if (key.ctrl && key.name === 'd') {
      this.dropContext = !this.dropContext
      this.store.flash(this.dropContext ? 'questions go without the page context' : 'questions carry the page context')
      return true
    }
    switch (key.name) {
      case 'escape':
        // hides the panel; the draft on the question line stays for next time
        if (this.linkCursor >= 0) this.linkCursor = -1
        else this.store.closeAssistant()
        return true
      case 'f5':
        void this.loadConfig(true)
        return true
      case 'tab':
        if (!links) return this.store.flash('no links in this conversation yet'), true
        this.linkCursor = key.shift ? (this.linkCursor <= 0 ? links - 1 : this.linkCursor - 1) : (this.linkCursor + 1) % links
        this.revealLink()
        return true
      case 'return': case 'enter':
        if (this.linkCursor >= 0) this.openLink()
        else this.ask()
        return true
      case 'pageup': this.scrollBack += Math.max(1, this.lastHeight - 1); return true
      case 'pagedown': this.scrollBack = Math.max(0, this.scrollBack - Math.max(1, this.lastHeight - 1)); return true
      case 'up': case 'down': {
        if (this.linkCursor >= 0) {
          this.linkCursor = key.name === 'up' ? Math.max(0, this.linkCursor - 1) : Math.min(links - 1, this.linkCursor + 1)
          this.revealLink()
          return true
        }
        const entries = this.history.entries()
        if (!entries.length) return true
        this.historyIndex = key.name === 'up' ? Math.min(entries.length - 1, this.historyIndex + 1) : Math.max(-1, this.historyIndex - 1)
        this.editor.set(this.historyIndex < 0 ? '' : entries[this.historyIndex]!)
        return true
      }
      default:
        break
    }
    if (key.name.startsWith('f') && /^f\d+$/.test(key.name)) return false
    if (this.linkCursor >= 0 && !key.ctrl && !key.meta && key.sequence === 'u') return this.showUrl(), true
    if (this.editor.handle(key)) {
      this.linkCursor = -1
      return true
    }
    return false
  }

  paste(text: string): void {
    this.linkCursor = -1
    this.editor.insert(text)
    this.store.bump()
  }

  /** Scrolls so the link under the cursor is on screen (set on the next render). */
  private pendingReveal = false
  private revealLink(): void {
    this.pendingReveal = true
  }

  private intro(): ChatLine[] {
    const c = this.config
    if (!c) return [{ text: 'checking the assistant…', role: 'activity' }]
    if (!c.installed) return [{ text: 'The assistant extension is not installed on this server.', role: 'error' }]
    if (!c.enabled) {
      return [
        { text: `The assistant is off (${c.reason ?? 'unknown'}).`, role: 'error' },
        ...(c.message ? [{ text: c.message, role: 'meta' as const }] : []),
        { text: 'F5 checks again.', role: 'meta' },
      ]
    }
    return [
      { text: c.greeting ?? `Ask about your data; answers use your permissions (model ${c.model ?? '?'}).`, role: 'meta' },
      ...c.starterPrompts.slice(0, 3).map((p) => ({ text: `e.g. ${p}`, role: 'meta' as const })),
    ]
  }

  render(width: number, height: number, focused: boolean) {
    const t = theme()
    if (this.store.assistantLayout()?.mode === 'side') this.capturePageContext()
    const inner = Math.max(10, width - 2)
    const context = this.pageContext()
    const label = this.label(context)
    const ctxLine = this.dropContext ? 'no page context (Ctrl+D adds it)' : label ? `on: ${label} (Ctrl+D drops)` : 'no page context'
    const bodyHeight = Math.max(1, height - 2 - 3)
    this.lastHeight = bodyHeight
    const all: ChatLine[] = this.exchanges.length ? chatLines(this.exchanges, inner, Date.now(), this.primaryKeyOf) : this.intro().flatMap((x) => wrap(x.text, inner).map((text) => ({ ...x, text })))
    if (this.pendingReveal && this.linkCursor >= 0) {
      const at = all.findIndex((l) => l.segs?.some((x) => x.link === this.linkCursor) || l.link === this.linkCursor)
      if (at >= 0) {
        const bottom = all.length - this.scrollBack
        if (at < bottom - bodyHeight) this.scrollBack = all.length - at - bodyHeight
        else if (at >= bottom) this.scrollBack = Math.max(0, all.length - at - 1)
      }
      this.pendingReveal = false
    }
    this.scrollBack = Math.min(this.scrollBack, Math.max(0, all.length - bodyHeight))
    const end = all.length - this.scrollBack
    const shown = all.slice(Math.max(0, end - bodyHeight), end)
    const color = (l: ChatLine): string => {
      switch (l.role) {
        case 'question': case 'heading': case 'header': return t.acc
        case 'context': case 'meta': case 'activity': case 'rule': return t.dim
        case 'number': return t.acc2
        case 'link': return t.ok
        case 'error': return t.err
        default: return t.fg
      }
    }
    const segColor = (l: ChatLine, seg: Seg): string => seg.style === 'link' ? t.ok : seg.style === 'code' ? t.acc2 : seg.style === 'dim' ? t.dim : color(l)
    const rows = shown.map((l, i) => {
      const used = l.segs ? l.segs.reduce((n, x) => n + cellWidth(x.text), 0) : 0
      const body = l.segs
        ? (
          <text flexShrink={0} wrapMode="none">
            {l.segs.map((seg, k) => {
              const selected = seg.link !== undefined && seg.link === this.linkCursor
              const fg = selected ? t.selFg : segColor(l, seg)
              const bg = selected ? t.selBg : undefined
              return <span key={k} fg={fg} bg={bg}>{seg.style === 'bold' ? <strong>{seg.text}</strong> : seg.text}</span>
            })}
            <span>{' '.repeat(Math.max(0, inner - used))}</span>
          </text>
        )
        : <text flexShrink={0} wrapMode="none" fg={color(l)}>{pad(l.text, inner)}</text>
      return l.link === undefined
        ? <box key={i} height={1} width={inner}>{body}</box>
        : <Zone key={i} onClick={() => { this.store.focus = 'assistant'; this.linkCursor = l.link!; this.openLink(l.link) }}><box height={1} width={inner}>{body}</box></Zone>
    })
    while (rows.length < bodyHeight) rows.push(<box key={`p${rows.length}`} height={1} width={inner}><text flexShrink={0} wrapMode="none">{pad('', inner)}</text></box>)
    const view = this.editor.view(Math.max(1, inner - 2))
    const ready = !this.config || this.config.enabled
    const hint = this.linkCursor >= 0
      ? 'Enter opens · u address · ↑↓ Tab links · Esc back to the question'
      : this.streaming ? 'answering… Ctrl+X stops · PgUp PgDn scroll · F12/Esc hides' : 'Enter asks · Tab links · ↑↓ history · Ctrl+L new · F12/Esc hides'
    const title = `Assistant${this.config?.model && ready ? ` · ${this.config.model}` : ''}${this.scrollBack ? ` · ↑${this.scrollBack}` : ''}`
    return (
      <Zone
        onClick={() => { this.store.focus = 'assistant' }}
        onWheel={(e) => { this.store.focus = 'assistant'; return wheelAsKeys(e, (k) => this.store.handleKey(k)) }}
      >
        <box flexDirection="column" overflow="hidden" width={width} height={height} {...borderProps(focused)} title={` ${trunc(title, Math.max(1, width - 4))} `}>
          <text flexShrink={0} wrapMode="none" fg={t.dim}>{pad(ctxLine, inner)}</text>
          {rows}
          <Zone onClick={() => { this.store.focus = 'assistant'; this.linkCursor = -1 }}>
            <text flexShrink={0} wrapMode="none">
              <span fg={t.acc}>{'> '}</span>
              <span fg={ready ? t.fg : t.dim}>{view.before}</span>
              <span fg={focused && this.linkCursor < 0 ? t.selFg : t.fg} bg={focused && this.linkCursor < 0 ? t.selBg : undefined}>{view.at}</span>
              <span fg={ready ? t.fg : t.dim}>{pad(view.after, Math.max(0, inner - 2 - view.before.length - 1))}</span>
            </text>
          </Zone>
          <text flexShrink={0} wrapMode="none" fg={t.dim}>{hintLine(hint, inner)}</text>
        </box>
      </Zone>
    )
  }
}

