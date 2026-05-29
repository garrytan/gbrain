# Cortex Evaluation Benchmarks

This guide describes the evaluation loop for Cortex retrieval, source ranking,
and knowledge-quality changes. It is written for Cortex operators and engineers
who need a repeatable way to prove that a tenant brain still answers correctly
after a code, schema, connector, or embedding change.

For the NDJSON capture format, see [eval-capture.md](./eval-capture.md).
For quality receipts on the synthesized takes layer, see
[eval-takes-quality.md](./eval-takes-quality.md).

## Evaluation Modes

Cortex uses three complementary gates:

| Gate | Command | What It Catches |
|---|---|---|
| Retrieval regression | `cortex eval gate --baseline <file>` | Ranking or recall movement against a frozen capture |
| Ground-truth relevance | `cortex eval gate --qrels <file>` | Whether known-right tenant fixtures are retrieved |
| Cross-modal quality | `cortex eval takes-quality run` | Whether synthesized takes stay accurate, attributed, and calibrated |

Both `--baseline` and `--qrels` can be supplied together. When both are present,
both must pass for the final verdict to pass.

## Recommended CI Loop

```bash
# 1. Export a tenant-safe capture from staging or a synthetic seeded tenant.
cortex eval export --limit 200 --tool query > /tmp/cortex-capture.ndjson

# 2. Publish the capture into the CI fixture store.
cortex bench publish \
  --from /tmp/cortex-capture.ndjson \
  --to .ci/evals/baselines/retrieval.baseline.ndjson \
  --label "retrieval-$(date +%Y%m%d)"

# 3. Gate future changes against the frozen baseline.
cortex eval gate \
  --baseline .ci/evals/baselines/retrieval.baseline.ndjson \
  --qrels .ci/evals/qrels/retrieval.qrels.json \
  --json
```

## Privacy Boundary

Production tenant traffic is never copied into public fixtures. Evaluation
captures are either:

- generated from a synthetic tenant seeded with placeholder companies and
  people, or
- exported from a tenant-controlled staging workspace for that tenant's private
  CI.

The capture path stores scrubbed query text by default. Emails, phone numbers,
JWTs, bearer tokens, payment card numbers, and other common identifiers are
redacted before rows are persisted.

## Qrels Shape

Use explicit `source_id` values for multi-source or multi-team brains. This
prevents a result from the wrong source from passing by slug alone.

```json
{
  "schema_version": 1,
  "queries": [
    {
      "query_id": "q1",
      "query": "latest enterprise renewal risk",
      "relevant": [
        { "source_id": "salesforce", "slug": "accounts/acme-renewal" },
        { "source_id": "calls", "slug": "meetings/acme-qbr" }
      ],
      "expected_top1": { "source_id": "salesforce", "slug": "accounts/acme-renewal" }
    }
  ]
}
```

Without `source_id`, a federated tenant brain can false-pass when two sources
share similar slugs.

## Metrics

| Metric | Meaning | Healthy Range |
|---|---|---|
| Mean Jaccard@k | Average overlap between baseline hits and current hits | `>= 0.85` for neutral retrieval changes |
| Top-1 stability | Fraction of queries whose first result stayed stable | `>= 0.85` for tuning passes |
| Mean latency delta | Current latency minus captured latency | Within 50 ms or within the agreed service target |
| Recall@k | Fraction of known-relevant qrels found in the top k | Set per tenant or fixture family |
| First-relevant-hit rate | How often the first relevant result appears before noise | Set per workflow |

These are regression alarms, not proof of universal correctness. Pair a failed
metric with manual inspection of the top moved queries.

## Determinism

`cortex eval gate --qrels` runs the deterministic retrieval pipeline. It avoids
cache warmth, live expansion calls, and ambient tenant state so CI can compare
changes fairly. The production query path may still include freshness boosts,
cached expansions, and connector-specific metadata that are intentionally left
out of the gate.

## Public Benchmarks

For long-context QA work, Cortex can run LongMemEval against an isolated
in-memory benchmark tenant:

```bash
cortex eval longmemeval ./longmemeval_oracle.json --limit 50 --retrieval-only \
  > /tmp/hypothesis.jsonl
```

The benchmark tenant is reset between questions. Production tenant data is not
opened during this run.

Useful flags:

| Flag | Purpose |
|---|---|
| `--limit N` | Cap question count for iteration |
| `--retrieval-only` | Emit retrieved chunks without answer generation |
| `--keyword-only` | Disable vector retrieval for diagnosis |
| `--top-k K` | Set retrieval depth |
| `--output FILE` | Write JSONL to a file |
| `--by-type` | Emit per-question-type recall summaries |
| `--by-type-floor N` | Fail when any question type falls below the floor |

## Nightly Quality Probe

Tenant operators can enable a scheduled quality probe for a controlled sample:

```bash
cortex config set autopilot.nightly_quality_probe.enabled true
cortex config set autopilot.nightly_quality_probe.max_usd 5.00
```

The probe records pass, fail, inconclusive, budget, and rate-limit outcomes in
the audit stream so dashboards and alerts can trend quality over time.

## When To Run

Run the gates before merging changes that affect:

- hybrid search, ranking, deduplication, or source boosts
- query expansion and intent classification
- embedding providers, dimensions, or migrations
- connector ingestion normalization
- synthesized takes or fact extraction prompts
- MCP query/search handlers
- tenant source routing

Skip the full benchmark loop for docs-only edits or isolated UI changes unless
the UI change alters query behavior.

## Failure Modes

| Symptom | Likely Cause |
|---|---|
| Low Jaccard with one source overrepresented | Source boost, filter, or connector normalization changed |
| Low top-1 with stable Jaccard | Rank fusion moved result order |
| High latency with stable quality | Embedding, database, or connector path slowed |
| Rows errored | Query handler or fixture data mismatch |
| Many skipped empty queries | Capture source sent invalid input |

Use `--json` and inspect the top regressions before changing thresholds.
