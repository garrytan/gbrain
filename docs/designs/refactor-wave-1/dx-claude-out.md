INPUT: dx 556d5039383893ec11becb0659d0f19e3223ffda241d09865268e59ff1291f63

# DX review: GBrain Refactor Wave 1

The developers here are GBrain contributors and AI agents writing PRs, the authors of the ~51 open PRs that touch these files, and downstream code that imports `package.json` exports. For them, "hello world" means three everyday tasks after the merge: add a migration, add a column, and add a CLI command or storage method. It also means rebasing an open PR onto the moved code. The plan is strong on verification: goldens, parity runs, the move-only verifier, and the moved-symbol map. It's weak on the post-merge contributor loop. It never writes down the new recipe for any of those everyday tasks. It only specifies failure text for one of its roughly nine new guards. And it leaves the library export contract out of "behavior-preserving." I checked these against the repo at 608a174 and cite the evidence below.

## 1. Getting started / TTHW

**[HIGH] Adding a migration goes from one step to three, and the plan has no scaffolder.** Today a contributor or agent appends one object to `MIGRATIONS` in `src/core/migrate.ts`. After W3 they have to pick the next free version, create `src/core/migrations/v<NNN>-<name>.ts` in the right shape, run an unnamed generator, and commit the regenerated `index.ts`. If they forget the generator step, the freshness guard fails. TTHW goes from about 2 minutes to about 10 plus a CI round trip. There's also a new conflict hotspot: every migration PR still appends a line to the committed, generated `index.ts`, so two concurrent PRs conflict in the same place, just in a different file.
*Fix:* Add `bun run new:migration <name>`. It should allocate `max(version)+1`, write a typed template (`sql`, `idempotent`, optional `sqlFor`/`handler`), and regenerate `index.ts`. Name the generator script (`bun run build:migrations`). Document the conflict recipe: "on an `index.ts` conflict, take either side and rerun `build:migrations`". Mark `index.ts` as `linguist-generated` / `merge=ours` in `.gitattributes`, or regenerate it in a pre-commit step.

**[HIGH] The plan never says which file you edit to change the schema.** Today `scripts/build-schema.sh` generates `schema-embedded.generated.ts` *from* `src/schema.sql`, and its header comment says "schema.sql is the canonical file". W2a says the PGLite bootstrap is generated "from a single source" but never names that source. T1 then makes part of `schema.sql` generated from the TS fragment modules. So `schema.sql` ends up half canonical and half generated, and a contributor adding a column can't tell whether to edit `schema.sql`, a TS fragment, or both.
*Fix:* Name the source explicitly, for example: "core tables: edit `src/schema.sql`; fragment tables: edit `src/core/**/…-schema.ts`; then run `bun run build:schema`, which rewrites X, Y, Z." Wrap the generated regions of `schema.sql` in `-- BEGIN GENERATED from <path> — do not edit` / `-- END GENERATED` banners. When the freshness guard fails, it should print the source file the contributor should have edited, not just "stale".

**[HIGH] Open-PR authors (51 PRs) get a map, but no worked recipes.** E2's moved-symbol map is necessary, but git can't carry a hunk from a 7,307-line file into 170 new files. A symbol map on its own still leaves each author to work out the port by hand. Posting it as a "pinned comment" also means agents can't consume it by default.
*Fix:* Commit the map as machine-readable JSON (`docs/architecture/wave-1-moves.json`: `old path:symbol -> new path:symbol`), plus a markdown porting guide with one before/after recipe per surface: a MIGRATIONS entry, a doctor check, a sync phase edit, a serve-http route, a CLI switch case, and an engine method in each driver. Better still, add `scripts/port-pr.ts <diff>` that tells an author which of their hunks landed where. Link the guide from CLAUDE.md so agents find it.

**[MEDIUM] No recipe for adding a storage method in the mixed state.** After W1-core, 5 domains live in `src/core/store/` and 7+ stay in the engines. A contributor adding, say, a `takes` method needs to know it goes in the store with thin delegations in both engines, while a `pages` method (if that domain wasn't migrated) goes in both engines as today. The plan never says how "migrated" is declared, even though the SQL-in-engine guard depends on it.
*Fix:* Keep a single declared list (for example `scripts/store-migrated-domains.tsv` or a const in `src/core/store/index.ts`) that the guard reads and `KEY_FILES` renders as a table. Add an "add a store method" recipe of three steps with the delegation boilerplate.

## 2. API/CLI ergonomics and naming

**[HIGH] `src/core/migrations/` collides with the existing `src/commands/migrations/`.** That directory already exists. It holds TS orchestrators registered in `index.ts` with filenames like `v0_11_0.ts`, `v0_12_0.ts` (semver, `apply-migrations`). `skills/migrations/` exists too. The plan adds a third `migrations/` directory, again with an `index.ts` registry and `v`-prefixed filenames, but this one uses schema integers. Agents grepping for "migrations/index.ts" or "v0_" / "v1" will open the wrong one.
*Fix:* Name it `src/core/schema-migrations/` (files `v175-<name>.ts`). Zero-pad to a fixed width you won't outgrow soon (4 digits), so directory order matches runner order in `ls` and editor trees. Add a one-line README comment in both registries pointing at the other.

**[HIGH] The CLI "static command table" misses the real drift source, and may break lazy loading.** `src/cli.ts` doesn't just have a switch. It has parallel hand-synced sets: `CLI_ONLY` (line 86), `CLI_ONLY_SELF_HELP` (118), `THIN_CLIENT_REFUSED_COMMANDS`, `STARTUP_HOOK_SKIP_COMMANDS` (338), and an alias table with a collision check (318). The comment at line 132 documents an actual drift bug (`pages` had a case but was missing from `CLI_ONLY`). Replacing only the switch still leaves a new command needing 4–5 edits. Separately, cli.ts uses 215 `await import(...)` sites, so every handler loads lazily. A `name -> handler` table built on static imports would pull every command module into cold start. The +20 ms budget would catch that, but only after the work is done.
*Fix:* Define the table as one record per command: `{ name, load: () => import('./commands/x.ts'), selfHelp, thinClientRefused, skipStartupHooks, aliases }`, and derive every set from it. Add a W0 golden asserting that each derived set equals master's set exactly (behavior-preserving). State explicitly that `load` stays dynamic, and add it to the `engine-dynamic-import-ok` rationale if the guard would object.

**[MEDIUM] The branded `ScopedExecutor` will produce cryptic type errors.** A brand mismatch reads as "Property '__brand' is missing in type 'Executor'". A contributor or agent won't learn from that message that they need `withScopedReadTransaction`.
*Fix:* Name the brand key after the fix (`readonly __obtainViaWithScopedReadTransaction: unique symbol`). Put a TSDoc on the type naming the factory, and add a `@ts-expect-error` fixture test so the message stays stable.

**[MEDIUM] Function-size baseline row identity is undefined.** The guard counts anonymous arrow functions and object-literal methods. The plan doesn't say how a TSV row identifies them (by `path:line`? by an enclosing name?), or what happens when a function is renamed or moved. If rows are keyed by line number, every unrelated edit above the function breaks the baseline.
*Fix:* Key rows by `path` plus a qualified name (`Class.method`, `outerFn>arrow#2`, or `varName`). The guard should treat a baselined function that shrank below 300 as "remove this row" (mirroring module-size's stale-slack rule), and a baselined function that grew as a failure.

## 3. Error handling

**[HIGH] Only W5 specifies failure text. The other new guards and tests don't.** New failure paths without problem/cause/fix/docs text:
- migration index freshness guard,
- duplicate-version generator failure ("fail loudly at rebase", with no text given),
- schema generation freshness guard,
- SQL-keyword-in-migrated-engine-method guard,
- `src/core/store/` dynamic-SQL scanner,
- the sync no-destructuring guard,
- the `requireAdmin` invariant/allowlist test,
- `verify-move-only.ts`,
- the snapshot-hash-inputs unit test,
- the migration registry golden (a mismatch in "handler source-text hash" is especially opaque).

These fire mostly on *future* contributors and agents who have never read this plan.
*Fix:* Make a requirement of W0/W5 that every new guard prints (1) the violating file:line, (2) the rule in one sentence, (3) the exact command or edit that fixes it, and (4) a docs anchor (`docs/architecture/key-files/tooling-and-tests.md#<guard>`). Each guard also gets a row in `guards-manifest.tsv` with bad/good fixtures. Today the plan says this for W5 only. Examples:
- duplicate version: "v176 is defined by both a.ts and b.ts. Rename yours to v<next free> (run `bun run new:migration --renumber <file>`)."
- registry golden: print which field differs for which version, and whether it's a handler-body change (not allowed in a move-only commit).

**[HIGH] Criterion (b) could turn into a permanent tax on unrelated fixes.** (b) says "no function over 300 lines in any touched file ('touched' = changed non-import lines), enforced by the new guard". W5 describes a baseline guard (no *new* >300-line function; baselined functions frozen). If the (b) rule stays in the permanent guard, then after this PR a one-line bug fix in, say, `cycle.ts` forces decomposing `runCycle` (1,227 lines). That contradicts D1 ("W5 freezes them; wave 2"). The plan also never says which base ref defines "touched" locally versus in CI.
*Fix:* State that (b) is a one-time acceptance check for this PR (run against `merge-base origin/master`), and that the permanent guard is the W5 baseline ratchet only. If (b) is meant to be permanent, say so and give the base-ref rule.

**[MEDIUM] The SQL-keyword guard will false-positive on messages.** Engine methods contain error strings and log lines ("failed to update page", "select a source"). A bare keyword scan flags them, and the plan offers no escape.
*Fix:* Match SQL shape (a keyword at the start of the literal plus `FROM`/`INTO`/`SET`/`WHERE` structure) rather than bare keywords, and support a per-line marker (`// store-sql-ok: <reason>`) following the `engine-dynamic-import-ok` convention.

## 4. Documentation

**[HIGH] The docs update list misses the docs that teach the old workflow.** The plan updates `KEY_FILES.md`/`key-files/*` and the ASCII diagram. But 11 docs/skills files reference `MIGRATIONS`, and 39 references to `src/core/migrate.ts` exist in docs, skills, CLAUDE.md, and CONTRIBUTING. Examples:
- CLAUDE.md:119 describes the `region-exempt` MIGRATIONS policy the plan deletes;
- `docs/architecture/frontmatter-scan-incremental.md:71-76` tells implementers to "take the next unused number in the MIGRATIONS array";
- `key-files/tooling-and-tests.md:32` documents `region-exempt`.

Agents follow these literally and will try to edit an array that no longer exists.
*Fix:* Add a docs step: `rg -n "MIGRATIONS|migrate\.ts|region-exempt|buildChecks|handleCliOnly|performSyncInner" docs skills CLAUDE.md CONTRIBUTING.md AGENTS.md`, update every hit, and add a CI grep guard that fails on the retired phrases. Put a "How to add a migration / schema column / CLI command / doctor check / store method / serve-http route" section in CONTRIBUTING.md (copy-paste commands), then run `build:llms`.

**[MEDIUM] The dual-copy hash inputs are under-specified, and one line reference is wrong.** The plan says to update `.github/workflows/e2e.yml` cache keys at "lines 71, 186". The file has **five** identical `pglite-snapshot-…hashFiles(...)` keys (lines 71, 186, 243, 372, 557). Updating two leaves three jobs on stale snapshots. W1 also moves the forward-reference bootstrap into new store files that affect the snapshot, and the plan doesn't add them to the hash inputs. The planned unit test only checks the TS side (`computeSnapshotSchemaHash`), not the YAML.
*Fix:* Use globs (`src/core/schema-migrations/*.ts`, `src/core/store/**/*.ts`) in all five YAML keys, and have the unit test parse `e2e.yml` and assert every key's inputs cover the same set as `computeSnapshotSchemaHash`. Better still, factor the key into one reusable step or composite action.

**[MEDIUM] Module-size note trimming loses rationale.** Trimming `module-size-limits.tsv` notes to one line is good (the longest rows are 3.4k–6.4k chars). But some notes carry the history of why a ceiling was raised.
*Fix:* Move long rationale into the relevant `key-files/*` entry or the CHANGELOG, and leave a one-line pointer.

## 5. Escape hatches

**[HIGH] The library export contract isn't in the behavior-preservation gates.** "No CLI/MCP contract change" leaves out `package.json` exports, which downstream importers depend on. Exports touched by this plan include `./pglite-engine`, `./engine`, `./search/hybrid` (hybridSearch/hybridSearchCached get decomposed), `./minions` (handlers move to `minions/handlers/`), and `./extract`. Also, 69 files import from `core/migrate`, and `MIGRATIONS`/`LATEST_VERSION` are exported from there. "Temporary forwarding exports *where useful*" is too weak a promise for a public entry point.
*Fix:* Add a W0 golden: for every `exports` entry, the sorted list of exported names (and ideally a `tsc --declaration` .d.ts snapshot), byte-identical on the final candidate. State that `migrate.ts` keeps re-exporting `MIGRATIONS` and `LATEST_VERSION`, and that `commands/jobs.ts` keeps `registerBuiltinHandlers` (already stated). Deprecation of any forwarding shim needs its own later PR with a CHANGELOG note.

**[HIGH] No escape hatch for intentionally unscoped reads.** Some reads legitimately bypass RLS scoping: doctor, maintenance, migrations, admin API, tests. With store reads accepting only the branded `ScopedExecutor`, contributors will cast (`as ScopedExecutor`) to get unblocked, which quietly defeats the invariant.
*Fix:* Provide an explicit, greppable `unscopedExecutor(reason: 'maintenance' | 'migration' | 'admin' | 'test')`, and add a guard that forbids `as ScopedExecutor` outside `src/core/store/executor*`. List every current unscoped call site in the PR.

**[MEDIUM] The freeze window has no hotfix lane.** "Freeze target paths from final review to merge" gives no protocol for an urgent security or data-loss fix that lands on a frozen path during the window.
*Fix:* State the rule: the fix lands on master, the named integration owner ports it into the moved code within N hours, and the goldens and gate rerun. Name who can lift the freeze.

**[MEDIUM] The rollback claim is overstated.** "`git revert` of the squash" only works until the first follow-up PR lands on the new layout. Wave 1 moves 7k+ lines across ~250 new files, and within days the revert conflicts.
*Fix:* Say so. The real escape hatch is forward-fix. Keep the W0 goldens and perf harness as the rollback-decision tooling, and define a 72-hour "revert-clean" window before follow-ups touching moved paths are allowed.

**[MEDIUM] The W5 baseline-raise escape hatch has no owner.** A justification column is good, but nothing says who approves it, and agents will fill it with boilerplate.
*Fix:* Require that the justification cite an issue or TODO id, and have the guard print the diff of baseline raises in its summary so reviewers see it even when CI is green.

## What's good (keep)

- W0 goldens before any move, E5 binding-matrix contract test, E3 move-only verifier: these carry the plan's credibility.
- The A10 test re-point policy builds on the existing `test/helpers/doctor-source.ts` split between containment (concatenated) and positional (single file) loaders. That's the correct generalization.
- The duplicate-version generator failure beats silent collisions. It just needs actionable text and a renumber helper.
- The E9 `requireAdmin` invariant with a mutation test is exactly the right guard for route extraction.

## Severity summary

| # | Finding | Severity |
|---|---|---|
| 1 | Migration scaffolder + generated-index conflict recipe missing | High |
| 2 | Schema "single source" unnamed; `schema.sql` half-generated | High |
| 3 | Open-PR porting: no committed JSON map or per-surface recipes | High |
| 4 | Declared migrated-domain list + store-method recipe | Medium |
| 5 | `src/core/migrations/` vs existing `src/commands/migrations/` | High |
| 6 | CLI table ignores parallel sets; static table breaks lazy import | High |
| 7 | Branded-type error message | Medium |
| 8 | Function-size baseline row identity | Medium |
| 9 | Guard failure text specified only for W5 | High |
| 10 | Criterion (b) permanence / base ref ambiguous | High |
| 11 | SQL-keyword guard false positives, no marker | Medium |
| 12 | Stale docs teaching the MIGRATIONS array (11 + 39 refs) | High |
| 13 | e2e.yml has 5 cache keys, plan names 2; store files missing from hash | Medium |
| 14 | TSV note trimming drops rationale | Medium |
| 15 | `package.json` exports not in the goldens | High |
| 16 | No sanctioned unscoped-executor escape hatch | High |
| 17 | No hotfix lane during freeze | Medium |
| 18 | Revert-as-rollback overstated | Medium |
| 19 | Baseline-raise approval unowned | Medium |

No critical findings. None of these block the refactor's correctness, but findings 1, 2, 5, 6, 9, 12, and 15 decide whether the next 50 contributor PRs after merge go smoothly or turn into a second wave of drift.
