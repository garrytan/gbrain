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

Automatic capture is opt-in. Time-limited facts need an explicit TTL; ordinary
saved facts do not expire just because they describe a temporary situation.
`forget` withdraws a fact from active recall, not from all source material,
history, or private backups. See [ambient writeback](ambient-writeback.md).

## Page writes and the graph are separate outcomes

| Write path | Graph behavior |
|---|---|
| Trusted local `put_page` / capture | Extracts supported page references without an LLM when auto-linking is enabled. |
| MCP `put_page` / capture, including stdio | Saves body references as text; no inline graph extraction. The receipt reports `auto_links.skipped: remote`. |
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

## Verify in the actual harness

Use a generic, unique test fact: remember it, recall it, correct it, recall the
correction, withdraw it, and confirm active recall no longer returns it. Then
open a new conversation in the intended harness and repeat recall with another
saved test fact. A local CLI test proves local storage, not skill activation or
cross-conversation recall in Grok Bot, Muse, Codex, or Claude Code.
