# BrainBench — cross-harness memory conformance suite

BrainBench measures the four failure modes of agent memory, per harness seam,
plus four memory-trust suites (#5575):

| Suite | Question it answers | Headline metrics |
|---|---|---|
| `know-to-ask` | Does memory surface unprompted when it should — and stay silent when it shouldn't? | `know_to_ask_failure_rate`, `false_fire_rate` |
| `push` | When context is volunteered, was it the right context? | `push_precision`, `push_recall` |
| `write-back` | Did conversation facts survive into storage, with correct provenance? | `write_back_fidelity`, `provenance_accuracy` |
| `continuity` | A decision made in harness A — recalled in harness B? | `continuity_rate` |
| `trust` | Is every write stored, and read back, at the tier its channel earns — with no laundering upward and no self-promotion? | `trust_label_accuracy`, `laundering_violations`, `self_promotion_violations` |
| `state-resolution` | After updates, is the current fact current, the old one history, and the owner's fact safe from a lower-tier writer? | `current_fact_accuracy`, `stale_surfaced_as_current`, `history_preserved`, `lower_tier_supersede_violations` |
| `poisoning` | Does instruction-like text from a connector, a tool output or an agent stay out of a later session's proactive context? | `poison_persist_rate`, `flagged_and_labeled_rate`, `agent_relayed_activation_rate`, `poison_activation_rate`, `benign_retention`, `false_quarantine_rate` (protections on); `default_persist_unlabeled_rate`, `default_activation_unlabeled_rate`, `default_benign_retention` (shipped defaults) |
| `deletion` | Does `forget --purge` remove a claim from every live store, account for each in its receipt, and keep it from coming back? | `residual_after_purge`, `receipt_completeness`, `resurrection_after_resync` |

Plus cross-cutting: `source_isolation_violations` (gates at zero — a cross-source
injection is gbrain's data-leak invariant) and `avg_injected_tokens` (intrusion
diagnostics, non-gating).

Run it:

```bash
gbrain eval brainbench --harness all --suite all              # scoreboard
gbrain eval brainbench --json --out /tmp/bb.json              # machine-readable
gbrain eval brainbench --compare evals/brainbench/baselines/main.json
gbrain eval brainbench --update-baseline                      # bless intentional movement
```

Hermetic by default: in-memory PGLite, `noEmbed` seeding, zero API keys, zero
LLM calls. `--llm` opts the write-back suite into the real extractor
(budget-guarded).

**Memory-trust suites write through real channels, never the seeder.** Their
fixtures carry `trust_steps` instead of `seed_pages`: an `owner` writes files in
the fixture's own git-backed source and syncs (your notes), confirms and purges
as the local CLI on a terminal; a `remote_agent` calls `put_page`, `capture`,
`remember`, `forget`, `confirm_memory` and `purge_fact` as an MCP connection; a
`local_agent` calls them as the CLI without a terminal; a `connector` is the
GitHub connector importing a synthetic issue feed; `raw` attempts a direct tier
raise. One persistence-enabled brain runs every trust fixture, one source (and
repository) per fixture, and each step waits for its post-commit effects. The
poisoning fixtures' turns then replay as a later session through every harness
seam and `context_pack`. Gold (`trust.items`) names what each step should have
produced; see `docs/eval/BRAINBENCH.md` for every metric's formula.

## Layout

```
fixtures/   *.fixture.json   adapter-visible conversations (schema/fixture.schema.json)
gold/       *.gold.json      SEALED gold annotations (schema/gold.schema.json)
schema/     JSON Schemas     the published interchange contract (fixture/gold/result/baseline)
baselines/  main.json        the committed CI gate baseline (diff-stable, metrics-only)
generator/  gen.ts           deterministic corpus generator (seed 42)
_ledger.json                 corpus metadata: counts, seed, rebuild command
```

**Sealed gold.** Fixture files contain only what an adapter may see. Gold lives
in `gold/`, joined by `fixture_id`; a `gold` key inside a fixture turn is a
validation error. The harness hands adapters a sanitized `PublicTurn`.

**Holdout.** ~15% of fixtures carry `holdout: true` — excluded from the CI
gate, scored only in published runs (`--include-holdout`). Gaming resistance.

## The corpus

Generated, not hand-authored: `bun evals/brainbench/generator/gen.ts` rebuilds
the committed corpus byte-identically (Mulberry32 PRNG, seed 42). The fictional
universe (~40 people, ~30 companies, ~12 funds) is invented whole-cloth from
curated synthetic name pools — no real person, company, fund, deal shape, or
timeline is mirrored (scenario-privacy rule; see "Fixture authoring" below).

**Prose is template-synthesized with PRNG-selected variants — deliberately no
LLM pass.** A conformance benchmark's difficulty must be controlled, not
incidental: the templates place exact capitalization patterns, near-miss
aliases, stopword collisions, ambiguous shared aliases, and budget-exceeding
entity counts. Several know-to-ask variants intentionally exercise documented
v1 reflex limits (lowercase mentions, surname-only references — see
`src/core/context/entity-salience.ts`); gold records what SHOULD happen, the
baseline records what the current system does, and the gap is the measured
roadmap. An optional Opus prose-polish layer (cache-keyed, cost-capped) is a
documented future extension.

Hand-authored spike fixtures (`kta-001`, `kta-002`, `ms-001`, `wb-001`,
`cont-001-*`) froze the schema before the generator scaled it; they remain part
of the corpus. `ms-002-nondefault-active` is hand-authored too: it is the only
fixture with a non-`default` `active_source` (the generator pins gen-ms
fixtures to `active_source: default`), exercising the cross-source leak
detector's other arm — a twin slug seeded into `default` AND `teambrain`, a
teambrain-only page, and a default-only leak canary, replayed with
`active_source: teambrain`.

## Fixture authoring (contributions welcome)

1. Conform to `schema/fixture.schema.json` + `schema/gold.schema.json`
   (`bun test test/brainbench-fixtures.test.ts` validates the corpus).
2. **String privacy:** placeholder/synthetic names only; dates within
   2024–2026; `$X` instead of real amounts (`scripts/check-synthetic-corpus-privacy.sh`
   enforces in `bun run verify`).
3. **Scenario privacy:** invent scenarios whole-cloth. Do NOT anonymize a real
   situation — no real deal shapes, amount patterns, timeline mirrors, or
   recognizable fund behavior. If someone in your network could recognize the
   situation with the names swapped, rewrite it.
4. Write-back fixtures (and continuity writers) need `ts` on every turn —
   segmentation is time-based. A >30 min gap splits segments.
5. Continuity pairs: exactly one `writer` + one `reader` per `pair_id`; the
   reader's gold carries the decision probes.
6. Memory-trust fixtures run exactly one trust suite, write only through
   `trust_steps` (the loader rejects `seed_pages`/`seed_facts` there), and use
   reserved domains (`.invalid`, `*-example`) for any address. Every poisoning
   payload and benign item carries a canary token unique to the corpus, in
   exactly one step, so the scorer can follow it through every store and
   surface. Do not tune a payload until the gate catches it: a payload the
   gate misses is the finding the suite exists to report.

### Gold conventions (validated by blind double-label, 96.4% agreement)

- **Facts must be stated.** Every `gold_facts[].fact` is a faithful
  restatement of claims actually present in the turn text — never an inferred
  rationale or template leftover.
- **Re-mentions demote, not retrieve.** A turn re-mentioning an entity whose
  pointer was just surfaced is `should_retrieve: false` (suppression is
  correct behavior); when a turn mixes a NEW entity with re-mentions, the new
  entity is gold and the re-mentioned ones go to `acceptable_slugs`.
- **Information-bearing pages are gold; named-but-secondary pages are
  acceptable.** In multi-entity push turns the person/fund pages carrying the
  answer are `gold_slugs`; a company named verbatim but secondary to the ask
  may sit in `acceptable_slugs` (injected = fine, missed = no penalty).
- **"Just got off the call" openers carry no gold.** A meeting having
  happened is below the notability bar; the claims inside it are the facts.

## Reusing BrainBench from another repo (gbrain-evals)

The full foreign-runner surface is the subprocess CLI contract:

```bash
gbrain eval brainbench --fixtures <DIR> --gold <DIR> --json --out result.json
```

Point it at any conforming corpus; parse `result.json` against
`schema/result.schema.json`. Exit codes: 0 pass, 1 regression (with
`--compare`), 2 error/inconclusive. The sibling gbrain-evals repo wires this as
`eval/runner/brainbench-memory.ts`.

## Baseline governance (how the CI gate works)

CI compares HEAD's run against **main's** copy of `baselines/main.json`
(fetched via `git show origin/master:...` — a PR cannot rewrite the thing it's
compared against). Same `fixtures_hash` ⇒ count-aware gate (any newly-failed
gold item fails). Different hash (you changed fixtures) ⇒ corpus-bless mode:
the gate verifies your committed baseline exactly matches HEAD's actual run,
and the fixture diff is what the reviewer judges. Any metric regression vs
main's baseline requires a `justification` string in the updated baseline —
visible in your PR diff. Methodology: `docs/eval/BRAINBENCH.md`.
