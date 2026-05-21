# Brain Ingestion Pilot

Status: operator skeleton for Phase 3 controlled backfill. This path is dry-run by default and only supports the Quant pilot sources approved in the Phase 2 runbook.

## Scope

Allowed pilot sources:

- `afirebrand` / `quant_x:afirebrand`
- `MoneyPrinter0x` / `quant_x:MoneyPrinter0x`
- `Taiki Madea`, `Humble Farmer Army`, or `quant_x:TaikiMadea`

Storage bucket:

- `brain-archive`

Universe and SF Hunter are not touched by this command.

## Dry-run

```bash
gbrain brain-ingest --source afirebrand --storage brain-archive --limit 500 --json
```

Manifest form:

```json
{
  "sources": ["afirebrand", "MoneyPrinter0x", "Taiki Madea"],
  "bucket": "brain-archive",
  "mode": "pilot",
  "limit": 500
}
```

```bash
gbrain brain-ingest --manifest /tmp/brain-pilot-manifest.json --json
```

Dry-run lists and parses archive objects, computes idempotency keys, and prints quality gates without writing database rows.

## Write mode

Persistent writes require both the CLI flag and an environment opt-in:

```bash
SUPABASE_URL=[REDACTED] \
SUPABASE_SERVICE_ROLE_KEY=[REDACTED] \
GBRAIN_BRAIN_INGESTION_ALLOW_WRITES=1 \
gbrain brain-ingest --manifest /tmp/brain-pilot-manifest.json --write --json
```

The command uses Supabase Storage through the existing storage backend. It upserts into the proposed Phase 1 `brain_*` tables by `idempotency_key` and records an ingestion run. Do not run write mode until the Phase 1 schema has been dry-run and applied to the target Supabase project.

## Quality gates

The output includes:

- parse success rate, target `>= 95%`
- duplicate idempotency key count, target `0`
- storage/database consistency, deferred in dry-run and checked from write counters in write mode

Any failed gate means stop the backfill and do not expand beyond the pilot.
