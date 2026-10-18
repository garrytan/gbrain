# Adoption funnel (`gbrain status --funnel`)

gbrain can keep a local count of how far an install has got: installed, data
imported, memory recalled in a later session, a correction applied, a
withdrawal applied, and use a week or more after install. It is **off by
default**, it never leaves your machine, and it records counts and dates only.
You decide whether to share the numbers.

## Turn it on

```bash
gbrain status --funnel --enable
```

This creates `~/.gbrain/funnel.jsonl` (under `GBRAIN_HOME` when that is set).
Recording happens only while that file exists. To count the install itself,
turn it on before `gbrain init`; the command needs no brain.

## View it

```bash
gbrain status --funnel          # one line per stage
gbrain status --funnel --json   # the same as one JSON document, to share if you choose
```

```json
{"schema_version":1,"enabled":true,"enabled_on":"2026-10-14","stages":[
  {"stage":"clean_install","count":1,"first_on":"2026-10-14"},
  {"stage":"import_useful_data","count":1,"first_on":"2026-10-14"},
  {"stage":"recall_new_session","count":3,"first_on":"2026-10-15"},
  {"stage":"correction_applied","count":1,"first_on":"2026-10-16"},
  {"stage":"withdrawal_applied","count":0,"first_on":null},
  {"stage":"use_after_seven_days","count":2,"first_on":"2026-10-21"}]}
```

The report gives counts, never rates. With recording off it prints
`"enabled":false` and zero counts, and writes nothing.

| Stage | Counted when |
|---|---|
| `clean_install` | `gbrain init` creates a new brain (no earlier config) |
| `import_useful_data` | an import (`gbrain import`, or a full sync) saves at least one page |
| `recall_new_session` | a session's `search`, `query` or `recall` returns at least one row, and an earlier session had saved, imported or corrected memory; counted once per session. Whether the answer was right is not judged here |
| `correction_applied` | a committed correction: `remember` superseding a fact (including `replaces`), or `takes_supersede` |
| `withdrawal_applied` | a committed withdrawal: `forget` or `forget_fact` |
| `use_after_seven_days` | distinct days with any of the above, seven or more days after the clean install (or after recording was turned on, without one) |

A session is one gbrain process: one CLI command, or one `gbrain serve` run. Events are recorded where the operation runs: on a thin client, the brain host's funnel counts them (if its owner turned it on), not the client's.

## What the file holds

One line per event: `{"event":"recall","at":"<time>","session":"<when the process started>"}`.
No page content, queries, slugs, fact ids or names, and no network request:
nothing is uploaded. `save` and `recall` lines are written at most once per
session, so the file grows with sessions, not with calls.

## Delete it

```bash
gbrain status --funnel --delete
```

This removes the file, which also turns recording off. Deleting
`~/.gbrain/funnel.jsonl` by hand does the same.
