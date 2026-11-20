# Refresh write barrier: hold writes during a refresh instead of refusing them (passed, 2026-11-08)

- **We learned that gbrain can hold a write that arrives during a refresh, and lose none.** In 2,000 counted concurrency trials on Postgres and PGLite, nothing was lost, stuck, duplicated or overwritten, and refusals during a refresh went to zero.
- **We learned that agents do far better with a held write than a refused one.** Refused writes led agents to resend under a new request id. If you build tools for agents, answer a busy write with a status the agent can check, not an error it has to retry.

## Question

gbrain refuses a write that arrives while it refreshes a brain checkout (`worktree_refreshing`), and the client has to retry. Can a barrier (`persistence.refresh_barrier`) hold those writes and save them safely, and do agents do better with it?

## What was tried

A preregistered counted run in gbrain-evals, flag off against flag on: 500 concurrency trials per engine and arm, a retrieval-latency check, and an agent part with gpt-6.1-sol and claude-opus-5-5 on 60 tasks each. The first counted run at gbrain `431cb3f9` failed (writes held behind aborted refreshes stayed pending up to about 300 s); gbrain fixed that in `773a29ee`, and the two runs are never pooled.

## Results

| Measure | Flag off | Flag on |
|---|---|---|
| Lost, stuck, duplicated or overwritten writes | 0 | 0 |
| Trials that met a `worktree_refreshing` refusal (Postgres, PGLite) | 170, 138 | 0, 0 |
| p95 wait for a write's first answer during a refresh (Postgres, PGLite) | about 10 s | 76 ms, 35 ms |
| gpt-6.1-sol strict success, of 60 | 4 | 60 |
| claude-opus-5-5 strict success, of 60, adjudicated (raw) | 15 (14) | 37 (28) |

Retrieval scores didn't change. The scorer counted an untitled `capture` as a duplicate fact, which worked against the flag; results stand as scored.

Source: gbrain-evals [#384](https://github.com/garrytan/gbrain-evals/pull/384) (merged as `2ecc322d`), with `docs/benchmarks/2026-11-08-refresh-barrier-results.md` and its preregistration amendments.

## Decision and why

PASS: the flag is recommended on for gbrain `773a29ee` and later. It is still opt-in: `persistence.refresh_barrier` defaults to off (`src/core/persistence/switches.ts`), so turning it on by default would be a separate default change.

## Cost

About $352 of a $390 budget, as reported by the eval team.

## What would reopen it

- Any lost or duplicated write under the barrier in production or a later run, or a proposal to make it the default.
