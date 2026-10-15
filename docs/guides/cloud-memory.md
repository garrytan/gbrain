# Cloud memory — HydraDB as storage and search backend (opt-in)

Connecting a brain to [HydraDB](https://docs.hydradb.com) copies every page, past
and future, to a HydraDB database and makes HydraDB the search backend: `query`,
`search` and `recall` rank with HydraDB. It is off until you connect. The brain
keeps a full local copy, which stays the system of record for writes, links,
facts and versions, and is searched whenever HydraDB is off or unreachable.
Another device connected to the same database can retrieve passages from its
readable sources even before it holds the pages locally.

## Quick start

**Say to your agent:** *"Make HydraDB my brain's backend"*: the agent runs
`gbrain cloud connect`, which shows what will be shared and asks you in a
terminal. *"Is my brain synced to HydraDB?"* runs `gbrain cloud status`.
*"Search my brain locally again"* runs `gbrain cloud primary off`.

```bash
gbrain cloud connect          # disclosure, consent, API key, full backfill, HydraDB becomes primary
gbrain cloud status           # database, key prefix, search backend, last push
```

You need a HydraDB API key from <https://dashboard.hydradb.com>. `connect` takes it
from `HYDRA_DB_API_KEY`, from stdin (`--key -`), or from a prompt. Prompted/stdin
keys are stored in the credential vault (`~/.gbrain/credentials.json`, 0600). The config table holds
only the vault id.

## What leaves the machine

The text gbrain already gives an embedding provider (each page's fence-aware
chunk projection), with every secret gbrain's scanner finds redacted on top, the
same rule the Memorable relay applies. These never leave:

- private pages (`visibility: private`, and derived pages that default private)
- private rows of a `## Facts` fence, and held fence rows
- embed-skipped and quarantined pages
- private keys, tokens, API keys and other detected secrets (sent as `<REDACTED:…>`)

A page that turns private, empties out, or is deleted is removed from the cloud.

## How it stays current

- **Backfill:** `connect` sends every existing page.
- **On every write:** each committed page write (put, edit, delete, import, sync,
  connector syncs) is pushed a moment after it settles.
- **Catch-up:** the `cloud_mirror` autopilot phase sends everything changed since
  its cursor, including maintenance writes (dream, chronicle, extraction) that
  don't go through the write journal, and anything a failed push missed.

`gbrain cloud push` mirrors now; `--full` re-sends every page. The mirror checks
every upload and deletion result and waits for indexing before advancing its
cursor. Archiving a source removes its unchanged pages too; restoring it sends
those pages again. PostgreSQL processes share a database lock, so an older
upload cannot overtake a newer sync. Failed or unfinished batches remain retryable;
`last_push_at` describes a completed mirror, not merely an accepted upload.

Bound: a page soft-deleted and then purged while every mirror run failed stays in
the cloud until `gbrain cloud disconnect --purge-cloud`.

Disconnect clears this brain's credential reference. The shared machine vault
entry remains available to other connected brains.

## How search uses it

While HydraDB is primary, `query`, `search` and `recall` take their ranking from
HydraDB (2.5 s in fast mode, 15 s in thinking mode, scoped to the caller's sources). Each hit resolves to this
brain's own page row under the caller's full read policy, so trust labels,
`get_page` and evidence delivery work as before:

- the page is here and the caller may read it: a normal page row;
- the page is here but deleted, archived, quarantined, private to this caller or
  outside its scope: dropped;
- the page is not here (another device's): a `result_type: "cloud"` row with the
  passage, labelled `trust_tier: unknown`, dropped for callers with a trust floor.

Source, type, date, slug and pagination filters stay in effect while HydraDB
owns relevance and ranking.

No separate embedding-provider key is needed: `query`, normal `search` and
`recall --query` use HydraDB even on a brain initialized with `--no-embedding`.
GBrain does not run its local vector retrieval, fusion or reranker for a
successful cloud search. It checks local access rules and delivers the results.

A cloud outage or timeout falls back to local search. Explicit `search
--match keyword` enumeration, image similarity, structural symbol walks and
record reads (`get_page`, saved-fact lists, `context_pack`) keep their existing
local contracts. They are not natural-language cloud searches.

While HydraDB is primary, private pages are not searchable (they are never sent),
and a page written seconds ago may not be found yet.

## Retrieval mode and Markdown

Fast mode is the default. Choose a mode during setup or change it later; the
preference is saved for this brain and used by `query`, `search` and `recall`:

```bash
gbrain cloud connect --mode thinking
gbrain cloud mode thinking
gbrain cloud mode fast
gbrain cloud status --json                # includes the saved mode
```

HydraDB's response includes Markdown and structured evidence. GBrain uses the
server's Markdown when all evidence survives the caller's access rules and
output limits. When results are filtered, stale or budgeted, it rebuilds the
allowed context using HydraDB's SDK `buildString`, retaining authorized graph
and dated evidence. Explicit page, section and window requests still expand
locally held pages under the caller's access rules; structured match spans
refer to that authoritative text, and Markdown retains permitted cloud context. CLI text and stdio MCP return readable Markdown. JSON CLI
output and MCP structured results remain available; HTTP MCP also includes a
Markdown content block while preserving the existing JSON block for clients.

## Off switches

```bash
gbrain cloud primary off                  # search locally; pages keep syncing
gbrain cloud disconnect                   # stop this brain; the cloud copy is kept
gbrain cloud disconnect --purge-cloud     # also delete the HydraDB database
```

`hydradb.*` keys are not settable with `gbrain config set`: `gbrain cloud connect`
is the only way to turn this on, so it can't be enabled around the disclosure.

## With gstack

After the usual `/setup-gbrain`, run `gbrain cloud connect`. Existing gstack
context queries call GBrain and automatically use its selected backend.
The context loader defaults to a 500 ms subprocess budget. Allow time for a
cloud round trip and CLI startup by setting this in the environment that
launches your agent:

```bash
export GSTACK_BRAIN_TIMEOUT_MS=10000
gbrain cloud connect
```

**Say to your agent:** *"Connect my gstack memory to HydraDB and allow ten seconds
for context loading."* Automatic transcript capture remains a separate opt-in.

For thinking mode, allow more time for retrieval:

```bash
gbrain cloud mode thinking
export GSTACK_BRAIN_TIMEOUT_MS=30000
```

## Staging and live verification

`gbrain cloud connect --api-url https://api-v2-go.staging.hydradb.com` selects
staging explicitly (or set `HYDRA_DB_BASE_URL` before connecting). Only HTTPS
HydraDB API origins are accepted; the selected endpoint is stored per brain and
shown in `cloud status --json`.

The opt-in `bun evals/cloud-memory/smoke.ts` uses `HYDRA_DB_API_KEY` and optionally
`HYDRA_DB_BASE_URL`. It creates and removes its own synthetic database, checks
cloud-only retrieval without an embedding provider, filters, edits, deletion
and the local off switch. Set `GBRAIN_GSTACK_ROOT` to a gstack checkout to also
exercise its context loader through the real GBrain CLI.
