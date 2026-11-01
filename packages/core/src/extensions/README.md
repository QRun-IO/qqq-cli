# Extensions in the kernel

Extensions are the qbits and modules that add UI API operations (`/qqq/v1/qbit/{name}/...`, or an
established prefix such as `/esb`). The client document carries every extension found when it was
generated; a server has only some of them installed and lists them in `GET /version`.

## Registry (`registry.ts`)

```ts
import { extensionRegistry, KNOWN_EXTENSIONS, operationsOf, ExtensionNotInstalledError } from '@qrun-io/qqq-core'

const registry = await extensionRegistry(server, authenticatedFetch)   // GET /version, cached 5 min with the metadata
registry.has('collaboration')        // installed at a version the client works with
registry.version('esb')              // '1.1.0' | undefined
registry.require('collaboration')    // throws ExtensionNotInstalledError:
                                     //   "extension collaboration is not installed on this server (installed: esb 1.1.0)"
registry.requireOperation(id)        // same check for an operation id; core operations pass
registry.installed                   // every extension the server lists, `known: false` for ones the client lacks
registry.describe()                  // 'esb 1.1.0, zebra 0.3.0 (unknown to this client)'
```

- `KNOWN_EXTENSIONS`: name, label, path prefix, the version the document was generated from,
  `minVersion` where the extension's docs state one (esb, health and collaboration 1.1.0), and
  `channels`: the realtime channels it publishes on (collaboration: `record:{table}:{pk}`,
  `table:{table}`, `user:me`).
- `operationsOf(name)` and `OperationInfo.extension` map operations to extensions.
- Unknown extensions are never dropped. An installed extension below `minVersion` gives
  `has() === false` and `require()` throws with `reason: 'too-old'`.
- `ExtensionNotInstalledError` is the CLI's exit 5. The TUI should hide what `has()` denies
  instead of showing the error.

## Collaboration (`collaboration.ts`)

```ts
const collab = new Collaboration(registry, {
  call: (id, input) => callOperation(server, id, input, authenticatedFetch),
  openStream: (signal) => openRealtimeStream({ baseUrl: server, signal, headers, token }),   // optional
})

const presence = await collab.joinPresence({ table: 'person', pk: '1' }, {
  onChange: (state) => draw(state.count, state.people),   // people: [{ userId, name, mode, fieldName, since }]
  mode: 'VIEWING',          // or 'EDITING' (setMode('EDITING', 'email') while a field has focus)
  announce: true,           // false: watch without appearing
})
presence.count; presence.people; presence.state.live; presence.state.error
presence.state.connections          // two terminals of one user count twice (collaboration 1.2.0)
await presence.stop()       // DELETE /presence, stop the heartbeat, close the stream
```

- Without the extension `joinPresence` returns at once with `available: false`, nobody there,
  and no requests; `stop()` is a no-op. A TUI can call it for every screen unconditionally.
- With it: POST `/presence` now and every 20 s (leases last 45 s), GET the snapshot, and, when
  `openStream` is given, subscribe to `record:{t}:{pk}` or `table:{t}` on the stream's `hello`
  and apply `presence.changed` events. Without a stream, each heartbeat re-reads the snapshot.
  The stream reconnects with backoff (2 s doubling to 30 s) and re-reads on `resync`.
- `since` is when this client first saw the person; the qbit does not send join times.
- The list includes the signed-in user when they hold a lease (tabs and clients merge per user;
  EDITING wins).
- Collaboration 1.2.0: each person has `connections` (their live tabs and terminals) and
  `state.connections` totals them. `perConnection: true` (option of `joinPresence` and
  `presenceSnapshot`) also fills `person.leases`: each connection's mode, field, start and opaque
  ids, this client's own marked `self` (the server's id is `c` + 16 hex digits of SHA-256 of
  user id, newline, connection id; see `opaqueConnectionId`). Older servers send neither: each
  person is then one connection and `leases` stays unset.
- One stream per joinPresence. A TUI that already holds a stream for other channels can pass an
  `openStream` that fans out its own connection's events instead of opening another.
- `state.error` holds a refused heartbeat (404 when presence is off for the table or the record is
  not visible). The heartbeat keeps trying.

Other calls (all throw `ExtensionNotInstalledError` before any request when it is absent):
`favorites()`, `addFavorite(target)`, `removeFavorite(target)`, `recents(limit)`,
`recordView(target)`, `comments(table, pk, { cursor, limit })`, `addComment(table, pk, body,
{ parentCommentId, fieldName })`, `followState`, `follow(table, pk, prefs)`, `unfollow`,
`myWork()`, `people(q, limit)`, `presenceSnapshot(scope)` (empty when absent). Everything else the
qbit offers is reachable by operation id through `callOperation`.

## Assistant (`assistant.ts`)

```ts
const assistant = new Assistant(registry, { call: (id, input) => callOperation(server, id, input, f), fetch: f, baseUrl: server })
const view = await assistant.config()     // { installed, enabled, reason?, message?, model?, starterPrompts, ... }
describeAssistantConfig(view)             // 'enabled, model claude-sonnet-5-5' | 'off (NOT_CONFIGURED): No model provider ...'
const answer = await assistant.ask('how many customers are there', {
  context: assistantContextFor({ tableName: 'customer', recordId: 5 }),   // { route: '/app/customer/5', tableName, recordId }
  conversationId,                         // continue one; omitted: a new conversation (with the context)
  onEvent: (event, answer) => draw(answer),   // text.delta, tool.start, tool.result, presentation, message.end, error
  signal,
})
answer.text; answer.numbers; answer.links     // links: { label, href, kind: record|table|page, tableName?, recordId? }
parseAppHref('/app/customer?filter=...')       // { tableName, recordId?, filter? }
```

- The question goes as the Next UI's panel sends it: `POST /conversations` with the page context, then
  `POST /conversations/{id}/turns` with `{ text, pageContext, concurrency: 'supersede' }`; the event
  stream is read as it arrives (`SseParser`) and folded by `applyAssistantEvent`.
- Without the extension `config()` answers `installed: false` with no request and `ask` throws
  ExtensionNotInstalledError. When it is off for the user, `ask` throws `AssistantUnavailableError` (a
  UiApiError with the reason as its code: 503, or 403 for NO_PERMISSION) carrying the server's message
  (assistant 1.7.0+) or the client's wording for the reason.

## Printing (`printing.ts`)

The printing extension's own operations are the print agent's (enrollment, claims, events, the device
WebSocket). What a person does goes through the qbit's tables and processes, which `Printing` wraps:

```ts
const printing = new Printing(registry, {
  call: (id, input) => callOperation(server, id, input, authenticatedFetch),
  runProcess: async (name, { values, recordIds }) => (await runProcess({ ..., values, records: { ids: recordIds } })).values,
})
await printing.printers({ printableOnly: true })   // approved, exposed by their agent, PDF
await printing.devices()                            // agents: ONLINE, OFFLINE, PAUSED, DISCONNECTED, REVOKED
const ids = await printing.print({ table: 'person', ids: ['1', '2'], printer: printerRowId, copies: 1 })
await printing.watch(ids, { onChange: (jobs) => draw(jobs) })   // until every job is final
await printing.cancel(ids)                          // jobs still queued in QQQ
```

- Print exists per table (`printingPrintRecords_{table}`, `tableHasPrint(meta, table)`); it renders each
  record as a record sheet and returns the queued job ids (`printingJobIds`).
- `resolvePrinter(printers, text)` takes an id, the agent's printer id, a name or a unique name prefix;
  `whyNotPrintable(printer)` says why a printer cannot take a record print.
- Final job states: SPOOLED, SPOOLER_COMPLETED, FAILED (also "Canceled by operator before dispatch"),
  OUTCOME_UNKNOWN. SPOOLED means the agent's spooler accepted it, not that paper came out.
- `readRememberedPrinter(profile)` / `writeRememberedPrinter(profile, printer)` keep the printer chosen
  last per profile (`printing.printers` in config.json), shared by the CLI and the TUI.
- Without the extension every call throws `ExtensionNotInstalledError` before any request.
