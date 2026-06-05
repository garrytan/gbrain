# MemPalace Boxed Eval — 2026-06-05

## Decision

Do not adopt MemPalace. Mine it for ideas only.

The boxed run showed that MemPalace is useful at locating the right transcript
drawer when the relevant text has been fed to it. That is not enough to justify
another memory system for Claude, Codex, Hermes, or app agents. Future agents
should not ask the operator to remember MemPalace as a tool option; if an idea
from MemPalace is useful, turn that idea into a concrete GBrain/Hermes/Codex
implementation task with its own owner and receipt.

## Scope

This eval used a generated public-safe transcript corpus derived from the
MemPalace source review and the GBrain eval runbook. It did not mine private
Claude, Codex, Hermes, customer, credential, or app-agent transcripts.

That means the result proves a narrow thing:

- MemPalace can index and retrieve a small boxed transcript corpus from `/tmp`.
- The eval can run without mutating live agent surfaces.
- The exact-answer layer did not clear the adoption bar.

It does not prove old-session backfill quality on real private transcripts.

## Receipts

- Upstream source inspected: `https://github.com/MemPalace/mempalace`
- Upstream checkout inspected: develop commit `02b8753`
- Upstream package version in inspected source: `3.3.6`
- Local binary used for the boxed run: `/Users/sawbeck/.local/bin/mempalace`
- Local binary version: `MemPalace 3.3.4`
- Boxed workspace: `/tmp/mempalace-boxed-eval-20260605`
- Boxed corpus: `/tmp/mempalace-boxed-eval-20260605/corpus`
- Boxed palace: `/tmp/mempalace-boxed-eval-20260605/palace`
- Temporary HOME: `/tmp/mempalace-boxed-eval-20260605/home`
- Query set: `/tmp/mempalace-boxed-eval-20260605/queries.tsv`
- Comparison output: `/tmp/mempalace-boxed-eval-20260605/receipts/comparison-results.md`

The run used `HOME=/tmp/mempalace-boxed-eval-20260605/home` and
`XDG_CACHE_HOME=/tmp/mempalace-boxed-eval-20260605/home/.cache`. Chroma's
`all-MiniLM-L6-v2` model downloaded into that temp cache. No real home hook
state, profile config, MCP config, or agent plugin config was intentionally
changed.

## Commands

```bash
HOME=/tmp/mempalace-boxed-eval-20260605/home \
XDG_CACHE_HOME=/tmp/mempalace-boxed-eval-20260605/home/.cache \
mempalace --palace /tmp/mempalace-boxed-eval-20260605/palace \
  mine /tmp/mempalace-boxed-eval-20260605/corpus \
  --mode convos \
  --wing mempalace_eval
```

Mine result:

- files processed: 20
- files skipped: 0
- drawers filed: 40

Status after mining:

- total drawers: 40
- wing: `mempalace_eval`
- rooms: `technical`, `general`, `architecture`, `planning`, `decisions`

Comparison command:

```bash
bun /tmp/mempalace-boxed-eval-20260605/run-comparison.js
```

## Comparison

The comparison used 20 recall queries.

Strict expected-string score:

| Surface | Hits |
|---|---:|
| MemPalace boxed corpus | 8/20 |
| GBrain current `gbrain` source | 1/20 |
| Current curated memory grep | 2/20 |

Source-level read:

- MemPalace returned the correct top source drawer for 20/20 queries.
- GBrain current-source search mostly returned unrelated current-source pages
  because this temporary corpus and the dirty eval runbook were not synced into
  live GBrain.
- Current memory correctly carried the operating preference around boxed
  sidecars, proof gates, and medium/high effort after a bounded goal, but it did
  not carry transient eval receipts such as the temp workspace path.

Interpretation:

- MemPalace was good at finding the right drawer in the corpus it owned.
- The CLI search output did not always include the exact expected answer string
  in the top three results, even when the right drawer was first.
- The current GBrain/memory stack remains the correct system of record; it was
  not fed this temporary transcript corpus, so this eval is not a head-to-head
  retrieval benchmark over identical indexed data.

## Decision Rationale

Adoption would require MemPalace to win a real job that GBrain/current memory
does not handle well, such as approved old-session transcript recall with strong
verbatim recovery and acceptable operator friction.

This run did not clear that bar. It cleared a lower bar: MemPalace can be boxed
safely and can retrieve the right drawer from a small controlled corpus.

The right next move is not "remember this tool later." The right next move is:

- do not install MemPalace plugins
- do not wire MemPalace hooks
- do not add the MemPalace MCP server
- do not add MemPalace to Hermes or app-agent surfaces
- mine the source-adapter contract idea only if it becomes a concrete GBrain
  task
- mine the bounded hook-timeout idea only if it becomes a concrete hook-safety
  task
- keep live Claude/Codex/Hermes/app agent surfaces unchanged

## Hard Nos Still Active

- no global Stop hooks
- no global PreCompact hooks
- no live MCP write tools
- no automatic live-agent diary writes
- no live knowledge-graph writes
- no drawer delete/update tools on live surfaces
- no Hermes profile edits
- no Codex or Claude user-scope plugin installation
- no migration of canonical GBrain content into MemPalace

## Verification

Passed before this report:

- `bun run build:llms`
- `bun test test/build-llms.test.ts`
- `bun run check:privacy`
- `bun run check:proposal-pii`
- `bun run check:doc-history`
- `git diff --check`

Known unrelated residue:

- `bun run check:newlines` still fails on
  `test/fixtures/e5-lease-cap-ab/2026-05-24-baseline-dry-run.json`, which
  predates this eval and is unrelated to the MemPalace files.
