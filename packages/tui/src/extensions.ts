/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * The installed server extensions, from GET /version `extensions`. A stand-in for the kernel's
 * extension registry (branch feat/m1-extensions): the TUI only asks `has(name)` and `get(name)`,
 * so swapping in the kernel registry is a one-line change. Panels and `:` commands of an extension
 * appear only when it is installed; otherwise the command says it is not.
 */

import type { VersionInfo } from './client'

export interface ExtensionInfo {
  name: string
  version: string
  pathPrefix?: string
  description?: string
}

export class Extensions {
  private list: ExtensionInfo[] = []

  load(version: VersionInfo | undefined): void {
    this.list = [...(version?.extensions ?? [])]
  }

  has(name: string): boolean {
    return this.list.some((e) => e.name === name)
  }

  get(name: string): ExtensionInfo | undefined {
    return this.list.find((e) => e.name === name)
  }

  all(): ExtensionInfo[] {
    return [...this.list]
  }

  /** The message for a command of an extension that is not installed. */
  missing(name: string): string {
    return `The ${name} extension is not installed on this server.`
  }
}
