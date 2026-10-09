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
just after the save). With default settings each saved page of an
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

Markdown export is a portable view of pages, **not a full database backup**.
DB-only facts and pages, revision history, withdrawal state, jobs, settings, and
authentication records may not be recoverable from Markdown. Use the engine's
full backup/restore path and verify a restore into a separate location. Treat
database backups as sensitive. See the [system-of-record contract](../architecture/system-of-record.md)
and [isolated local backup guide](in-agent-setup.md#6-back-up-the-complete-local-database).

<a id="purge"></a>
## Expire versus purge

`forget` **expires**: the fact stops being recalled, cannot be saved again in
the same source and visibility, and its row is struck in the page's Markdown.
The text stays in the row, the file, page history and backups.

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
purge (a restore brings back the content and an older purge ledger), provider
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
