/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/** The function-key decoder (keys/fkeys.ts), per sequence family, and the stdin rewrite into what OpenTUI reads. */

import { EventEmitter } from 'node:events'
import { describe, expect, test } from 'bun:test'
import { parseKeypress } from '@opentui/core'
import { bankKey, canonicalSequence, chordName, decodeFKey, fkeyChord, legacyProfile, rewriteFKeyInput, shiftNumber, type FKeyChord, type LegacyProfile } from '../src/keys/fkeys'
import { CPR_QUIET_MS, installFKeyRewrite } from '../src/keys/stdin-rewrite'

const E = '\x1b'
const name = (seq: string, profile: LegacyProfile = 'vt220') => {
  const d = decodeFKey(seq, profile)
  return d ? chordName(d.chord) : undefined
}
const family = (seq: string, profile: LegacyProfile = 'vt220') => decodeFKey(seq, profile)?.family

/** What OpenTUI makes of a sequence after the rewrite (kitty parsing on, as the renderer runs). */
function opentui(seq: string, profile: LegacyProfile = 'vt220'): string | undefined {
  const k = parseKeypress(rewriteFKeyInput(seq, profile, { cpr: true }), { useKittyKeyboard: true })
  if (!k?.name) return undefined
  return `${k.ctrl ? 'ctrl+' : ''}${k.meta ? 'alt+' : ''}${k.shift ? 'shift+' : ''}${k.name}`
}

describe('xterm modifier forms (tmux, iTerm2, Windows Terminal, xterm, VTE)', () => {
  const shift = ['1;2P', '1;2Q', '1;2R', '1;2S', '15;2~', '17;2~', '18;2~', '19;2~', '20;2~', '21;2~', '23;2~', '24;2~']
  test('Shift+F1…F12', () => {
    shift.forEach((s, i) => expect(name(`${E}[${s}`)).toBe(`shift+f${i + 1}`))
    expect(family(`${E}[1;2P`)).toBe('csi-letter')
    expect(family(`${E}[1;2R`)).toBe('csi-f3-cpr')
    expect(family(`${E}[15;2~`)).toBe('csi-tilde')
  })
  test('SS3 with a modifier and the plain F1–F4', () => {
    expect(name(`${E}O2P`)).toBe('shift+f1')
    expect(name(`${E}O2S`)).toBe('shift+f4')
    expect(name(`${E}OQ`)).toBe('f2')
    expect(family(`${E}O2R`)).toBe('ss3')
  })
  test('CSI 11..14 forms (VT220, PuTTY) with and without modifiers', () => {
    expect(name(`${E}[11~`)).toBe('f1')
    expect(name(`${E}[12;2~`)).toBe('shift+f2')
    expect(name(`${E}[14;2~`)).toBe('shift+f4')
  })
  test('Ctrl, Alt and combinations come for free', () => {
    expect(name(`${E}[1;5P`)).toBe('ctrl+f1')
    expect(name(`${E}[15;5~`)).toBe('ctrl+f5')
    expect(name(`${E}[24;5~`)).toBe('ctrl+f12')
    expect(name(`${E}[1;6P`)).toBe('ctrl+shift+f1')
    expect(name(`${E}[20;3~`)).toBe('alt+f9')
    expect(name(`${E}${E}[1;2P`)).toBe('alt+shift+f1')
    expect(name(`${E}[1;5R`)).toBe('ctrl+f3')
  })
  test('OpenTUI reads all of them after the rewrite, Shift+F3 included', () => {
    shift.forEach((s, i) => expect(opentui(`${E}[${s}`)).toBe(`shift+f${i + 1}`))
    expect(opentui(`${E}[1;5R`)).toBe('ctrl+f3')
    // without the rewrite OpenTUI drops Shift+F3: it looks like a cursor position report
    expect(parseKeypress(`${E}[1;2R`, { useKittyKeyboard: true })).toBeNull()
  })
})

describe('kitty keyboard protocol', () => {
  test('F3 is CSI 13 ~; event sub-parameters; the CSI u code points', () => {
    expect(name(`${E}[13;2~`)).toBe('shift+f3')
    expect(name(`${E}[15;2:2~`)).toBe('shift+f5')
    expect(decodeFKey(`${E}[1;2:3Q`)!.chord).toEqual({ n: 2, shift: true, ctrl: false, alt: false, release: true })
    expect(name(`${E}[57364;2u`)).toBe('shift+f1')
    expect(name(`${E}[57375;2u`)).toBe('shift+f12')
    expect(family(`${E}[57365;2u`)).toBe('kitty-u')
    // F13 and up are keys of their own (macOS keyboards have them)
    expect(decodeFKey(`${E}[57376;2u`)).toBeUndefined()
  })
  test('OpenTUI reads the kitty forms itself (no rewrite)', () => {
    expect(rewriteFKeyInput(`${E}[13;2~`, 'vt220', { cpr: true })).toBe(`${E}[13;2~`)
    expect(opentui(`${E}[13;2~`)).toBe('shift+f3')
    expect(opentui(`${E}[57364;2u`)).toBe('shift+f1')
  })
})

describe('legacy numbered forms, per terminal profile', () => {
  const codes = ['25~', '26~', '28~', '29~', '31~', '32~', '33~', '34~']
  test('vt220 (F13 = Shift+F1): CSI 25~…34~ are Shift+F1…F8', () => {
    codes.forEach((c, i) => expect(name(`${E}[${c}`, 'vt220')).toBe(`shift+f${i + 1}`))
    expect(family(`${E}[25~`)).toBe('legacy-number')
  })
  test('rxvt and the Linux console (F11 = Shift+F1): Shift+F3…F10', () => {
    codes.forEach((c, i) => expect(name(`${E}[${c}`, 'rxvt')).toBe(`shift+f${i + 3}`))
    // CSI 23~ / 24~ stay F11 / F12 everywhere (rxvt's Shift+F1 / F2 cannot be told apart from them)
    expect(name(`${E}[23~`, 'rxvt')).toBe('f11')
  })
  test('macOS Terminal.app: Shift+F5…F12', () => {
    codes.forEach((c, i) => expect(name(`${E}[${c}`, 'apple')).toBe(`shift+f${i + 5}`))
  })
  test('modern terminals: legacy numbers mean nothing (Windows Terminal sends CSI 29~ for the Menu key)', () => {
    for (const c of codes) expect(decodeFKey(`${E}[${c}`, 'modern')).toBeUndefined()
    expect(rewriteFKeyInput(`${E}[29~`, 'modern', { cpr: true })).toBe(`${E}[29~`)
  })
  test('the rewrite gives OpenTUI the canonical form', () => {
    expect(opentui(`${E}[25~`, 'vt220')).toBe('shift+f1')
    expect(opentui(`${E}[26~`, 'vt220')).toBe('shift+f2')
    expect(opentui(`${E}[33~`, 'apple')).toBe('shift+f11')
    expect(opentui(`${E}[34~`, 'rxvt')).toBe('shift+f10')
  })
})

describe('rxvt suffixes and the Linux console', () => {
  test('$ Shift, ^ Ctrl, @ Ctrl+Shift', () => {
    expect(name(`${E}[23$`)).toBe('shift+f11')
    expect(name(`${E}[24$`)).toBe('shift+f12')
    expect(name(`${E}[11^`)).toBe('ctrl+f1')
    expect(name(`${E}[15^`)).toBe('ctrl+f5')
    expect(name(`${E}[24^`)).toBe('ctrl+f12')
    expect(name(`${E}[25^`)).toBe('ctrl+shift+f3')
    expect(name(`${E}[23@`)).toBe('ctrl+shift+f11')
    expect(family(`${E}[15^`)).toBe('rxvt-suffix')
    expect(opentui(`${E}[23$`)).toBe('shift+f11')
    expect(opentui(`${E}[15^`)).toBe('ctrl+f5')
  })
  test('editing keys with the same suffixes are not function keys', () => {
    expect(decodeFKey(`${E}[2$`)).toBeUndefined()
    expect(decodeFKey(`${E}[5^`)).toBeUndefined()
    expect(rewriteFKeyInput(`${E}[3^`, 'rxvt', { cpr: true })).toBe(`${E}[3^`)
  })
  test('Linux console CSI [ A…E are F1…F5', () => {
    expect(name(`${E}[[A`)).toBe('f1')
    expect(name(`${E}[[E`)).toBe('f5')
  })
})

describe('the rewrite', () => {
  test('leaves cursor reports alone during the probe, and CSI 1;1R always', () => {
    expect(rewriteFKeyInput(`${E}[1;2R`, 'vt220', { cpr: false })).toBe(`${E}[1;2R`)
    expect(rewriteFKeyInput(`${E}[1;1R`, 'vt220', { cpr: true })).toBe(`${E}[1;1R`)
    expect(rewriteFKeyInput(`${E}[12;40R`, 'vt220', { cpr: true })).toBe(`${E}[12;40R`)
    expect(rewriteFKeyInput(`${E}[1;2R`, 'vt220', { cpr: true })).toBe(`${E}[13;2~`)
  })
  test('rewrites inside a chunk, keeps text and other sequences, never touches a paste', () => {
    expect(rewriteFKeyInput(`ab${E}[25~${E}[A${E}[1;2R`, 'vt220', { cpr: true })).toBe(`ab${E}[11;2~${E}[A${E}[13;2~`)
    expect(rewriteFKeyInput(`${E}[200~${E}[25~${E}[201~`, 'vt220', { cpr: true })).toBe(`${E}[200~${E}[25~${E}[201~`)
    expect(rewriteFKeyInput('plain', 'vt220', { cpr: true })).toBe('plain')
  })
  test('canonical sequences', () => {
    const c = (n: number, mods: Partial<FKeyChord> = {}): FKeyChord => ({ n, shift: false, ctrl: false, alt: false, ...mods })
    expect(canonicalSequence(c(1, { shift: true }))).toBe(`${E}[11;2~`)
    expect(canonicalSequence(c(3, { ctrl: true }))).toBe(`${E}[13;5~`)
    expect(canonicalSequence(c(12))).toBe(`${E}[24~`)
  })
  test('on the stream: Buffer chunks before any listener; quiet after a resume; dispose restores', () => {
    const stream = new EventEmitter()
    const seen: string[] = []
    stream.on('data', (d: Buffer | string) => seen.push(Buffer.isBuffer(d) ? d.toString('latin1') : d))
    let now = 1000
    const r = installFKeyRewrite(stream, 'vt220', () => now)
    stream.emit('data', Buffer.from(`${E}[1;2R`))
    stream.emit('data', Buffer.from(`${E}[25~`))
    now += CPR_QUIET_MS
    stream.emit('data', Buffer.from(`${E}[1;2R`))
    r.quiet()
    stream.emit('data', `${E}[1;2R`)
    stream.emit('data', Buffer.from('é', 'utf8'))
    r.dispose()
    stream.emit('data', `${E}[25~`)
    expect(seen).toEqual([`${E}[1;2R`, `${E}[11;2~`, `${E}[13;2~`, `${E}[1;2R`, Buffer.from('é', 'utf8').toString('latin1'), `${E}[25~`])
  })
})

describe('key events and the profile', () => {
  test('fkeyChord and bankKey: Shift (only) becomes the Shift bank; Ctrl+F keeps acting as F', () => {
    expect(bankKey({ name: 'f2', sequence: `${E}[1;2Q`, shift: true }).name).toBe('shift+f2')
    expect(bankKey({ name: 'f2', sequence: `${E}OQ` }).name).toBe('f2')
    expect(bankKey({ name: 'f5', sequence: '', ctrl: true }).name).toBe('f5')
    expect(bankKey({ name: 'f1', sequence: '', ctrl: true, shift: true }).name).toBe('f1')
    expect(bankKey({ name: 'f9', sequence: '', meta: true, shift: true }).name).toBe('f9')
    // a sequence OpenTUI left unnamed is decoded from its bytes
    expect(bankKey({ name: '', sequence: `${E}[26~` }, 'vt220').name).toBe('shift+f2')
    expect(bankKey({ name: 'menu', sequence: `${E}[29~` }, 'modern').name).toBe('menu')
    expect(fkeyChord({ name: 'f13', sequence: '' })).toBeUndefined()
    expect(fkeyChord({ name: 'x', sequence: 'x' })).toBeUndefined()
    expect(shiftNumber({ name: 'shift+f10', sequence: '' })).toBe(10)
    expect(shiftNumber({ name: 'f10', sequence: '' })).toBeUndefined()
  })
  test('legacyProfile from the environment', () => {
    expect(legacyProfile({ TERM_PROGRAM: 'Apple_Terminal', TERM: 'xterm-256color' })).toBe('apple')
    expect(legacyProfile({ TERM_PROGRAM: 'iTerm.app', TERM: 'xterm-256color' })).toBe('modern')
    expect(legacyProfile({ WT_SESSION: 'x', TERM: 'xterm-256color' })).toBe('modern')
    expect(legacyProfile({ TMUX: '/tmp/x', TERM: 'tmux-256color', TERM_PROGRAM: 'tmux' })).toBe('modern')
    expect(legacyProfile({ TERM: 'rxvt-unicode-256color' })).toBe('rxvt')
    expect(legacyProfile({ TERM: 'linux' })).toBe('rxvt')
    expect(legacyProfile({ TERM: 'xterm' })).toBe('vt220')
    expect(legacyProfile({ TERM: 'xterm', QQQ_FKEYS: 'apple' })).toBe('apple')
    expect(legacyProfile({ TERM: 'xterm', QQQ_FKEYS: 'bogus' })).toBe('vt220')
  })
})
