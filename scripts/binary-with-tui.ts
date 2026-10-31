/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * Entry point of a qqq binary that carries the terminal UI (scripts/build-binaries.mjs --with-tui).
 * Only Bun builds it: the CLI stays a Node program, and `qqq ui` hands over to the bundled TUI in the
 * same process instead of spawning `bun run packages/tui/src/main.tsx` from a checkout.
 */

globalThis.__qqqRunTui = async (args: string[]) => {
  process.argv = [process.argv[0]!, 'qqq-ui', ...args]
  await import('../packages/tui/src/main.tsx')
}

await import('../packages/cli/src/main.ts')
