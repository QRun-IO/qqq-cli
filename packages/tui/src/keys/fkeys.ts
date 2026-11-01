/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The one decoder for function keys with modifiers (Shift+F1…F12, Ctrl+F-keys, Alt), across the
 * forms terminals send:
 *
 *  - xterm modifier forms: `CSI 1;m P|Q|R|S` (F1–F4), `SS3 m P…S`, `CSI n;m ~` (F5–F12; also
 *    `CSI 11..14;m ~` and kitty's `CSI 13;m ~` for F3), m = 1 + shift + 2·alt + 4·ctrl
 *    (tmux, iTerm2, Windows Terminal, xterm, VTE, Konsole, Alacritty);
 *  - the kitty keyboard protocol: the same forms with `:event` sub-parameters, and `CSI 57364..57375;m u`;
 *  - legacy numbered forms with no modifier parameter, which mean different keys per terminal:
 *    `CSI 25~ … CSI 34~` is Shift+F1…F8 with the VT220 numbering (F13 = Shift+F1), Shift+F3…F10 on
 *    rxvt and the Linux console (F11 = Shift+F1), Shift+F5…F12 on macOS Terminal.app;
 *  - rxvt's suffixes: `CSI n $` Shift, `CSI n ^` Ctrl, `CSI n @` Ctrl+Shift;
 *  - the Linux console's `CSI [ A…E` (F1–F5).
 *
 * OpenTUI 0.8 reads the xterm and kitty forms itself, except Shift+F3 (`CSI 1;2R`) and the other
 * modified F3s: they look like a cursor position report, so OpenTUI takes them as one and drops them.
 * It reads none of the legacy or rxvt forms. `rewriteFKeyInput` turns exactly those into the
 * canonical `CSI n;m ~` form before OpenTUI sees the bytes (stdin-rewrite.ts), so every terminal
 * ends up as one OpenTUI key event (name `f3`, shift true), which `bankKey` names `shift+f3`.
 */

import type { Key } from '../keys'

/** A function key with its modifiers. */
export interface FKeyChord {
  /** 1..12 */
  n: number
  shift: boolean
  ctrl: boolean
  alt: boolean
  /** A kitty key-release event (nothing to do). */
  release?: boolean
}

/** Which sequence family a chord was read from. */
export type FKeyFamily = 'ss3' | 'csi-letter' | 'csi-f3-cpr' | 'csi-tilde' | 'kitty-u' | 'legacy-number' | 'rxvt-suffix' | 'linux-console'

/**
 * How a terminal numbers its legacy shifted F-keys (`CSI 25~` and up): `vt220` (F13 = Shift+F1),
 * `rxvt` (rxvt, urxvt, the Linux console: F11 = Shift+F1), `apple` (macOS Terminal.app: Shift+F5 is
 * `CSI 25~`), `modern` (the terminal only sends the xterm forms; legacy numbers mean nothing).
 */
export type LegacyProfile = 'vt220' | 'rxvt' | 'apple' | 'modern'

export const LEGACY_PROFILES: LegacyProfile[] = ['vt220', 'rxvt', 'apple', 'modern']

/** The `CSI n ~` number of F1..F12. */
const TILDE_CODE = [0, 11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24]
const TILDE_TO_N: Record<number, number> = Object.fromEntries(TILDE_CODE.map((code, n) => [code, n]).filter(([, n]) => n > 0))
const LETTER_TO_N: Record<string, number> = { P: 1, Q: 2, R: 3, S: 4 }
const LINUX_TO_N: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5 }
/** kitty's private-use code points for F1..F12 (F13 and up are real keys of their own). */
const KITTY_F1 = 57364

/** Legacy numbers (no modifier) that stand for Shift+F-keys, per profile. */
const LEGACY_SHIFT: Record<LegacyProfile, Record<number, number>> = {
  vt220: { 25: 1, 26: 2, 28: 3, 29: 4, 31: 5, 32: 6, 33: 7, 34: 8 },
  rxvt: { 25: 3, 26: 4, 28: 5, 29: 6, 31: 7, 32: 8, 33: 9, 34: 10 },
  apple: { 25: 5, 26: 6, 28: 7, 29: 8, 31: 9, 32: 10, 33: 11, 34: 12 },
  modern: {},
}

/** The profile for this terminal: QQQ_FKEYS overrides; otherwise from TERM_PROGRAM, TERM and friends. */
export function legacyProfile(env: NodeJS.ProcessEnv = process.env): LegacyProfile {
  const forced = env.QQQ_FKEYS?.trim().toLowerCase()
  if (forced && (LEGACY_PROFILES as string[]).includes(forced)) return forced as LegacyProfile
  const program = env.TERM_PROGRAM ?? ''
  const term = env.TERM ?? ''
  if (program === 'Apple_Terminal') return 'apple'
  // tmux re-encodes the keys it knows in the xterm forms; Windows Terminal sends CSI 29~ for the Menu key
  if (env.TMUX || env.WT_SESSION || /^(iTerm\.app|WezTerm|ghostty|vscode|tmux)$/.test(program) || /kitty|ghostty|alacritty|foot/.test(term)) return 'modern'
  if (/^(rxvt|linux)/.test(term)) return 'rxvt'
  return 'vt220'
}

function modifiers(m: number): Pick<FKeyChord, 'shift' | 'ctrl' | 'alt'> {
  const bits = Math.max(0, m - 1)
  return { shift: Boolean(bits & 1), alt: Boolean(bits & 2), ctrl: Boolean(bits & 4) }
}

/** `m` or `m:event` → modifier number and whether it is a kitty release. */
function modParam(p: string | undefined): { m: number; release: boolean } {
  if (!p) return { m: 1, release: false }
  const [m, event] = p.split(':')
  return { m: Number(m) || 1, release: event === '3' }
}

function chord(n: number, m: number, release = false, alt = false): FKeyChord | undefined {
  if (!(n >= 1 && n <= 12)) return undefined
  const mods = modifiers(m)
  const out: FKeyChord = { n, ...mods, alt: mods.alt || alt }
  if (release) out.release = true
  return out
}

/** Reads one whole sequence; undefined when it is not a function key. */
export function decodeFKey(seq: string, profile: LegacyProfile = 'vt220'): { chord: FKeyChord; family: FKeyFamily } | undefined {
  // an extra ESC in front is Alt (meta) on terminals that send it that way
  let s = seq
  let alt = false
  if (s.startsWith('\x1b\x1b')) {
    alt = true
    s = s.slice(1)
  }
  let m: RegExpExecArray | null
  if ((m = /^\x1bO(\d*)([PQRS])$/.exec(s))) {
    const c = chord(LETTER_TO_N[m[2]!]!, Number(m[1]) || 1, false, alt)
    return c && { chord: c, family: 'ss3' }
  }
  if ((m = /^\x1b\[(?:1;)?(\d+(?::\d+)?)?([PQRS])$/.exec(s))) {
    const { m: mod, release } = modParam(m[1])
    const c = chord(LETTER_TO_N[m[2]!]!, mod, release, alt)
    return c && { chord: c, family: m[2] === 'R' ? 'csi-f3-cpr' : 'csi-letter' }
  }
  if ((m = /^\x1b\[(\d+)(?:;(\d+(?::\d+)?))?~$/.exec(s))) {
    const code = Number(m[1])
    const { m: mod, release } = modParam(m[2])
    if (TILDE_TO_N[code]) {
      const c = chord(TILDE_TO_N[code]!, mod, release, alt)
      return c && { chord: c, family: 'csi-tilde' }
    }
    const shifted = LEGACY_SHIFT[profile][code]
    if (shifted && !m[2]) {
      const c = chord(shifted, 2, false, alt)
      return c && { chord: c, family: 'legacy-number' }
    }
    return undefined
  }
  if ((m = /^\x1b\[(\d+)([$^@])$/.exec(s))) {
    // rxvt: $ Shift, ^ Ctrl, @ Ctrl+Shift; 25..34 are the shifted F3..F10 there
    const code = Number(m[1])
    const suffix = m[2]!
    const base = TILDE_TO_N[code] ?? LEGACY_SHIFT.rxvt[code]
    if (!base) return undefined
    const shift = suffix !== '^' || LEGACY_SHIFT.rxvt[code] !== undefined
    const ctrl = suffix !== '$'
    const c = chord(base, 1 + (shift ? 1 : 0) + (ctrl ? 4 : 0), false, alt)
    return c && { chord: c, family: 'rxvt-suffix' }
  }
  if ((m = /^\x1b\[(\d+)(?:;(\d+(?::\d+)?))?u$/.exec(s))) {
    const { m: mod, release } = modParam(m[2])
    const c = chord(Number(m[1]) - KITTY_F1 + 1, mod, release, alt)
    return c && { chord: c, family: 'kitty-u' }
  }
  if ((m = /^\x1b\[\[([A-E])$/.exec(s))) {
    const c = chord(LINUX_TO_N[m[1]!]!, 1, false, alt)
    return c && { chord: c, family: 'linux-console' }
  }
  return undefined
}

/** `shift+f2`, `ctrl+f5`, `ctrl+shift+f1`, `alt+f3`, `f4`. */
export function chordName(c: FKeyChord): string {
  return `${c.ctrl ? 'ctrl+' : ''}${c.alt ? 'alt+' : ''}${c.shift ? 'shift+' : ''}f${c.n}`
}

/** The canonical xterm form OpenTUI reads for every modifier: `CSI n;m ~`. */
export function canonicalSequence(c: FKeyChord): string {
  const m = 1 + (c.shift ? 1 : 0) + (c.alt ? 2 : 0) + (c.ctrl ? 4 : 0)
  return `\x1b[${TILDE_CODE[c.n]}${m > 1 ? `;${m}` : ''}~`
}

/** Families OpenTUI 0.8 does not read (or reads as something else); these are rewritten. */
const NEEDS_REWRITE = new Set<FKeyFamily>(['csi-f3-cpr', 'legacy-number', 'rxvt-suffix'])

/**
 * Rewrites the function-key sequences OpenTUI cannot read into the canonical form, leaving every
 * other byte alone. `cpr` false leaves `CSI 1;m R` alone: during startup (and after a resume) those
 * bytes are real cursor position reports that OpenTUI's capability probe is waiting for. A chunk
 * inside a bracketed paste is never touched.
 */
export function rewriteFKeyInput(chunk: string, profile: LegacyProfile, options: { cpr: boolean }): string {
  if (!chunk.includes('\x1b') || chunk.includes('\x1b[200~')) return chunk
  return chunk.replace(/\x1b{1,2}\[(?:1;\d+R|\d+[~$^@])/g, (seq) => {
    if (seq.endsWith('R') && !options.cpr) return seq
    const found = decodeFKey(seq, profile)
    if (!found || !NEEDS_REWRITE.has(found.family)) return seq
    // Shift+F3 and friends only with a modifier: CSI 1;1R is always a cursor report
    if (found.family === 'csi-f3-cpr' && !found.chord.shift && !found.chord.ctrl && !found.chord.alt) return seq
    return canonicalSequence(found.chord)
  })
}

/** The chord of a key event from OpenTUI (or a test), when it is a function key. */
export function fkeyChord(key: Key, profile: LegacyProfile = 'vt220'): FKeyChord | undefined {
  const named = /^f(\d{1,2})$/.exec(key.name)
  if (named) {
    const n = Number(named[1])
    return n >= 1 && n <= 12 ? { n, shift: Boolean(key.shift), ctrl: Boolean(key.ctrl), alt: Boolean(key.meta) } : undefined
  }
  if (key.name && key.name !== 'menu') return undefined
  return key.sequence?.startsWith('\x1b') ? decodeFKey(key.sequence, profile)?.chord : undefined
}

/**
 * The key the store dispatches: Shift+F1…F12 (no Ctrl, no Alt) become `shift+f1`…`shift+f12` (the
 * Shift bank); everything else is left as it is (Ctrl+F5 still acts as F5: no Ctrl bank yet).
 */
export function bankKey(key: Key, profile: LegacyProfile = 'vt220'): Key {
  const c = fkeyChord(key, profile)
  if (!c || c.release || !c.shift || c.ctrl || c.alt) return key
  return { name: `shift+f${c.n}`, sequence: key.sequence ?? '', shift: true }
}

/** The Shift bank number of a dispatched key (`shift+f2` → 2), or undefined. */
export function shiftNumber(key: Key): number | undefined {
  const m = /^shift\+f(\d{1,2})$/.exec(key.name)
  return m ? Number(m[1]) : undefined
}
