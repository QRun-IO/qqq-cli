# The filter dialog (F6)

How the filter dialog is meant to read and behave. The code (`src/overlays/filter.tsx`) follows this
page; change both together.

## The model

A filter is a list of **condition rows**. Every row reads as a sentence in three cells:

```
Field          operator        value
```

A row whose value is empty is **not applied**: it shows `(any)` dimmed and is left out of the filter.
An applied row is drawn in the normal colour. Nothing is stuck: Backspace or Delete clears the focused
cell (a value back to `(any)`, an operator back to the field's default).

**Quick rows** are the same rows, seeded from the table's quick filter fields (the table's
`defaultQuickFilterFieldNames`, else its T1 fields, plus the ones added with
`+ add a quick field`, remembered per table). They are marked `quick` in a dim gutter and their field
cell is fixed. Ctrl+D on a quick row forgets an added quick field; a table's own quick field is only
cleared.

Rows at one level are joined by one word, AND or OR, printed in the gutter of every row after the
first. One level of **groups** (conditions in parentheses) sits under the top-level rows, indented, with
its own joiner. Below the rows: the sort, as a sentence, then the `[ Apply ]` and `[ Cancel ]` buttons.

## Layout

```
 Guided │ Advanced                                                F2 switches
 ▶ quick       Name         contains        avery
   quick  and  Is Active    is              (any)
          and  Birth Date   between         2000-01-01, 2010-12-31
              + add a quick field (remembered for this table)
              + add a condition
       ( group, joined by OR )
               City         is any of       Chicago
          or   City         is any of       Boston
              + add a condition to this group
              + add a group
   conditions are joined by AND
   sorted by Last Name, ascending
   [ Apply ]  [ Cancel ]
 Is Active: Space or Enter cycles (any) → true → false; t or f sets it; Backspace clears
 ↑↓ rows · ←→ Tab cells · Ctrl+N add · Ctrl+D remove · Ctrl+O AND/OR · F10 apply · Esc cancel
 matches 3 of 6 records
 name CONTAINS avery AND birthDate BETWEEN 2000-01-01,2010-12-31
 qqq table query person -g "name CONTAINS avery AND birthDate BETWEEN 2000-01-01,2010-12-31"
```

The line under the rows is the **cell help**: it says how the focused cell is edited. The next line is
the **key line**: only the keys that apply where the focus is. The footer shows the live match count
(counted by the server a moment after the last change; `…` while counting; the server's message if it
rejects the filter), the filter in the CLI grammar, and the equivalent `qqq table query` command.

## How each cell edits

| Cell | Enter / Space | Typing | Backspace, Delete |
|---|---|---|---|
| field | pick list of the table's fields (search as you type); a new field resets the operator and value | opens the list, searching | - |
| operator | pick list of the operators that fit the field type, then More operators…; text matches also offer Match exact case | opens the list, searching | back to the default operator |
| value, text | edit in place, Enter confirms, Esc cancels | starts the edit | `(any)` |
| value, number | edit in place; a list operator takes `a, b, c`; between takes `from, to` | starts the edit | `(any)` |
| value, date | Enter: presets (today, 7 days ago, this month, …) or type; between and lists edit in place | starts the edit (`2026-01-31`, `now(-7d)`, `startOf(month)`) | `(any)` |
| value, true/false | cycles `(any)`, `true`, `false` | `t`, `f` set it | `(any)` |
| value, choice (possible values) | pick list with search; for "is any of" Enter adds or removes a value, Done finishes | opens the list, searching | `(any)` |
| value, no-value operator (is empty) | - | - | back to the default operator |

Default operators: text `contains` (case-insensitive), number and date `=`, choice `is any of`,
true/false `is`. Text matches ignore case unless the operator list's Match exact case is chosen; the
row then says `(exact case)`.

## Keys (Guided)

| Key | Does |
|---|---|
| ↑ ↓ PgUp PgDn Home End | rows |
| ← → Tab Shift+Tab | cells of the row |
| Enter, Space | edit the focused cell; on a `+` row, add; on the joiner row, switch AND/OR; on a button, press it |
| typing | edits the value, or searches the pick list of the cell |
| Backspace, Delete | clear the focused cell |
| Ctrl+N, Insert | add a condition at the focused level |
| Ctrl+D | remove the row (a quick row: forget the added quick field) |
| Ctrl+O | AND/OR of the focused level |
| Ctrl+G | add a group |
| Ctrl+U | clear every condition (asks) |
| F2 | switch to Advanced |
| F10, Ctrl+S | apply |
| Esc | cancel (asks when there are changes not applied); while editing a cell, cancels the edit |

Commands are on Ctrl and F keys so that letters always type.

## Advanced

The filter as grammar text with completion from the kernel (Tab accepts, ↑↓ choose, ↑↓ on an empty
line walk the history, Ctrl+R searches it), a cheat sheet beside the candidates, and a parse error
with a caret under the offending place. F2 or Ctrl+G returns to Guided when the text parses and fits the
guided form (top-level conditions plus one level of groups); otherwise the dialog says why and stays.
Guided to Advanced always works. Enter, F10 or Ctrl+S applies.

## States

- **editing a cell**: the value cell is an input; Enter confirms (a parse error keeps the edit open
  and shows the error on the cell help line), Esc cancels the edit.
- **changed**: the filter or sort differs from what the dialog opened with; Esc asks before
  discarding.
- **counting**: the match count is `…` until the server answers; a count failure shows its message.
