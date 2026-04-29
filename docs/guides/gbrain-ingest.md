# gbrain-ingest

`gbrain-ingest` is the agent-native ingest entrypoint. It validates a text, URL,
or local text file, enqueues a protected `gbrain-ingest` Minions job, prints a
job id immediately, and returns. Workers do enrichment, canonical writes,
database import, and embeddings later.

```bash
printf '%s\n' 'Remember this: retrieval notes should cite sources.' | gbrain-ingest
gbrain-ingest --url https://example.com/article --json
gbrain ingest --file ./notes/meeting.md --title "Meeting notes"
gbrain jobs get <job-id>
```

## Modes

- `--mode explicit` preserves the submitted source/provenance and is for direct
  user or agent requests.
- `--mode signal` is for hooks. Signal payloads must be distilled summaries or
  explicit `remember this` content, never raw prompts, tool output, or full
  transcripts.

## Worker Contract

Workers claim jobs from the shared PostgreSQL Minions queue. The foreground
command only validates and enqueues; it does not fetch URLs, call inference,
write wiki pages, write canonical pages, or embed content.

The ingest worker writes accepted source pages to the configured filesystem
brain source when `sources.local_path` is set, then imports the same markdown
into PostgreSQL/searchable state with embeddings deferred. If no local path is
configured for the target source, the worker records `wiki_write:
skipped_no_local_path` and still imports into PostgreSQL. Enrichment uses Codex
OAuth with `gpt-5.4-mini` only. OpenAI API keys are not read for inference.
Embeddings use the existing scoped embedding-key path and unchanged chunks reuse
existing vectors.

## Status And Debugging

```bash
gbrain jobs list --status waiting --limit 50
gbrain jobs list --status active
gbrain jobs get <job-id>
gbrain jobs supervisor status --json
```

Progress phases include `resolve`, `wiki_write`, `db_import`, optional
`enrich`, and `done`. Repeated identical submissions coalesce by idempotency key
or complete as `no-op`.

Enrichment has its own status inside the terminal job result:

- `succeeded`: Codex OAuth returned cited JSON and the worker wrote extracted
  people, organizations, concepts, relationships, or timeline entries.
- `skipped`: enrichment was disabled, the source import was a no-op, or the
  cited extraction produced no durable candidates.
- `timeout`: the Codex OAuth enrichment attempt exceeded its bounded runtime.
- `configuration_error`: the Codex OAuth route is unavailable, unauthenticated,
  interactive, missing, or rejected before usable output.
- `failed`: enrichment returned unusable output or hit another bounded failure.

If source write/import succeeds but enrichment fails, the job still reaches a
terminal result and records the enrichment status. Worker cancellation,
lock-loss, or job timeout still aborts the child Codex process and lets Minions
mark the job according to queue policy.

## Runtime Health Checks

Use the cheap checks first:

```bash
gbrain doctor --fast --json --codex-oauth-smoke
gbrain jobs smoke --gbrain-ingest --json --timeout-ms 60000
gbrain jobs get <job-id>
```

`doctor --codex-oauth-smoke` is opt-in because it runs a tiny live
`codex exec` probe. It verifies the explicit `gpt-5.4-mini` Codex OAuth route
and reports a sanitized failure if the gateway user needs OAuth setup. It does
not fall back to an OpenAI API key.

`jobs smoke --gbrain-ingest` enqueues a tiny signal-mode canary, starts a worker
for the smoke queue, waits only for a bounded terminal state, and prints the job
id plus `gbrain jobs get <job-id>` for follow-up. It reports enqueue, worker
terminal status, and enrichment status separately so operators can tell queue
health from OAuth health.

Avoid pasting raw prompts, raw service logs, or secret-bearing environment
output into docs, brain pages, or handoffs. If service logs are needed, use
redacted counts and status summaries before inspecting full journal lines.

## Hook Canaries

Unit tests prove the hook emits/enqueues distilled payloads. They do not prove a
model saw dynamic context. Treat OpenClaw `agent:bootstrap` as the supported
prompt-visible path unless a live canary proves another hook surface reaches the
final model prompt.
