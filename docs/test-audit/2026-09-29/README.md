# Test audit evidence, 2026-09-29

Read-only discovery records from the 2026-09-29 test audit of gbrain at
`2ede415` (v0.59.11.0). Five lanes looked for tests that protect no shipped
behavior, the production code only those tests keep alive, and the coverage
holes that must be filled before anything is removed. Every candidate carries a
mutation probe: a behavior-breaking edit the test missed, or a
behavior-preserving edit it failed on.

These files are a historical research record. They describe the tree as it was
at `2ede415`; line numbers and counts drift as master moves, so re-verify a
reference against the current checkout before acting on it. They are not part of
the `llms.txt` bundles (`scripts/llms-config.ts` lists its sources explicitly
and does not include `docs/test-audit/`). The scanner scripts that produced the
inventories are not committed.

How a test is retired, and the evidence each deletion needs, is described in
[docs/TESTING.md](../../TESTING.md) ("Coverage responsibilities before
consolidation").

## Lanes

| Lane | Report | What it establishes | Consumed by |
|---|---|---|---|
| source-grep | [lane-source-grep/source-grep.md](lane-source-grep/source-grep.md) | Tests that read `src/**` as text: which are blind to behavior changes (probe edits they miss), which pin real contracts, and which need a routing fix before they can go | Blind/duplicate deletions; the source-grep rewrites; the `postgres-engine.ts` E2E map entry |
| doc-pins | [lane-doc-pins/doc-pins.md](lane-doc-pins/doc-pins.md) | Tests that assert on committed docs, skills, templates and recipes: prose-only pins versus generated-artifact freshness, link integrity and shipped prompt contracts | Doc-pin deletions; the resolver fixture tests; the doc-claims consolidation |
| e2e | [lane-e2e/e2e.md](lane-e2e/e2e.md) | How `test/e2e` files are routed in CI, which files run only PGLite, which wrappers double-run scenarios, and where selected E2E spends time | E2E lane corrections; the PGLite-only lane-move pilot |
| patterns | [lane-patterns/patterns.md](lane-patterns/patterns.md) | Cross-cutting low-value shapes over `test/**`: typeof probes, placeholder assertions, copied-function tests, near-duplicate files | Placeholder and typeof-probe cleanup; the `gbrain features` behavioral tests |
| seams | [lane-seams/seams.md](lane-seams/seams.md) | Test-only exports in `src/`, seams with no callers, and `src/` modules unreachable from every runtime entry (static walk, orphan guard, poison probe) | Seam cleanup; the dead-module cluster removals and their disposition gate |

## Inventories and probe logs

| File | Contents |
|---|---|
| [lane-source-grep/inventory.tsv](lane-source-grep/inventory.tsv) | Per test file: lane, test count, source reads, source imports, spawns, weight (ms), LOC |
| [lane-source-grep/pertest.json](lane-source-grep/pertest.json) | The same inventory with each file's test names |
| [lane-source-grep/struct_src.json](lane-source-grep/struct_src.json) | Files whose source reads look structural (counts, weight, LOC) |
| [lane-source-grep/probes.log](lane-source-grep/probes.log) | Raw mutation-probe results for the source-grep lane |
| [lane-e2e/e2e-files.json](lane-e2e/e2e-files.json) | Every `test/e2e` file classified by engine, key gating, spawning and weight |
| [lane-e2e/pglite-files.txt](lane-e2e/pglite-files.txt) | PGLite-only `test/e2e` files by weight (lane-move candidates) |
| [lane-e2e/attendance-retrieval-postgres.log](lane-e2e/attendance-retrieval-postgres.log), [lane-e2e/attendance-repair-postgres.log](lane-e2e/attendance-repair-postgres.log) | Measured runs showing the attendance wrappers execute both engine arms in the E2E lane |
| [lane-patterns/scan.json](lane-patterns/scan.json), [lane-patterns/scan2.json](lane-patterns/scan2.json) | Raw pattern-scan output (assertion shapes per file and per test) |
| [lane-patterns/neardup.txt](lane-patterns/neardup.txt) | Near-duplicate test file pairs by similarity |
| [lane-patterns/probes.log](lane-patterns/probes.log) | Raw mutation-probe results for the patterns lane |
| [lane-seams/test-only-exports.tsv](lane-seams/test-only-exports.tsv) | Exported `src/` symbols with no production caller, and the tests that use them |
| [lane-seams/seam-callers.tsv](lane-seams/seam-callers.tsv) | Test-named exports with their caller counts |
| [lane-seams/unreachable.tsv](lane-seams/unreachable.tsv), [lane-seams/dead-modules.txt](lane-seams/dead-modules.txt) | `src/` modules unreachable from any runtime entry, with LOC and the tests that import them |
| [lane-seams/dead-tests.txt](lane-seams/dead-tests.txt) | Test files that exist only to test those modules |
| [lane-seams/bundled-src.txt](lane-seams/bundled-src.txt) | `src/` files reached by a `bun build` of every runtime entry and package export |

The doc-pins lane recorded its probe results inline in its report; it has no
separate probe log.

## Implementation evidence

`implementation/` holds the per-slice evidence tables from the fix wave that
acted on these reports (v0.59.20.0): each deleted test's probe and surviving
owner, each new test's mutation, and each dead module's disposition.

| File | Slice |
| --- | --- |
| `implementation/security.md` | Source-config secret surfaces |
| `implementation/holes.md` | Coverage holes filled |
| `implementation/e2e-lanes.md` | E2E lane corrections |
| `implementation/deletions-guards.md` | Blind/duplicate test deletions, placeholder guard, source-read policy, docs |
| `implementation/dead-modules.md` | Dead-module clusters and the orphan permitted list |
| `implementation/pending-deletions.md` | Deletions that waited on new owners; process-cleanup fix |
| `implementation/lane-pilot.md` | Lane-move pilot and measurements |
| `implementation/rewrites.md` | Behavior rewrites, doc claims, docs-CLI truth check |
