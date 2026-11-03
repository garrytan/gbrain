# Ingest a pasted document

`gbrain ingest` (MCP `ingest`) saves a document a user pasted or downloaded: a podcast transcript,
meeting notes, a memo. One call reads the whole text in windows, plans every page and fact and runs every check
before it writes anything, then commits through the source's own write door. It returns one report with a status
for every item, how much of the document was read, what it spent, and the actions that approve or undo it.

**Say to your agent:** *"Save this transcript to my brain."* (it calls `ingest` with the text)

Chat exports and agent session logs have their own importer: `gbrain transcripts ingest`
([chat connectors](chat-connectors.md)).

## Quick start

```bash
gbrain ingest --file notes/call-2026-03-01.txt --title "Call with acme-example" --json
gbrain ingest --stdin < transcript.txt            # same, from standard input
gbrain ingest --file transcript.txt --dry-run      # preview: no provider call, nothing written
```

What gets written:

1. **The source page**, created once per document (`inbox/ingest-<hash>` unless you pass `--slug`), with
   `facts_backstop: false` so sync and rebuilds never extract it a second time. A repeat of the same document
   reuses it.
2. **The report page** `ingest/<attempt_id>` (type `ingest-report`): the attempt's record and the evidence undo
   reads. Only the attempt that owns it writes it ([reserved namespace](#reserved-namespace)).
3. **One page per new entity**, filed by its schema-pack type (`people/`, `companies/`, or the pack's own
   directory), with the sentences that mention it and a link to the source page, never an empty stub. New pages
   are **proposed** (`provenance: auto-extracted`, `status: unverified`) for the owner to approve with
   `gbrain extraction-review promote`. The local owner can pass `--trusted-extraction` to create real pages
   for names the model typed; names the keyless candidate function found, names flagged as near an existing name
   and names whose near-name check was incomplete always stay proposed.
4. **Each fact on the entities it names**, at most two, in order of first mention, through remember's
   explicit-entity writer: the facts fence in the page's file on a source with a repository, the facts fence in
   the database page body on a repo-less source. A claim already saved becomes `support` for the saved row; a
   withdrawn claim is skipped. A claim saved on two entities also gets one `mentions` edge between them.

A name one edit or one acronym letter away from an existing entity name or alias (`ACMX` next to `ACME`) is
flagged in `near_names` and proposed, never merged
([entity detection](entity-detection.md#ingest)).

## Keyless and keyed runs

With a chat model configured (`gbrain models --json` shows it) and fact extraction on, each window goes to the
ingest extractor, which returns typed names and the claims that name them. The run is bounded by
`ingest.max_usd` (default 0.50, a local-only key) or `--max-usd`; a remote caller can lower the cap but never raise
it. The facts kill switch (`facts.extraction_enabled false`) is re-checked before every window.

Without a chat model the run is keyless: names come from the keyless candidate function (all-caps acronyms,
one-word names in company context, capitalised names), every new page is proposed, facts are skipped and the
report names the missing capability:

```json
"missing_capability": { "capability": "chat", "check": ["gbrain", "models", "--json"] }
```

`--dry-run` never calls a provider: it returns the keyless candidate plan, the window count and `est_usd`,
with `plan_basis: "keyless_candidates"` so a keyed user knows it is not the model's plan.

## Report

```json
{
  "attempt_id": "a3f9c2d1e0b4a5968",
  "status": "complete",
  "complete": true,
  "summary": "Ingested: 1 page created or proposed, 2 existing; 3 facts saved; read 100% of 58,212 characters; spent $0.0120.",
  "storage": "database",
  "source_page": { "slug": "inbox/ingest-d821c1d7babb", "status": "created" },
  "report_page": "ingest/a3f9c2d1e0b4a5968",
  "coverage": { "chars_read": 58212, "chars_total": 58212, "windows_done": 8, "windows_total": 8 },
  "spent_usd": 0.012, "max_usd": 0.5,
  "pages": [
    { "name": "Zentrix", "slug": "companies/zentrix", "type": "company", "status": "proposed" },
    { "name": "ACMX", "slug": "companies/acmx", "type": "company", "status": "proposed",
      "near_names": [{ "slug": "companies/acme", "name": "ACME", "kind": "typo" }] },
    { "name": "Alice Example", "slug": "people/alice-example", "type": "person", "status": "existing" }
  ],
  "facts": [
    { "fact": "Alice Example moved to Lisbon in March.", "status": "created",
      "copies": [{ "entity_slug": "people/alice-example", "status": "created", "fact_id": 8 }] }
  ],
  "undo_window_days": 30,
  "actions": [
    { "kind": "approve_proposed", "next": "tell_user_to_run", "argv": ["gbrain", "extraction-review", "promote", "--slugs", "companies/zentrix,companies/acmx"] },
    { "kind": "status", "next": "run", "argv": ["gbrain", "ingest-show", "a3f9c2d1e0b4a5968"] },
    { "kind": "undo_preview", "next": "run", "argv": ["gbrain", "ingest-undo", "a3f9c2d1e0b4a5968"] }
  ]
}
```

Every page and fact carries one of `created | existing | proposed | support | skipped | held | pending | failed`
with a reason. `status` resolves failed over pending over incomplete over complete. Every action is rendered for
the caller: `run` only when the caller can call it, otherwise `tell_user_to_run` with the CLI argv (approving
proposed pages is always the owner's). A provider failure names its stage and window, the reason
(`auth`, `billing`, `model_not_found`, `content_block`, `rate_limit`, `transient`), whether it is retryable,
the model and a sanitized cause; never a key.

Exit codes for `gbrain ingest`: 0 complete (or a repeat of a complete attempt), 1 failed, 2 invalid input,
10 pending writes, 11 incomplete or resumable. `gbrain ingest-undo` exits 3 on a preview. The full table is in
[exit codes](#exit-codes).

## Status and resume

An attempt is the document, the caller, the options and the source. Repeating a complete attempt returns its
stored report (`repeated: true`); repeating an incomplete one returns the stored report with `resumable: true`
and resumes only when you ask:

```bash
gbrain ingest-show a3f9c2d1e0b4a5968                       # read-only, no provider call (MCP: ingest {attempt_id})
gbrain ingest --resume --attempt a3f9c2d1e0b4a5968 --file transcript.txt
```

The attempt checkpoint is written before the first provider call and advanced after every window (its outputs
and the cumulative spend), on both storages, so a resume after a budget stop, a kill switch or a crashed process
never pays for a finished window again. A resume needs the same document text (its hash must match). New options
(keyed after keyless, `--trusted-extraction`) or a re-ingest after undo start a new attempt on the same source
page; claim dedup keeps it from saving a claim twice.

## Storage

The report states `storage`:

- `git` — the source has a repository. Every page and fence row is committed to Git first; the database is
  derived. If the source has a repository but its Git target is unavailable (`sync.write_through false`, a
  subagent sandbox, an unavailable owner), ingest refuses with `ingest_storage_unavailable` before writing
  anything; it never falls back to the database.
- `database` — a repo-less source, the default keyless install. The same pages, fences, report, review,
  approval and undo, with the database as the record.

The storage is pinned when the attempt starts and checked again before the first write.

## Undo

```bash
gbrain ingest-undo a3f9c2d1e0b4a5968                                   # preview, exit 3, writes nothing
gbrain ingest-undo a3f9c2d1e0b4a5968 --yes --expect <plan_hash>        # apply exactly that preview
```

Undo retracts only what the attempt created, read from the report page's evidence (it outlives the write
receipts' `persistence.receipt_retention_days` window, default 30) and cross-checked against the attempt record:

- the fence rows it appended are struck (`valid_until` today) in the page's own fence, through the page door on
  both storages, so a later edit, ingest or rebuild never brings them back; no withdrawal is recorded, so a later
  ingest of the same claim saves it again;
- the pages it created are soft-deleted (restorable for 72 hours with `gbrain restore`), and the source page when
  no other attempt uses it.

It keeps anything edited, promoted or linked from another page since, support it counted for a claim that already
existed, and claims another attempt counts as support, with their page and the source page they cite. Apply runs under the source's publication guard and refuses
`preview_changed` when the plan moved since the preview. A repeat is a no-op. After a rebuild that renumbered the
facts, or without the attempt record, undo refuses `ingest_undo_unverifiable` rather than guess. A page whose body is segmented keeps its rows
(reported `segmented`).

## Reserved namespace

Report pages (type `ingest-report`, slugs `ingest/<attempt_id>`) are written only by the attempt that owns them.
Every generic page write (put, edit, append, delete, restore, revert, batch, upload) that names one, or declares the
type in a page's leading frontmatter, is refused `ingest_namespace_reserved`; the same line in a page body is ordinary text. Other slugs under `ingest/` stay ordinary pages; an owner who wants
the whole prefix reserved sets `gbrain config set ingest.reserve_namespace true`.

## Remote callers

`ingest` and `ingest_undo` are on the full and starter MCP surfaces. A remote ingest always proposes new pages,
cannot set `visibility: private` or `trusted_extraction`, and sees only its own attempts; pages it cannot read are
withheld from reports by slug. Before any provider call, ingest checks that the caller's grant covers what it
commits: `put_page` on the source page slug and on `ingest/` (the report page), and `remember` when it extracts
facts. Otherwise it refuses `permission_denied` with nothing extracted or written. A bound-slug client writes
entities only inside its prefixes (others are `skipped: outside_grant`). When another writer creates a planned slug
first, ingest plans that entity once more and reports what it found (`existing`, a hash-tagged slug, or
`skipped: create_conflict`).

## Errors

| Code | Reason | Fix |
|---|---|---|
| `ingest_input_invalid` | `missing`, `conflicting`, `unreadable`, `binary`, `empty`, `too_large` | pass one readable text document of at most 200,000 characters |
| `ingest_option_invalid` | `unknown_type`, `valid_from`, `visibility`, `max_usd`, `trusted_extraction`, `slug` | correct the option; the fix lists the pack's types |
| `ingest_storage_unavailable` | `disabled_by_config`, `subagent_sandbox`, `owner_unavailable`, `topology_changed` | the operator restores the Git target, then run it again |
| `ingest_document_mismatch` | | resume with the same document |
| `ingest_attempt_not_found` | | check the attempt id |
| `ingest_undo_unverifiable` | | review the attempt's pages by hand |
| `ingest_namespace_reserved` | | use ingest-undo or another slug |

All of them are in [error codes](error-codes.md); `gbrain errors <code>` explains each offline.

## Exit codes

`gbrain ingest` and `gbrain ingest-undo` use the [exit codes](exit-codes.md) this way:

| Exit | `gbrain ingest` | `gbrain ingest-undo` |
|---|---|---|
| 0 | complete, or a repeat of a complete attempt (the stored report) | undone, or already undone |
| 1 | failed (the report names the stage, the window and what committed) | failed |
| 2 | invalid input or option (`ingest_input_invalid`, `ingest_option_invalid`, `ingest_document_mismatch`) | missing attempt id |
| 3 | | preview: nothing changed; apply with `--yes --expect <plan_hash>` after the user agrees |
| 10 | a page write is still pending; its facts stay pending and the attempt resumes | |
| 11 | incomplete (budget stop, kill switch, retryable provider failure): run the report's resume action | |
| 130 | interrupted: the checkpoint keeps every finished window | interrupted |

## Agent transcript: a report and its undo, `run`, then `ask_user`, exit 3

A user pasted a transcript and asked the agent to save it. The agent calls `ingest` with the text; the report's
actions are already rendered for this caller (CLI shown):

```text
$ gbrain ingest --file transcript.txt --json
{ "attempt_id": "a3f9c2d1e0b4a5968", "status": "complete", "complete": true, "storage": "database",
  "summary": "Ingested: 2 pages created or proposed, 1 existing; 3 facts saved; read 100% of 58,212 characters; spent $0.0120.",
  "actions": [
    { "kind": "approve_proposed", "next": "tell_user_to_run", "argv": ["gbrain", "extraction-review", "promote", "--slugs", "companies/zentrix"] },
    { "kind": "status", "next": "run", "argv": ["gbrain", "ingest-show", "a3f9c2d1e0b4a5968"] },
    { "kind": "undo_preview", "next": "run", "argv": ["gbrain", "ingest-undo", "a3f9c2d1e0b4a5968"] } ] }
exit 0
```

The agent relays the summary and tells the user the approve command (owner only). Later the user asks to undo it.
The preview is read-only, so the agent runs it; applying it is destructive, so the agent asks first:

```text
$ gbrain ingest-undo a3f9c2d1e0b4a5968 --json
{ "status": "preview", "plan_hash": "5b0c9e1f2a3d4c5b6a7f8e9d0c1b2a39", "consent": ["destructive"],
  "retract": [{ "fact_id": 8, "entity_slug": "people/alice-example" }], "delete": [{ "slug": "companies/zentrix" }],
  "fix": { "next": "ask_user", "argv": ["gbrain", "ingest-undo", "a3f9c2d1e0b4a5968", "--yes", "--expect", "5b0c9e1f2a3d4c5b6a7f8e9d0c1b2a39"],
    "user_message": "Undo ingest a3f9c2d1e0b4a5968: retract 1 facts and soft-delete 1 pages (restorable for 72 hours)?" } }
exit 3
```

After the user agrees, the agent runs `fix.argv` exactly. If anything changed since the preview it refuses
`preview_changed` and the agent previews again. An incomplete report (exit 11) resumes only with its `resume`
action; `ingest` with `attempt_id` alone is the read-only status call a `fix.verify` can point at.

## Not in this release

- The ingest extractor writes no `appendContextNote` on the second copy of a two-entity claim; both copies carry
  the source page as provenance.
- Undo does not remove the `mentions` edge between two existing pages.
- The writeback instructions do not yet mention `ingest`.
