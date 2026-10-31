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
