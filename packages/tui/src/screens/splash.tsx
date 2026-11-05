/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The start-up splash of `qqq ui`: Query (the qrun.io mascot) blinking and wagging while the TUI
 * boots, the `qqq` wordmark, the version, and one status line that follows the boot steps (reading
 * profiles, connecting, signing in, loading metadata). It drives the boot (boot-plan.ts decides the
 * first step): with several profiles and none named the Servers picker opens over it; with none the
 * add form; a failure stays on the splash with Enter retrying and c choosing another profile.
 * Any key stops the animation (not the boot); --no-splash and `ui.splash: off` skip the splash.
 */

import { useEffect, useReducer } from 'react'
import { UI_API_VERSION } from '@qrun-io/qqq-ui-api-client'
import { CLI_VERSION } from '@qrun-io/qqq-cli/program'
import { probeServer, readConfig } from '@qrun-io/qqq-core'
import { PICK_HINT, splashWait, type BootPlan } from '../boot-plan'
import type { Key } from '../keys'
import { charOf } from '../keys'
import { ProfileFormOverlay, ServersOverlay } from '../overlays/servers'
import { blockText, blockWidth } from '../saver/font'
import { queryFrame, querySize } from '../saver/query-art'
import { ServersModel } from '../servers'
import type { AppStore, Target } from '../store'
import { isAscii, theme, type ThemeTokens } from '../theme'
import type { FKeyLabels, Screen } from '../types'
import { cellWidth, errorText, trunc } from '../util/text'
import { NeedsSignIn, SignInScreen, connect, type SignInDeps } from './signin'

export type SplashPhase = 'starting' | 'picking' | 'adding' | 'connecting' | 'failed' | 'done'

/** The colour a piece of the splash is drawn in (a theme token). */
export type SplashTone = 'art' | 'mark' | 'fg' | 'dim' | 'status' | 'err' | 'key'

export interface SplashSeg {
  text: string
  tone: SplashTone
}

export const SPLASH_TAGLINE = 'Terminal client for QQQ'

/** `qqq 1.1.0 · UI API client 1.10.0` */
export function versionLine(): string {
  return `qqq ${CLI_VERSION} · UI API client ${UI_API_VERSION}`
}

/** Query's pose at a moment: a blink every 3 s; while the boot works, the tail wags (his wave). */
export function splashPose(now: number, busy: boolean): { blink: boolean; wag: boolean } {
  return { blink: now % 3000 < 200, wag: busy && Math.floor(now / 300) % 2 === 1 }
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_ASCII = ['|', '/', '-', '\\']

export interface SplashLayoutInput {
  ascii: boolean
  pose: { blink: boolean; wag: boolean }
  status: SplashSeg
  /** Lines under the status (a sign-in address, a device code). */
  extra: SplashSeg[]
  /** The key hint line, or ''. */
  keys: string
  /** `top`: the header only (the picker is drawn below it), from `headerTop`, keeping `reserve` rows under it. */
  anchor: 'center' | 'top'
  reserve?: number
  headerTop?: number
}

/** Rows of the large header (Query, gap, wordmark, gap, tagline, version) and of the compact one. */
const LARGE_HEADER = querySize('large').height + 9
const COMPACT_HEADER = querySize('small').height + 1

export type SplashLine = SplashSeg[]

/** Which composition fits with `rowsBelow` rows under it: the large Query over the wordmark, the small one beside it, or text. */
export function splashTier(width: number, height: number, rowsBelow: number): 'large' | 'compact' | 'text' {
  // a free row to spare, so a header and the picker under it never meet the screen's foot
  if (width >= 40 && height > LARGE_HEADER + rowsBelow) return 'large'
  if (width >= 40 && height > COMPACT_HEADER + rowsBelow) return 'compact'
  return 'text'
}

/**
 * The splash as lines of coloured pieces, centred in `width` and clipped to `width` × `height`
 * (pure: tests read it at 80×24 and in ASCII). Blank lines are empty arrays.
 */
export function splashLayout(width: number, height: number, input: SplashLayoutInput): SplashLine[] {
  const below: SplashLine[] = [[{ ...input.status }], ...input.extra.map((s) => [{ ...s }]), ...(input.keys ? [[{ text: input.keys, tone: 'key' as const }]] : [])]
  const header = input.anchor === 'top'
  const rowsBelow = header ? input.reserve ?? 0 : below.length + 1
  const tier = splashTier(width, height, rowsBelow)
  const mark = blockText('qqq', input.ascii)
  const lines: SplashLine[] = []
  if (tier === 'large') {
    for (const row of queryFrame('large', input.pose, input.ascii)) lines.push([{ text: row, tone: 'art' }])
    lines.push([])
    for (const row of mark) lines.push([{ text: row, tone: 'mark' }])
    lines.push([])
    lines.push([{ text: SPLASH_TAGLINE, tone: 'fg' }])
    lines.push([{ text: versionLine(), tone: 'dim' }])
  } else if (tier === 'compact') {
    // the small Query beside the wordmark, the tagline under the wordmark
    const art = queryFrame('small', input.pose, input.ascii)
    const right = Math.max(blockWidth('qqq'), SPLASH_TAGLINE.length)
    // the wordmark and the tagline (a row apart) centred against Query's height
    const from = Math.max(0, Math.floor((art.length - mark.length - 2) / 2))
    const taglineRow = Math.min(art.length - 1, from + mark.length + 1)
    art.forEach((row, i) => {
      const inMark = i >= from && i < from + mark.length
      const text = inMark ? mark[i - from]! : i === taglineRow ? SPLASH_TAGLINE : ''
      lines.push([{ text: row, tone: 'art' }, { text: '   ', tone: 'fg' }, { text: text.padEnd(right), tone: inMark ? 'mark' : 'fg' }])
    })
    lines.push([{ text: versionLine(), tone: 'dim' }])
  } else {
    if (width >= blockWidth('qqq') && height >= 7 + rowsBelow) for (const row of mark) lines.push([{ text: row, tone: 'mark' }])
    else lines.push([{ text: 'qqq', tone: 'mark' }])
    lines.push([{ text: SPLASH_TAGLINE, tone: 'fg' }])
    lines.push([{ text: versionLine(), tone: 'dim' }])
  }
  if (!header) {
    lines.push([])
    lines.push(...below)
  }
  // the ASCII glyph set (no UTF-8 locale): the middle dot and the ellipsis too
  if (input.ascii) for (const line of lines) for (const seg of line) seg.text = seg.text.replace(/·/g, '-').replace(/…/g, '...')
  const shown = lines.slice(0, Math.max(0, height))
  const top = header ? input.headerTop ?? 1 : Math.max(0, Math.floor((height - shown.length) / 2))
  const out: SplashLine[] = Array.from({ length: Math.min(top, height) }, () => [])
  for (const line of shown) {
    if (out.length >= height) break
    out.push(centerSegs(line, width))
  }
  return out
}

/** Centres a line of pieces in `width` cells, cutting the last pieces with an ellipsis when it is wider. */
export function centerSegs(line: SplashLine, width: number): SplashLine {
  const total = line.reduce((w, s) => w + cellWidth(s.text), 0)
  if (total <= width) {
    const left = Math.floor((width - total) / 2)
    return left > 0 ? [{ text: ' '.repeat(left), tone: 'fg' }, ...line] : line
  }
  const out: SplashLine = []
  let room = width
  for (const s of line) {
    if (room <= 0) break
    const w = cellWidth(s.text)
    if (w <= room) {
      out.push(s)
      room -= w
    } else {
      out.push({ text: trunc(s.text, room), tone: s.tone })
      room = 0
    }
  }
  return out
}

/** The plain text of a laid-out splash (tests, the overflow sweep). */
export function splashText(lines: SplashLine[]): string {
  return lines.map((l) => l.map((s) => s.text).join('')).join('\n')
}

function toneColor(t: ThemeTokens, tone: SplashTone): string {
  return tone === 'art' ? t.acc : tone === 'mark' ? t.acc2 : tone === 'dim' || tone === 'key' ? t.dim : tone === 'err' ? t.err : tone === 'status' ? t.acc : t.fg
}

export interface SplashOptions {
  plan: BootPlan
  /** How to connect and sign in (the store's signInDeps). */
  deps: SignInDeps
  /** Ends the program and prints a line (the picker closed without a choice). */
  exit: (hint: string) => void
  /** The splash stays at least this long (0 in tests). */
  minMs: number
  /** Animate Query (off in tests: one still frame). */
  animate: boolean
}

export class SplashScreen implements Screen {
  readonly kind = 'splash'
  readonly id = 'splash'
  phase: SplashPhase = 'starting'
  status = 'reading profiles…'
  statusKind: 'info' | 'error' = 'info'
  /** The profile being connected to (Enter retries it after a failure). */
  target?: Target
  /** Query moves until a key is pressed. */
  animate: boolean
  readonly shownAt = Date.now()
  /** The sign-in itself (prompts, device code, browser address) is the sign-in screen's, unshown. */
  readonly signIn: SignInScreen
  private signingIn = false
  /** The picker's profiles (its height follows them). */
  private pickerModel?: ServersModel

  constructor(readonly store: AppStore, readonly options: SplashOptions) {
    this.animate = options.animate
    this.signIn = new SignInScreen(store, options.deps)
  }

  title(): string {
    return 'qqq'
  }

  fkeys(): FKeyLabels {
    return {}
  }

  /** Starts the boot plan. */
  start(): void {
    const plan = this.options.plan
    if (plan.kind === 'connect') this.connectTo(plan.target)
    else if (plan.kind === 'pick') this.pick(plan.note, false)
    else this.add(plan.note)
  }

  private say(text: string, kind: 'info' | 'error' = 'info'): void {
    this.status = text
    this.statusKind = kind
    this.store.bump()
  }

  private model(): ServersModel {
    const deps = this.options.deps
    return new ServersModel({ secrets: deps.secrets, probe: (server) => probeServer(server, { fetch: deps.fetch }), onChange: () => this.store.bump() })
  }

  /** The Servers picker over the splash; Esc quits (or, after a failure, returns to it). */
  pick(note?: string, fromFailure = this.phase === 'failed'): void {
    const model = this.model()
    if (!model.rows.length) return this.add(note)
    this.pickerModel = model
    const before = { phase: this.phase, status: this.status, kind: this.statusKind }
    this.phase = 'picking'
    this.say(note ?? 'choose a server to connect to', note ? 'error' : 'info')
    const select = this.target?.name ?? (this.options.plan.kind === 'pick' ? this.options.plan.select : undefined)
    const overlay: ServersOverlay = new ServersOverlay(this.store, (row) => this.connectTo({ name: row.name, server: row.server }), model, {
      title: 'Connect to a server',
      enterLabel: 'Enter connects',
      escLabel: fromFailure ? 'Esc goes back' : 'Esc quits',
      select,
      top: (sh) => this.pickerPlace(sh).pickerTop,
      onEscape: () => {
        this.store.closeOverlay(overlay)
        if (!fromFailure) return this.options.exit(PICK_HINT)
        this.phase = before.phase
        this.say(before.status, before.kind)
      },
    })
    this.store.open(overlay)
  }

  /** The picker's rows: two per profile and six of frame, filter, header and hints (the Servers dialog's own sum). */
  private pickerHeight(): number {
    return Math.max(10, Math.min(30, (this.pickerModel?.rows.length ?? 2) * 2 + 6))
  }

  /**
   * The header and the picker under it, centred together; a terminal too short for both gets the
   * picker near the top, over the header.
   */
  pickerPlace(screenHeight: number): { headerTop: number; pickerTop: number } {
    const pickerHeight = this.pickerHeight()
    const header = splashLayout(this.store.width, screenHeight, { ...this.layoutInput('top'), reserve: pickerHeight + 1, headerTop: 0 }).length
    const total = header + 1 + pickerHeight
    if (total > screenHeight - 1) return { headerTop: 1, pickerTop: 1 }
    const top = Math.max(0, Math.floor((screenHeight - total) / 2))
    return { headerTop: top, pickerTop: top + header + 1 }
  }

  /** What to lay out at a height: the centred splash, or the header above the picker. */
  inputFor(height: number, now = Date.now()): SplashLayoutInput {
    if (!(this.phase === 'picking' && this.store.overlays.length)) return this.layoutInput('center', now)
    const place = this.pickerPlace(height)
    return { ...this.layoutInput('top', now), reserve: this.pickerHeight() + 1, headerTop: place.headerTop }
  }

  /** The add form (no profile yet, or `n`); a saved profile is connected to at once. */
  add(note?: string): void {
    this.phase = 'adding'
    this.say(note ?? 'no server profile yet: add one to connect', note ? 'error' : 'info')
    this.store.open(new ProfileFormOverlay(this.store, this.model(), undefined, (name) => {
      const p = readConfig().profiles[name]
      if (p) this.connectTo({ name, server: p.server })
    }))
  }

  /** Connects to a profile (signing in when there is no stored sign-in); Home replaces the splash. */
  connectTo(target: Target): void {
    if (this.phase === 'connecting') return
    this.phase = 'connecting'
    this.target = target
    const where = target.server.replace(/^https?:\/\//, '')
    this.say(`connecting to ${where}…`)
    const deps: SignInDeps = {
      ...this.options.deps,
      progress: (text) => this.say(text),
      beforeHome: () => new Promise((resolve) => setTimeout(resolve, splashWait(this.shownAt, Date.now(), this.options.minMs))),
    }
    const run = async () => {
      try {
        await connect(this.store, target, deps)
      } catch (e) {
        if (!(e instanceof NeedsSignIn)) throw e
        this.signingIn = true
        this.signIn.status = ''
        this.say(`signing in to ${where}…`)
        await this.signIn.signIn(target)
        this.signingIn = false
        this.say(`connecting to ${where}…`)
        await connect(this.store, target, deps)
      }
    }
    run().then(() => {
      this.phase = 'done'
    }).catch((e) => {
      this.phase = 'failed'
      this.say(errorText(e), 'error')
    }).finally(() => {
      this.signingIn = false
      this.signIn.device = undefined
      this.signIn.browserUrl = undefined
      this.store.bump()
    })
  }

  /** Every key is the splash's (no F-keys, menu or palette before a server is connected). */
  claimsKey(): boolean {
    return true
  }

  onKey(key: Key): boolean {
    this.animate = false
    const ch = charOf(key).toLowerCase()
    if (key.name === 'escape') {
      if (this.phase === 'connecting') this.signIn.onKey(key)
      else if (this.phase === 'failed' || this.phase === 'adding' || this.phase === 'starting') this.options.exit(this.phase === 'failed' ? `qqq ui: ${this.status}` : PICK_HINT)
    } else if (key.name === 'f10' || (key.ctrl && key.name === 'q')) this.options.exit('')
    else if (this.phase === 'failed' && (key.name === 'return' || ch === 'r') && this.target) this.connectTo(this.target)
    else if (this.phase !== 'connecting' && (ch === 'c' || ch === 'p' || (key.ctrl && key.name === 'o'))) this.pick()
    else if (this.phase !== 'connecting' && ch === 'n') this.add()
    this.store.bump()
    return true
  }

  /** The status line: the sign-in's own words while it runs (creating a session, waiting for the browser). */
  private statusSeg(now: number): SplashSeg {
    const text = this.signingIn && this.signIn.status ? this.signIn.status : this.status
    if (this.statusKind === 'error') return { text, tone: 'err' }
    const busy = this.phase === 'connecting' || this.phase === 'starting'
    if (!busy) return { text, tone: 'status' }
    const frames = isAscii() ? SPINNER_ASCII : SPINNER
    const spin = this.animate ? frames[Math.floor(now / 100) % frames.length]! : isAscii() ? '*' : '·'
    return { text: `${spin} ${text}`, tone: 'status' }
  }

  private extra(): SplashSeg[] {
    const s = this.signIn
    if (s.browserUrl) return [{ text: 'Sign in in your browser (opened); if it did not open, visit:', tone: 'fg' }, { text: s.browserUrl, tone: 'fg' }]
    if (s.device) {
      const left = Math.max(0, Math.round((s.device.expires - Date.now()) / 1000))
      return [{ text: `Open ${s.device.url}`, tone: 'fg' }, { text: `and confirm the code ${s.device.code} (expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')})`, tone: 'fg' }]
    }
    return []
  }

  private keys(): string {
    if (this.store.overlays.length) return ''
    if (this.phase === 'failed') return 'Enter retries · c chooses another profile · n adds one · Esc quits'
    if (this.phase === 'adding') return 'n adds a server profile · Esc quits'
    if (this.phase === 'connecting' && (this.signIn.browserUrl || this.signIn.device)) return 'Esc cancels the sign-in'
    return ''
  }

  layoutInput(anchor: 'center' | 'top', now = Date.now()): SplashLayoutInput {
    const busy = this.phase === 'connecting' || this.phase === 'starting'
    return { ascii: isAscii(), pose: this.animate ? splashPose(now, busy) : { blink: false, wag: false }, status: this.statusSeg(now), extra: this.extra(), keys: this.keys(), anchor }
  }

  /** The text as drawn now (tests). */
  text(width: number, height: number): string {
    return splashText(splashLayout(width, height, this.inputFor(height)))
  }

  render(width: number, height: number) {
    return <SplashView splash={this} width={width} height={height} />
  }
}

/** Repaints itself at about 10 fps while Query moves (only this component). */
function SplashView({ splash, width, height }: { splash: SplashScreen; width: number; height: number }) {
  const [, tick] = useReducer((n: number) => n + 1, 0)
  const moving = splash.animate && splash.phase !== 'done'
  useEffect(() => {
    if (!moving) return
    const timer = setInterval(tick, 100)
    return () => clearInterval(timer)
  }, [moving])
  const t = theme()
  const lines = splashLayout(width, height, splash.inputFor(height))
  return (
    <box flexDirection="column" overflow="hidden" width={width} height={height}>
      {lines.map((line, i) => (
        <text key={i} flexShrink={0} wrapMode="none" height={1}>
          {line.length ? line.map((s, k) => <span key={k} fg={toneColor(t, s.tone)}>{s.text}</span>) : ' '}
        </text>
      ))}
    </box>
  )
}
