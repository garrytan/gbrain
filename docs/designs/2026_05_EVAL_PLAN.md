# Embedder Shootout — May 2026 Eval Plan

**Status:** approved, ready to execute
**Owner:** Garry
**Plan source:** `~/.claude/plans/system-instruction-you-are-working-linear-origami.md` (review log)
**Target wallclock:** ~2 weeks
**Target API spend:** ~$525 (hard cap $700)

## What this is

A head-to-head A/B/C comparison of three embedding providers under v0.35.0.0's new
multi-vendor gateway routing:

- **OpenAI** `text-embedding-3-large` @ 1536 dims
- **Voyage** `voyage-4-large` @ 2048 dims
- **ZeroEntropy** `zembed-1` @ 2560 dims (also 1280 in a Matryoshka ablation)

Each tested with and without the `zerank-2` reranker. Two corpora: public LongMemEval
(500q) and BrainBench in-house (145 relational queries + 50 newly-curated Cat 13
embedder-sensitive queries).

The goal: produce a publishable comparison report that answers "which embedder wins,
and does zerank-2 carry the win for ZeroEntropy" with bootstrap p-values, suitable
for a v0.35.2.0 release-note headline.

## Why this design

Locked decisions from the planning review (see plan file + `GSTACK REVIEW REPORT` at
the bottom of the linked plan):

- **Synthetic-only** — LongMemEval (public) + BrainBench (in-house). No `~/.gbrain` data.
- **Answer-gen mode** — `gbrain eval longmemeval` runs the default answer-gen path
  (Anthropic Sonnet), then feeds the resulting hypothesis JSONL to LongMemEval's
  published `evaluate_qa.py` (OpenAI gpt-4o judge) for real correctness numbers.
  `--retrieval-only` is NOT used (would produce an attackable headline; the judge
  expects answer text, not retrieval text).
- **`tokenmax` search mode** pinned across all cells (expansion + reranker slot active).
- **Serial execution** in one workspace. Clean rate-limit profile; first-contact run on
  ZE wants debuggable signal.
- **7-cell matrix** (no matched-dim cross-vendor row — no shared dim exists across
  all three vendors; honest framing is "each vendor at marketed sweet spot").

## Architectural facts that constrain the plan

- `content_chunks.embedding vector(N)` dim is fixed per brain. Per-question PGLite in
  LongMemEval makes this free; BrainBench needs separate brain per cell.
- pgvector HNSW caps at **2000 dims** (`PGVECTOR_HNSW_VECTOR_MAX_DIMS` in
  `src/core/vector-index.ts:19`). Voyage 2048 and ZE 2560 fall back to exact vector
  scan. Helps quality (no HNSW approximation) but adds latency. Footnoted in writeup.
- Reranker disable key is **`search.reranker.enabled false`**, NOT `reranker_model none`.
  `tokenmax` mode defaults reranker=true.
- `gbrain/ai/gateway` is NOT exported in v0.35.0.0. PR α exposes it.

## Matrix

| Cell | Embedder | Dim | HNSW | Reranker | Notes |
|---|---|---|---|---|---|
| A0 | `openai:text-embedding-3-large` | 1536 | yes | none | OpenAI baseline |
| A1 | `openai:text-embedding-3-large` | 1536 | yes | `zerank-2` | mixed-vendor |
| B0 | `voyage:voyage-4-large` | 2048 | no (exact) | none | Voyage solo |
| B1 | `voyage:voyage-4-large` | 2048 | no (exact) | `zerank-2` | mixed-vendor |
| C0 | `zeroentropyai:zembed-1` | 2560 | no (exact) | none | ZE embedder solo |
| C1 | `zeroentropyai:zembed-1` | 2560 | no (exact) | `zerank-2` | **ZE full stack** |
| C2 | `zeroentropyai:zembed-1` | 1280 | yes | `zerank-2` | ZE-Matryoshka ablation |

## PR structure — as few as possible

**PR α — gbrain repo: v0.35.1.0 infra.** All gbrain changes bundled. Lands first.
Bisect-friendly commits inside, ship at the very end.

**PR β — gbrain-evals repo: adapter + smoke + curation + eval receipts + writeup.** The
big one. Includes the full eval-run output committed alongside the code that produced
it, plus the comparison writeup. Lands when everything is done.

**PR γ (optional) — gbrain repo: v0.35.2.0 release** that cross-links the gbrain-evals
benchmark in CHANGELOG. Small commit; no code changes.

Total: 2 substantive PRs + 1 optional release commit. **No mid-stream ships.**

## Conductor sessions

Each section below is a self-contained brief. Copy-paste into a fresh Conductor session
to hand off. Each session ends with a clean deliverable.

---

## Session 1 — PR α: gbrain infra (v0.35.1.0)

**Repo:** `/Users/garrytan/conductor/workspaces/gbrain/<NEW-WORKSPACE>` (fresh from `master`)
**Branch:** `garrytan/v0.35.1.0-infra`
**Wallclock:** ~2h
**API spend:** $0

### What this session ships
Three changes in one PR, bundled so the embedder shootout in gbrain-evals (PR β) has a
clean prereq baseline:

1. Add `voyage:voyage-4-large` ($0.18/M) and `zeroentropyai:zembed-1` ($0.05/M) to the
   embedding pricing table. Patch the `gbrain models doctor` cost estimator + test.
2. Expose `gbrain/ai/gateway` in `package.json` exports map so the gbrain-evals
   adapters can call `configureGateway({embedding_model, embedding_dimensions, reranker_model})`
   from outside the gbrain process.
3. Add `--resume-from <jsonl>` to `gbrain eval longmemeval` so a mid-run abort
   (rate-limit, cost-cap, OS interrupt) doesn't lose the cells we already paid for.

Ships at the end as v0.35.1.0.

### Prereqs (verify before starting)
- On gbrain master at v0.35.0.0 baseline. `cat VERSION` shows `0.35.0.0`.
- `bun test` and `bun run verify` both pass on master.

### Commits (bisect-friendly, one feature per commit)

```
1. feat(pricing): add voyage-4-large + zembed-1 to EMBEDDING_PRICING
   - src/core/embedding-pricing.ts: add both entries
   - test/embedding-pricing.test.ts: pin both with $0.18 and $0.05
   - Verify: bun test test/embedding-pricing.test.ts

2. feat(exports): expose gbrain/ai/gateway with canary test
   - package.json: add "./ai/gateway" to exports map
   - test/public-exports.test.ts: add canary for configureGateway + embed
   - scripts/check-exports-count.sh: 17 -> 18
   - Verify: bun run verify

3. feat(eval): add --resume-from <jsonl> to longmemeval
   - src/commands/eval-longmemeval.ts: parse flag, skip questions already in input JSONL
   - test/eval-longmemeval.test.ts: simulated mid-run abort + resume regression
   - Verify: bun test test/eval-longmemeval.test.ts

4. chore: v0.35.1.0
   - VERSION: 0.35.1.0
   - package.json: 0.35.1.0
   - CHANGELOG.md: new entry
   - bun install (refresh lockfile)
```

### Verify before /ship
```bash
bun run typecheck
bun run verify
bun test test/embedding-pricing.test.ts test/public-exports.test.ts test/eval-longmemeval.test.ts
```

### Ship
```bash
/ship
```

### Deliverable
- `master` of gbrain at v0.35.1.0
- `gbrain/ai/gateway` reachable from external consumers (verified by canary test)
- `git tag eval-run-v0.35.1.0-baseline` (annotated, names this exact commit)
- `gbrain --version` prints `0.35.1.0`

### Hand-off to Session 2
- gbrain-evals can now `bun update gbrain` to v0.35.1.0
- The tag preserves the exact commit for any future reproducibility need

---

## Session 2 — PR β setup: gbrain-evals adapter + smoke + subset flag

**Repo:** `/Users/garrytan/git/gbrain-evals` (or a fresh Conductor workspace cloned from it)
**Branch:** `garrytan/embedder-shootout`
**Wallclock:** ~3-4h
**API spend:** ~$0.10 (smoke verification calls only)

### What this session ships into PR β (does NOT merge yet)
Wire the harness to drive 3 embedding providers via the newly-exposed gbrain gateway:

1. New typed `EvalAdapterConfig {embedder, dim, reranker?}` passed into each adapter.
2. Rewrite `vector.ts` + `hybrid-rrf.ts` to call `configureGateway()` from
   `gbrain/ai/gateway` instead of the hardcoded `gbrain/embedding` import.
3. Critical: hybrid adapter must also route `search.reranker.enabled` (true/false) and
   `search.mode` (tokenmax) — codex flagged that the existing hybrid never sets these.
4. New 3-phase smoke harness: wiring (5 queries × embed roundtrip + dim check) +
   long-haystack (1 query × 50K-token synthetic haystack) + rerank-payload (1 query
   × `topNIn=30`). Exit code is the gate.
5. New `--include-subset <name>` flag on the BrainBench runner (Cat 13 wiring; subset
   itself comes in Session 3).

### Prereqs
- Session 1 done. gbrain master at v0.35.1.0.
- API keys present: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`,
  `ZEROENTROPY_API_KEY`. Smoke fails-loud on missing key.

### Commits

```
1. chore(deps): bump gbrain pin to v0.35.1.0
   - package.json + bun.lock
   - Verify: bun install && bun run typecheck

2. feat(adapter): typed EvalAdapterConfig + gateway swap
   - NEW: eval/runner/eval-adapter-config.ts (the type)
   - eval/runner/adapters/vector.ts: constructor takes EvalAdapterConfig,
     calls configureGateway({embedding_model, embedding_dimensions})
   - Drop hardcoded gbrain/embedding import
   - Verify: existing vector adapter unit tests still pass

3. feat(adapter): hybrid-rrf wires reranker_enabled + search.mode
   - eval/runner/adapters/hybrid-rrf.ts: constructor takes EvalAdapterConfig,
     plumbs search.reranker.enabled + search.mode = tokenmax through
   - Verify: bun test eval/

4. feat(smoke): 3-phase smoke harness
   - NEW: eval/runner/smoke.ts (CLI entry: bun run eval:smoke -- --embedder X --dim Y [--reranker Z])
   - Phase 1: 5 queries × embed roundtrip, assert vector dim matches config
   - Phase 2: 1 query × synthetic 50K-token haystack, assert no token-limit error
   - Phase 3: 1 query × topNIn=30 documents, assert no 5MB payload cap hit
   - Non-zero exit on any failure
   - Verify: bun run eval:smoke -- --embedder openai:text-embedding-3-large --dim 1536

5. feat(runner): --include-subset flag for BrainBench
   - eval/runner/multi-adapter.ts: parse flag, filter queries by subset tag
   - Subset itself comes in next commit (Session 3)
   - Verify: bun run eval:run -- --include-subset cat13-embedder (errors politely because subset file doesn't exist yet)
```

### Smoke verification (run manually before opening PR)
```bash
bun run eval:smoke -- --embedder openai:text-embedding-3-large --dim 1536
bun run eval:smoke -- --embedder voyage:voyage-4-large --dim 2048
bun run eval:smoke -- --embedder zeroentropyai:zembed-1 --dim 2560
bun run eval:smoke -- --embedder zeroentropyai:zembed-1 --dim 2560 --reranker zeroentropyai:zerank-2
```

All four MUST exit 0. Reports should print the observed vector dim, matching the
configured dim.

### Open PR β
```bash
gh pr create --base main --title "feat: embedder shootout (adapter + smoke + Cat 13 + eval receipts)" --body "$(cat <<'EOF'
## Summary
v0.35.0.0 shipped ZeroEntropy zembed-1 + zerank-2 reranker support. This PR runs a head-to-head A/B/C comparison across OpenAI, Voyage, and ZeroEntropy under the new gateway routing.

This first commit batch lands the harness. Cat 13 curation, Phase 1+2 evals, and the
writeup follow in subsequent commits to this same PR.

## Test plan
- [x] Adapter unit tests pass
- [x] Smoke harness exits 0 against all 3 providers
- [ ] Cat 13 subset committed (Session 3)
- [ ] LongMemEval x 7 cells run (Session 4)
- [ ] BrainBench x 7 cells run (Session 5)
- [ ] Writeup committed (Session 5)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

### Deliverable
- PR β open against gbrain-evals `main`, green CI
- Smoke verified against all 3 providers (paste the smoke output in the PR body)
- Branch ready for Session 3 (Cat 13 curation)

### Hand-off to Session 3
- Branch `garrytan/embedder-shootout` exists on origin
- The `--include-subset cat13-embedder` flag is wired but the subset file doesn't exist
  yet — that's Session 3

---

## Session 3 — PR β: Cat 13 conceptual-recall curation

**Repo:** `/Users/garrytan/git/gbrain-evals`, branch `garrytan/embedder-shootout` (same as Session 2)
**Wallclock:** ~3-4h (heavily user-interactive; AI proposes, you review each)
**API spend:** $0

### What this session ships into PR β
Hand-curated 50 embedder-sensitive queries from BrainBench's Cat 13 (conceptual recall)
corpus. These are the queries where a graph/keyword adapter would likely miss but a
semantic adapter would find.

Codex flagged the existing 145-query relational corpus as graph/keyword-dominated and
weak for embedder claims. Cat 13 is closer to the embedder-sensitive workload but
needs hand-selection.

### Prereqs
- Session 2 done. PR β open with adapter + smoke + subset flag.

### Workflow
Interactive: Claude proposes queries in batches of 10, you accept/reject/edit each.

1. Claude reads the existing Cat 13 raw query pool:
   ```bash
   ls eval/data/raw/ | grep -i cat13
   cat eval/data/raw/cat13-*.json | jq '.'
   ```
2. Claude proposes 10 candidate queries per batch, each tagged with the inclusion
   reasoning ("would a graph adapter miss this?")
3. User accepts/rejects/edits inline. Target: 50 queries × ~5 batches.
4. Claude commits to `eval/data/gold/brainbench-cat13-embedder-subset.json`:
   ```json
   {
     "schema_version": 1,
     "subset": "cat13-embedder",
     "queries": [
       {
         "id": "cat13-emb-001",
         "query": "...",
         "relevant_chunk_ids": ["..."],
         "inclusion_reason": "paraphrase relationship; graph adapter wouldn't catch the synonym"
       }
       // ... 49 more
     ]
   }
   ```

### Commit

```
feat(eval): curate Cat 13 conceptual-recall subset (50 embedder-sensitive queries)
- NEW: eval/data/gold/brainbench-cat13-embedder-subset.json
- Each query tagged with inclusion_reason for future audit
```

### Spot-check before commit
- Pick 5 random queries, run them against a hypothetical graph adapter (e.g. grep on
  the relevant terms) and verify they would NOT surface the right chunk.
- Run the same 5 against the existing hybrid adapter and verify they DO.

### Deliverable
- `eval/data/gold/brainbench-cat13-embedder-subset.json` committed to PR β
- Exactly 50 queries
- Spot-check evidence in the commit message

### Hand-off to Session 4
- PR β now has: adapter + smoke + Cat 13 subset
- Ready for the actual eval runs

---

## Session 4 — PR β Phase 1: LongMemEval × 7 cells (overnight)

**Repo:** Same gbrain-evals branch
**Wallclock:** ~10.5h (mostly hands-off, kick off and walk away)
**API spend:** ~$476 (LongMemEval-heavy; 7 × $68/cell)

### What this session ships into PR β
7 LongMemEval scored receipts (one per matrix cell). Each is a JSONL of 500
hypotheses + a JSON file of correctness scores from `evaluate_qa.py`.

### Prereqs
- Sessions 1+2+3 done. PR β has adapter + smoke + Cat 13.
- LongMemEval dataset downloaded (gated HuggingFace; one-time setup).
- `evaluate_qa.py` checked out somewhere (from
  https://github.com/xiaowu0162/LongMemEval) with its own venv set up.
- API keys: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`,
  `ZEROENTROPY_API_KEY`.

### Wrapper script
Claude writes `scripts/run-shootout-phase1.sh` in the gbrain-evals branch. Single
entry point that loops the 7 cells serially with smoke gating + cost-cap aborts.

```
NEW: scripts/run-shootout-phase1.sh
- Per cell: gbrain config set (embedder, dim, reranker, search.reranker.enabled, search.mode=tokenmax)
- Per cell: bun run eval:smoke (abort cell on non-zero)
- Per cell: gbrain eval longmemeval ... --output results/longmemeval-{cell}.jsonl
- Per cell: cost-cap check ($90/cell hard stop)
- Per cell: --resume-from existing results/longmemeval-{cell}.jsonl if present
- Logs to results/phase1-run-log.txt
```

### Run
```bash
# Kick off in background; check back in 10-12h
bash scripts/run-shootout-phase1.sh 2>&1 | tee results/phase1-run-log.txt &
```

Use `run_in_background: true` if running through Claude. Check back periodically.

### Scoring (after all 7 cells done)
```bash
for cell in A0 A1 B0 B1 C0 C1 C2; do
  python evaluate_qa.py \
    --input results/longmemeval-${cell}.jsonl \
    --output results/longmemeval-${cell}-scored.json
done
```

Each scored file has correctness %.

### Commits

```
1. feat(scripts): Phase 1 LongMemEval wrapper with smoke gating + cost cap
   - NEW: scripts/run-shootout-phase1.sh

2. data(phase1): 7 LongMemEval cells (raw hypothesis JSONL)
   - results/longmemeval-{A0,A1,B0,B1,C0,C1,C2}.jsonl
   - results/phase1-run-log.txt (run timing + cost ledger)

3. data(phase1): evaluate_qa.py scoring results
   - results/longmemeval-{cell}-scored.json × 7
```

### Verify
- Each `longmemeval-{cell}.jsonl` has exactly 500 lines
- Each `hypothesis` field is non-empty AND is actual answer text (NOT retrieval text)
- Each `scored.json` has a `correctness_score` field

### Deliverable
- 7 scored LongMemEval receipts committed to PR β
- Real cost ledger committed alongside (compare against estimate)

### Hand-off to Session 5
- Phase 1 done. Phase 2 (BrainBench, ~3.5h) and writeup remaining.

---

## Session 5 — PR β Phase 2 + writeup + ship

**Repo:** Same gbrain-evals branch
**Wallclock:** ~7h (3.5h BrainBench + 3h writeup + /ship)
**API spend:** ~$56 (BrainBench is cheap)

### What this session ships into PR β
- 7 BrainBench cells (relational corpus + Cat 13 subset)
- Final comparison writeup
- PR β merged

### Prereqs
- Session 4 done. PR β has Phase 1 receipts.

### Phase 2 wrapper script
```
NEW: scripts/run-shootout-phase2.sh
- Per cell: configure provider (same as Phase 1)
- Per cell: bun run eval:run -- --N 10 --include-subset cat13-embedder
  --output docs/benchmarks/2026-05-22-{cell}.md
- Cost-cap check
```

### Run
```bash
bash scripts/run-shootout-phase2.sh 2>&1 | tee results/phase2-run-log.txt
```

### Writeup
`docs/benchmarks/2026-05-22-embedder-shootout.md`. Structure:

1. **Headline table** — 7 cells × {LongMemEval correctness %, BrainBench relational MRR + P@5, Cat 13 correctness %, total cost}
2. **Two questions answered:**
   - Which embedder wins solo? (A0 vs B0 vs C0)
   - Does zerank-2 carry ZE's win? (C0 vs C1 vs A1 vs B1)
   - Bonus: does dim matter for ZE? (C1 vs C2)
3. **Paired-bootstrap p-values** per headline pair (methodology in
   `gbrain/docs/eval/SEARCH_MODE_METHODOLOGY.md`)
4. **HNSW footnote** — Voyage 2048 and ZE 2560 used exact vector scan; OpenAI 1536
   and ZE 1280 used HNSW. Quality is primary, latency is secondary
5. **What this does NOT prove** — synthetic-only, tokenmax-only, no real-brain replay
6. **Recommendation:** explicit NON-recommendation to change `gbrain init` default;
   defer to a v0.36.x evidence pass with real-brain replay data

### Commits

```
1. feat(scripts): Phase 2 BrainBench wrapper
   - NEW: scripts/run-shootout-phase2.sh

2. data(phase2): 7 BrainBench cells
   - docs/benchmarks/2026-05-22-{cell}.md × 7

3. docs(benchmark): embedder shootout comparison writeup
   - NEW: docs/benchmarks/2026-05-22-embedder-shootout.md
   - Bootstrap p-values, HNSW footnote, NOT-in-scope section
```

### Ship
```bash
# Merge PR β to gbrain-evals main
gh pr merge --squash --auto
# Or non-auto if reviewing one more time:
gh pr merge --squash
```

### Deliverable
- PR β merged to gbrain-evals `main`
- Comparison report public at
  `gbrain-evals/docs/benchmarks/2026-05-22-embedder-shootout.md`

### Hand-off to Session 6 (optional)
- gbrain-evals master has the full data + writeup
- Ready for a v0.35.2.0 gbrain release that cross-links it

---

## Session 6 (optional) — PR γ: gbrain v0.35.2.0 release

**Repo:** `/Users/garrytan/conductor/workspaces/gbrain/<NEW-WORKSPACE>` (fresh from master)
**Branch:** `garrytan/v0.35.2.0-benchmark-release`
**Wallclock:** ~30min
**API spend:** $0

### What this session ships
A release-notes-only PR that bumps gbrain to v0.35.2.0 with a CHANGELOG entry
cross-linking the embedder shootout benchmark. Optional — could be folded into the
next routine release if no rush.

### Prereqs
- Session 5 done. gbrain-evals merged with the comparison writeup.

### Commits

```
1. docs(benchmark): mirror embedder shootout summary
   - NEW: docs/benchmarks/2026-05-22-embedder-shootout.md (slim mirror)
   - Cross-link to gbrain-evals canonical version

2. chore: v0.35.2.0
   - VERSION: 0.35.2.0
   - package.json: 0.35.2.0
   - CHANGELOG.md: new entry with the GStack-voice release summary
     + "numbers that matter" table from the benchmark
```

### Ship
```bash
/ship
```

### Deliverable
- gbrain v0.35.2.0 on master
- CHANGELOG entry that drives the release-note headline

---

## Cost ledger (revised, post-review)

| Component | Per cell | × 7 cells |
|---|---|---|
| LongMemEval embed | <$0.05 | <$0.35 |
| LongMemEval Sonnet answer-gen (500q × 2K tokens × $3/M) | $18 | $126 |
| LongMemEval gpt-4o judge (500q × $0.10/q) | $50 | $350 |
| BrainBench relational embed | $0.05-0.18 | <$1 |
| BrainBench Cat 13 answer-gen + judge (50q × $0.14) | $7 | $49 |
| Smoke harness (30 calls/cell) | <$0.10 | <$1 |
| **Total** | **~$75/cell** | **~$525** |

**Hard cap: $700.** Per-cell hard cap: $90 (wrapper aborts cell if exceeded; partial
JSONL preserved for resume).

## Failure modes and recovery

| Failure | Recovery |
|---|---|
| Voyage/ZE 429 rate-limit mid-cell | `gateway._shrinkState` halves safety_factor and retries. Cell continues. |
| ZE 5MB rerank payload cap hit | `applyReranker` fail-opens, returns un-reranked results. Stderr warn. |
| Mid-cell OS interrupt / cost-cap abort | Re-run with `gbrain eval longmemeval --resume-from results/longmemeval-{cell}.jsonl`. Picks up where it left off. |
| `evaluate_qa.py` auth fail | OPENAI_API_KEY check in wrapper aborts before any spend. |
| Adapter typo (bad dim) | `EvalAdapterConfig` runtime assertion at constructor throws AIConfigError. Cell aborts before API call. |

## NOT in scope (deliberate)

- **Real `~/.gbrain` replay** — adds 6-12h wallclock + $40-80 embed. Filed as v0.36.x.
- **All 3 search modes** — pinned to tokenmax. `conservative` + `balanced` are v0.35.3.0
  follow-ups if reviewers push back.
- **Matched-dim cross-vendor row** — no shared dim exists across all 3 vendors.
  Permanently out.
- **`gbrain eval whoknows` / `cross-modal` / `takes-quality`** — embedding-invariant;
  rerunning across embedders produces noise.
- **`gbrain eval code-retrieval`** — code corpus, separate concern.
- **`gbrain eval suspected-contradictions`** — wants a real brain.
- **`gbrain init --recommended` default change** — codex correctly flagged the evidence
  base as insufficient. Defer to v0.36.x with real-brain replay data.

## What already exists (reused, not rebuilt)

- `gbrain eval longmemeval` CLI (in-tree, answer-gen mode default)
- gbrain-evals BrainBench runner (`eval:run`) — needs adapter parameterization but
  per-cell test plumbing is reused
- Gateway routing for Voyage + ZE (shipped v0.35.0.0)
- Reranker pipeline (`src/core/search/rerank.ts`, fail-open)
- Pricing table (extended, not rebuilt)
- Paired-bootstrap methodology (`docs/eval/SEARCH_MODE_METHODOLOGY.md`)
- LongMemEval published `evaluate_qa.py` (invoked externally, not bundled)
