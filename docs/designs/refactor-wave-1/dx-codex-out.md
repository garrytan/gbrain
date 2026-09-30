**Request changes before implementation.** The refactor should reduce duplicated work, but the plan underestimates the contributor tooling and porting work needed to make the new structure usable.

I checked repository code and docs at `608a174dc`. This is a static plan review; I did not run tests or read skill files.

**1. Medium — “Time to hello world” is not yet demonstrably better.**

The existing setup is four commands: clone, enter directory, install, test. Below are approximate total workflow steps, including those four commands. These are planning estimates for small changes, not measured completion times.

| Contributor task | Before | After, as specified | What changes |
|---|---:|---:|---|
| Storage method in an already split domain | ~11 | ~10–11 | One SQL implementation, but interface, two engine delegates, normalization, tests and parity validation remain |
| DDL migration affecting bootstrap | ~10–12 | ~11–12 | Smaller authoring file; adds registry generation while schema generation and bootstrap rules remain |
| Doctor check | ~9 | ~8–9 | Registry can replace orchestration edits; category ownership is unresolved |
| CLI-only command | ~10–13 | ~10–13 | Table replaces switch, but membership, help, flag generation and routing still need handling |
| HTTP route | ~8–9 | ~8–9 | Easier location; middleware, dependencies, registration and outcome tests remain |

An operation added to an existing `core/ops/` domain already gets CLI/MCP exposure automatically. That workflow should remain distinct from adding a CLI-only command. [Current contribution instructions](CONTRIBUTING.md:273)

**Fix:** Add five short, executable contribution recipes, each naming editable files, generated outputs, the smallest useful test command, and the required pre-merge gate. Measure those five tasks before and after. The current docs describe individual tests taking seconds and the full unit loop taking roughly eight minutes; requiring the complete gate for every exploratory edit would erase much of the DX gain. [Testing commands](CONTRIBUTING.md:97)

**2. High — The CLI table breaks a generator that depends on the current dispatch syntax.**

`generate-flag-registry.ts` explicitly locates `CLI_ONLY`, finds `async function handleCliOnly`, and segments its switch cases and `if` branches. Its `facadeExpansion` also knows specific existing sync extraction paths. Replacing the switch and moving argument parsing without updating this machinery can produce missing or incorrectly attributed flags. [Generator implementation](scripts/generate-flag-registry.ts:275)

CLI goldens may catch existing regressions, but they do not establish that a newcomer can correctly register the *next* command.

**Fix:** Make generator adaptation an explicit W4 deliverable. Specify one discoverable command-registration location and how membership, aliases, help, engine requirements, thin-client policy and flag-source ownership connect to it. Preserve lazy loading where required. Verify a synthetic newly registered command with an accepted flag, rejected unknown flag and engine-free help.

**3. High — Migration collision detection is not a usable recovery procedure.**

“Duplicate version; renumber on rebase” is incomplete for an author who already ran their migration locally.

The runner selects migrations solely with `version > current`. It even documents a previous renumbering incident where a migration appeared applied without its DDL running. A filename or registry correction does not repair that database state. [Runner and documented incident](src/core/migrate.ts:7106)

**Fix:** The porting guide must distinguish:

- An unapplied branch migration: allocate a unique number, update references, regenerate.
- An already-applied migration in a disposable development database: rebuild that isolated database and replay.
- An already-applied migration against retained data: require an explicit reconciliation procedure; do not suggest merely changing the version counter.

The duplicate diagnostic should name both files and the conflicting record versions. Document filename/version agreement, allocation ownership and the rule against changing released migrations.

**4. High — “Temporary forwarding exports where useful” is too weak for downstream compatibility.**

The repository’s existing rule is stronger: peeled façades retain everything they exported. Package exports also include concrete engine and search modules beyond the three subpaths highlighted in the request. [Façade contract](CLAUDE.md:121), [package exports](package.json:16)

The existing public-export test checks package resolution and selected runtime canaries. It does not establish that `BrainEngine`, option types, overloads, return types or all named exports remain compatible. [Public export tests](test/public-exports.test.ts:35)

**Fix:** Make preservation of supported exports unconditional for this PATCH. Add W0 public API declarations/snapshots and a small external consumer fixture importing through package names, then typecheck and run it against the candidate. Keep `ScopedExecutor` and new adapter requirements internal. Test the distributable artifact as well as repository self-imports.

Downstream users should need **zero import edits, zero new configuration and zero special migration commands** because of this refactor.

**5. High — Moving code changes guard coverage; A10 only addresses tests.**

The engine dynamic-import guard enumerates the two engine files, `migrate.ts`, and the two engine implementation directories. It does **not** scan the proposed `store/` or `core/migrations/` directories. Moving implementation there silently removes that enforcement. [Guard scan roots](scripts/check-engine-dynamic-import.sh:24)

There is also an inner-loop performance consequence: the E2E selector maps existing engine directories, while unknown paths fall back to the entire suite. New store paths would retain conservative coverage but lose focused selection. [Engine mappings](scripts/e2e-test-map.ts:294), [fallback behavior](scripts/select-e2e.ts:169)

**Fix:** Extend A10 into a tooling-consumer inventory: scanners, generators, test selectors, snapshot inputs and documentation indexes. Add the new engine-live paths to the guard and fixture-test their coverage. Map store domains to both engines’ relevant tests; retain an explicit all-tests rule for migrations.

**6. Medium — The canonical schema-editing location remains ambiguous.**

Today `build-schema.sh` says `src/schema.sql` is canonical and generates the embedded TypeScript string. W2 would additionally generate parts of that SQL file from TypeScript fragments and generate PGLite’s bootstrap. The plan never fully identifies where the remaining canonical DDL lives or whether `schema.sql` becomes wholly or partially generated. [Current generator](scripts/build-schema.sh:1)

A newcomer encountering a stale-schema error could reasonably edit an output that the next build overwrites.

**Fix:** Specify the complete input → output graph, exact canonical paths and capability-rule ownership. Use one documented regeneration command and explicit generated-file headers. Include examples for adding a column/index and adding a table, including when forward-reference bootstrap changes are required.

**7. Medium — Names are mostly guessable, but several ownership boundaries are not.**

`doctor/checks/`, numbered migration files and flat HTTP route modules fit existing conventions. Three ambiguities need resolution:

- `core/store/` versus existing `core/storage/`: database domain SQL versus blob/file storage.
- `core/migrations/` versus existing `commands/migrations/`: database schema history versus command-level upgrade work.
- New sync phases under `commands/sync/` versus existing reusable `core/sync-*` modules: where should the next helper go?

Doctor also risks two category sources: the new `{name, category, run}` registry and the existing category sets, which explicitly claim ownership of categorization. [Category contract](src/core/doctor-categories.ts:38)

The executor needs a worked authoring example. Existing `SqlValue` is scalar-only, and `executeRawJsonb` deliberately rejects top-level arrays; “sharing” them does not explain the new array/JSONB binding API. [Existing parameter contract](src/core/sql-query.ts:17), [array rejection](src/core/sql-query.ts:114)

**Fix:** Add a short placement decision table, choose one category authority, and provide one complete storage read/write example covering parameter encoding, scope acquisition, normalization, delegation and testing. Preserve the existing scalar helper’s contract while defining any additional parameter types explicitly.

**8. Medium — The two-minute lookup and open-PR porting experience are not established.**

Updating `KEY_FILES.md` helps, but the always-loaded instructions still direct agents to the monolithic migration array and engine-specific implementations. `CONTRIBUTING.md` also directs command authors to the switch. Those entrypoints are absent from the explicit documentation update list. [Current orientation](CLAUDE.md:94)

A PR-body map and pinned comment are insufficient for offline contributors and agents. An AST-generated one-to-one symbol map also cannot adequately explain a closure split into several phases.

**Fix:** Commit a searchable porting guide and move map, linked from `CONTRIBUTING.md`, `CLAUDE.md` and `KEY_FILES.md`. Include:

- Old symbol → one or more destinations, with public façade versus implementation identified.
- Generated-file conflict resolution commands.
- Worked examples for porting an engine fix, migration, doctor check and CLI flag.
- The named integration owner and the exact freeze start, end and exception process.

Test the two-minute requirement with five lookup exercises. The existing index already provides a useful `rg` discovery pattern. [Index guidance](docs/architecture/KEY_FILES.md:7)

**9. Medium — Guard diagnostics and intermediate-commit rules need an explicit contract.**

“Actionable failure text” is specified only for function size. The other guards need equally concrete repair guidance.

| Guard | Required diagnostic and repair guidance |
|---|---|
| Function size | File, qualified symbol, measured length, limit, counting convention, and whether it is a new violation or baseline growth |
| SQL in engine | Method, offending literal, migrated domain and exact shared implementation destination; avoid treating ordinary prose containing “update” as SQL |
| Registry freshness | Distinguish stale output from duplicate/invalid migration records; show inputs, output and regeneration command |
| Move-only | Base/commit identifiers, mapped symbols and first token mismatch; define allowed normalization and how to classify a legitimate transformation |
| Schema freshness | Identify canonical input and stale output, regeneration command and diff; distinguish stale generation from catalog drift |

The existing freshness guard provides a good model: it shows the diff and exact regeneration command. [Freshness diagnostic](scripts/check-tool-catalog-fresh.sh:29)

There is also a workflow conflict: W5 lands before moves, prohibits new oversized functions, while W4 requires move-only commits before decomposition. Moving an existing oversized function can become a “new function” under path-based baselines.

**Fix:** Define whether each rule applies per commit or only to the final candidate. Support explicit baseline identity transfer for verified moves without raising limits, then require decomposition by the final gate. Clarify whether the whole-touched-file ceiling is a wave acceptance condition or permanent policy. Keep diagnostics concise enough to survive the verifier’s last-30-lines failure output.

I recommend **W1-core** for this landing window. It provides a bounded contributor model and lets the executor contract be demonstrated before seven additional domains multiply the porting burden.

Recommendation: revise the plan before implementation because CLI generation, migration collision recovery, moved-code guard coverage and public TypeScript compatibility remain underspecified.
