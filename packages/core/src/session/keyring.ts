/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Secret storage behind one interface, with no native modules (so Bun single binaries work):
 * macOS Keychain through `security`, Linux Secret Service through `secret-tool`, Windows through
 * DPAPI via PowerShell, and a 0600 file for headless hosts or when QQQ_KEYRING=file.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { configDir } from './profiles.js'

const run = promisify(execFile)

export interface SecretStore {
  readonly kind: string
  get(account: string): Promise<string | undefined>
  set(account: string, secret: string): Promise<void>
  delete(account: string): Promise<boolean>
}

const SERVICE = 'qqq'

/** A secrets file that is not valid JSON: refused, so saving one sign-in never wipes the others. */
export class SecretFileError extends Error {}

function readSecretsFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {}
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, string>
  } catch {
    // reported below
  }
  throw new SecretFileError(`${file} is not a valid secrets file; fix or remove it (sign in again afterwards)`)
}

/** macOS Keychain. */
export class KeychainStore implements SecretStore {
  readonly kind = 'macos-keychain'
  async get(account: string): Promise<string | undefined> {
    try {
      const { stdout } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w'])
      return stdout.replace(/\n$/, '')
    } catch {
      return undefined
    }
  }
  async set(account: string, secret: string): Promise<void> {
    await run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', account, '-l', `qqq: ${account}`, '-w', secret])
  }
  async delete(account: string): Promise<boolean> {
    try {
      await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account])
      return true
    } catch {
      return false
    }
  }
}

/** Linux Secret Service (GNOME Keyring, KWallet via the portal) through secret-tool. */
export class SecretServiceStore implements SecretStore {
  readonly kind = 'secret-service'
  async get(account: string): Promise<string | undefined> {
    try {
      const { stdout } = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account])
      return stdout === '' ? undefined : stdout
    } catch {
      return undefined
    }
  }
  async set(account: string, secret: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = execFile('secret-tool', ['store', '--label', `qqq: ${account}`, 'service', SERVICE, 'account', account], (error) => (error ? reject(error) : resolve()))
      child.stdin?.end(secret)
    })
  }
  async delete(account: string): Promise<boolean> {
    try {
      await run('secret-tool', ['clear', 'service', SERVICE, 'account', account])
      return true
    } catch {
      return false
    }
  }
}

/** Windows: a file whose values are protected with DPAPI for the current user (PowerShell). */
export class DpapiFileStore implements SecretStore {
  readonly kind = 'windows-dpapi'
  constructor(private readonly file = join(configDir(), 'secrets.dpapi.json')) {}
  private read(): Record<string, string> {
    return readSecretsFile(this.file)
  }
  private write(data: Record<string, string>): void {
    mkdirSync(join(this.file, '..'), { recursive: true })
    writeFileSync(this.file, JSON.stringify(data, null, 2))
  }
  private async ps(script: string, input: string): Promise<string> {
    const shell = process.env.QQQ_POWERSHELL ?? 'powershell'
    const command = "$ErrorActionPreference = 'Stop'; [Console]::InputEncoding = [Text.UTF8Encoding]::new($false); "
      + '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $qqqSecretInput = [Console]::In.ReadToEnd(); '
      + '$qqqResult = & { ' + script.replace('$INPUT', '$qqqSecretInput') + ' }; '
      + '[Console]::Write((ConvertTo-Json -InputObject $qqqResult -Compress))'
    return new Promise<string>((resolve, reject) => {
      const failed = () => reject(new Error('Windows credential protection failed; check PowerShell and your Windows profile'))
      const child = execFile(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 15000 }, (error, stdout) => {
        if (error) { failed(); return }
        try {
          const result: unknown = JSON.parse(stdout.trim())
          if (typeof result !== 'string') { failed(); return }
          resolve(result)
        } catch { failed() }
      })
      child.stdin?.on('error', failed)
      child.stdin?.end(input, 'utf8')
    })
  }
  async get(account: string): Promise<string | undefined> {
    const blob = this.read()[account]
    if (!blob) return undefined
    return this.ps('$s = ConvertTo-SecureString -String $INPUT; $p = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($p) } finally { [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p); $s.Dispose() }', blob)
  }
  async set(account: string, secret: string): Promise<void> {
    const blob = await this.ps('ConvertTo-SecureString -String $INPUT -AsPlainText -Force | ConvertFrom-SecureString', secret)
    const data = this.read()
    data[account] = blob
    this.write(data)
  }
  async delete(account: string): Promise<boolean> {
    const data = this.read()
    const had = account in data
    delete data[account]
    this.write(data)
    return had
  }
}

/** A JSON file, mode 0600: the fallback, and the choice for CI and headless hosts. */
export class FileStore implements SecretStore {
  readonly kind = 'file'
  constructor(private readonly file = join(configDir(), 'secrets.json')) {}
  private read(): Record<string, string> {
    return readSecretsFile(this.file)
  }
  private write(data: Record<string, string>): void {
    mkdirSync(join(this.file, '..'), { recursive: true, mode: 0o700 })
    writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 })
  }
  async get(account: string): Promise<string | undefined> {
    return this.read()[account]
  }
  async set(account: string, secret: string): Promise<void> {
    const data = this.read()
    data[account] = secret
    this.write(data)
  }
  async delete(account: string): Promise<boolean> {
    const data = this.read()
    const had = account in data
    delete data[account]
    this.write(data)
    return had
  }
}

function commandExists(name: string): boolean {
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  const names = process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, name] : [name]
  return dirs.some((d) => names.some((n) => existsSync(join(d, n))))
}

/**
 * The secret store for this host: QQQ_KEYRING=file|keychain|secret-service|dpapi forces one;
 * otherwise the platform's, falling back to the file when its tool is absent.
 */
export function defaultSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  const forced = env.QQQ_KEYRING
  if (forced === 'file') return new FileStore()
  if (forced === 'keychain') return new KeychainStore()
  if (forced === 'secret-service') return new SecretServiceStore()
  if (forced === 'dpapi') return new DpapiFileStore()
  if (process.platform === 'darwin' && commandExists('security')) return new KeychainStore()
  if (process.platform === 'linux' && commandExists('secret-tool') && (env.DBUS_SESSION_BUS_ADDRESS || env.XDG_RUNTIME_DIR)) return new SecretServiceStore()
  if (process.platform === 'win32') return new DpapiFileStore()
  return new FileStore()
}
