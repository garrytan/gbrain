# Resolve a file path the way gbrain does

A harness that checks whether a commit "landed" in search (a landing check, an agent that just wrote a page, a CI step) should
ask gbrain what it did with each file, not re-implement gbrain's rules. A copied rule drifts. Three real shapes of that drift:

- **Slug folding.** gbrain lowercases each path segment and strips leading and trailing hyphens, so
  `articles/outlet-example/a-headline-.md` is the page `articles/outlet-example/a-headline`. A copy that only lowercases looks
  for a page that never exists.
- **Case-folded twins.** A deleted `notes/Call-AbC.md` and a live `notes/call-abc.md` share one slug. Checked by slug, the
  delete looks failed because the twin's page is live. Checked by origin (the page that records the file as its
  `source_path`), it is a clean delete.
- **Skipped scaffolding.** Sync skips folder scaffolding names (`index.md`, `README.md`, `schema.md`, `log.md`, `RESOLVER.md`; root
  `AGENTS.md` and `CLAUDE.md`) unless the file sits below the source root and its frontmatter has `type:` or `title:`
  (`sync.metafile_pages`, default `typed`; `off` skips them all). Waiting for a page on a skipped file waits forever.

## The command

```bash
gbrain sources resolve-path <source-id> <path...> [--stdin] [--json]
git diff --name-only HEAD~1 | gbrain sources resolve-path default --stdin --json
```

MCP: `sources_resolve_path` with `{ id, paths }` (read scope, confined to the caller's sources). At most 200 paths per call. Paths
are relative to the source root, or to the Git top level when they start with the source's subpath. Read-only: Git object reads
and bounded lookups on existing indexes; nothing is scheduled or written.

Each path returns the `slug` sync gives it, `in_synced_commit` / `at_head`, `skipped` (with `typed_frontmatter` for a metafile),
`hold`, `page` (id, chunks, unembedded), `embedding_hold` (a large page's held or capped embedding budget), `slug_owner` (a live page that owns the slug with another origin), `frontmatter_slug`
(a `slug:` line that differs from the path slug: sync holds that file), `searchable` (`true`, `"keyword"` or `false`), a `why`
sentence and a `fix` (an existing command, never run here; null when nothing is owed).

## States

| state | meaning | fix |
|---|---|---|
| `searchable` | live page, every chunk has a vector | none |
| `pending_embedding` | found by keyword; some chunks still wait for a vector (with `embedding_hold` set: a large page's budget waits for approval) | `gbrain embed --stale --catch-up` (paid, asks first), or `gbrain embed --held --dry-run --source <id>` for a held page; none on a brain keyless by choice |
| `chunkless` | page with body text and no chunk rows | `gbrain embed --stale --catch-up` |
| `keyword_only` | an `embed_skip` page: keyword search only, by design | see `gbrain pages unsearchable` |
| `quarantined` | hidden from search by the import gate | doctor `quarantined_pages` |
| `empty` | live page with no body | none |
| `held` | a sync hold waits on the file | `gbrain sync status --source <id> --json` lists the hold's own fix |
| `skipped` | sync never imports this path (`skipped.reason`) | none: no page by design |
| `not_synced_yet` | the file at HEAD differs from the last synced commit | `gbrain sync --source <id> --no-pull` |
| `missing` | committed and eligible, no page, no hold, no skip: a real gap | `gbrain sources retry-held <id> --unindexed`, then the sync |
| `slug_taken` | no page because another file's page owns the slug | rename one of the two files |
| `page_deleted` | committed, but its page was deleted and sync keeps it deleted | restore the page, or delete the file |
| `deleted` | the file is gone and no live page records it as its origin | none (a `slug_owner` twin is not this file's page) |
| `stale_page` | the file is gone but its page is still live | the sync |

A landing check treats `searchable`, `keyword_only`, `empty`, `skipped` and `deleted` as landed, `pending_embedding` as landed for
keyword search, `not_synced_yet` as lag, and every other state as an alert carrying its `why` and `fix`.

## Synced but not searchable

`gbrain sync status --source <id> --detail --json` adds a `landing` block, and doctor `sync_landing_gaps` (a cheap incident
check, so it answers even when a full doctor run cannot finish) reads the same thing: pages a managed sync committed more than
the source's freshness target ago (`sync.freshness_target_seconds`, default 300 s) that search still cannot fully see, one row per
page with its reason (`pending_embedding`, `chunkless`, `quarantined`, `page_missing`) and fix. It reads at most the newest 2,000
committed sync receipts of the last 24 h and says `unknown`, never `ok`, when its read times out.

## What "blocked" means

`gbrain sync status` reads `blocked` only when the source cannot advance without a person or an operator, the same meaning as a
sync run's drain outcome and a sync job's `blocked` progress. A file hold that waits on a person while the rest of the source
keeps syncing reads `synced` with reason `held_needs_human`; `needs_human` and `next` still carry that decision.

## Is my write searchable yet?

`gbrain write-request <request_id> --applied --json` (MCP `get_write_request` with `applied: true`) carries `applied`, read live each time. It is opt-in, so a plain receipt poll costs no extra reads. The write's own reply stays frozen, so a same-request-id replay returns it unchanged; read the receipt for the live answer:

| Field | Meaning |
|---|---|
| `searchable_yet` | `true` only when search finds the page by keyword and by vector |
| `searchable`, `state` | the vocabulary above: `searchable`, `pending_embedding`, `chunkless`, `keyword_only`, `quarantined`, `empty`, plus `pending_write` (the request has not settled), `not_written` (it settled without committing) and `deleted` |
| `page` | `{ slug, chunks, unembedded }`; `unembedded` counts visible chunks with no vector in the active embedding column |
| `embedding_hold` | a large page's held or capped embedding budget, which waits for approval |
| `gap` | `requests_ahead` (unsettled requests of the source queued before this one) and `unembedded_chunks` |
| `sequence` | the request's journal sequence; the write has settled once it is at or below `watermark.committed_through_request` |
| `watermark` | `indexed_through`, `committed_through_request` and `requests_pending` of the source (indexed reads only) |

A receipt read whose watermark read fails leaves `applied` out.

## The source watermark

`gbrain sources status --json` (each source's `watermark`), MCP `sources_status` and `gbrain sync --json` (each synced source) carry the full watermark:

- `indexed_through`: `{ commit, synced_at }`. The commit is the source's last synced commit, which only a finished sync pass moves. A pass stopped by its deadline, an abort or a page budget leaves it where it was. Files held at that commit are counted in `pending.held_files`.
- `embedded_through`: `complete` (with `commit`) when every live page that is not `embed_skip` has a vector for each visible chunk; `partial` with `unembedded_pages`, `held_pages` (held and capped large pages count as not embedded) and `before`, the oldest `updated_at` among the pages still waiting, so every page written before it is embedded; or `embeddings_off`.
- `committed_through_request`: a request sequence at or below which every request of the source has settled (committed, conflict, failed or cancelled): one below the oldest queued, running or recovering request, else the journal's newest sequence.
- `pending`: `requests` (unsettled, with the oldest age), `commits_behind` and `files_behind` (on this host's checkout after the last synced commit), `held_files` and `deletes_withheld` (deletes a mass-delete cap withheld). `count` adds requests, files behind, held files and withheld deletes; `oldest_age_seconds` is the older of the oldest request and the oldest commit behind.
- `writer_heartbeat`: the process holding the source's drain lease (`holder`: kind, id, host, PID), `heartbeat_age_seconds`, `last_progress_at` (its last committed sync write, cursor save or pass-row write), `progress_age_seconds` and `stalled` (no progress for 5 minutes). A remote caller sees the holder's kind and the times, never its host, PID or job id.

A landing check that only needs "has this commit landed?" compares `indexed_through.commit` with its commit and reads `pending` for the rest.
