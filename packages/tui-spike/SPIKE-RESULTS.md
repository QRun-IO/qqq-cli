# M0 spike: OpenTUI (React) on Bun for the QQQ terminal UI

Date: 2026-10-31. Branch `spike/m0-opentui`. Throwaway code; the decision and findings are the deliverable.
Design context: `QRun-IO/.planning/research/tui-cli-clients.md` (section 8, spike exit criteria).

## Decision

**Go for OpenTUI 0.8.1 (React binding) on Bun 1.4.4**, with two conditions carried into M1:

1. Windows Terminal is cross-compiled only. Nobody has run the `.exe` yet. M1 adds a Windows x64 CI lane
   that runs the in-memory tests and a ConPTY smoke test before the TUI head is written.
2. Keyboard handling must not rely on React closures or on the `focused` prop for same-tick bursts
   (details below). The kernel's input layer keeps focus and cursor state in refs or a reducer.

## Exit criteria and results

| Criterion (from the design doc) | Result | Evidence |
|---|---|---|
| 10,000 rows x 40 columns page and sort without visible lag at 200 columns, macOS | **Pass.** Key press to painted frame: avg 1.6 ms at 200x49, avg 3.2 ms / p95 6.1 ms at 120x29; worst sample 13.6 ms (jump to End). Only the visible window is rendered, one `<text>` per row. | `results/perf-grid-tmux-120x29.json`, tmux captures in the session log |
| Same on Windows Terminal | **Not verified.** `dist/qqq-tui-spike-windows-x64.exe` compiles (126.6 MB) with the `@opentui/core-win32-x64` native; no Windows machine in this session. | condition 1 above |
| Sort 10,000 rows | **Pass.** String column 2.5 to 6 ms, numeric 2.6 ms, date 4 ms (`sortRows`, `localeCompare`). Server-side sorting is the real design anyway. | `test/_sortbench.ts` run, this file |
| A form with every field type | **Pass.** STRING, INTEGER, DECIMAL, BOOLEAN, DATE, DATE_TIME, TIME, PASSWORD (masked, custom), TEXT (`<textarea>`, multi-line), possible-value picker (filter + list + Enter), BLOB path. Tab / Shift+Tab, local validation, errors shown beside the field, Ctrl+S save. | `src/form.tsx`, tmux capture 2026-10-31 20:38 |
| One interactive process with an async job and progress | **Pass** against the real sample server (QQQ 4.1.0-SNAPSHOT `develop` 6ac64fc66, UI API 1.8.0, MOCK auth): `init` → `step` with `stepTimeoutMillis=0` → `JOB_STARTED` → `RUNNING` polled every 250 ms → `COMPLETE` with values after 4.17 s. The sample's `sleepInteractive` reports no `current`/`total`, so the bar is indeterminate; the code path for a determinate bar is in place. | `src/process.tsx`, `src/api.ts` |
| Resize and Ctrl+C leave the terminal clean | **Pass.** tmux resize 200x50 → 120x30 re-laid out the grid; Ctrl+C and Ctrl+Q exit 0 and restore the screen (compiled binary too). | tmux captures |
| Tests run in memory | **Pass.** 4 tests, 20 assertions, 140 ms, `@opentui/react/test-utils` + `@opentui/core/testing` mock keyboard. | `bun test` |
| Single-binary packaging | **Pass.** `bun build --compile`: darwin-arm64 97.9 MB, linux-x64 120.4 MB (glibc), windows-x64 126.6 MB. Bigger than the 60 to 90 MB estimated in the design doc; the Linux build keeps both libc branches unless `OPENTUI_LIBC` is defined (it is, in `build.ts`). macOS binary smoke-tested in tmux; Linux binary not yet run (see bottom). | `build.ts`, `dist/` (ignored) |

## Findings that change the M1 design

### Server (file as qqq issues before M1)

1. **Bearer session UUID cannot continue an async process step under MOCK auth.** Same session
   UUID: as a cookie, `step` returns `JOB_STARTED` and completes; as `Authorization: Bearer`, the job
   fails with `Permission denied for process state` (server log: the job runs under a different
   session user than the one that created the state). The client guide says MOCK/TABLE_BASED
   clients use `manageSession` then `Bearer {sessionUUID}`, so this is a server bug or an
   undocumented limitation. The spike sends the session as a cookie; the kernel should prefer
   bearer and fall back to the cookie until this is fixed and the fix is detectable by `apiVersion`.
2. **Process `init` and `step` need `multipart/form-data`.** A url-encoded `values={"sleepMillis":4000}`
   is accepted silently and ignored (the step ran with the default 1000 ms). The OpenAPI document
   says multipart, so the client is at fault, but a 400 on an unexpected content type would have
   saved an hour. Worth a server-side check.
3. `RUNNING` responses are flat (`message`, `current`, `total`, `progress`, `logTail` at top level),
   matching `ProcessStepRunning` in the spec. The design doc's prose implied a nested job status.

### Framework

4. **`focused` prop changes land after the React commit.** Keys that arrive in the same stdin chunk
   as the Tab (paste, automation, a fast typist on a slow terminal) go to the previously focused
   input. Fix for M3: move focus imperatively from the key handler through refs
   (`renderable.focus()`), or buffer input until the commit. Humans typing normally never hit it.
5. **`useKeyboard` closures go stale inside a burst**: three Right arrows and an `s` in one chunk
   sorted the old cursor column. Same root cause; same fix (state in refs or a reducer, handlers
   read the ref).
6. The React binding exposes `focused`, `onInput`, `onChange`, `onSubmit` on `<input>`, but
   `<textarea>` has no `onInput`; use `onContentChange` and read `plainText` through a ref.
7. `<text-table>`, `<tab-select>` are core renderables without React intrinsic elements in 0.8.1;
   the grid is better served by one `<text>` per row anyway (window of N rows, no table node per cell).
8. OpenTUI 0.8.1 is six days old and 0.8.0 removed ScrollBox methods; pin exact versions and
   expect to touch the TUI head on each minor. Keep the kernel free of OpenTUI imports.
9. `bun install --os="*" --cpu="*"` is needed once on the release machine so that all eight native
   packages are present before cross-compiling.

### Not covered by this spike

- Mouse (off by default per the design; not exercised).
- Windows Terminal, ConPTY, PowerShell input quirks (condition 1).
- Node 26 `--experimental-ffi` path and Node SEA (deferred to M5 as the second packaging route).
- Ink was not tried, because OpenTUI met every criterion that could be checked here.

## How to run it

```sh
cd packages/tui-spike
bun install
bun test                         # in-memory renderer
bun run src/main.tsx             # Ctrl+G grid, Ctrl+F form, Ctrl+P process, Ctrl+Q quit
QQQ_SERVER=http://localhost:8077 QQQ_PROCESS=sleepInteractive bun run src/main.tsx
bun run build.ts [darwin|linux|windows]   # dist/ executables (needs the native packages, see above)
```

Sample server used: `mvn -f qqq-sample-project/pom.xml compile exec:java -Dexec.mainClass=com.kingsrook.sampleapp.SampleJavalinServer -Dqqq.sample.mockAuthentication=true -Dqqq.sample.port=8077`
on a `develop` worktree after `mvn -DskipTests install` of the reactor.

## Linux container smoke test

Not completed in this session: the `debian:bookworm-slim` image pull stalled for over ten minutes, so the
Linux x64 binary has only been checked for file type (`ELF 64-bit x86-64, dynamically linked`). Rerun when
the registry is reachable:

```sh
docker run --rm -t --platform linux/amd64 -e TERM=xterm-256color -v "$PWD/dist:/d:ro" debian:bookworm-slim \
   sh -c 'stty cols 100 rows 20; timeout -s INT 8 /d/qqq-tui-spike-linux-x64; echo exit=$?'
```

## Trying it yourself

`qqq-sample-server start` and `qqq-tui-spike` (launchers in `~/.local/bin` pointing at `scripts/dev/`);
see `TRY-IT.md` at the repo root.
