# Optional HydraDB memory validation

`smoke.ts` exercises an isolated synthetic brain through connect, indexed
backfill, query/search/recall on a second brain without local embeddings,
fast/thinking Markdown MCP output, updates, local switching and deletion.
Set `GBRAIN_GSTACK_ROOT` to a gstack checkout to include its real context loader.
It creates and removes its own unique cloud database.

```bash
export HYDRA_DB_API_KEY=...                 # use your own key; do not commit it
bun evals/cloud-memory/smoke.ts
```

## Public retrieval comparison

`ab.ts` uses [LongMemEval](https://github.com/xiaowu0162/LongMemEval), a public
long-term conversation memory benchmark. Download its
[cleaned S dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json)
outside the repository. The checked-in split manifest
`evals/longmemeval/splits-seed42.json` records its SHA-256.

The complete matrix crosses both local corpora, both local embedding settings,
and all three backend choices. Selection happens before retrieval: five questions
per category sampled from `decision430` (which excludes the development split),
using Python's `random.Random(20261014)`. Every question keeps its complete haystack.

```bash
export LME_DATASET=/absolute/path/longmemeval_s_cleaned.json
python3 - <<'SELECT'
import json, os, random
from pathlib import Path
questions = json.loads(Path(os.environ['LME_DATASET']).read_text())
held = set(json.loads(Path('evals/longmemeval/splits-seed42.json').read_text())['decision430'])
rng = random.Random(20261014)
selected = []
for kind in sorted({q['question_type'] for q in questions}):
    candidates = sorted(q['question_id'] for q in questions
                        if q['question_id'] in held and q['question_type'] == kind)
    selected += sorted(rng.sample(candidates, 5))
Path('/tmp/gbrain-lme-ids.txt').write_text('\n'.join(selected) + '\n')
SELECT
export HYDRA_DB_API_KEY=...
export OPENROUTER_API_KEY=...               # embeds the local vector baselines
bun --no-env-file evals/cloud-memory/ab.ts \
  --dataset "$LME_DATASET" --ids /tmp/gbrain-lme-ids.txt \
  --out /tmp/gbrain-lme-results.json \
  --work-dir /tmp/gbrain-lme-brains \
  --k 10 --local-share 0.3 --repeats 3 --ingest-concurrency 4
```

| Local corpus | Local embeddings | Backend choices |
| --- | --- | --- |
| All sessions | Complete real vectors | GBrain local, HydraDB fast, HydraDB thinking |
| All sessions | Zero vectors, embedding disabled | GBrain local, HydraDB fast, HydraDB thinking |
| Most recent 30%, rounded up per question | Complete real vectors | GBrain local, HydraDB fast, HydraDB thinking |
| Most recent 30%, rounded up per question | Zero vectors, embedding disabled | GBrain local, HydraDB fast, HydraDB thinking |

This is **12 conditions, 30 questions, three repetitions: 1,080 measurements**.
Every HydraDB condition has the full cloud corpus. Full-history comparisons use
matching corpora; recent-local comparisons measure access to older cloud memory.

There are four independent local databases. Vector arms use
`openrouter:openai/text-embedding-3-small`, 1536 dimensions, and verify complete
vector coverage. No-embedding arms have zero stored vectors, the same opt-out
sentinel as `init --no-embedding`, no embedding-provider key in the gateway, and
an assertion that no query makes an embedding request. HydraDB still manages its
own internal retrieval. Fixture content and UUID revisions are matched between
replicas before embedding, so cloud graph evidence is equally fresh.

The runner uses the shipped MCP `query` operation and captures both its readable
Markdown and structured results. Expansion, semantic cache and autocut are off;
the normal evidence-delivery default applies. Arm order rotates and reverses.
The local gateway is reconfigured for each arm, clearing query-embedding reuse.
HydraDB internal caching is not controlled, so timing does not compare identical
cache behavior. Its shipped timeouts stay at 2.5 seconds
for fast and 15 seconds for thinking. Queries are scoped to their question's source;
opaque session slugs/titles conceal gold labels. The same scorer joins raw IDs only
after retrieval.

Quality uses the first repetition; latency, query errors and fallback counts use
all three. Errors remain in quality denominators. A HydraDB-selected row includes
the integration's local fallback and is never described as pure cloud retrieval.
The report includes any/all gold-session hit rates @10, gold-session recall, and
p50/p95 in-process MCP query latency. Setup, ingestion and embeddings are excluded
from query latency. All 18 primary-metric comparisons (cloud versus matching local,
thinking versus fast, and embeddings versus no embeddings) use paired question
bootstrap intervals and sign-flip p-values with Holm correction across the whole
family. A benefit is supported only when its difference is positive, the 95% interval
excludes zero, and the adjusted p-value is at most 0.05. Report regressions and
non-significant differences alongside any supported benefit.

Setup uploads the production Markdown projection and metadata through production
`ingestHydra`, verifying every document's acceptance and indexed completion. Batches
contain 50 documents, with configurable concurrency 1–4 (default 1). A regression
compares its uploads with production mirroring. Setup concurrency is a benchmark
control; this does not measure the normal mirror's backfill throughput. One owned,
uniquely named cloud database is deleted in `finally`. Local databases persist under
`--work-dir` with a corpus identity manifest for retries. Receipts checkpoint each
measurement and record the app commit, harness hash, vector coverage and cleanup.

This is a balanced held-out retrieval sample, not the full 430-question decision
set or an answer-accuracy evaluation. A fixed reader and judge plus the full dataset
would be needed for broader answer-quality claims.

Keep raw question/session/output rows outside the repository. Publish only
aggregate metrics, sample size, dataset hash, settings and fallback counts.

Cloud indexing is asynchronous and may take much longer than retrieval. The
runner waits for verified completion (up to 30 minutes per upload batch), logs
aggregate indexing states and error codes, and keeps the disposable database
identifier in `--work-dir/live-cloud.json` during the run for diagnosis. The
file and cloud database are removed after completion or failure.

Measured matrix: [30-question held-out comparison](results/longmemeval-matrix-2026-10-15.md).

Historical preliminary pilot (fast with local vectors only): [six-category retrieval comparison](results/longmemeval-pilot-2026-10-14.md). It does not cover the complete matrix.
