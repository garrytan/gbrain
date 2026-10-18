# What belongs in shared memory

**Say to your agent:** *"Remember my preference for short recommendations, but keep this session's setup and credentials out of shared memory."*

GBrain can carry durable facts and preferences between agents that have access to
the same brain and source. It does not replace the harness's identity,
instructions, configuration, or permission controls.

## Durable knowledge versus runtime state

Save explicit requests to remember with provenance: preferences, corrections,
decisions, commitments, and facts the user wants available later. For example,
"I want meeting briefs in three bullets" is useful shared knowledge. Recall it
before the next brief, and verify corrections against the stored record.

Keep current task progress, temporary tool output, local paths, enabled plugins,
MCP connection settings, credentials, and harness activation state in the
appropriate local configuration or session state. A remembered preference does
not install a skill, change an authorization grant, or override higher-priority
instructions. Do not put secrets in memory pages. A durable decision about a
setup can be recorded without copying its credentials or assuming that setup is
active in another harness.

Automatic capture is opt-in. Installing the harness hooks opts into the
compaction and SessionEnd capture lanes; `gbrain config set
memory.auto_writeback off` stops every capture lane, and `gbrain bootstrap
harness --remove` stops the hooks from banking session text at all (see
[ambient writeback](ambient-writeback.md#capture-lanes-and-the-off-switch)).
Time-limited facts need an explicit TTL; ordinary
saved facts do not expire just because they describe a temporary situation.
`forget` withdraws a fact from active recall, not from all source material,
history, or private backups. To remove the text itself from live stores, the
owner runs a [purge](#purge) on the brain host. See [ambient writeback](ambient-writeback.md).

## What a write costs

Saving text or a fact never waits on a generative model: a write is
acknowledged and keyword-queryable without one. Embeddings are the configured
feature (`remember` embeds before saving to detect near-duplicates; pages embed
just after the save, and a page over 1 MiB embeds later through the stale
sweep: see [large pages](#large-pages)). With default settings each saved page of an
extraction-eligible type (note, meeting, email and similar) also gets one facts
extraction call after it is saved; it runs as a queued job, is attributed to the
write that caused it, and stops with `gbrain config set facts.extraction_enabled
false`.
`gbrain config set facts.page_write_notability_filter medium-and-up` keeps
only high- and medium-notability facts from page writes (`high-only` keeps the
high tier, as sync does; `all`, the default, keeps every tier). Image OCR, when turned on (`embedding_image_ocr`), runs before the save.
Set `GBRAIN_AI_CALL_LOG=<path>` to record every model call a process makes (kind,
model, tokens, duration, and the write request, job or cycle phase it served; no
prompt or response text).

## Page writes and the graph are separate outcomes

| Write path | Graph behavior |
|---|---|
| Trusted local `put_page` / capture | Extracts supported page references without an LLM when auto-linking is enabled. |
| MCP `put_page` / capture / `edit_page`, including stdio | Saves body references as text; no inline graph extraction. The receipt reports `auto_links.skipped: remote`. |
| Post-commit `links` effect of an MCP page write | Adds untyped `mentions` edges (`link_source: mcp-remote-mention`) for the body's markdown links, `[[wikilinks]]` and page-path mentions whose target already exists in the same source, is not deleted, is visible to the writer and is inside its slug grant. No typed, frontmatter, timeline or cross-source edges and no new pages. The receipt reports `auto_links.mention_links: queued`; `get_write_request` lists the effect with `added`/`removed` counts. `gbrain config set mcp.remote_auto_links off` (or `auto_link off`) disables it. |
| Stdio `gbrain serve` | Has bounded, best-effort startup and idle maintenance sweeps, unless disabled. This is eventual maintenance, not a guarantee that a remote write immediately has edges. |
| `gbrain serve --http` | Does not self-sweep. The host must run maintenance explicitly. |

For an HTTP brain, ask the host operator to run `gbrain sweep --once` (it can
delegate to the live server over local IPC), or explicitly extract links and
timeline entries for the intended source. Use an authorized `add_link` operation
for an edge needed immediately, then verify it with `get_links` or a graph query.
Check the write receipt and the graph separately; a saved page is not proof of
graph reconciliation. See [graph setup](../../INSTALL_FOR_AGENTS.md#step-45-wire-the-knowledge-graph).

A timeline entry has no update or remove operation: `add_timeline_entry`
returns the rendered bullet, and editing or deleting that bullet in the page's
Timeline section through `edit_page` (with `expected_revision`) refreshes or
removes its row, because the page is the system of record for timeline rows.

<a id="large-pages"></a>
## Large pages

**Say to your agent:** *"Import this long conversation export as one page and
make it searchable. Tell me what embedding it will cost before you spend
anything."* The agent imports the file on the brain host with
`gbrain import <file>`, checks that keyword search finds it, and asks before
running `gbrain embed`.

**Say to your agent:** *"I upgraded gbrain. Which of my big pages couldn't be
found before, and what would it cost to embed them now?"* The agent runs
`gbrain reindex --oversized --dry-run --json` and `gbrain doctor --json`, then
asks before `gbrain embed --held --source <id> --max-usd <N>`, one source at a time.

A page stays one page whatever its size: one slug, one title, one set of
links. Size no longer decides whether search can find it. Every Markdown page
up to the page ceiling is stored, chunked and keyword-indexed when it is
written: 256 MiB on Postgres and 128 MiB on PGLite (`pages.max_bytes` lowers
it), or 24 MiB (25,165,824 bytes) while [segmented storage](#segmented-page-storage)
is off. Don't split a page by hand to make it searchable.

| Page body | Keyword search | Meaning (vector) search |
| --- | --- | --- |
| Up to 1 MiB | right after the write | right after the write |
| Over 1 MiB, up to the page ceiling (a *large* page) | right after the write | after the write commits, when the stale sweep embeds it (`gbrain embed --stale`, sync's embed pass, autopilot) |
| Over the page ceiling | refused with [`file_too_large`](write-refusals.md#file_too_large); nothing is stored | — |

Code files keep a lower limit; see [limits per entry point](#large-page-limits).

A large page commits without vectors, so a big write never waits on the
embedding provider. It also differs from a small page in three ways. Its
chunks use the free title context tier, never a per-chunk model synopsis.
Before it is embedded, the junk check samples its head, middle and tail
instead of reading the whole body. And gbrain keeps a bounded number of
version snapshots of it, so a page appended to every day doesn't store its
whole body again in history on every write.

An operator who set a lower `content_sanity.bytes_block` (the
`GBRAIN_PAGE_BLOCK_BYTES` env var, the config file, or the database config)
stops embedding above that value: such a page is stored with an `embed_skip`
marker and gets no vectors, but it is still chunked, so keyword search finds
it. The same holds for any page with an `embed_skip` marker. The default is
the page ceiling, so nothing is skipped for size unless someone lowered it.

**What a write says about size.** `put_page`, `remember` and sync receipts
carry the same field for a large or `embed_skip` page, so the writer learns on
the write itself, without reading the sync log. `size_state` on a page receipt
(and on `remember` when it appended to such a page) is
`{ embedding, reason, bytes }`; a sync receipt has `size_states`:
`{ total, pages }` with the first 50 pages, each with its `slug`, `path` (a
managed sync) and the same fields, and the sync output prints a line per page.
An ordinary page carries no field.

| `embedding` | `reason` | What happened |
| --- | --- | --- |
| `deferred` | `large_page` | Over 1 MiB: committed with chunks and no vectors; the embedding sweep embeds it after the commit, under `embed.max_usd_per_page`. |
| `partial` | `spend_cap` | The per-page cap stopped embedding; the rest stays keyword-only. |
| `held` | e.g. `upgrade_backfill` | Embedding waits for the user's approval of the previewed cost (`gbrain embed --held --dry-run`, then one source at a time). |
| `skipped` | `oversized` | Over the operator's `bytes_block`: chunked and keyword-searchable, never embedded. |
| `skipped` | `operator_marker` | Another `embed_skip` marker: chunked and keyword-searchable, never embedded. |

A body over the page ceiling, or `put_page` content over 24 MiB, has no
receipt: the write is refused as `request_too_large`.

<a id="segmented-page-storage"></a>
### Segmented page storage

A page over 1 MiB is stored as segments of about 256 KiB instead of one text
column (`pages.segmented_storage`, on by default). Reading a window, an
outline or a chunk's context costs the size of the window, not the page, and
a rewrite re-indexes only the segments that changed. Pages at or under 1 MiB
are stored exactly as before; a segmented page goes back to one column when a
write leaves it at or under 512 KiB.

A body that arrives as one string (`put_page`, `put_pages`, `capture` content
and `gbrain put` stdin) stays limited to 24 MiB per call. A larger page comes
in by `gbrain import` or `gbrain sync` of its file. On a source backed by
files that is only the file at its own place in the checkout, which gbrain
never rewrites; a database-only source takes it by `gbrain import`.

The switch stays off while an older gbrain writes to the same brain: a
gbrain older than the release that turned it on by default (v0.60.290.0
included), or one that stamps no version, that in the last 7 days admitted or
published a managed write, logged an import, sync or connector run, or ran a
resident process keeps new pages inline, even when the setting is `on`.
`gbrain doctor` check `segmented_storage` shows the configured and effective
value and names each blocking host by UUID. Run `gbrain upgrade` there; the
hold clears 7 days after that writer's last write. An older binary's
single-page write on a brain without managed persistence (a classic brain
shared by several hosts) is not detected: upgrade every host that writes to
such a brain, or run `gbrain config set pages.segmented_storage off` until
they are upgraded.

<a id="segmented-searchable"></a>
**When a segmented write is searchable.** The receipt of a write that stores a
page in segments says `searchable`. A new page up to 4 MiB, and every rewrite of
a segmented page, is searchable when it commits (`searchable: true`). A larger
new page commits first and builds its chunks and keyword index right after,
about 10 seconds for 20 MB: its receipt says `searchable: "pending"`, with
`searchable_retry_after_ms` and a `searchable_fix` that reads the receipt again
(`get_write_request`, `gbrain write-request -- <id>`). Read it at that interval
until it says `searchable: true`; search finds the page from then on. Until
then, search does not return the page. If it still says `"pending"` after a
minute, no running gbrain process is building it (a brain with no resident
writer, or a build that died): `gbrain projections drain`, the fix's fallback,
builds it now, and doctor `text_projection_readiness` names how many such
pages wait. A quarantined page says
`searchable: false`. `gbrain import` waits for the build and reports
`searchable` in its result the same way.

Deleting and restoring a segmented page on a source backed by files works up
to the page ceiling. A restore reserves room for its file twice (the staging
file and the file) in the worktree recovery budget, so with the switch on
`persistence.limits.worktree_recovery_bytes` defaults to twice `pages.max_bytes`
plus 2 MiB, never less than 256 MiB (514 MiB on Postgres and 258 MiB on PGLite
at the default ceilings). A value you set is kept; a page that does not fit it
is refused with `request_too_large` before anything is touched. A restored
page is searchable when the restore commits, or, when its chunks were never
built, right after it (`gbrain projections drain` builds it if that build
dies).

<a id="segmented-withdrawal-mirror"></a>
**Withdrawals rewrite a segmented page's file.** `forget`, `forget_fact` and
`purge_fact` on a page stored in segments, on a source backed by files,
rewrite its canonical file as they rewrite an inline page's: the file shows the
row forgotten, or loses the purged row, and holds the bytes `gbrain export`
writes for the page; the withdrawal's Git effect commits it. The file is
streamed from the segments into its staging file, one segment at a time, and
never held whole. Its recovery record names that staging file by path and
SHA-256 instead of holding the file, so the mirror reserves the file once in
the recovery budget. A mirror interrupted before, during or after writing the
staging file finishes on the writer's next pass: a staging file a crash cut
short is discarded and written again.

<a id="segmented-doctor-skips"></a>
**What doctor does not read on a segmented page.** Some doctor checks read a
page's whole body as one string, and a page stored in segments has none.
Those checks say how many such pages they passed by: `oversized_pages`,
`scraper_junk_pages`, `markdown_body_completeness`,
`link_resolution_opportunity`, `fence_integrity`, `core_memory` and
`extract_health` (its facts-backlog overlay) carry `skipped_segmented: N` in
`gbrain doctor --json` and end their message with `skipped (segmented): N`.
`gbrain repair frontmatter` reports the same count (residual
`skipped_segmented` and a warning) for the stored bodies it does not check;
it still checks their files. An `ok` from such a check covers only the pages
it read. The field is absent when no page is stored in segments.
Core memory reads a core page stored in segments back whole up to 24 MiB,
as it reads an inline page, so `core_memory` counts only the core pages over
24 MiB, which core leaves out of every session and of its budget. A
frontmatter re-import of a page stored in segments works the same way up to
24 MiB; over it the file is listed `needs_review` with `page_body_segmented`
and nothing is written.

While the switch is off (`gbrain config set pages.segmented_storage off`, or
held by an older writer), new pages are stored inline up to 24 MiB as before.
Pages already stored in segments stay readable and exportable; a write that
would leave one over 24 MiB is refused until the switch is on again.

<a id="large-page-limits"></a>
### Limits per entry point

The page ceiling applies everywhere, but some transports carry less. When one
of them refuses a page under 24 MiB, send the page by file instead: nothing is
wrong with the page.

| Entry point | Limit | What to do above it today |
| --- | --- | --- |
| Markdown import and sync (`gbrain import`, `gbrain sync`, the managed sync blob read) | the page ceiling: 256 MiB on Postgres, 128 MiB on PGLite (24 MiB while segmented storage is off); above 24 MiB on a source backed by files, only from the file's own place in the checkout | — |
| CLI stdin (`gbrain put`, `gbrain capture --stdin`) | 24 MiB (was 5 MB) | `gbrain import` the file |
| MCP stdio (local agents, `gbrain serve`) | 64 MiB per JSON-RPC message (the MCP SDK default of 10 MiB is raised), so a JSON-escaped page at the ceiling fits | — |
| MCP over HTTP (`gbrain serve --http`) | 4 MiB request body (the MCP SDK default) | the same: sync or the CLI on the brain host (chunked uploads arrive in a later release) |
| Legacy HTTP transport | 1 MiB (`GBRAIN_HTTP_MAX_BODY_BYTES`) | the same |
| `put_pages` batch | 8 MiB per batch | send large pages one per `put_page`, or by file |
| Persistence journal | 64 MiB of outstanding JSON-escaped write intent per principal (was 32 MiB), 256 MiB per brain | nothing: a second large write waits for the first |
| Local persistence socket (IPC) | 32 MiB per frame, JSON-escaped | nothing for ordinary text; only a pathological page (mostly quotes or backslashes) reaches it below the ceiling |
| Pre-push secret scan | 512 MiB per staged file: up to 25 MiB a file is scanned whole, above it in bounded windows streamed from git; gbrain still never writes a canonical file over 25 MiB | split the file, or `git rm --cached` it |
| GitHub | warns at 50 MB, rejects at 100 MB | — |
| Export | streams a page stored in segments, up to the page ceiling; aborts on an inline page whose payload is over 32 MiB, which the 24 MiB ceiling makes unreachable | — |
| Company-brain inspection | 5 MB per file | unchanged |
| Transcript ingest input (Claude Code `.jsonl`) | 10 MiB by default, 50 MiB hard cap | unchanged |
| Code files | 5 MB | unchanged |

**Reading a large page.** Large reads come back in windows, not as one
response, because agent transports and harness result caps can't carry tens of
megabytes. The [`get_page` reference](../mcp/TOOL_REFERENCE.md#get_page)
describes how to read the next window.

**Cost.** Chunking and keyword indexing run locally and cost nothing.
Embedding a large page costs about $0.15 per 10 MB at the default embedding
model, so a 24 MiB page costs about $0.40 and one at the 256 MiB ceiling about $4. Each page has a paid
spend cap, `embed.max_usd_per_page` (default $2), covering its embedding at
every paid entry point (the stale sweep, `gbrain embed`, the post-write
embedding job). A large page uses the free title context tier, never paid
per-chunk synopses; conversation facts keep their own 25 MiB input bound and
are not yet metered by this cap. When several caps apply,
the lowest wins: the per-page cap, the run's consent cap (`--max-usd`),
`embed.backfill_max_usd` and `embed.backfill_max_usd_per_source_24h`. A page
over its cap is still keyword-searchable, and its newest chunks are embedded
first, up to the cap. Doctor's `partial_embedding` check counts such pages by
source and prints each source's approve command with a concrete N,
`gbrain embed --held --source <id> --max-usd <N>`; raising a cap is the
user's call.

<a id="large-pages-upgrade"></a>
**After upgrading.** Older releases stored a page over 500 KB with an
`embed_skip` marker (reason `oversized`) and no chunks. `gbrain upgrade` (its
`gbrain post-upgrade` step) re-chunks and keyword-indexes those pages itself
for up to two minutes, on the CPU, on keyless brains too, and prints a receipt;
`gbrain reindex --oversized` does the rest. The backfill is idempotent and
resumes where it stopped. It removes only gate-written markers whose reason is
`oversized`, and the matching `content_flag: oversized`; a page above the
operator's effective `bytes_block` keeps both and is re-chunked for keyword
search with no vectors. The backfill never embeds.
Backfilled pages over 1 MiB are held for consent; the post-upgrade notice,
`gbrain embed --stale` (its `budget_limited` line) and doctor's
`partial_embedding` check show how many are held and what embedding them
would cost. Pages between 500 KB and 1 MiB cost a cent or two each and embed
through the normal sweep under the existing caps.

Nothing releases a hold automatically. `gbrain embed --held --dry-run` lists
every source, writes nothing and prints one approve command per source; an
approval covers one source, so `--held --max-usd` needs `--source` when held
pages span several sources. `--max-usd N` is two things at once: the run's
hard cap and the extra allowance saved on each page it approves, so the
printed N is a ceiling (the estimate x1.5, at least $0.25), not the estimate.
It works on every provider; on a local one that bills nothing the printed N is
$0.01 and the run costs nothing. A run stopped by its cap, or interrupted,
keeps every vector it wrote: the page it was on is no longer held and the stale
sweep finishes it under its new allowance, and pages it never reached stay
held for the next approval. `--yes` never approves a held page. An approval is
refused, with every hold and cap unchanged, when embeddings are unavailable
(disabled, no provider credentials) or the paid model has no price.

```bash
gbrain reindex --oversized --dry-run --json      # preview the backfill: free, no provider calls
gbrain reindex --oversized --source <id>         # run it now for one source
gbrain embed --held --dry-run                    # every source: held pages, the cost to finish, one approve command each (free)
gbrain embed --held --source <id> --max-usd 2    # embed one source's held pages: $2 caps the run and is each page's extra allowance (paid)
gbrain embed --slugs <slug> --source <id> --max-usd 1  # embed one page, capped at $1 (paid)
gbrain search "<a phrase from deep in the page>" # keyword search finds it before any embedding
gbrain doctor --only partial_embedding --json    # pages embedded only up to their cap
gbrain config set embed.max_usd_per_page 5       # raise the per-page cap (ask the user first)
```

## Where text goes

Local storage does not mean every enabled feature runs locally. Keyless keyword
retrieval and deterministic link extraction need no model API. Configured cloud
embeddings receive the text being embedded; rerankers receive the query and
candidate passages; expansion receives the query; synthesis and LLM extraction
receive the relevant retrieved content or source text. Self-hosted providers have
their own deployment boundary. The connected agent's own model also receives
whatever memory its harness includes in context, even on a keyless GBrain setup.

Enable paid capabilities and automatic capture only with consent, using the
provider's actual data-handling policy. See [installation capabilities](../../INSTALL_FOR_AGENTS.md#step-2-api-keys)
and [spend controls](../operations/spend-controls.md). A spending cap is not a
promise that no text leaves the machine.

## Sharing and backup limits

Remote access depends on authenticated source/operation grants and visibility
filters. Sources organize memory; they do not isolate agents that share local
files or database credentials. Stdio is local access, not an HTTP client grant.
Read [brains and sources](../architecture/brains-and-sources.md#what-confines-remote-callers-and-what-does-not)
before choosing a sharing topology. Tests cover specific boundaries, not a
universal security guarantee.

<a id="fence-markers-in-code"></a>
**Fence markers quoted in code.** Since 0.60.97.0 the readers (the fence
parser, projections, repair) ignore a takes or facts fence marker that sits in
inline code or inside a fenced code block, and since 0.60.162.0 a marker
written into a cell is encoded, never live, so documenting the marker no longer
creates a phantom fence (#5395). The remote privacy boundary deliberately does
not follow: `sanitizeRemoteBody` still treats the first begin marker it sees,
quoted or not, as the start of a protected region and hides everything after
it from remote readers, and a remote whole-page replace of a page with an
unpaired quoted marker is refused with "The takes fence must be repaired before
replacing this page." The boundary only ever changes toward hiding more; a
remote reader that cannot see the tail of a page that quotes the marker is
seeing that rule, not a bug. To publish such a page remotely, write the marker
in a form the scanner does not match (split it, or describe it) or move the
mention after the real fence. Pinned by `test/fence-marker-code-context.test.ts`
("remote privacy boundary" and "remote page replacement").

Markdown export is a portable view of pages, **not a full database backup**.
DB-only facts and pages, revision history, the belief ledger (what the brain
had recorded, and when; `gbrain beliefs`), withdrawal state, jobs, settings,
and authentication records may not be recoverable from Markdown. Use the engine's
full backup/restore path and verify a restore into a separate location. Treat
database backups as sensitive. See the [system-of-record contract](../architecture/system-of-record.md)
and [isolated local backup guide](in-agent-setup.md#6-back-up-the-complete-local-database).

<a id="purge"></a>
## Expire versus purge

`forget` **expires**: the fact stops being recalled, cannot be saved again in
the same source and visibility, and its row is struck in the page's Markdown.
The text stays in the row, the file, page history and backups.

Automatic extraction (sync import, `put_page`, `extract_facts`, the sweep)
skips a candidate whose exact claim was forgotten in that source and visibility
and still saves the other facts it found about the same entity; the entity and
completion write receipts and the extraction result count the skips as
`withdrawn_skipped`, and a group of only forgotten claims completes with nothing
inserted. Explicitly remembering the forgotten claim still refuses with
`fact_withdrawn`, and a purge tombstone still refuses the whole write with
`purged_content`. A claim forgotten after an extraction's facts were prepared
refuses that entity's write with `revision_conflict` and a detail naming the
withdrawal; nothing is published. An extraction keyed by its input alone (sync
import or the sweep, which have no request id) recovers on its next run from
such a refusal, and from a batch an older release refused for a forgotten
claim, by re-admitting the retained facts without another model call (at most
three follow-ups per batch, each visible as its own write receipt; the refused
receipts stay as they were). An extraction admitted under a request id replays
its receipt; give it a new `request_id` to extract again.

`gbrain forget <id> --purge` **purges**: an owner-only command on the brain
host that removes the claim from the live stores gbrain controls and returns a
receipt. It is a separate operation (`purge_fact`), never a mode of the
`forget` verb, and no MCP connection can call it; agents get
`trusted_local_only` with the command to give the user.

**Say to your agent:** *"I saved a secret by mistake. Show me what purging fact
42 would remove, then purge it once I confirm."* The agent runs
`gbrain forget 42 --purge --dry-run` and hands the purge itself to you.

What one purge does, in one transaction:

- deletes every fact row with the same normalized claim in the fact's source,
  visibility and entity (`--all-subjects`: every entity), and verbatim take
  copies (consolidated takes, takes with the same claim);
- drops the row (not a strike) from the page's facts or takes fence, from the
  stored page body and from every saved page version, then rebuilds that page's
  chunks; the canonical file is rewritten by the owner and committed as
  `gbrain: purge fact <hash8>` (no claim text in the commit);
- redacts stored write intents that carry the claim (a pending write blocks
  the purge with `purge_blocked_pending_recovery` until it finishes; retry with
  the same request id), deletes legacy query-cache rows and drops the fact's
  rewording-review rows (close active matches are returned first as
  `similar_active`);
- hides rows a model derived from the fact (through the derivation edges
  derivers record) and marks them `needs_rederive`; the receipt reports them as
  `retained_inactive`, not as removed text;
- records a text-free tombstone: the claim's fingerprint, its source,
  visibility, entity, request id and reason. Any later write of the same
  normalized claim is refused with `purged_content`, and a stale file, re-sync
  or revert drops the row on import.

On a terminal the CLI prints the dry-run receipt and asks you to type the
fact's 8-character token; without a terminal it needs `--yes` and
`--request-id`. `--match "<text>"` lists candidate ids and never purges.
`--status --request-id <id>` reports completion: `committed` (effects such as
the file rewrite still running, exit 10), `complete` (exit 0) or `incomplete`
(an effect failed or a swept store still holds the claim, exit 75; retry with
the same request id).

**The receipt lists residuals first.** Purge removes content from live stores;
it is not physical erasure. Out of its reach, and named in every receipt: the
brain repository's git history (the commits that carry the row are listed,
never rewritten) and every other clone or remote, backups taken before the
purge (a restore brings back the content and an older purge ledger; with the
belief ledger on, `gbrain doctor --only belief_ledger_coverage` asks you to
replay those purges when the restore could not), provider
copies (embedding and decision providers), Markdown exports and compiled
context files, and deleted rows in database pages and the write-ahead log until
vacuum. On PGLite, `--vacuum` compacts the touched tables; on Postgres the
receipt names the `VACUUM` the operator runs, and WAL archives, replicas and
point-in-time recovery stay outside gbrain. Claim text in page prose (outside a
facts fence) is reported as `source_prose`: edit or purge that page. Each store
in the receipt is `deleted`, `retained_inactive`, `unverified` (a probe hit its
time or row bound) or `out_of_reach`; "verified" covers only the swept stores.
The vector probe lists close same-model facts as possible rewordings; it is not
a residual count.

The tombstone fingerprint of a short claim is guessable: anyone who already
knows the claim can confirm it was purged. It never reveals what an unknown
claim said.

`gbrain delete <slug> --purge` purges a whole page the same way: facts filed on
it (tombstoned), its takes, take proposals, open loops, core notices, stored
write intents, attached file records and blobs, and the page row with its
chunks, versions, timeline, links and raw data. It records the page's content
hash and the hash of every saved version, so the same content or an older version of it is refused under any slug until
`gbrain pages unpurge <slug>`; `gbrain pages purges list` shows the tombstones.
An edited file imports normally. Its response carries the same store-by-store
`receipt` as a fact purge, naming other pages whose prose still states one of
the purged page's facts. A write refused because it carries purged content,
or accepted as a no-op after its purged rows were dropped, keeps no copy of
that content in its stored write request.

## Verify in the actual harness

Use a generic, unique test fact: remember it, recall it, correct it, recall the
correction, withdraw it, and confirm active recall no longer returns it. Then
open a new conversation in the intended harness and repeat recall with another
saved test fact. A local CLI test proves local storage, not skill activation or
cross-conversation recall in Grok Bot, Muse, Codex, or Claude Code.
