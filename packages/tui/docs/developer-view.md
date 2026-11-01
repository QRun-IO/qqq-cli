# Developer view

`D` on a record opens the record developer view; `D` on a table grid opens the table developer
view. Both show what the web UI's developer mode shows (record `/app/{table}/{id}/dev`, table
`/app/{table}/dev`), split into sections instead of one long page.

## Layout

```
┌─ Developer · Person 12 ──────────────────────────────────────────────┐
│ 1 Security  2 Events  3 Scripts  4 JSON  5 Metadata  6 Audits  7 APIs│  section bar
│ ESB Events · Publishing                                              │  title · status (tone colour)
│ This table publishes its record changes to the ESB as CloudEvents.   │  description, dim
│──────────────────────────────────────────────────────────────────────│
│ body: headings, key/value pairs, grids, JSON, actions               █│  scrollable pane
│                                                                     ░│  with a scroll bar
│ ←→ 1-7 section · ↑↓ PgUp PgDn scroll · Enter open · v view · y copy  │  key line
└──────────────────────────────────────────────── lines 1–20 of 48 ────┘
```

The bar windows around the active section (with `‹ ›`) when the sections do not fit. The standard
status line and F-key bar stay below: F1 Help, F2 Go to, F3 Record (record view) or Table (table
view: back to the grid), F5 Refresh, F9 Menu, F10 Quit; F4 F6 F7 F8 do nothing here. Esc goes back
to the screen underneath (the record or the grid, at the row it was on).

## Sections

| Record view                                   | Table view                                    | Source |
|-----------------------------------------------|-----------------------------------------------|--------|
| Security (record security locks)              | —                                             | developer panel `recordSecurity` |
| Events (CloudEvents, published to, subscribers, sample event, ESB links) | Events (publications and subscribers with counters, dead-letter queues, last errors) | panel `esb`; `GET /esb/table/{t}` |
| Scripts (associated scripts, revisions: code, run logs, test run, store a new version from `$EDITOR`) | — | `GET /table/{t}/{pk}/developer` |
| JSON (raw values; API endpoints for the record) | JSON (the full table metadata)               | the developer route; table metadata |
| Metadata (summary, fields, sections)          | Metadata (the same)                           | table metadata |
| Audits (newest first; Enter shows the changes)| —                                             | kernel `getAudits` |
| APIs (application APIs and OpenAPI documents) | APIs (the same)                               | `listTableApis` |
| any further provider panel (Quick Search, SQL Workbench, Assistant…), one section each | — | other developer panels |

Shared sections have the same name, order and rendering in both views.

## Body rules

- Grids use the main grid's column layout (`layoutColumns`): fixed columns, cells cut with `…`,
  empty cells show `—`. When a column is `—` for every row a dim line under the grid says why
  (the broker does not report queue counts, for example).
- JSON is pretty-printed with two-space indent and tinted (keys, strings, numbers, literals). In
  the pane, a line longer than the width is cut with `…`; it is never wrapped onto a new line, so
  values cannot be split or repeated. `v` (or Enter on the block) opens the full value viewer,
  which soft-wraps long lines without losing characters. `y` copies the value under the cursor
  (system clipboard tool when present, else OSC 52; a message says when neither is available).
- An empty section says why in one dim line (no panel from the server, no scripts on the table,
  no audit source).
- Links become actions: `/app/{t}/dev` opens the table developer view, `/app/{t}/{id}/dev` the
  record developer view, `/app/{t}/{id}` the record, `/app/{t}` the grid, `/app/{process}` the
  process. Anything else (the ESB overview, the SQL workbench) has no TUI screen: the line shows the
  web URL with a dim "browser only" note, and `y` copies it.
