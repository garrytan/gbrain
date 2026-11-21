# Research records

Everything we try in gbrain gets a page here, whatever the outcome: experiments,
evals, pilots, quick looks and trial features. Read the matching page before you
repeat an approach. These are historical evidence, not promises about current
GBrain behavior. Eval results with their own preregistration also live in
[gbrain-evals](https://github.com/garrytan/gbrain-evals/tree/main/docs/benchmarks);
a page here links them instead of copying them.

| Date | What we tried | Outcome |
|---|---|---|
| 2026-11-21 | [Rust engine parity test audit](rust-test-audit.md) | Research only; no code changed. The parity tests caught 23 of 29 reachable injected bugs. Recommends gating pushes to the Rust trunk on checks that already exist, failing a positive case on a refused or empty answer, and letting a case declare its expected value. |
| 2026-11-20 | [Retrieval playbooks: a search recipe served on the turn](2026-11-20-retrieval-playbooks.md) | Cut candidate; nothing built. On 14 list-or-count questions the recipe got 9 right against plain's 6, one short of the +4 bar. gbrain's served "call context_pack at session start" line fixed GPT-6.2 Sol's first call whatever the recipe said. |
| 2026-11-20 | [Finding duplicate people and companies: head-to-head](2026-11-20-entity-dedupe-head-to-head.md) | The automatic tier stays empty for people: it joined 36 of 488 different-person pairs (7.38%) on hard cases, 0 of 188 companies. Tuned Splink beat the proposed tier (+8.26 recall, −7.54 false-merge points), so a native version of that method is planned. |
| 2026-11-20 | [A "no evidence found" line from memory](2026-11-20-no-evidence-line.md) | No build. Even a perfect line cut made-up answers on BEAM-500K by 2.0 points (−0.5 to 5.1) against a 13-point bar; particle-1 made up more answers with it. |
| 2026-11-19 | [Reading several pages in one call](2026-11-19-multi-page-read.md) | Closed unmerged ([#9798](https://github.com/garrytan/gbrain/pull/9798)). Agents read more pages per cell, so tool text went up 13.8%, then 3.4% after a fair-share budget fix. |
| 2026-11-17 | [Trunk Dynamic CI test skipping](2026-11-17-trunk-test-skipping.md) | Don't enforce; stays in learning mode. Enforcement would have skipped 10 of 52 gated failures, one a security-regressions failure. |
| 2026-11-16 | [Multi-user prior art for the Rust engine](rust-engine/multi-user-prior-art.md) | Research only; no code changed. Recommends optimistic, serializable transactions in the FoundationDB style over a proven embedded store (redb leads the bake-off), deterministic simulation from the start, and a replacement without PGLite-style whole-brain locking for each Postgres lock and queue pattern gbrain uses today. Avoid the Rust Postgres rewrite as a dependency. |
| 2026-11-15 | [Keyless any-word fill](2026-11-15-keyless-any-word-fill.md) | Shipped ([#9414](https://github.com/garrytan/gbrain/pull/9414)) after a first build was closed in review. Keyless LongMemEval S recall_all@10 80.64% → 91.06%, 0 questions worse. |
| 2026-11-15 | [Per-turn context and OpenClaw's prompt cache](2026-11-15-openclaw-prompt-cache.md) | Shelved. Current OpenClaw already pins the system prompt; the fix cut cache writes 34% against a 70% bar. |
| 2026-11-14 | [Skill resolver no-skill gate](2026-11-14-skill-resolver-no-skill-gate.md) | Shipped at 0.6 ([#9356](https://github.com/garrytan/gbrain/pull/9356)). No-skill suggestions 61/61 → 7/61 on a 351-skill set; still 93/112 at 750 skills, open. |
| 2026-11-11 | [search_exact on the starter tool surface](2026-11-11-search-exact-starter-probe.md) | No change. Cat 40 list-or-count 9/84 → 17/84 (p = 0.057) while Opus cost per episode rose from $1.45 to $3.37. |
| 2026-11-10 | [Reranker on or off for memory questions](2026-11-10-reranker-on-off.md) | Keep the reranker. 9 questions better with it, 7 without (p = 0.80); underpowered. |
| 2026-11-08 | [Refresh write barrier](2026-11-08-refresh-write-barrier.md) | Passed; flag recommended on, still opt-in. 0 lost writes in 2,000 trials; gpt-6.1-sol strict success 4 → 60 of 60. |
| 2026-09-29 | [PGLite managed-persistence write throughput](pglite-persistence-throughput-2026-09-29.md) | Shipped. PGLite soak 8.9 → 31.7 writes/s in matched 1,000-write runs on `standard-30`; the 10,000-write gate soak drops from 1,417 s to 277–308 s; Postgres 11.2 → 13.5 writes/s; all crash boundaries and full gates pass. |
| 2026-09-24 | [T-Mem validation for GBrain](t-mem-2026-09-24/postmortem.md) | Feature [#5374](https://github.com/garrytan/gbrain/pull/5374) is mothballed, not merged. Preserve the research and evaluator separately: no completed custom feature-on score; a released-code pilot found a small descriptive-trigger retrieval signal but no demonstrated answer-quality gain. |

Older recorded experiments, including answer-evidence packets and the
October external-ideas waves, are listed in
[eval-bench.md](../eval-bench.md#recorded-experiments-including-negative-results).

## Adding a page

Add a page when a try reaches a decision (shipped, kept, cut, shelved, no build),
and add its row above, newest first: the date it was decided, the page link
phrased as what we tried, and the outcome with its headline number. Name the
file `YYYY-MM-DD-<short-name>.md`. Use generic placeholders for people and
companies (`alice-example`, `acme-example`), and link pull requests, runs or
reports as sources; an internal tracker code can follow as a secondary note,
never as the only source. A number you couldn't check against its source is
written as "reported by", not as fact.

```markdown
# <What we tried> (<outcome>, <date>)

- **We learned that ...** One to three plain takeaways, what works first.

## Question
What we wanted to know, and why it mattered.

## What was tried
Build version or commit, method, models, and the bars set before the run.

## Results
The numbers, each with its source (run, pull request, report).

## Decision and why
Shipped, kept, cut, shelved or no build, and the reason.

## Cost
Model use and paid runs, or "not recorded" with where it lives.

## What would reopen it
The evidence or change that would make this worth trying again.
```

## Living research maps

| Research | What it is |
|---|---|
| [Rust rewrite research maps](rust-engine/README.md) | Maps of what TypeScript gbrain and gbrain-evals do today (storage engine, agent contract, jobs, tests, evals), pinned to one commit. The plan of record is [docs/designs/RUST_ENGINE.md](../designs/RUST_ENGINE.md) (PR #9593); the draft [PLAN.md](../plans/PLAN.md) is kept as research. |
