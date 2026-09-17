# TypeSafe (Jev) reranking

TypeSafe is an optional reranking provider. Jev returns typed relevance judgments
through the native System One API. It does not supply chat, synthesis, or embeddings.
Select it using GBrain's existing reranker configuration.

## Setup

Get a key from [TypeSafe](https://console.typesafe.ai). Add it to the existing
GBrain home environment file (`~/.gbrain/.env`, or `$GBRAIN_HOME/.env`):

```dotenv
TYPESAFE_API_KEY=<your-key>
```

The process environment is also supported and takes precedence over the home
environment file. Choose the model and enable reranking:

```bash
gbrain config set search.reranker.model typesafe:jev-1.13.0
gbrain config set search.reranker.enabled true
gbrain search modes
```

`typesafe:jev-latest` is also accepted; the alias may change after a TypeSafe
release. Pin the version for reproducible evaluations. Existing installations
keep their selected provider and default model. A TypeSafe key does not change
the selection automatically. No new environment selector is required.

## Behavior

The gateway sends a Score question for each candidate with four concrete levels:
unrelated, same topic without answer evidence, partial answer evidence, and direct
answer evidence. Scores are normalized to 0..1; ties preserve incoming rank.
This is relevance, not a probability that a stored fact is true.
The query is shared state. Each independent Score question carries only its own
candidate in a structured `instructions.candidate` field, with an explicit task
to treat candidate content as data. This avoids unrelated candidates in shared
state and positional lookup. Question IDs map answers back to code; they are not
model instructions. The layout was validated with native regression and bounded
performance controls; API-supported object instructions do not themselves prove
resistance to every adversarial input.

Each request packs as many candidates as fit both documented context budgets:
32k tokens for state plus the longest question and 64k for state plus all questions.
There is no fixed question-count cap. Independent Score questions in the same
request use Jev's internal parallelism; splitting adds requests only when an
estimated context budget is full. Source query and document text are preserved.

The estimate uses GBrain's existing cl100k tokenizer with a 2x margin, an
individual-digit floor, fragment-boundary reserves, and 2,048 tokens of headroom.
This is not Jev's tokenizer or an exact proof of the minimum request count;
provider validation remains authoritative. The payload byte ceiling is checked
separately from context tokens. Up to 16 batches run concurrently using a worker queue under one overall
timeout; a finished worker starts queued work without waiting for slower batches.
There is no automatic retry that can extend the search deadline.

Authentication, model allowlists, cancellation, cost admission, and usage remain
in the existing gateway. Input tokens from all started batches are metered;
missing usage uses a conservative estimate. Missing keys, rejected requests,
oversized pairs, incomplete scores, and timeouts preserve original search order
through existing skip reporting and failure auditing. There is no automatic second provider call.

The current keyword-only/no-vector search branches return before reranking.
Setting only a TypeSafe key does not enable embeddings or change those branches.
Jev's relevance scale also needs evaluation with existing autocut/CRAG thresholds;
normalizing a score does not calibrate those thresholds automatically.

## Say to your agent

> Configure TypeSafe Jev as my reranker using the existing GBrain settings. Keep
> my current search mode and embedding provider, and check that reranking is ready.

Provide the key through the existing home environment file or process
configuration; avoid putting credentials in chat.

## Evaluation

The [completed free-account pilot](../eval/typesafe-rerank/README.md) includes the
frozen-input generator, protocol, final receipt and individual HTTP table/CSV.
It uses the production Jev planner/executor. Voyage rerank-3 selection, chunking,
rolling quota scheduling and `truncation:false` are evaluation-only adaptations
for a 3 RPM / 10K TPM account. They do not change the production Voyage adapter
or the default model. Its larger-profile results are an account-constrained
collector comparison, not a native single-request production baseline.

The rank-only harness compares identical capped candidate text/order, alternates
provider order, preflights readiness and cost, validates complete coverage, and
records native input usage, nominal cost and measured per-HTTP timings. Failed
calls make the campaign incomplete. Missing native usage is null in evidence;
gateway budget estimates are not substituted as actual measured costs. Dry runs
perform no provider calls and never report candidate-model quality.

```bash
# Reproduce the frozen synthetic inputs without opening the operator's brain.
bun scripts/fixtures/jev-rerank-workloads.ts .context/jev-workloads.jsonl
bun scripts/typesafe-rerank-ab.ts --pools .context/jev-workloads.jsonl --baseline voyage:rerank-3 --dry-run --out .context/jev-preflight.json

# Known isolated NamedThing regression fixture; requires both provider keys.
# Set account-specific quota flags as in the pilot protocol before a live run.
bun scripts/typesafe-rerank-ab.ts --namedthing --baseline voyage:rerank-3 --baseline-rpm 3 --baseline-tpm 10000 --repeats 1 --out .context/jev-namedthing.json
```

Independent question-local evidence is an evaluated inference from API-supported
object instructions, not an official cookbook recommendation. The twelve known
relevance cases and NamedThing are developer regression fixtures. They do not
establish held-out quality or calibrated autocut/CRAG confidence. Native gateway
integration tests verify these existing mechanisms accept the normalized scores;
no production threshold or downstream behavior is changed.

References: [API](https://docs.typesafe.ai/api),
[models and pricing](https://docs.typesafe.ai/models),
[Score](https://docs.typesafe.ai/primitives/score), and
[reranking cookbook](https://docs.typesafe.ai/cookbooks/rerank_typesafe).
