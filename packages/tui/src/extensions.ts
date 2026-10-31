/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The installed server extensions, through the kernel's ExtensionRegistry (from GET /version).
 * Panels and `:` commands of an extension appear only when it is installed; otherwise the
 * command says it is not.
 */

import { ExtensionRegistry, type InstalledExtension } from '@qrun-io/qqq-core'
import type { VersionInfo } from './client'

export class Extensions {
  registry = new ExtensionRegistry([])

  load(version: VersionInfo | undefined): void {
    this.registry = ExtensionRegistry.fromVersion((version ?? { apiVersion: '' }) as never)
  }

  has(name: string): boolean {
    return this.registry.has(name)
  }

  get(name: string): InstalledExtension | undefined {
    return this.registry.installed.find((e) => e.name === name)
  }

  all(): InstalledExtension[] {
    return [...this.registry.installed]
  }

  describe(): string {
    return this.registry.describe()
  }

  /** The message for a command of an extension that is not installed. */
  missing(name: string): string {
    return `The ${name} extension is not installed on this server (installed: ${this.registry.describe()}).`
  }
}
