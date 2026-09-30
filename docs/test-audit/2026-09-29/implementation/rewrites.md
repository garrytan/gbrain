# Evidence — PR N+1 slice: rewrites and consolidation

Mutation harness: `(scratch) mut.sh <file> <old> <new> <test...>` applies one textual edit, runs the test, reverts with `git checkout`. Counts are executed pass/fail.

## 1. Class-3 source-grep rewrites

### schema-cli-contract (6 remaining source pins → 2 behavior tests via `runSchema` on a temp GBRAIN_HOME + file-backed PGLite)

| Test | Mutation (src/commands/schema.ts) | New test | Old pins |
|---|---|---|---|
| envelope table (13 verbs, `schema_version: 1`, `tier` exactly on experimental verbs) | `graph --json` drops `tier: 'experimental'` | 2/1 fail | 7/0 pass (blind) |
| same | `review-orphans --json` drops `schema_version: 1` | 2/1 fail | 7/0 pass (blind; the count-of-`schema_version: 1` pin still clears its threshold) |
| same | parseFlags ignores `--json` | 0/3 fail | not run |
| source scoping (`--source`, `--source-id`, `=` forms) | parseFlags drops `--source-id` | 2/1 fail | variant drop pin fails only on literal text |
| same | parseFlags drops `--source=` | 2/1 fail | not probed |

Deleted pins (vacuous/implementation-coupled; new owner above): "every new verb routes through runSchema dispatch", "every new verb-handler reads parseFlags()", "parseFlags() returns the documented shape", "parseFlags accepts both --source and --source-id forms", "every new verb when --json passed produces a JSON envelope" (count of literals), "legacy v0.38 verbs are explicitly NOT in NEW_VERBS" (constant vs constant tautology). Kept: the PR 1 `schema usage` experimental-verbs behavior test. Smell ratchet: `schema-cli-contract.test.ts` 1 → 0 (entry removed).

### extract-workers (10 source pins → 4 behavior tests: `runExtractCore` through a parallel-reporting engine proxy + `runExtract` CLI on PGLite)

Each run executes the new file (4 tests) and the old pin file (10 tests) together; the fail column names which failed.

| Mutation (src/commands/extract.ts) | New file | Old pins |
|---|---|---|
| incremental (slugs) pool `workers: 1` | 1 fail (incremental concurrency) | 0 fail (blind: `runSlidingPool(` count still 3) |
| directory-walk links pool `workers: 1` | 1 fail (directory concurrency) | 0 fail (blind) |
| `resolveWorkersWithClamp(engine, undefined, …)` | 3 fail | 1 fail |
| CLI drops `workers` from the `runExtractCore` call | 1 fail (clamp warning not printed) | 1 fail |
| invalid `--workers` no longer exits | 1 fail | 0 fail (blind) |

Not covered: the timeline directory-walk pool has no await per page, so its concurrency is unobservable (and immaterial); the old pin on it only checked the call exists. Smell ratchet: `extract-workers.test.ts` 1 → 0.

### thin-client-routing-audit (22 source pins → 4 in-process route tests; REFUSE pins → 12 rows added to the one batched spawn in `cli-dispatch-thin-client`)

| Mutation | New owner | Old pins (25 tests) |
|---|---|---|
| `src/cli.ts` refusal guard skips `code-*` commands (set literal intact) | `cli-dispatch-thin-client` 4 fail (code-def/refs/callers/callees rows) | 0 fail (blind) |
| `src/commands/jobs.ts` `jobs list` thin branch disabled | `thin-client-routing-audit` 1 fail | 0 fail (blind; `callRemoteTool(cfg!, 'list_jobs'` literal intact) |
| `src/commands/recall.ts` `forget` thin branch disabled | 1 fail | 0 fail (blind) |
| `jobs get` sends `{ id: String(id) }` | 1 fail | 0 fail (blind) |
| null-engine guard also lets `stats` through | 1 fail | regex pin fails on text only |
| `'jobs'` added to `THIN_CLIENT_REFUSED_COMMANDS` | `cli-dispatch-thin-client` › jobs list 1 fail (new not-refused assertion) | old "'jobs' is NOT in the set" pin (text) |

Refused rows added to `refusedCommands`: pages, files, eval, code-def, code-refs, code-callers, code-callees, dream, transcripts, storage, takes extract, sources list (the stderr assertion `not routable` proves the `THIN_CLIENT_REFUSE_HINTS` entry exists; the no-hint fallback prints "requires a local engine"). Recall route owner: `recall-thin-client-fallback.serial.test.ts` (unchanged). Cost: +12 spawns in one `runCliBatch` (file 14.7 s locally, was about 9 s). Smell ratchet: `thin-client-routing-audit.test.ts` 6 → 0.

### models-doctor-embed (3 slice-of-function greps → 3 behavior tests: `probeEmbeddingReachability` with an injected `embed`, `runModels doctor --json` with the gateway embed transport injected and `fetch` stubbed offline)

Each run executes the new file (3 tests) and the old file (3 tests) together.

| Mutation (src/commands/models.ts) | New | Old |
|---|---|---|
| reachability no longer gated on `embeddingConfig.status === 'ok'` | 1 fail | 1 fail |
| same, with the gate text kept in a comment | 1 fail | 0 fail (blind) |
| probe embeds with `inputType: 'document'` (old text kept in a comment) | 1 fail | 0 fail (blind) |
| probe drops `abortSignal` (identifier kept) | 1 fail | 0 fail (blind) |
| reachability result never added to the report | 1 fail | 0 fail (blind) |

Smell ratchet: `models-doctor-embed.test.ts` 1 → 0. Found while writing it: an unstubbed doctor run makes a real Voyage rerank call; the new test stubs `fetch`.

### dream-cli-flags (whole file deleted: the 14 remaining source pins → behavior tests in `dream.test.ts` (5) and `dream-drain-failure-summary.serial.test.ts` (4))

Old = the deleted file (14 tests) run against the mutation; new = the named describe.

| Mutation (src/commands/dream.ts; the grepped token kept in a comment where the pin needs it) | New | Old |
|---|---|---|
| `synthInputFile` not forwarded to runCycle | 1 fail (--input reaches synthesize) | 0 fail (blind) |
| `synthDate` not forwarded | 1 fail (explicit targets bypass the cooldown) | 0 fail (blind) |
| inverted `--from/--to` range accepted | 1 fail (exit-2 table) | 0 fail (blind) |
| `--input` no longer implies `--phase synthesize` | 1 fail | 0 fail (blind; `phases = ['synthesize']` literal intact) |
| drain exits 0 while backlog remains | 1 fail (exit 3) | 0 fail (blind) |
| drain ignores `--window` | 1 fail | 0 fail (blind) |
| drain drops the resolved `--source` | 1 fail | 0 fail (blind) |
| totals line drops `patterns=` | 1 fail | 0 fail (blind) |

Help-text pins (dry-run synthesis cost, `cycle.timezone`) now assert the runtime `--help` output rather than the source file. Deleted file: `test/dream-cli-flags.test.ts` (smell ratchet entry removed; weights keys removed).

## 2. Doc claims consolidation (`test/doc-claims.test.ts`)

One table of 10 retracted honesty/privacy claims, negative only, scanned whitespace-flattened across every shipped Markdown file (`git ls-files`: README, AGENTS, CLAUDE, INSTALL_FOR_AGENTS, `docs/**` minus `docs/test-audit/**`, `skills/**`, `templates/**`, `recipes/**`, `plugin/**`, `plugin-variants/**`; CHANGELOG excluded as history). Runs in about 0.1 s.

| Deleted/moved test | Probe edit | Result | Surviving owner | Owner result |
|---|---|---|---|---|
| `mcp-registration-blocks` › "no doc prescribes the retired ~/.openclaw/config.json path" | `docs/mcp/OPENCLAW.md` re-adds `~/.openclaw/config.json` | old fails | `doc-claims` | fails |
| `mcp-registration-blocks` › "OPENCLAW.md registers via the openclaw mcp CLI" (positive) | reword the registration sentence | old passes (the phrase appears elsewhere); vacuous as a guard | none needed (dropped positive) | — |
| `docs-navigation` › "active memory guidance keeps durable preferences separate…" | `brain-vs-memory.md` re-adds "Don't store user⏎preferences in GBrain" (line-wrapped) | old passes (blind: no whitespace flattening) | `doc-claims` | fails |
| `docs-navigation` › "primary docs do not reinstate blanket graph or exclusivity promises" | `memory-boundaries.md` "not a full database backup" → "not a complete database backup" (same meaning) | old fails (prose-coupled positive) | negatives moved to `doc-claims` | — |
| same | `skills/query/SKILL.md` adds "Every `put_page` auto-creates links." | old passes (blind: skills not scanned) | `doc-claims` | fails |
| `put-page-remote-autolink-hint` › "downstream-upgrade doc and enrich skill state the MCP skip…" | `skills/enrich/SKILL.md` re-adds "MCP response includes `auto_links: { created`" | old fails | `doc-claims` | fails |
| `ambient-recall-templates` › "CODEX.md session-boundary instruction names both verbs", "ambient-recall guide exists and names both verbs" (positives) | vacuous as behavior guards (prose presence only) | — | the guide's existence moved into the kept template test | — |
| (new row, was unguarded after PR 2) | `docs/guides/skillopt.md` re-adds "keychain and survives" | — | `doc-claims` | fails |

Kept, not folded: `put-page-remote-autolink-hint` › brain-ops skill test (lane: shipped-skill honesty, keep) and `docs-mcp-deploy` (doc↔route anchor kept by PR 2). Deliberately dropped positive pins: `memory-boundaries.md` disclaimers ("no inline graph extraction", "not a full database backup", …) and `brain-vs-memory.md` positives, per the plan's "negative checks only".

## 4. Recipe checks folded into the all-recipes loop (`test/integrations.test.ts`)

5 twilio-only tests → 1 generic all-recipes test (semver version, every secret named with a non-empty `where`, `requires` resolve; runs over all 10 `recipes/*.md`) + 1 twilio-specific test (its 3 secret names, https console URLs). The generic "where is https" rule does not hold for every recipe (`restart-sweep`, `x-to-brain` point at config or a profile, not a URL), so it stays twilio-specific. "Parses correctly" and body-with-`---` are owned by the all-recipes parse test and the parseRecipe horizontal-rule test.

| Probe edit | New | Old (twilio-only) |
|---|---|---|
| `recipes/calendar-to-brain.md` version `v1.x.y` | 1 fail | 0 fail (blind: only twilio checked) |
| `recipes/email-to-brain.md` requires a missing recipe | 1 fail | 0 fail (blind) |
| `recipes/twilio-voice-brain.md` renames `TWILIO_AUTH_TOKEN` | 1 fail | fails (same contract) |

## 5. context-audit-skill executes the shipped snippet

The byte pins (`* 10 + 27 ) / 28`, `bytes/2.8`, not `* 2 / 7`, not `/ 4 ))`, not `chars/4`) are replaced by running the step-1 bash snippet from `skills/context-audit/SKILL.md` on fixture files of 1, 28, 29 and 10,000 bytes and asserting `ceil(bytes/2.8)` per file. The report-header phrases (estimate basis, `/context` deferral) stay: they are the user-facing prompt contract.

| Probe edit (skills/context-audit/SKILL.md) | New | Old |
|---|---|---|
| whitespace only: `27 ) / 28` → `27) / 28` (same behavior) | 0 fail | 1 fail (coupled) |
| estimate `* 0` (every file 0 tokens) | 1 fail | 0 fail (blind) |
| floor instead of ceil (`(n*10)/28`) | 1 fail | 1 fail |

## 3. Docs CLI truth check + shared scanner (sub-task; full evidence below)

### Evidence: docs CLI truth check (test-reduction wave sub-slice)

## Files changed (uncommitted)

- NEW `test/helpers/cli-command-surface.ts`: shared `liveCliVerbs`, `commandPosition`, `codeRegions` (with `HISTORICAL_MARKER`), `gbrainInvocations`, and `flagRejection`, which runs production `parseGlobalFlags` → `migrationCliArgumentError` → `validateCommandFlags`.
- `test/docs-cli-commands.test.ts`: uses the helper. Flags are now checked in docs/guides, docs/migrations and skills. docs/migrations and skills/migrations are no longer excluded. Adds the historical marker, a shrink-only allowlist with reasons, a stale-entry test, and a scanner self-check.
- `test/remediation-command-resolution.test.ts`: the duplicated `validCommands` / `commandPosition` / fence scanner is deleted and the file now uses the helper.
- `docs/TESTING.md`: new short section "Docs CLI truth check".
- Stale docs fixed: `docs/guides/{cron-schedule,minions-deployment,minions-shell-jobs}.md`, `docs/migrations/v0.41.2-markdown-greenfield.md`, `skills/brain-pdf/SKILL.md`, `skills/migrations/{v0.13.0,v0.14.0,v0.32.2,v0.33.0,v0.33.3.0,v0.40.5,v0.41.11.0}.md`.
- Historical markers added: `skills/migrations/{v0.33.0,v0.33.3.0,v0.34.0.0}.md`.
- Regenerated: `skills/skills.lock.json`, `plugin/skills/brain-pdf/SKILL.md` (generate-plugin-tree), `llms-full.txt` (build:llms).

## Mutation / probe evidence (new tests)

| New/changed test | Probe edit | Result | Reverted |
|---|---|---|---|
| docs-cli › every `gbrain <verb> [--flag]` … resolves | (i) append ```` ```bash\ngbrain notacommand --x\n``` ```` to docs/guides/cron-schedule.md | FAIL: `docs/guides/cron-schedule.md:354: gbrain notacommand — unknown verb` (4 pass / 1 fail) | yes |
| same | (iii) same block with `<!-- gbrain-cli: historical -->` above the fence | PASS (5/5): the marker suppresses it | yes |
| same | (ii) `skills/brain-pdf/SKILL.md`: `gbrain get "$SLUG" --no-such-flag` | FAIL: `skills/brain-pdf/SKILL.md:83: … unknown flag --no-such-flag for 'gbrain get'` | yes |
| docs-cli › ALLOWLIST has no stale entries | (iv) add allowlist entry `docs/guides/cron-schedule.md: --type` (already fixed) | FAIL: "no longer match a violation — remove them … docs/guides/cron-schedule.md: --type" | yes |
| same (production) | (vi) `src/core/cli-flag-registry.generated.ts`: add `--dry-run` to `auth` | FAIL: the auth `--dry-run` allowlist entries are reported stale | yes |
| docs-cli › scanner self-check | (v) `src/cli.ts` `validateCommandFlags`: `return null;` first line | FAIL: self-check (expected `3:--no-such-flag` missing) and stale-allowlist test both fail | yes |
| docs-cli main + remediation | (vii) `src/cli.ts`: drop `'sync'` from CLI_ONLY | FAIL: dozens of `gbrain sync — unknown verb` (docs/ENGINES.md:289, …) | yes |
| remediation › CHANGELOG top entry | (viii) add ``Run `gbrain notacommand` first.`` to the top CHANGELOG entry | FAIL: `CHANGELOG.md (top entry): gbrain notacommand is not a real command` (2 pass / 1 fail) | yes |

## Retiring-a-test evidence

No test cases were deleted. Only duplicated scanner code was deleted: `validCommands()` and `commandPosition()` in both files, plus the inline fence walker in `scanChangelogTopEntry`. The helper replaces them. One test was renamed and extended:

| Deleted test | Probe edit | Result | Surviving owner | Owner result |
|---|---|---|---|---|
| `test/docs-cli-commands.test.ts` › "every `gbrain <verb>` in README/docs/skills resolves to a live command" (renamed, not removed) | `src/cli.ts`: drop `'sync'` from CLI_ONLY | n/a (renamed) | same file › "every `gbrain <verb> [--flag]` in README/docs/skills resolves against the live CLI" | fails (1 of 5) |
| duplicated `validCommands`/`commandPosition` in `test/remediation-command-resolution.test.ts` (helper code, not a test) | CHANGELOG top entry gains `gbrain notacommand` | n/a | same file › "CHANGELOG top entry: every gbrain verb resolves" (via helper) | fails (1 of 3) |

## Stale docs found (28 hits → 0 open)

| Location | Finding | Action |
|---|---|---|
| docs/guides/minions-deployment.md:445, minions-shell-jobs.md:258, skills/migrations/v0.14.0.md:136,155 | `jobs list --name shell`: `--name` never existed (the real CLI rejects it) | `jobs list --status X --json \| jq 'select(.name == "shell")'` |
| skills/migrations/v0.14.0.md:167 | `jobs stats --orphaned` (never shipped, listed as deferred) | reworded to "an orphaned-job view in `gbrain jobs stats`" |
| docs/guides/cron-schedule.md:98 | `search --type calendar --recent 7d` (no such flags) | `query "flight" --types calendar --since 7d` |
| skills/brain-pdf/SKILL.md:83 | `get --raw` ("whatever flag exposes raw body") | `gbrain get "$SLUG"`, which already prints markdown with frontmatter |
| skills/migrations/v0.13.0.md:64 | `graph --type a,b` | `graph … --link-type invested_in` (the op param is `link_type`) |
| skills/migrations/v0.13.0.md:82 | `gbrain normalize-types` (v0.14), never shipped | claim deleted |
| skills/migrations/v0.32.2.md:62 | `gbrain rebuild` (v0.32.3), never existed | reworded to "a rebuild of the database from the repo" |
| skills/migrations/v0.33.0.md:104, v0.33.3.0.md:104 | `apply-migrations --status \| grep edges_backfilled_at_v0_34` (no `--status`, and v51 is facts_fence_columns) | `gbrain doctor --json \| jq '.checks[] \| select(.name == "schema_version")'` |
| skills/migrations/v0.40.5.md:67-68 | `gbrain exec "UPDATE …"`, never existed | `psql "$DATABASE_URL" -c "UPDATE …"`, with a note that no gbrain command sets priority |
| skills/migrations/v0.41.11.0.md:60 | `gbrain forget --where` described as a TODO | reworded so the fake flag is not shown as a command |
| docs/migrations/v0.41.2-markdown-greenfield.md:37,70,131,149 | `capture --source markdown-greenfield --repo …` never worked; the importer module is unwired (scripts/check-orphan-modules.mjs:82 "awaits a wire-up vs delete product decision") | Dry-run, import, re-run and rollback sections replaced with a "Status: not wired to the CLI" note pointing to `gbrain import <dir>` |
| skills/migrations/v0.33.0.md:130, v0.33.3.0.md:130, v0.34.0.0.md:69-70 | `gbrain wiki` / `blast` / `flow` in "what v0.34 will add / slipped" plan notes | `<!-- gbrain-cli: historical -->` marker |
| docs/guides/rls-and-you.md:188 | `gbrain rls-exempt` (the doc says it is deliberately not shipped) | allowlist (carried over) |
| docs/guides/concurrent-writes.md:398,471, shared-brain-skills.md:192 | `auth rescope-client … --dry-run`, `auth local-writer register … --dry-run` | allowlist. **Real CLI bug:** the handlers parse `--dry-run` (src/core/grants/cli.ts:19, persistence-admin.ts), but `CLI_FLAG_REGISTRY['auth']` omits it (the generator's SAFETY_FLAGS drop it because auth.ts does not consume it at depth zero). `bun src/cli.ts auth rescope-client foo --dry-run --json` → `unknown flag --dry-run for 'gbrain auth'`, exit 1. Fix: `EXTRA_FLAGS.auth = ['--dry-run']` in scripts/generate-flag-registry.ts, then `bun run build:flag-registry`; the stale-entry test then forces removal of the allowlist entries. |

## Commands run

- `bash …/gstack/scripts/install.sh --check` → exit 1; ran the installer → "Claude skills, GPT-6 Astra skills, and Chromium are ready"
- `bun install --frozen-lockfile` → ok
- `bun test test/docs-cli-commands.test.ts` → 5 pass / 0 fail, 0.47 s wall
- `bun test test/remediation-command-resolution.test.ts` → 3 pass / 0 fail, 0.60 s wall
- `bun test` build-llms, docs-navigation, skills-conformance, codex-plugin-manifest, openclaw-plugin-manifest, migrations-registry, scripts/check-skill-refs, skill-brain-first, filing-audit, post-install-advisory, doctor-skill-checks, resolver, check-resolvable, cli-flag-validation, migrations-v0_14_0 → 880 pass / 0 fail
- `bun run typecheck` → exit 0
- `bun run check:skills-manifest | check:plugin-tree | check:privacy | check:resolver | check:newlines` → all exit 0. `node scripts/check-skill-refs.mjs` and `node scripts/check-orphan-modules.mjs` → ok. `check:doc-history` → ok; its TESTING.md WARN is pre-existing (identical on a clean tree).
- `bun test test/test-reads-source-smell.test.ts` → 11 pass / 1 fail. The failure is pre-existing and unrelated: a stale `test/distribution-import-boundary.test.ts` entry, reproduced on a clean stash.

## Smell counts

- test/docs-cli-commands.test.ts: 0 unjustified src read sites before, 0 after (not in GRANDFATHERED)
- test/remediation-command-resolution.test.ts: 0 before, 0 after (not in GRANDFATHERED)
- test/helpers/cli-command-surface.ts: 0 (no file reads)
- No files deleted or renamed. The scripts/structural-suites.tsv row for remediation-command-resolution (3 readFileSync) is unchanged: `bun scripts/classify-tests.ts` produced no diff.

## Limitations / skips

- CLI_ONLY flags are validated per top-level command, not per subcommand. This is inherited from CLI_FLAG_REGISTRY and cannot be fixed without a production refactor.
- Verbs only (no flag check) for validator-exempt commands: `call`, `config`, `jobs submit`, `eval brainbench`. Also for routes main() dispatches before the validator (`search modes|stats|tune|diagnose`, `sources inspect|connect`, `sources demo company-brain`), which the helper mirrors from src/cli.ts main().
- Flags are checked only in docs/guides, docs/migrations and skills (the requested scope); README and the rest of docs/ get verb checks only. An informational scan outside that scope found 8 flag hits, left untouched: docs/architecture/RETRIEVAL.md:387 `eval --config`, frontmatter-scan-incremental.md:100,153 `frontmatter scan --incremental/--reconcile`, key-files/commands-4.md:34 `purge-deleted --older-than`, plus key-files/commands-4.md:22, a usage-grammar line whose `[--reranker auto|off|keep|<model>]` alternation the tokenizer reads as extra positionals (a tokenizer limitation, not a doc bug), docs/contradictions.md:120 `dream --slug`, docs/protocol/MEMORY_VERBS_v1.md:54 `recall --entity`, docs/what-schemas-unlock.md:136 `schema review-orphans --limit`.

## 1b. Class-3 per-file batch (sub-task; full evidence below)

Integration note: the `patterns subagent submission` test originally made a real (failing) Anthropic call with a fake key; it now stubs `fetch` offline. Re-probed after the change: `dream.patterns.output_slug_prefix` config read renamed → 1 fail.

### Class-3 source-grep rewrites — evidence (test-reduction wave, 2026-09-29)

Scope: lane report §3 "Per file" row + the conversation-facts row. All 10 files handled; no skips.
Executed tests (runtime counts): 224 → 176 (−48); `git diff --shortstat`: 16 files, +774 / −855.

## Files changed (uncommitted)

- Deleted: `test/backlinks-job-default.test.ts`, `test/cycle/cycle-lock-ttl.test.ts`, `test/phantom-redirect-per-source-lock.test.ts`, `test/extract-conversation-facts-workers.test.ts`
- Rewritten: `test/cycle-pack-gating.test.ts` (21→8), `test/cycle-patterns.test.ts` (16→11), `test/regression-strict-source-id.test.ts` (9→5), `test/asymmetric-encoding-contract.test.ts` (6→4), `test/cli.test.ts` (24→20), `test/upgrade.serial.test.ts` (30→25)
- New behavior owners added to: `test/handlers.test.ts` (10→12), `test/core/cycle.serial.test.ts` (39→41), `test/phantom-redirect.test.ts` (41→42; vacuous C4 test replaced by 2), `test/extract-conversation-facts-diagnostics.serial.test.ts` (4→8)
- Docs: `docs/architecture/key-files/core-utilities-1.md`, `docs/architecture/key-files/commands-3.md` (pointers from deleted test files to their new owners)
- No production code changed. No shared files (smell GRANDFATHERED, tsv, weights, CLAUDE.md, CHANGELOG, VERSION) touched.

## Smell ratchet (`bun test test/test-reads-source-smell.test.ts` — fails as expected, "stale ratchet entry")

All touched files now have 0 unjustified src/ read sites:
asymmetric-encoding-contract 3→0, backlinks-job-default 1→0 (deleted), cli.test 1→0 (read now tagged `[structural]`), cycle-pack-gating 1→0, cycle-patterns 1→0 (one tagged `[structural]` read kept), cycle/cycle-lock-ttl 1→0 (deleted), extract-conversation-facts-workers 1→0 (deleted), phantom-redirect-per-source-lock 1→0 (deleted), regression-strict-source-id 6→0, upgrade.serial 1→0.
Also reported stale but NOT from this slice (already stale at HEAD): `distribution-import-boundary.test.ts` 1→0.

## Shared-file edits the parent owns

- GRANDFATHERED: remove the 10 entries above (+ distribution-import-boundary if not handled elsewhere).
- `scripts/test-weights.json`, `scripts/ubicloud/weights.json`: remove the 4 deleted files. `scripts/structural-suites.tsv`: backlinks-job-default, cycle/cycle-lock-ttl, phantom-redirect-per-source-lock appear; regenerate with `bun scripts/classify-tests.ts`. No hits in `.github/`, `scripts/e2e-test-map.ts`, `test/fixtures/e2e-unmapped-baseline.txt`, `scripts/serial-weights.json`, `scripts/e2e-weights.json`.

## Commands run

- `bash ~/.capy/drive/user-garry-tan/skills/gstack/scripts/install.sh --check` → failed (not installed); installer run → "Claude skills, GPT-6 Astra skills, and Chromium are ready"
- `bun install --frozen-lockfile` → OK
- each touched file alone: handlers 12/0, core/cycle.serial 41/0, phantom-redirect 42/0, asymmetric-encoding-contract 4/0, regression-strict-source-id 5/0, cycle-pack-gating 8/0, cycle-patterns 11/0, cli 20/0, upgrade.serial 25/0, extract-conversation-facts-diagnostics.serial 8/0
- `bun run typecheck` → clean
- `bun run check:test-isolation` → OK (1988 non-serial unit files)
- `bun run check:doc-history` → ok
- every probe: mutation applied with a scripted exact-string replace, `bun test` new owner + a copy of the HEAD version of the old test, then `git checkout src` (final `git status --short src` clean)


All probes were applied to production code, run, and reverted with `git checkout <file>`.
"new" = behavior test added in this slice. Counts are `bun test <file>` pass/fail.

## Retiring a test — evidence table

| Deleted test | Probe edit | Result | Surviving owner | Owner result |
|---|---|---|---|---|
| `test/backlinks-job-default.test.ts` › "default action is 'check'" + "inverted shape stays absent" + "block exists" (file deleted) | `src/commands/jobs.ts` backlinks handler: `job.data.action === 'fix' ? 'fix' : 'check'` → `=== 'check' ? 'check' : 'fix'` (fix-by-default) | deleted test fails (2 of 3) | `test/handlers.test.ts` › "no action in job.data → check: gap reported, target page untouched" (new) | fails (1 of 12) |
| ↳ coupling evidence | `jobs.ts`: behavior-preserving rewrite `job.data.action !== 'fix' ? 'check' : 'fix'` | deleted test fails (1 of 3) | same owner | passes (12 of 12) |
| `test/cycle/cycle-lock-ttl.test.ts` › "LOCK_TTL_MINUTES === 5" (file deleted) | `src/core/cycle.ts`: `LOCK_TTL_MINUTES = 5` → `30` (DB lock TTL) | deleted test fails (1 of 1) | `test/core/cycle.serial.test.ts` › "a held cycle lock expires 5 minutes out" (new) | fails (1 of 41) |
| ↳ same test, second literal | `src/core/cycle.ts`: `LOCK_TTL_MS = 5*60*1000` → `30*60*1000` (file-lock staleness) | deleted test fails (1 of 1) | `test/core/cycle.serial.test.ts` › "a live holder whose lock file is older than 5 minutes is treated as stale" (new) | fails (1 of 41) |
| `test/phantom-redirect-per-source-lock.test.ts` › "import line uses syncLockId" + "acquireLockWithRetry passes syncLockId(sourceId)" (file deleted) | `src/core/cycle/phantom-redirect.ts`: `acquireLockWithRetry(engine, syncLockId(sourceId), …)` → `acquireLockWithRetry(engine, SYNC_LOCK_ID, …)` (+ import) | deleted test fails (2 of 3) | `test/phantom-redirect.test.ts` › "lock contention (C4) — per-source sync lock" (2 new tests) | fails (2 of 42) |
| ↳ same, bare literal | `phantom-redirect.ts`: lock id → `'gbrain-sync'` | deleted test fails (1 of 3) — import pin blind | same owner | fails (2 of 42) |
| `test/phantom-redirect-per-source-lock.test.ts` › "helper sanity: syncLockId returns gbrain-sync:<source> shape" | `src/core/db-lock.ts`: `syncLockId` → `gbrain-sync/${sourceId}` | deleted test fails (1 of 3) | `test/phantom-redirect.test.ts` › "same-source sync lock held → lock_busy" (seeds the literal `gbrain-sync:src-b` row) | fails (1 of 42) |
| `test/phantom-redirect.test.ts` › "lock contention (C4)" — REPLACED (vacuous: asserted only the row it had just inserted, and seeded the pre-D16 bare `gbrain-sync` id) | any lock-id mutation above | old test passes (blind; it never called the pass) | replaced by the two per-source behavior tests in the same describe | fails (2 of 42) |
| `test/asymmetric-encoding-contract.test.ts` › "Source-text contract": "hybrid.ts imports embedQuery" + "hybrid.ts calls embedQuery" (describe deleted; file kept) | `src/core/search/hybrid.ts` `embedQueryBounded`: `embedQuery(text, {...})` → `embed(text)` (document encoding on the search path) | deleted tests: 1 of 3 fails (import pin blind — `embedQuery` still imported) | `test/asymmetric-encoding-contract.test.ts` › "embedQueryBounded sends input_type=query for Voyage" (new; both hybridSearch query-embed call sites, hybrid.ts:1880 and :2767, go through `embedQueryBounded`) | fails (1 of 4) |
| `test/asymmetric-encoding-contract.test.ts` › "embedding.ts re-exports both embed and embedQuery" | vacuous for behavior: `hybrid.ts` imports `{ embed, embedQuery }` from `../embedding.ts`, so dropping either export is a `tsc` error | — | `bun run typecheck` (verify battery) | see typecheck probe below |
| `test/regression-strict-source-id.test.ts` › "patterns.ts imports validateSourceId from utils.ts" + "patterns.ts calls validateSourceId before reverse-write join" (deleted; file kept) | `src/core/cycle/patterns.ts` `reverseWriteRefs`: move `validateSourceId(source_id)` after `writeFileSync` | old file 1 of 9 fails | `test/regression-strict-source-id.test.ts` › "patterns: snake_id and traversal ids throw and write nothing" (new, drives `patterns.__testing.reverseWriteRefs`) | fails (1 of 5) |
| `test/regression-strict-source-id.test.ts` › "synthesize.ts imports validateSourceId from utils.ts" + "synthesize.ts calls validateSourceId before reverse-write join" (deleted) | `src/core/cycle/synthesize.ts` `reverseWriteRefs`: delete `validateSourceId(source_id)` | old file 1 of 9 fails | `test/regression-strict-source-id.test.ts` › "synthesize: snake_id and traversal ids throw and write nothing" (new) | fails (1 of 5) |
| `test/regression-strict-source-id.test.ts` › "utils.ts source text contains no permissive regex" + "utils.ts re-exports assertValidSourceId as validateSourceId" (deleted) | `src/core/utils.ts`: replace the re-export with a permissive `/^[a-z0-9_./-]+$/` validator | old file 3 of 9 fail | kept behavior tests "validateSourceId from utils.ts IS assertValidSourceId…", "rejects underscores", plus both new reverse-write tests | fails (4 of 5) |
| `test/cycle-pack-gating.test.ts` (file rewritten: 21 → 8 tests; 14 source-grep pins over `cycle.ts` deleted, exported-constant ALL_PHASES/PHASE_SCOPE checks consolidated) › "packDeclaresPhase helper exists", "reads resolved.manifest.phases", "fail-open returns false" | `src/core/cycle.ts` `packDeclaresPhase`: `return phases.includes(phase)` → `… && false` (gate never opens) | old file passes 21/21 (blind) | new › "a pack that declares the phases (gbrain-creator) opens the gate" | fails (1 of 7) |
| ↳ "dispatch for synthesize_concepts calls packDeclaresPhase" + "not_in_active_pack uses the same marker" | `cycle.ts`: `else if (!(await packDeclaresPhase(engine,'synthesize_concepts')))` → `else if (false && …)` (gate dropped, string kept) | old file passes 21/21 (blind) | new › "a pack without the phases skips both…" + "pack gating is additive…" | fails (2 of 7) |
| ↳ "only extract_atoms + synthesize_concepts reference packDeclaresPhase" + "extract_facts / calibration_profile dispatch does NOT consult packDeclaresPhase" | `cycle.ts`: add a `packDeclaresPhase(engine,'extract_facts')` skip branch to the extract_facts dispatch | old 3 of 21 fail | new › "pack gating is additive: a full default-pack cycle pack-skips only the two lens phases" | fails (1 of 7) |
| ↳ "NEEDS_LOCK_PHASES includes extract_atoms / synthesize_concepts" | `cycle.ts`: drop `'extract_atoms'` from `NEEDS_LOCK_PHASES` | old 1 of 21 fail | new › "extract_atoms alone waits behind a live cycle-lock holder" | fails (1 of 7) |
| ↳ "#2117 both skip summaries name the phases: key and a lens pack" + "drain hint" | `cycle.ts`: synthesize_concepts skip summary → `'synthesize_concepts: skipped'` | old 1 of 21 fail | new › "a pack without the phases skips both with an actionable … summary" | fails (1 of 7) |
| ↳ "packDeclaresPhase reads phases from active pack manifest (NOT extends chain)" | `src/core/schema-pack/merge.ts` `mergeInheritedManifest`: inherit `phases` from the nearest ancestor that declares them | old passes 21/21 (blind) | new › "phases are not inherited through extends (D4-B)" (user pack under `$GBRAIN_HOME/.gbrain/schema-packs/`, verified to load: merged page_types include `atom`, `phases` undefined) | fails (1 of 8) |
| `test/cycle-patterns.test.ts` (file rewritten: 16 → 11 tests; module-level `patterns.ts` source read removed; 1 tagged structural pin kept — see "Kept pins") › "caps gather to 100 reflections" | `src/core/cycle/patterns.ts` gatherReflections: `LIMIT 100` → `LIMIT 1000` | old file 16/16 pass (blind: `'LIMIT 1000'` contains `'LIMIT 100'`) | new › "scoped to <prefix>/, newest first, capped at 100, bounded by lookback" | fails (1 of 10) |
| ↳ "orders by updated_at DESC" | `patterns.ts`: `ORDER BY updated_at DESC` → `ASC` | old 16/16 pass (blind: the DESC string survives in a comment) | same new test | fails (1 of 10) |
| ↳ "filters reflections by slug LIKE <prefix>/%" | `patterns.ts`: bind `${sourceSlugPrefix}%` (no slash; sibling trees leak in) | old 1 of 16 fails | same new test | fails (1 of 10) |
| ↳ "reads min_evidence + lookback_days config" | `patterns.ts` loadPatternsConfig: `Math.max(1, parseInt(minEvidenceStr)…)` → `Math.max(3, …)` | old 16/16 pass (blind) | new › "min_evidence: 2 reflections skip by default … run at min_evidence=2" | fails (1 of 10) |
| ↳ (same test, lookback half) | `patterns.ts`: `lookbackDays: lookbackStr ? 30 : 30` (config ignored) | old 16/16 pass (blind) | new › "lookback_days narrows the window" | fails (1 of 10) |
| ↳ "source slug prefix defaults to …/reflections" + scope-filter `dream.patterns.source_slug_prefix` | `patterns.ts`: read key `dream.patterns.source_slug_prefix_x` | old 16/16 pass (blind: substring) | new › "source_slug_prefix points the phase at another reflection tree" | fails (1 of 10) |
| ↳ "gates on gateway provider reachability, not ANTHROPIC_API_KEY" | `patterns.ts`: probe → `process.env.ANTHROPIC_API_KEY ? ok : fail` | old 1 of 16 fails | new › "a non-Anthropic model passes the gate with no ANTHROPIC_API_KEY" | fails (1 of 10) |
| ↳ (same test, `normalizeModelId`) | `patterns.ts`: `probeChatModel(normalizeModelId(config.model))` → `probeChatModel(config.model)` | old 16/16 pass (blind: import still present) | new › "a bare model id is normalized to its provider before probing" | fails (1 of 10) |
| ↳ "adds a configured output_slug_prefix to the subagent write allow-list" + "threads allowed_slug_prefixes from filing-rules JSON" | `patterns.ts`: `if (!allowedSlugPrefixes.includes(outputGlob))` → `if (allowedSlugPrefixes.includes(outputGlob))` | old 16/16 pass (blind) | new › "job carries filing-rule + configured output allow-list and prompt prefixes; no raw_data" | fails (1 of 10) |
| ↳ "output slug prefix is config-driven" | `patterns.ts`: read key `dream.patterns.output_slug_prefix_x` | old 16/16 pass (blind: substring) | same submission test | fails (1 of 10) |
| ↳ "does NOT use raw_data table (Codex #3)" | `patterns.ts`: `INSERT INTO raw_data …` right after `new MinionQueue(engine)` | old 16/16 pass (blind) | same submission test (asserts `raw_data` empty) | fails (1 of 10) |
| ↳ "reverse-writes pages to disk via serializeMarkdown" | `patterns.ts` renderPageToMarkdown: `return page.compiled_truth ?? ''` (frontmatter dropped) | old 16/16 pass (blind) | new › "writes the page back as markdown that round-trips title, type, tags and body" | fails (1 of 10) |
| ↳ "uses subagent_tool_executions for slug provenance" | `patterns.ts` collectChildPutPageSlugs: `tool_name = 'brain_put_page'` → `'put_page'` | old 1 of 16 fails | `test/cycle-patterns-source-scope.test.ts` › "collected refs carry the cycle source" (+4) | fails (5 of 6) |
| ↳ "runs after extract — does not call runAutoLink / extractPageLinks" (vacuous negative pin) | `src/core/cycle.ts` ALL_PHASES: move `'patterns'` before `'extract'` | old 16/16 pass (blind) | `test/core/cycle.serial.test.ts` › "default: all 6 phases run in order" | fails (1 of 41) |
| ↳ "imports … SubagentHandlerData" | vacuous: a type-only import, enforced by `tsc` | — | `bun run typecheck` | — |
| `test/cli.test.ts` › "reindex is in CLI_ONLY" (deleted) | `src/cli.ts`: drop `'reindex'` from `CLI_ONLY` | old file 2 of 24 fail (this pin + the census) | `test/cli.test.ts` › "CLI-only commands reach their handlers instead of \"Unknown command\"" (new, spawns `gbrain <cmd> --help` for reindex/import/export/embed/files) + kept census | fails (2 of 20) |
| `test/cli.test.ts` › "CLI_ONLY set contains expected commands" (deleted) | `cli.ts`: drop `'files'` from `CLI_ONLY` | old 1 of 24 fails — only the kept census; this pin is blind (`'files'` still appears in `case 'files':`) | same new spawn test | fails (2 of 20) |
| `test/cli.test.ts` › "ask alias maps to query in source" (replaced) | `cli.ts`: delete the `if (command === 'ask') command = 'query'` block | old 1 of 24 fails | `test/cli.test.ts` › "ask dispatches to the query op" (new, spawns `gbrain ask --help`, expects `Usage: gbrain query`) | fails (1 of 20) |
| ↳ coupling evidence | `cli.ts`: behavior-preserving `command = ({ ask: 'query' })[command] ?? command` | old 1 of 24 fails | same new test | passes (20 of 20) |
| `test/cli.test.ts` › "imports operations from operations.ts" + "builds cliOps map from operations" (deleted) | `cli.ts`: `cliOps` population guarded with `&& false` (map left empty) | old 1 of 24 fails — neither pin (strings survive) | existing `test/cli.test.ts` › "per-command --help prints usage without DB connection" + new "ask dispatches to the query op" | fails (2 of 20) |
| `test/cli.test.ts` › "has formatResult function for CLI output" (deleted) | vacuous: `formatResult` is imported and called by the kept "formatResult's default renderer is bigint-safe" test; removal is a `tsc` + runtime failure there | — | `test/cli.test.ts` › "formatResult's default renderer is bigint-safe" | — |
| `test/upgrade.serial.test.ts` › describe "detectInstallMethod heuristic (source analysis)" (13 source-grep tests deleted; replaced by 4 in-process + 4 PATH-shimmed behavior tests) › "checks node_modules before binary" | `src/commands/upgrade.ts` detectInstallMethod: `if (execPath.endsWith('/gbrain')) return 'binary'` inserted before the node_modules branch | old file 30/30 pass (blind: first `node_modules` hit is a comment) | new › "node_modules is checked before the compiled-binary execPath name" | fails (1 of 25) |
| ↳ "checks binary before clawhub" | `upgrade.ts`: clawhub probe inserted before the binary check | old 4 of 30 fail | existing › "binary self-update {smoke_failed,version_mismatch,replace_failed} records to_version" (run under a `gbrain`-named bun with a succeeding clawhub shim) | fails (3 of 25) |
| ↳ "uses clawhub --version, not which clawhub" | `upgrade.ts`: `execSync('which clawhub', …)` | old 2 of 30 fail | new › "clawhub is detected by running `clawhub --version`, not by PATH presence" (+ hung-probe test) | fails (2 of 25) |
| ↳ "has timeout on upgrade execSync calls" | `upgrade.ts`: drop `timeout: 5_000` from the clawhub detection probe | old 30/30 pass (blind: other `timeout:` literals keep the count ≥2) | new › "a hung `clawhub --version` probe times out instead of wedging upgrade" | fails (1 of 1 run with `-t hung`; hit the 60s test timeout) |
| ↳ "does not reference npm in case labels or messages" | covered by the same clawhub test: the `unknown` path's full stdout+stderr must not mention `npm` | — | new › "clawhub is detected by running `clawhub --version`…" | asserts on output |
| ↳ "bun-link signal walks .git/config for garrytan/gbrain match" (`toLowerCase`) | `upgrade.ts` detectBunLink: `cfg.includes(GBRAIN_GITHUB_REPO)` (case-sensitive) | old 30/30 pass (blind: `toLowerCase()` appears elsewhere) | new › "bun-link: case-insensitive .git/config marker; git pull + bun install run at the repo root without a shell" (config url `GarryTan/GBrain`) | fails (1 of 25) |
| ↳ "detectBunLink does not gate on isSymbolicLink" | `upgrade.ts` detectBunLink: `if (!lstatSync(argv1).isSymbolicLink()) return null` | old 1 of 30 fails | same new bun-link test (argv[1] is a real file) | fails (1 of 25) |
| ↳ "detectBunLink returns repoRoot" + "bun-link upgrade uses execFileSync for shell-injection safety" | `upgrade.ts`: `execSync(\`git -C ${linkInfo.repoRoot} pull --ff-only\`)` | old 1 of 30 fails | same new bun-link test (checkout path contains `$(touch INJECTED-…)`; the probe run created the marker, the test caught it) | fails (1 of 25) |
| ↳ "bun global upgrade passes cwd to bun update" | `upgrade.ts`: drop `cwd: bunGlobalRoot` from `bun update gbrain` | old 1 of 30 fails | new › "bun global install: `bun update gbrain` runs in the bun global root" | fails (1 of 25) |
| ↳ "classifyBunInstall checks repository.url AND src/cli.ts marker" | `upgrade.ts` classifyBunInstall: remove the repository.url check | old 30/30 pass (blind) | new › "canonical by repository.url: bun, no squatter warning" | fails (1 of 25) |
| ↳ (same test, marker half) | `upgrade.ts` classifyBunInstall: remove the `src/cli.ts` marker check | old 1 of 30 fails | new › "canonical by shipped src/cli.ts marker when repository is absent" | fails (1 of 25) |
| ↳ "squatter recovery message names both source-clone AND release-binary paths" | `upgrade.ts` printSquatterRecovery: drop the releases URL line | old 30/30 pass (blind: `releases` appears elsewhere in the file) | new › "npm squatter … warns with clone + release recovery (#658)" | fails (1 of 25) |
| ↳ "return type includes bun-link variant" | vacuous: the `switch (method)` has `case 'bun-link'`, so dropping the union member is a `tsc` error | — | `bun run typecheck` | — |
| `test/extract-conversation-facts-workers.test.ts` (file deleted; 17 tests: 12 source-grep + 3 exported-helper + 2 type-shape greps) › "LockUnavailableError caught + pages_lock_skipped incremented (D6)" | `src/commands/extract-conversation-facts.ts`: drop `state.result.pages_lock_skipped++` in the lock-busy catch | old file 1 of 17 fails | `test/extract-conversation-facts-diagnostics.serial.test.ts` › "a page locked by another worker is skipped and counted; the CLI exits 3; release lets it run" (new) | fails (1 of 8) |
| ↳ "per-page work wrapped in withRefreshingLock (D2 + D12)" | `extract-conversation-facts.ts`: replace `withRefreshingLock(engine, lockId, fn, …)` with a direct `fn()` call | old 1 of 17 fails | same new lock test | fails (1 of 8) |
| ↳ "exit 3 fires when lock-busy pages remain (codex #3)" | `extract-conversation-facts.ts`: delete `if (aggregate.pages_lock_skipped > 0 …) process.exit(3)` | old 1 of 17 fails | same new lock test (`process.exit` spied → expects `exit:3` and the "Skipped 1 page(s) held by another worker" summary) | fails (1 of 8) |
| ↳ "delete-orphans-first called BEFORE segment extraction (D11)" | `extract-conversation-facts.ts`: remove the delete-orphans-first call | old 17/17 pass (blind: `deleteOrphanFactsForPage(` still appears in the non-extractable path) | new › "replay deletes a prior partial run's facts before extracting, keeping the new ones (D11)" | fails (1 of 8) |
| ↳ (same test, ordering) | `extract-conversation-facts.ts`: move the delete from before the segment loop to after it | old 17/17 pass (blind) | same new D11 test (the late delete wipes the facts it just inserted) | fails (1 of 8) |
| ↳ "preflight fires … BEFORE work loop" + "imports assertFactsEmbeddingDimMatchesConfig" | `extract-conversation-facts.ts`: delete the D15 preflight call | old 1 of 17 fails | new › "embedding-width drift fails the run before any page is attempted (D15 preflight)" (engine view reporting `kind: 'postgres'` over the same PGLite DB; gateway reconfigured to 1024 dims vs the `halfvec(1536)` column) | fails (1 of 8) |
| ↳ (same, ordering) | `extract-conversation-facts.ts`: move the preflight from before the work loop to just before `return result` | old 1 of 17 fails | same new preflight test (asserts no page was attempted before the throw) | fails (1 of 8) |
| ↳ "parsedArgs.workers threaded into core opts" | `extract-conversation-facts.ts` runExtractConversationFacts: drop `workers: parsed.workers` from the core opts | old 17/17 pass (blind: the job-envelope copy of the string survives) | new › "--workers reaches the worker resolver and the --background job envelope" | fails (1 of 8) |
| ↳ "Minion job envelope includes workers (D9 round-trip)" | `extract-conversation-facts.ts` buildJobParams: drop `workers: parsed.workers` | old 17/17 pass (blind: the core-opts copy survives) | same new workers test (job row `data.workers === 20`) | fails (1 of 8) |
| ↳ "runExtractConversationFactsCore calls resolveWorkersWithClamp" + import pins (runSlidingPool, parseWorkers/resolveWorkersWithClamp, withRefreshingLock/LockUnavailableError) | import pins are vacuous (`tsc`); the resolver call is observed by the kept "three actual pool workers share exact counters…" (spied resolver; `maxActive === 3`) and the new workers test | — | existing + new diagnostics tests | — |
| ↳ "ExtractConversationFactsResult has pages_lock_skipped + orphan_facts_cleaned" + "initial result object literal initializes both counters to 0" | the counters are asserted as exact values (`pages_lock_skipped: 1/0`, `orphan_facts_cleaned: 1`) and via the CLI summary; an uninitialized counter becomes `NaN` and fails those | — | new lock + D11 tests | — |
| ↳ "extractConversationFactsLockId composes source + slug" + "lock id differs across sources" | `extract-conversation-facts.ts`: lock id → `extract-conversation-facts:${slug}` (source dropped) | old 2 of 17 fail | new lock test (the same slug in `speaker-b` must run while `speaker-a`'s is held) | fails (1 of 8) |
| ↳ "PER_PAGE_LOCK_TTL_MINUTES is short enough…" | `extract-conversation-facts.ts`: `PER_PAGE_LOCK_TTL_MINUTES = 2` → `30` | old 1 of 17 fails | new lock test (reads the live lock's TTL during the model call; must be ≤ 10 min) | fails (1 of 8) |

### Typecheck probes for vacuous pins

| Deleted pin | Probe edit | `bun run typecheck` |
|---|---|---|
| asymmetric › "embedding.ts re-exports both embed and embedQuery" | `src/core/embedding.ts`: un-export `embedQuery` | 10 errors (e.g. `src/commands/takes.ts(28,10): TS2459 … 'embedQuery' … not exported`; `hybrid.ts` imports it too) |
| upgrade › "return type includes bun-link variant" | `src/commands/upgrade.ts`: drop `'bun-link'` from `detectInstallMethod`'s return union | `upgrade.ts(48,10): TS2678` + `upgrade.ts(823,22): TS2322` |

## Kept pins (tagged, class-2, no cheap harness)

| File › test | Why kept | Probe |
|---|---|---|
| `test/cli.test.ts` › "every handleCliOnly top-level case label is reachable via CLI_ONLY" | A self-updating registry census: switch `case` labels in `handleCliOnly` cannot be enumerated at runtime, so a NEW case missing from CLI_ONLY can only be caught from source text. Now carries a `test-reads-source-ok[structural]` marker (shared module-level read). | drop `'reindex'`/`'files'` from CLI_ONLY → fails |
| `test/cli.test.ts` › "cli.ts no longer uses a replacer-less stringify on the normalize path" | The local-op normalize call site sits inline in `main()`; bigints only reach it from Postgres (PGLite returns int8/COUNT as JS numbers — verified with `SELECT 5::bigint, count(*)` → `number number`), so no unit-lane harness can drive a bigint through it without a production seam. Same tagged read. | not re-probed (unchanged test body) |
| `test/cycle-patterns.test.ts` › "the post-drain wait renews the private-queue lease through the shared throttled factory" | The lease only lapses after a >10-min post-drain wait with a live child; on the inline drain the child is terminal before the wait, so renewal is unobservable (verified: a `renewPrivateQueueLease` spy saw no call even on real code). Library behavior is owned by `test/wait-for-completion.test.ts` / `test/queue-child-done.test.ts`. Tagged `test-reads-source-ok[structural]`. Honest limits: blind to `import { waitForCompletion as waitForCompletionRenewing }` (passes), and trips on a behavior-preserving `(waitForCompletionRenewing as any)(…)` cast. `test/cycle-abort.test.ts` also pins the same call. | alias probe: passes (blind); cast probe: fails |

## Ratchets, manifests, commands

| Command | Result |
|---|---|
| focused: 34 touched/owner files each run alone (`(scratch) focused.txt`) | all pass |
| `bun run typecheck` | clean |
| `bun run verify` | 56/56 checks green (23 s) |
| `bun run check:test-placeholders` | OK (2622 files, 6 allowlisted sites) |
| `bun test test/test-reads-source-smell.test.ts` | 12/0 after removing 16 GRANDFATHERED entries (15 rewritten/deleted files → 0, plus the stale `distribution-import-boundary` entry left by slice 19) |
| `bun scripts/classify-tests.ts` | `scripts/structural-suites.tsv` regenerated (314 suites / 1339 cases / 182 files) |
| weights: 5 deleted files removed from `scripts/ubicloud/weights.json` and `scripts/test-weights.json` (none in serial/e2e weights, `.github`, `e2e-test-map.ts`, e2e baseline) | `run-serial-pool`, `ci-ubicloud-schedule`, `sharding`, `test-shard.slow` pass |
| `bun run check:orphan-modules` | OK (20 permitted test-only) |
| `bun run check:test-isolation` | OK |
