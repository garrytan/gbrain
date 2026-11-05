# Running gbrain on servers today

gbrain serves one brain per process. To serve several brains, or to run
gbrain inside containers, give each brain its own process and its own
`GBRAIN_HOME`. This guide covers what that takes today and what still
breaks. The [embedded core](../architecture/topologies.md#embedded-core-planned)
is the planned way to run many brains in one process.

## Pick the brain's shape

- **No-root (database-only).** `gbrain init --db-only --url postgresql://<user>:<password>@<host>:5432/<database>`
  keeps the brain in the database with no content directory or checkout.
  Any host can publish its writes, so a replaced container never strands
  them. Take markdown out with `gbrain export`.
- **Content directory or repository.** The default install, or a source
  backed by a git checkout. Writes publish through the host that owns the
  checkout, named by `host.json` in `GBRAIN_HOME`.

## Keep GBRAIN_HOME stable

`GBRAIN_HOME` holds the config file, the host identity, the content
directory and the local locks. Mount a persistent volume there, one per
brain, and never share one home between two brains. A container that
restarts with an empty `GBRAIN_HOME` gets a new host identity: writes for a
content-directory or repository source then wait for the old owner, and
`gbrain doctor` warns `owner_host_stale`
([troubleshooting](troubleshooting.md#owner-host-stale)). A no-root brain is
not affected.

## Keys

Provider keys come from the process environment (`OPENAI_API_KEY`,
`VOYAGE_API_KEY` and the rest) or from `gbrain config set` in that brain's
home. Without a key the brain stays keyword-only. If a re-setup without a key
left an embedded brain keyword-only, doctor warns
`embedding_plane_disagreement` and prints the command that turns embeddings
back on ([troubleshooting](troubleshooting.md#embedding-plane-disagreement)).

## Migrations

The CLI applies pending schema migrations when it connects. On a deploy, run
`gbrain apply-migrations --yes` once before starting the server, so the
first request does not pay for them and several containers do not race for
the migration lock.

## What still breaks

Two brains opened in one process still share state: the Postgres pool, the
AI keys and model clients, the query-embedding cache, the chat usage and
search telemetry sinks, schema-pack link semantics, the minion admission and
retrieval-tracking caches, page-lock names and `GBRAIN_HOME` paths. The
two-engine suite (`test/helpers/two-engine.ts`) lists each one with the wave
that fixes it. Until then, run one process per brain. `gbrain serve --http`
serves one brain per process too.

## Example

Two brains, two processes, two homes:

```bash
GBRAIN_HOME=/srv/gbrain/brain-a gbrain init --db-only --url "$BRAIN_A_DATABASE_URL"
GBRAIN_HOME=/srv/gbrain/brain-b gbrain init --db-only --url "$BRAIN_B_DATABASE_URL"
GBRAIN_HOME=/srv/gbrain/brain-a gbrain serve --http --port 3001 &
GBRAIN_HOME=/srv/gbrain/brain-b gbrain serve --http --port 3002 &
```
