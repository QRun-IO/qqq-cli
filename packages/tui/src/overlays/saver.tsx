/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The screen saver: live tiles (people online, jobs, health, load, event rate…) and Query, the
 * qrun.io mascot, in one of four styles (src/saver/layout.ts). It is also the lock: the key
 * handling is the LockOverlay's (any key wakes it; with a PIN the prompt appears over the saver,
 * which keeps animating; Esc goes back to the saver). `:saver [style]` previews it without a PIN.
 *
 * Only this overlay's own component repaints at the frame rate (4 fps while something moves, about
 * 1 fps otherwise); the tiles poll every refresh interval and only while the saver is shown.
 */

import { useEffect, useReducer } from 'react'
import { hasPin, readConfig, readRecents, shortNameOf } from '@qrun-io/qqq-core'
import type { Key } from '../keys'
import type { AppStore } from '../store'
import { glyphs, isAscii, theme } from '../theme'
import type { MenuEntry, Overlay } from '../types'
import { paintSaver, nextFrameDelay, isDimmed, styleAt, type SaverInput } from '../saver/layout'
import { TileModel, realtimeEvents } from '../saver/model'
import { saverSources, type SaverContext } from '../saver/sources'
import { DIM_CHOICES, REFRESH_CHOICES, SAVER_STYLES, STYLE_LABELS, isStyle, readSaverSettings, writeSaverSettings, type SaverSettings, type SaverStyle, type SaverStyleSetting } from '../saver/settings'
import { ChoiceOverlay, overlayId } from './basic'
import { LockOverlay } from './center'

/** Tables sampled for presence at most (favourites and recents first). */
const PRESENCE_TABLE_CAP = 40

export class SaverOverlay implements Overlay {
  readonly id = overlayId('saver')
  readonly settings: SaverSettings
  readonly model: TileModel
  private readonly lock: LockOverlay
  /** When the saver came up (the dim counts from here). */
  readonly startedAt = Date.now()
  private readonly shortName: string | undefined

  /** `preview`: shown by `:saver` (a style, or the setting): any key returns, no PIN. */
  constructor(private store: AppStore, readonly preview?: SaverStyleSetting) {
    this.settings = readSaverSettings(this.profile())
    this.lock = new LockOverlay(store)
    this.shortName = this.profileShortName()
    this.model = new TileModel(store.client ? saverSources(this.context()) : [], { intervalMs: this.settings.refreshSeconds * 1000 })
  }

  private profile(): string | undefined {
    return this.store.status.profile || this.store.target?.name || undefined
  }

  /** The profile's short name (what the block-letter logo says), if there is a profile. */
  private profileShortName(): string | undefined {
    const name = this.profile()
    if (!name) return undefined
    try {
      return shortNameOf(name, readConfig().profiles[name])
    } catch {
      return undefined
    }
  }

  private context(): SaverContext {
    const s = this.store
    const client = s.client!
    const tables = s.meta?.tables ?? {}
    const favourites = this.settings.tables.filter((t) => !s.meta || t in tables)
    return {
      client,
      has: (name) => s.extensions.has(name),
      features: s.version?.features ?? [],
      status: () => s.status,
      events: realtimeEvents,
      sessionTable: () => {
        // the session store qbit's table (storedSession)
        const t = Object.values(tables).find((x) => /^(stored_?)?sessions?$/i.test(x.name))
        return t && t.readPermission !== false ? t.name : undefined
      },
      favouriteTables: favourites,
      tableLabel: (name) => tables[name]?.label ?? name,
      intervalMs: () => this.model.intervalMs,
      presenceTables: () => {
        let recents: string[] = []
        try {
          recents = readRecents(client.server).map((r) => r.table).filter((t): t is string => Boolean(t))
        } catch {
          recents = []
        }
        const rest = Object.values(tables).filter((t) => !t.isHidden && t.readPermission !== false).map((t) => t.name)
        return [...new Set([...favourites, ...recents, ...rest])].filter((t) => !s.meta || t in tables).slice(0, PRESENCE_TABLE_CAP)
      },
    }
  }

  /** The style on screen now. */
  style(now = Date.now()): SaverStyle {
    return styleAt(this.preview ?? this.settings.style, now)
  }

  onKey(key: Key): void {
    if (this.preview) {
      this.store.lock = undefined
      return
    }
    this.lock.onKey(key)
  }

  /** Starts polling and the frame timer; returns the stop function (the component unmounts). */
  start(repaint: () => void): () => void {
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const refresh = () => void this.model.refresh().catch(() => undefined)
    refresh()
    const poll = setInterval(refresh, 1000)
    const frame = () => {
      if (stopped) return
      repaint()
      const now = Date.now()
      timer = setTimeout(frame, nextFrameDelay(this.style(now), now))
    }
    timer = setTimeout(frame, FIRST_FRAME_MILLIS)
    return () => {
      stopped = true
      clearTimeout(timer)
      clearInterval(poll)
    }
  }

  /** The input for one frame. */
  input(width: number, height: number, now = Date.now()): SaverInput {
    const s = this.store
    return {
      style: this.style(now), now, width, height,
      tiles: this.model.tiles().map((state) => ({ state, stale: this.model.isStale(state, now) })),
      server: s.status.server.replace(/^https?:\/\//, '') || 'not connected',
      profile: s.status.profile || s.target?.name || '',
      brand: (s.meta?.branding as { appName?: string } | undefined)?.appName ?? 'QQQ',
      ascii: isAscii(), theme: theme(), ramp: glyphs().spark,
      shortName: this.shortName, burnin: this.settings.burnin, dim: isDimmed(now - this.startedAt, this.settings.dimMinutes),
      locked: !this.preview && hasPin(), preview: Boolean(this.preview),
      pin: !this.preview && this.lock.asking ? { length: this.lock.pin.value.length, message: this.lock.message } : undefined,
    }
  }

  render(width: number, height: number) {
    return <SaverView saver={this} width={width} height={height} />
  }
}

const FIRST_FRAME_MILLIS = 250

function SaverView({ saver, width, height }: { saver: SaverOverlay; width: number; height: number }) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => saver.start(force), [saver])
  const canvas = paintSaver(saver.input(width, height))
  const rows: React.ReactNode[] = []
  for (let y = 0; y < height; y++) {
    rows.push(
      <text key={y} flexShrink={0} wrapMode="none">
        {canvas.runs(y).map((r, i) => <span key={i} fg={r.fg} bg={r.bg}>{r.bold ? <strong>{r.text}</strong> : r.text}</span>)}
      </text>,
    )
  }
  return (
    <box position="absolute" left={0} top={0} width={width} height={height} overflow="hidden" zIndex={100} flexDirection="column" backgroundColor={theme().overlayBg}>
      {rows}
    </box>
  )
}

/** `:saver` arguments: a style to preview, `style <s>`, `refresh <seconds>`, `tables <a,b>`, `burnin on|off`, `dim <minutes|off>`. */
export function saverCommand(store: AppStore, args: string[], fail: (text: string) => void): void {
  const [first, ...rest] = args
  const profile = store.status.profile || store.target?.name
  if (!first || isStyle(first)) {
    store.lock = new SaverOverlay(store, (first as SaverStyleSetting | undefined) ?? readSaverSettings(profile).style)
    return store.bump()
  }
  if (first === 'style') {
    if (!isStyle(rest[0])) return fail(`saver style: auto, ${SAVER_STYLES.join(', ')}`)
    writeSaverSettings({ style: rest[0] })
    return store.flash(`screen saver style ${rest[0]} (saved)`)
  }
  if (first === 'refresh') {
    const n = Number(rest[0])
    if (!Number.isFinite(n)) return fail('saver refresh <seconds>: 10 to 30')
    writeSaverSettings({ refreshSeconds: n })
    return store.flash(`screen saver tiles refresh every ${readSaverSettings(profile).refreshSeconds} s (saved)`)
  }
  if (first === 'tables') {
    const tables = rest.join(',').split(',').map((t) => t.trim()).filter(Boolean)
    const unknown = tables.filter((t) => store.meta?.tables && !(t in store.meta.tables))
    if (unknown.length) return fail(`no such table: ${unknown.join(', ')}`)
    writeSaverSettings({ tables }, profile)
    return store.flash(tables.length ? `screen saver counts ${tables.slice(0, 3).join(', ')} for this profile` : 'screen saver table counts off')
  }
  if (first === 'burnin') {
    if (rest[0] !== 'on' && rest[0] !== 'off') return fail('saver burnin on|off: on moves every element so nothing burns in')
    writeSaverSettings({ burnin: rest[0] === 'on' })
    return store.flash(`screen saver burn-in guard ${rest[0]} (saved)`)
  }
  if (first === 'dim') {
    const n = rest[0] === 'off' ? 0 : Number(rest[0])
    if (rest[0] !== 'off' && (!Number.isFinite(n) || n < 1)) return fail('saver dim <minutes|off>: dim the saver after this many minutes')
    writeSaverSettings({ dimMinutes: n })
    const minutes = readSaverSettings(profile).dimMinutes
    return store.flash(minutes ? `screen saver dims after ${minutes} min (saved)` : 'screen saver dimming off (saved)')
  }
  fail('saver [auto|bounce|starfield|flip|big] previews · saver style <s> · saver refresh <seconds> · saver tables <a,b> · saver burnin on|off · saver dim <minutes|off>')
}

/** Completions for `:saver …`. */
export const SAVER_WORDS = ['auto', ...SAVER_STYLES, 'style', 'refresh', 'tables', 'burnin', 'dim']

/** The Settings entries of the F9 menu: style, refresh interval, burn-in guard, dim, preview. */
export function saverMenuEntries(store: AppStore): MenuEntry[] {
  const profile = store.status.profile || store.target?.name
  const current = readSaverSettings(profile)
  const styles: SaverStyleSetting[] = ['auto', ...SAVER_STYLES]
  return [
    {
      section: 'Settings', label: `Screen saver style: ${current.style}`, command: 'saver style <style>',
      run: () => store.open(new ChoiceOverlay<SaverStyleSetting>(store, 'Screen saver style', styles.map((v) => ({ label: STYLE_LABELS[v], value: v })), (v) => {
        writeSaverSettings({ style: v })
        store.flash(`screen saver style ${v} (saved)`)
      }, 'Enter chooses · :saver <style> previews', styles.indexOf(current.style))),
    },
    {
      section: 'Settings', label: `Screen saver refresh: ${current.refreshSeconds} s`, command: 'saver refresh <seconds>',
      run: () => store.open(new ChoiceOverlay<number>(store, 'Refresh the screen saver tiles every', REFRESH_CHOICES.map((n) => ({ label: `${n} seconds`, value: n })), (n) => {
        writeSaverSettings({ refreshSeconds: n })
        store.flash(`screen saver tiles refresh every ${n} s (saved)`)
      }, 'Enter chooses', Math.max(0, (REFRESH_CHOICES as readonly number[]).indexOf(current.refreshSeconds)))),
    },
    {
      section: 'Settings', label: `Screen saver burn-in guard: ${current.burnin ? 'on' : 'off'}`, command: 'saver burnin on|off',
      run: () => store.open(new ChoiceOverlay<boolean>(store, 'Move every element of the screen saver so nothing burns in', [
        { label: 'On: everything drifts', value: true }, { label: 'Off: fixed layout', value: false },
      ], (v) => {
        writeSaverSettings({ burnin: v })
        store.flash(`screen saver burn-in guard ${v ? 'on' : 'off'} (saved)`)
      }, 'Enter chooses', current.burnin ? 0 : 1)),
    },
    {
      section: 'Settings', label: `Screen saver dim: ${current.dimMinutes ? `after ${current.dimMinutes} min` : 'off'}`, command: 'saver dim <minutes|off>',
      run: () => store.open(new ChoiceOverlay<number>(store, 'Dim the screen saver after', DIM_CHOICES.map((n) => ({ label: n ? `${n} minutes` : 'never', value: n })), (n) => {
        writeSaverSettings({ dimMinutes: n })
        store.flash(n ? `screen saver dims after ${n} min (saved)` : 'screen saver dimming off (saved)')
      }, 'Enter chooses · :saver dim <minutes|off> for another time', Math.max(0, (DIM_CHOICES as readonly number[]).indexOf(current.dimMinutes)))),
    },
    { section: 'Settings', label: 'Preview the screen saver', command: 'saver', run: () => saverCommand(store, [], (t) => store.flash(t, 'error')) },
  ]
}
