# Managed Google `loops_extract` — Lane A release evidence

Date: 2026-09-25
Branch: `fix/managed-google-loops-extract`
Repository: contributor fork of GBrain
Target upstream: GBrain `master`

## Scope and safety

This evidence covers only the GBrain upstream release lane for managed Google open-loop extraction.

Out of scope and intentionally untouched:

- downstream product code;
- browser acceptance;
- production deploy;
- production job recovery;
- OAuth changes;
- Source recreation;
- knowledge-authority reconciliation.

No production environment was modified while producing this evidence. No credentials, tokens, real email content, private account identifiers, or private PII are included here.

## Rebaseline

Checkpoint lineage started from upstream:

- original checkpoint base: `31f257a0a7b218b40e03d302bc6913c99f26f0ec` (`v0.54.1.1`);
- intermediate release baseline: `46c71f228f607006b2777d314b1a37bc34607738` (`v0.56.2.0`);
- final release baseline: `467ff6737f741375a9a78eafd2818634d908eb99` (`v0.57.0.0`).

Both later upstream baselines still list `loops_extract` in
`UNSUPPORTED_MANAGED_BULK_WRITERS`, and the upstream extractor still enters
`assertUnmanagedCanonicalWriter` before provider work. No equivalent upstream fix was found.

The `v0.57.0.0` baseline also pinned and patched `postgres@3.4.9`. The local
dependency tree was refreshed with `bun install --frozen-lockfile` before final
lock-accurate gates; no versioned file changed as a result.

The three implementation commits were preserved and rebased without conflict:

| Checkpoint commit | Final rebased commit | Purpose |
|---|---|---|
| `28440cef5` | `64f03b947` | authorize managed loop extraction |
| `e7f227491` | `339ecda62` | cover managed loop authority fences |
| `cb5694a68` | `271da756b` | refresh structural/module-size guards |

Final code SHA before this evidence-only commit: `271da756b`. The evidence
commit is intentionally separate so the implementation SHA remains explicit.

## Root cause

The existing Google commitment extractor was a multi-stage writer:

1. read a Google email page;
2. call the configured chat provider;
3. project results into facts;
4. upsert native `open_loops`;
5. add typed graph edges.

Managed Persistence correctly blocked that legacy writer through `assertUnmanagedCanonicalWriter(..., 'Google loop extraction')`.

Removing that guard alone would be unsafe: provider work could run without durable Source identity, a Source could be archived/recreated while the provider was running, and the resulting facts/loops/edges could publish outside the managed writer coordinator.

## Managed authority design

The patch keeps the legacy direct path fail-closed and adds a separate managed execution path.

### 1. Durable Source incarnation at enqueue

The Google sweep reads the active Source identity and stamps `sourceIncarnation` into each newly accepted `loops_extract` job.

This makes a job refer to a specific Source incarnation rather than only a reusable Source ID.

### 2. Authority before provider

Managed execution requires:

- Managed Persistence still enabled;
- trusted application-job submission authority;
- `sourceIncarnation` present;
- active, non-archived Source;
- exact current Source incarnation match;
- Source config kind = `google`.

This check runs before chat/provider I/O.

### 3. Coordinated source-scoped publication

After the provider returns, publication runs in a database transaction and:

- revalidates the same authority again;
- obtains a Source row lock for the revalidation;
- enters `withCoordinatedWrite(..., [sourceId])`;
- writes the fact projection through the coordinated database-only seam;
- writes native `open_loops`;
- writes typed source-bound edges.

The coordinated capability is callback-scoped and is proven not to leak after the publication callback.

### 4. Publication revalidation

If Source authority changes while provider work is in flight — archive, recreation, replacement, or incarnation change — the second authority check fails before any fact, loop, or edge publication.

### 5. Source isolation

All page lookup, loop writes, fact writes, entity resolution, and typed-edge writes remain bound to the job's Source. Tests cover wrong-source invisibility and source-bound edge publication.

### 6. Legacy direct denial preserved

`runLoopsExtract` remains the legacy/unmanaged path. Under Managed Persistence it still fails through `assertUnmanagedCanonicalWriter`.

Only the registered trusted managed application-job route can enter `runManagedLoopsExtract`.

## Test matrix

### Branch-owned positive/negative coverage

Final lock-accurate focused command covered 15 relevant files:

- **248 PASS**
- **0 FAIL**
- 1,029 expectations
- 15 files
- 30.17s Bun runtime / 31s wall clock
- schema baseline: v165

Coverage includes authority-before-provider, legacy direct denial,
`sourceIncarnation` fencing, archived/replaced Source denial, coordinated
publication, capability non-leak, post-provider authority loss, source
isolation, Google materialize/reconcile/detect, loops store, persistence
fences/page authority, and job identity/startup/lifecycle.

### Upstream/pre-existing failures

The two broad suites were run on the final rebased branch and reproduced from
a detached pure-upstream `467ff6737` worktree with the same lock-accurate
dependency tree.

Branch run: **37 PASS / 7 FAIL**, 44 tests, 6.61s Bun runtime.
Pure upstream run: **37 PASS / 7 FAIL**, 44 tests, 13.41s Bun runtime.

The same seven assertions fail in both runs. They include macOS `/tmp` ->
`/private/tmp` canonicalization expectations plus existing managed-topology
fixture behavior. Classification: **FAIL UPSTREAM / PRE-EXISTING**.
No branch-owned assertion failure was found in these suites.

### Typecheck / build / diff

After installing the exact `v0.57.0.0` lock:

- `bun run typecheck`: **PASS**, 33s wall clock.
- `bun run build`: **PASS**, approximately 1s wall clock.
- `git diff --check upstream/master...HEAD`: **PASS**.

An initial post-rebase typecheck used the prior baseline dependency tree and
exposed the expected mismatch around the newly patched postgres API.
Refreshing dependencies from the committed lock resolved it without source
changes.

### Verify

Final host/default verify:

- **55/55 PASS**
- pool: 4
- per-check timeout: unchanged at 120s
- elapsed: 50s (53s wall-clock class)
- no assertion weakening or timeout increase.

### `ci:local:diff`

The default Docker run started on the immediately preceding rebased baseline
`46c71f2` and completed these phases successfully:

- gitleaks configuration/self-test: **PASS**;
- worktree secret scan: **PASS**;
- branch commit gitleaks scan: **PASS**;
- Docker verify: **55/55 PASS**, pool=10, timeout=120s;
- serial lane: **318 files / 3,156 PASS**, all files passed, 1,245s;
- slow lane: **135 PASS / 1 SKIP / 0 FAIL**, 17 files, 738.88s;
- 4-shard unit/E2E phase started and every observed completed group had `fail=0`.

While shards were still running, upstream published the material persistence
release `467ff6737` (`v0.57.0.0`). The Docker run was stopped deliberately and
classified **SUPERSEDED BY UPSTREAM REBASE**, not as a test failure. It
recorded no branch assertion failure before termination.

After rebasing onto `467ff6737`, the branch reran the lock-accurate focused
matrix, broad-suite classification, typecheck, build, diff check, and verify;
all branch-owned gates remained green.

Historical checkpoint note: an earlier Docker run intermittently timed out one
verify check under pool=10 while every affected check passed in isolation and
verify passed with supported lower parallelism. That result remains
**FLAKE / INFRA resource contention**. A later Docker verify passed 55/55 at
pool=10 with the original 120s timeout.

## CI classification vocabulary

| Class | Final lane interpretation |
|---|---|
| PASS | Final branch-owned focused/type/build/verify gates completed successfully. |
| FAIL — branch-owned | None observed. |
| FAIL — upstream/pre-existing | 7 failures reproduced identically on pure upstream `467ff6737`. |
| FLAKE / INFRA | Historical Docker verify timeout under resource contention; later Docker verify pool=10 passed 55/55 without timeout change. |
| SUPERSEDED | Long Docker `ci:local:diff` stopped only because upstream published a material persistence baseline while shards were running. |
| SKIP | Production deploy, browser acceptance, and production job recovery are outside this lane. |

## Pre-contract job disposition and recovery runbook

Older `loops_extract` jobs created before this patch do not contain `sourceIncarnation`.

The real queue implementation for `retryJob(id)` reuses the existing row and its existing `data`; it resets execution state/counters but does **not** enrich the payload with a current Source incarnation.

The managed handler now rejects a payload without `sourceIncarnation` with `source_changed` and instructs the operator to re-candidate through the current Google Source sweep.

Therefore the disposition is:

**B — leave pre-contract jobs historical/dead and create a new candidacy through the official Google sync path.**

Do not:

- manually `UPDATE` or `DELETE` job rows;
- clear an idempotency key manually;
- fabricate a new SQL payload;
- mark old jobs completed;
- use `gbrain jobs retry <old-id>` for pre-contract `loops_extract` rows.

### Future recovery procedure — only after an authorized deploy

1. Confirm the deployed GBrain contains this managed patch or an accepted upstream equivalent.
2. Confirm Managed Persistence is enabled and healthy.
3. Resolve the currently active Google Source through normal GBrain source inspection; do not recreate the Source.
4. Confirm the Source is active, non-archived, and `kind=google`.
5. Confirm the chat provider required for commitment extraction is available.
6. Confirm `loops.extraction_enabled` is not disabled.
7. Leave all pre-contract dead rows untouched.
8. Run the official full sync for the existing Source:
   `gbrain sync --source <google-source-id> --full`
9. The full sync re-candidates current, eligible, in-window threads and enqueues new revision-keyed `loops_extract` rows carrying the current `sourceIncarnation`.
10. Inspect newly created jobs through normal job read surfaces and verify their payload includes `sourceIncarnation`. Do not infer success from the old job IDs.
11. Let the normal worker claim and execute the new rows.
12. Verify resulting loops through normal read surfaces and confirm Source isolation/provenance. Any remediation remains source-scoped and uses supported GBrain operations.

## Limits and assumptions

- No production Google provider call was made for this release lane.
- No real email body is part of this evidence.
- No schema migration is introduced by these three commits; the final upstream baseline itself advances to schema v165.
- The patch assumes the existing managed coordinator primitives and submission-authority context remain available.
- The patch deliberately does not turn generic remote jobs into trusted application jobs.
- The patch does not make legacy/direct `loops_extract` a supported managed writer.
- Full-sync recovery only re-candidates currently eligible/in-window material according to the Google connector's normal rules; it is not a raw resurrection of historical job payloads.

## Rollout / rollback assumptions

This lane does **not** authorize deployment.

If deployment is later authorized:

- cut over by deploying the reviewed branch/upstream merge through the normal GBrain release process;
- do not retry pre-contract extraction jobs;
- create fresh candidacy via the official full Google sync path.

If the runtime must be rolled back:

- deploy the previously approved GBrain binary/revision through the normal release mechanism;
- keep historical job rows intact;
- do not mutate Source identity or queue tables by hand;
- if any managed extraction already committed native facts/loops/edges, handle semantic correction through supported GBrain operations rather than destructive SQL.

## Production

**NOT DEPLOYED.**

No production service, source, OAuth grant, Source lifecycle, or production job state was changed by Lane A.
