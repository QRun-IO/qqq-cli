/*
 * Copyright 2026 QRun.IO, Inc.
 * Licensed under the Apache License, Version 2.0 (see LICENSE).
 */

/**
 * prepack hook of each published package: copies the repository's LICENSE into the package
 * directory so npm packs it (npm only picks up a LICENSE from the package root). The copies are
 * git-ignored.
 *
 * Usage (from a package directory): node ../../scripts/copy-license.mjs
 */

import { copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

copyFileSync(resolve(import.meta.dirname, '..', 'LICENSE'), join(process.cwd(), 'LICENSE'))
