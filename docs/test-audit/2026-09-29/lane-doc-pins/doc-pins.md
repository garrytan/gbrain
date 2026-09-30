# Test audit — lane `doc-pins` (read-only discovery)

Repo: garrytan/gbrain @ `2ede415` (v0.59.11.0), shallow clone (50 commits; history before `d9909cd` squashed).
Method: openclaw `test-audit` skill (audit mode, evidence-before-edit), gbrain `docs/TESTING.md` §"Coverage responsibilities before consolidation" (surviving owner must cover the same contract **and** boundary, and must execute).
Cost source: `scripts/ubicloud/weights.json` (ms per file). Lane totals for scale: unit 3,985 s, serial 1,930 s, slow 847 s, e2e 2,879 s.
Tree state: every probe reverted with `git checkout -- .`; `git status --short` empty at the end. `bun install --frozen-lockfile` was needed first (node_modules was absent; untracked).

## 1. Scope actually found

The "~157 files" estimate comes from a coarse grep (`CHANGELOG|README|SKILL.md|docs/...`). I reproduced it (152 files), but most of those hits are **temp-fixture trees** (tests that `mkdtemp` a workspace and write their own `README.md` / `SKILL.md` / `RESOLVER.md` / `AGENTS.md`, e.g. skillpack-*, shared-skills-*, sync*, bootstrap-* renders). Those test product behavior, not committed docs, and are out of this lane.

Tests that read **committed** repo docs / skills / templates / recipes / version files as text and assert on them: **~44 files** (list in §6). Of these, ~10 files carry prose-only pins; the rest are generated-artifact freshness, link/reference integrity, release/version sync, or shipped prompt/recipe contracts.

Compute is not the argument in this lane: the whole in-lane set costs ~83 s of per-file time (40 s of that is one e2e that executes a shipped script — keep). The value of cutting here is friction: prose pins make doc edits fail CI without protecting behavior.

## 2. Top candidates (full evidence)

### C1 — `test/readme-hero-anchors.test.ts` (whole file, 5 tests) → **delete**
- Tests: `README hero anchors (D9 regression guard) > mentions OpenClaw`, `> mentions Hermes`, `> leads with controlled memory and the two distinct setup paths`, `> includes at least one production number`, `> includes BrainBench framing (P@5 or R@5)`.
- Detects: exact marketing phrases in the first 50 README lines. **Probe P1:** meaning-preserving reword "Give the agent you already use a memory you control" → "Give your existing agent a memory you control": **FAIL** (`leads with controlled memory…`). No product behavior involved.
- Non-test callers of the seam: none. `grep src` for README reads finds only unrelated `README.md` files that shared-skills/template generators write themselves (`src/core/bootstrap/template-repo.ts:171`, `src/core/shared-skills/*`); nothing consumes the repo README.
- Surviving owner: none needed (no contract). README links are already checked by `test/docs-navigation.test.ts > local Markdown links and fragments resolve in README.md`; README commands by `test/docs-cli-commands.test.ts > every gbrain <verb> in README/docs/skills resolves`; privacy by `check:privacy`.
- History: rewritten at each headline rotation — `1fc8b6c` (#5026) replaced the "Search gives you raw pages…" anchor with the new headline; `db56c77` trimmed the comment again. The file's own header says "If yes [deliberate rotation]: update the anchors here". Pure lockstep churn; no evidence it ever caught a regression.
- Unlocks: 52 test LOC. No production seam.
- Cost: unit 154 ms. Risk: **low**.

### C2 — issue-fix doc-wording pins: `test/docs-bootstrap-persistence-table.test.ts` (2), `test/docs-timeline-extraction-guide.test.ts` (2) → **delete**
- Tests: `#4986 bootstrap.md scopes the Stop-push knobs… > per-turn row says the switch + debounce govern the Stop path only`, `> session-end row names no switch/debounce; crash-recovery push has its own row`; `#4987 timeline extraction docs describe the real trigger > system-of-record.md Timeline row…`, `> compiled-truth.md warns that compiled-truth citations mint timeline rows`.
- Detects: specific phrases in operator guides. They import no product code, so they cannot detect the doc drifting from behavior — only the doc drifting from its own past wording.
  - **Probe P2 (behavior break):** removed `if (process.env.GBRAIN_STOP_PUSH === '0') return 'push_disabled';` from `stopPushIfDue` (`src/commands/hook.ts:932`) — the exact behavior the doc describes. docs-bootstrap-persistence-table: **PASS (2/2)**, i.e. blind.
  - **Probe P2b (meaning-preserving doc reword):** "Stop path only" → "Stop hook alone": **FAIL**.
- Surviving behavior owner (same contract, real boundary): `test/hook-command.serial.test.ts > stop-hook per-turn push [D3] > GBRAIN_STOP_PUSH=0 disables the per-turn push (buffer append still runs)` — passes at baseline, **fails** under P2. Timeline trigger behavior: `test/extract.test.ts` (cited in the test's own header as the behavior pin).
- History: both added in `f1fbdfb` (v0.50.1.0 community fix wave) as doc fixes for #4986/#4987; single commit each.
- Unlocks: 53 test LOC. Cost: unit 189 + 227 = 416 ms. Risk: **low**.
- Note (environment): 10 other tests in `hook-command.serial.test.ts` fail at baseline on this machine (push-spawn tests; environment, not probe-related). The named owner test passes at baseline.

### C3 — `test/docs-mcp-deploy.test.ts` (9 tests) → **delete 7 doc-only pins; rewrite 1 at the CLI boundary; keep route anchor only if wanted**
- Doc-only pins (7): `DEPLOY.md documents the tailnet/LAN-only… > troubleshooting names the SDK issuer error…`, `> HTTP section states --source-guard is stdio-only…`, `> ALTERNATIVES.md distinguishes tailnet-only Serve…`, `DEPLOY.md documents dual-mode /mcp auth > troubleshooting covers "needsAuth…"`, `owner magic-link flow > warns against consuming the single-use nonce…`, `> preserves private delivery and protected-bootstrap requirements`, `> distinguishes login from client creation and states lifecycle limits`.
  - **Probe P8 (behavior break):** `NONCE_TTL_MS` 5 min → 60 min (`src/commands/serve-http.ts:1319`), making "expires after five minutes" false: **PASS 9/9** (blind).
  - **Probe P8b (meaning-preserving):** "expires after five minutes" → "is valid for five minutes": **FAIL**.
- `auth help points at the owner login flow…` reads `src/commands/auth.ts` source text (`test-reads-source-ok` exemption). Rewrite at the boundary: move the 3 help-text substrings into `test/cli-help-discoverability.test.ts > #4003 — gbrain auth --help reaches the detailed usage block`, which already spawns `gbrain auth --help`.
- `documents the owner request and the existing mint endpoint` anchors the documented route to `app.post('/admin/api/issue-magic-link'` in source. The route itself is behavior-tested in `test/e2e/serve-http-consent.test.ts` (POSTs to it) and `test/mcp-admin-http.test.ts`. Weak doc↔code check; drop or keep as a one-liner.
- History: single commit `f1fbdfb` (#4500, #4893, #5007 doc fixes).
- Unlocks: ~70 test LOC and 2 `test-reads-source-ok` exemptions. Cost: unit 251 ms. Risk: **low–med** (the privacy/secret-handling sentences are security guidance; if the owner wants them frozen, fold them into one "security guidance phrases" table row, see cluster K1).

### C4 — `test/skillopt/deadline-and-hermetic.test.ts` describe `#4741 — hermetic-config docs make no platform-survives-logout claim` (2 tests) → **delete**
- Tests: `docs/guides/skillopt.md does not promise the empty-dir form keeps macOS logged in`, `the provider doc comment does not promise it either`.
- Detects: only the literal regex `/keychain and survives/` coming back. The second test greps a **source code comment** (it says so: "comment text has no runtime surface to assert").
  - **Probe P5:** re-added the retracted claim reworded ("keeps the macOS keychain login, which survives logout") to the provider file: **PASS 2/2**.
- Surviving owner for behavior: same file, `#4119 — resolveHermeticConfigDir (opt-in)` tests (3) exercise the real function.
- Unlocks: 13 test LOC, one source-read exemption. Cost: marginal (file 315 ms stays). Risk: **low**.

### C5 — per-guard "wired into verify / package.json" pins (5 files, ~14 tests) → **delete; one assertion moves to `ci-gates`**
- Tests:
  - `test/tool-catalog.test.ts > freshness guard > check script exists and is wired into package.json + the verify chain`
  - `test/no-tracked-symlinks-guard.test.ts > check-no-tracked-symlinks.sh > exists and is executable`, `> is wired into the verify dispatcher`
  - `test/check-bootstrap-guards.test.ts > check-bootstrap-tag.sh > exists and is executable`, `check-bootstrap-templates.sh > exists and is executable`, `verify + workflow wiring > both guards are registered in the verify dispatcher`, `> package.json carries both check scripts`, `check-grok-pin.sh > verify wiring: run-verify-parallel CHECKS + package.json both carry check:grok-pin`
  - `test/privacy-script-wired.test.ts > check-privacy.sh CI wiring > exists and is executable`, `> package.json "verify" script delegates to run-verify-parallel.sh`, `> run-verify-parallel.sh dispatches check:privacy`, `> package.json "check:privacy" alias points at the script`, `> CI test.yml runs bun run verify…`
  - `test/scripts/check-engine-dynamic-import.test.ts > engine dynamic-import guard wiring > is wired into the verify registry…`, `> is listed by the authoritative verify dispatcher`, and `check-engine-dynamic-import.sh > exists`
- Surviving generic owner: `test/scripts/run-verify-parallel.test.ts > guard registration ⇒ execution coverage > every manifest guard is executed by verify or explicitly exempt` (with `scripts/guard-self-test.sh` requiring every `scripts/check-*` to be in `guards-manifest.tsv`; all 8 guards are registered there). Same contract, same boundary (the `--dry-list` of the real dispatcher plus `package.json` scripts).
  - **Probe P3a:** dropped `"check:tool-catalog"` from `CHECKS`: tool-catalog wiring test FAIL **and** generic owner FAIL.
  - **Probe P3c:** dropped 7 guards (`no-tracked-symlinks, bootstrap-tag, bootstrap-templates, grok-pin, opencode-pin, privacy, engine-dynamic-import`) from `CHECKS`: every per-file pin failed, **and** the generic owner failed naming all 7 by file. Complete duplication.
  - **Probe P3b (behavior-preserving rename):** renamed `check:tool-catalog` → `check:tool-catalog-fresh` in both `package.json` and `CHECKS`. The generic owner PASSES and the guard still runs (dry-list shows it), but the tool-catalog pin FAILS: implementation-coupled.
  - The "executable" bit: every guard is invoked as `bash scripts/<x>.sh` from package.json, so the mode bit has no effect on execution.
- The one non-duplicated assertion: "test.yml verify job runs `bun run verify`" (pinned twice, in privacy-script-wired and in check-bootstrap-guards `[C2]`). `test/scripts/ci-gates.test.ts` already loads `test.yml` and asserts the verify job's `needs`/`if`, but not its command. Move one assertion there (`unit.jobs.verify.steps.some(s => s.run === 'bun run verify')`) and delete both copies.
- Keep in those files: the fixture-driven guard behavior tests (e.g. `fails and names the offender when a symlink is tracked`, all `check-bootstrap-*` / grok / opencode / pin-doc fixture failure modes, the privacy scanner behavior tests, and the `.gitignore node_modules patterns` test).
- Unlocks: ~110 test LOC. Cost: small (~6 dry-list spawns at ≈10 ms each). Risk: **low**.
- Lane overlap: these read `package.json` and `run-verify-parallel.sh` as text, so the CI/tooling lane may report them too. Dedupe when merging.

### C6 — duplicated and vacuous real-repo `checkResolvable(skills/)` assertions → **delete 5, rewrite 2 at a fixture boundary**
- Owner test: `test/check-resolvable.test.ts > v0.22.4 regression — actual repo skills/ has 0 errors > repo skills/ pass check-resolvable cleanly (zero errors AND zero warnings)`. Every issue carries `severity: 'error'|'warning'` (`src/core/check-resolvable.ts:61`), so this test already requires `issues == []` for every type. `check:resolver` in verify (`check-resolvable --strict`) is the CLI-boundary owner.
- Subsumed (same boundary, same in-process call on the real tree): `test/resolver.test.ts > RESOLVER.md > references only existing skill files`, `> every manifest skill is reachable from resolver`; `test/check-resolvable.test.ts > checkResolvable — real skills directory > all manifest skills are reachable from RESOLVER.md`, `> no missing files referenced by RESOLVER.md`, `> no orphan triggers (in resolver but not manifest)`.
  - **Probe Q2:** pointed one RESOLVER row at a missing `skills/academic-verifyx/SKILL.md`. Failures: resolver.test ×2, check-resolvable.test `no missing files` **and** `repo skills/ pass … cleanly`, plus `check:resolver` rc=1. Four in-process copies plus a CLI gate for one regression.
  - Probe Q1 (removing academic-verify's row entirely) failed nothing, because frontmatter triggers union with RESOLVER rows by design (#1451). This confirms the reachability pins add nothing beyond the owner.
- **Vacuous (assertion-free on a clean repo):** `> action strings are specific (contain file paths)`, `> unreachable issues have structured fix objects`, `> whitelisted skills … don't trigger MECE overlap`. Each loops over `report.issues`, and the real tree reports `issues: 0` (verified: 75/75 skills reachable).
  - **Probe Q3:** changed the emitted fix type `add_trigger` → `add_row_PROBE` in `src/core/check-resolvable.ts:429`. check-resolvable.test + check-resolvable-cli.test + resolver.test: **231 pass / 0 fail**. No test anywhere asserts `add_trigger` (grep), so the fix-object and MECE-whitelist contracts are currently unguarded.
- Action: delete the 5 subsumed tests. Rewrite `unreachable issues have structured fix objects` and the MECE-whitelist test on a `makeSkillsFixture(...)` tree that actually produces the issue (the fixture helper already exists in the same file, around line 333). This rewrite *adds* real coverage.
- Unlocks: ~45 test LOC net. Cost: ≈130 ms (two `checkResolvable(skills/)` calls in resolver.test). Risk: **low** (for the deletions; the rewrite is net coverage gain).
- Keep: `resolver.test.ts` trigger round-trip (D5/C) and the example-name validator (D13). Those are distinct contracts.

### C7 — `test/ambient-recall-templates.test.ts > HEARTBEAT ambient-delta row > rendered template-repo HEARTBEAT.md carries the same row` → **delete**; CODEX.md and guide pins → **consolidate or delete**
- **Probe P4:** renamed the row only in the rendered `templates/bootstrap/template-repo/HEARTBEAT.md`. The pin FAILS, **and** `scripts/check-bootstrap-templates.sh` fails (rc=1, generator↔vendored `diff -r`), **and** so does `test/check-bootstrap-guards.test.ts > check-bootstrap-templates.sh > passes on this repo` (unit lane). The source-template pin plus the byte-diff guard fully cover the rendered copy.
- `docs surfaces > CODEX.md session-boundary instruction names both verbs`, `> ambient-recall guide exists and names both verbs`: prose pins. The guide's existence and inbound links are already checked by docs-navigation's link resolution (HEARTBEAT links to it). Low value; fold into K1 or delete.
- Keep: `source template points heartbeats at gbrain delta + context-pack`. Templates are rendered into users' workspaces, so this is a shipped prompt contract.
- Unlocks: ~22 LOC. Cost: unit 175 ms if the file shrinks to one test (no whole-file saving). Risk: **low**.

### C8 — `test/context-audit-skill.test.ts` → **rewrite (keep the contract, change the boundary)**
- Shipped skill, so this is a prompt-byte contract. But the arithmetic pin is implementation-coupled:
  - **Probe C1 (behavior-identical whitespace edit)** `* 10 + 27 ) / 28` → `* 10 + 27) / 28`: **FAIL**.
  - **Probe C2 (behavior break)** appended `* 0`, so every estimate becomes 0 tokens: **PASS 3/3**.
- Rewrite like `test/skillpack-check-report-only.test.ts` already does: extract the fenced bash pre-pass, run it on a fixture file of known size, and assert `ceil(bytes/2.8)`. Keep the `Estimate basis` / `/context` deferral phrase checks (they are the user-facing prompt contract).
- Cost: unit 203 ms. Risk: **low**. Net LOC ≈ 0.

## 3. Consolidation clusters (one generic contract instead of many one-off pins)

- **K1 — "doc claims" table.** Replace the one-off phrase pins (C2, C3's doc-only tests, C4, C7-docs, `mcp-registration-blocks > OpenClaw stdio registration docs (#4842)` ×2, `docs-navigation > active memory guidance keeps durable preferences separate…` and `> primary docs do not reinstate blanket graph or exclusivity promises`, `put-page-remote-autolink-hint > downstream-upgrade doc and enrich skill state the MCP skip…`) with **one** table-driven test: rows of `{file, mustContain[], mustNotContain[], reason/issue}`. Recommend keeping only **retracted-claim negatives** (honesty and privacy promises such as "no inline graph extraction", "not a full database backup", the retired `~/.openclaw/config.json` path), because AGENTS.md makes those a stated user-facing boundary. Drop the positive wording pins. ~15 tests → 1 table; about −90 LOC after adding the table.
- **K2 — guard wiring.** Covered by C5. The generic owner already exists; the per-guard copies are pure duplication.
- **K3 — `gbrain <verb>` scanners.** `docs-cli-commands.test.ts` (README/docs/skills) and `remediation-command-resolution.test.ts` (CHANGELOG top entry plus src strings) carry copy-pasted `validCommands()` / `commandPosition()` / fence-scanning code. Both are valuable (generic doc↔CLI contract). Extract one shared helper in `test/helpers/`. No coverage change, about −40 LOC. `canonical-migration-command.test.ts > docs/skills sweep` is a third hand-rolled markdown walker that could use the same helper.
- **K4 — recipe files.** `test/integrations.test.ts > twilio-voice-brain recipe` (5 per-file tests: parses, where-URLs are https, required secrets, semver version, requires resolve) sits beside `all recipes` (parses, typed health checks, no personal refs). Fold the generic properties (secret `where` is https, semver version, `requires` resolve) into the `all recipes` loop. That extends coverage to all 9 recipes. Keep only twilio's specific secret-name assertion. `features-recipe-secrets.test.ts` (entry↔recipe secrets) and `integrations-getstatus-anyof.test.ts` stay: they test runtime status resolution. About −40 LOC, with net coverage gain.
- **K5 — contributor-doc content pins in `build-llms.test.ts`.** `content contract: AGENTS.md mirrors README + INSTALL_FOR_AGENTS install path`, `CLAUDE.md keeps the inline ship IRON RULES`, `CLAUDE.md carries the resolver + cross-cutting invariants`, `AGENTS.md keeps its boot order…`, `llms.txt references required entry points`, `llms.txt indexes the relocated docs`. These pin agent-instruction files for contributors (not shipped product), and the llms-config paths are already guarded by `every configured path exists on disk` plus the freshness test. Low value, but CLAUDE.md is literally the prompt that coding agents on this repo read, so treat it as **owner's call**. If kept, move the rows into K1's table. ~40 LOC.

## 4. Retained false positives (looked like doc pins; they are the independent contract)

- `build-llms.test.ts > committed llms.txt + llms-full.txt match current generator output`, `every configured path exists`, `llmstxt spec shape`, `size budget`, `does NOT inline KEY_FILES.md`: generated-artifact freshness plus a bundle-shape contract that ships to LLM fetchers.
- `tool-catalog.test.ts > committed docs/TOOL_CATALOG.md matches a fresh render` (+ render-behavior tests): generated-artifact freshness for the public tool surface.
- `harness-onboarding.test.ts > published adapter facts and guide destinations match the runtime registry`: doc must equal `renderHarnessReference()` byte for byte; this is a generated-doc contract tied to the runtime registry.
- `docs-navigation.test.ts` link and fragment resolution (test.each over ~30 docs, 3.5 s): the only link checker. It is the lane's most expensive file; consider scoping or caching rather than deleting.
- `docs-cli-commands.test.ts`, `remediation-command-resolution.test.ts`, `canonical-migration-command.test.ts`: generic doc↔live-CLI contracts (they caught the real #3502 `gbrain install` and #3697 rot classes).
- `skillopt/error-code-docs.test.ts`: bijection between emitted remediation codes and doc anchors, a user-visible link contract emitted by product code.
- `release-workflow.test.ts`, `check-bootstrap-guards.test.ts` fixture tests, `template-repo-generator.test.ts`, `cli.test.ts > VERSION matches package.json`, `codex-plugin-manifest` / `openclaw-plugin-manifest` version lockstep: release, version-stamp and package contracts (self-update asset names, provenance, template publish).
- `skills-conformance.test.ts`, `resolver.test.ts` trigger round-trip and example-name validator, `check-resolvable … repo skills/ pass cleanly`, `openclaw-plugin-manifest > every skills/ path reference in a bundled SKILL.md resolves`: shipped skill-pack structural contracts.
- `canonical-writer-inventory.test.ts`: architecture contract (write-site census against a reviewed TSV).
- `skillpack-check-report-only.test.ts`: executes the skill's bash snippet against hostile input. This is a security contract and the model for rewriting C8.
- `pg-access-classify.test.ts > the marker literal appears in skills/db-repair frontmatter`: the `GBRAIN_DB_ACCESS` marker must route agents to the db-repair skill (routing contract).
- `put-page-remote-autolink-hint.test.ts > brain-ops skill Phase 2.5 states the MCP skip…`: agent-facing honesty in a shipped skill (remote=true behavior). Keep; the adjacent downstream-doc half can go to K1.
- `retrieval-reflex-recipe-routing.test.ts`: MECE trigger routing between the recipe skill and the query skill (routing behavior).
- `resolver.test.ts > has categorized sections`: `Brain operations` is the default section in check-resolvable's fix suggestion (`src/core/check-resolvable.ts:419`) and a mounts-cache field. Weak, but it has a consumer.
- `ambient-recall-templates > source template…`, `bootstrap-contract > the default skill bundle carries the memory loop contract`, `migrations-v0_12_0/v0_22_4` markdown-exists tests: shipped template, skill-bundle or migration pointers that product code emits.
- `integrations.test.ts > x-to-brain recipe > health check works with an app-only bearer token (#2343)`: credible regression on a runtime-parsed recipe.
- `e2e/qm-provisioning.test.ts`: executes a shipped script under `docs/integrations/` (behavior, not prose).

## 5. Category counts and sizing

| Category | Files | Tests (approx) | Verdict |
|---|---:|---:|---|
| Temp-fixture false hits in the coarse grep (not doc pins) | ~108 | n/a | out of lane |
| Generated-artifact freshness / link / reference integrity | 15 | ~110 (incl. per-doc/per-skill test.each) | keep |
| Release / version-stamp / package sync | 5 | ~70 | keep |
| Shipped skill / template / recipe prompt contracts | 13 | ~45 | keep (C8 rewrite, K4 merge) |
| Prose pins with no product consumer | 10 | ~31 | delete or fold into K1 |
| Duplicate verify-wiring pins (package.json / CHECKS text) | 5 | ~16 | delete (C5) |
| Real-repo checkResolvable duplicates + vacuous loops | 2 | 8 | delete 5, rewrite 2 (C6) |
| Redundant rendered-template pin | 1 | 1 | delete (C7) |

Estimated savings:
- **High-confidence batch** (C1, C2, C4, C5, C6, C7-rendered): ≈ **280 test LOC**, 3 whole files deleted, 0 production LOC (doc pins need no production seams; 2–3 `test-reads-source-ok` exemptions go away). Compute ≈ **0.7–0.9 s** of unit per-file time (whole files 154 + 189 + 227 ms, plus ≈130 ms of checkResolvable calls, plus ≈60 ms of dry-list spawns). That is ~0.02% of the unit lane.
- **Full lane** (adding C3, K1, K3, K4, K5): ≈ **450–500 test LOC**, ≈ 1.1 s compute. C6 and K4 add coverage (the fix-object and MECE contracts, and all-recipe properties).

## 6. In-lane file list (committed docs read as text) with weights (ms)

readme-hero-anchors 154 · docs-bootstrap-persistence-table 189 · docs-timeline-extraction-guide 227 · docs-mcp-deploy 251 · mcp-registration-blocks 287 · ambient-recall-templates 175 · skillopt/deadline-and-hermetic 315 · context-audit-skill 203 · build-llms 185 · docs-navigation 3525 · docs-cli-commands 558 · remediation-command-resolution 648 · canonical-migration-command 300 · skillopt/error-code-docs 168 · tool-catalog 572 · harness-onboarding 458 · release-workflow 173 · check-bootstrap-guards 3491 · template-repo-generator 243 · privacy-script-wired 534 · no-tracked-symlinks-guard 192 · scripts/check-engine-dynamic-import 5442 · scripts/check-key-files-current-state 890 · resolver 648 · check-resolvable 338 · skills-conformance 299 · codex-plugin-manifest 3181 · openclaw-plugin-manifest 175 · put-page-remote-autolink-hint 2839 · retrieval-reflex-recipe-routing 188 · skillpack-check-report-only 167 · pg-access-classify 243 · bootstrap-contract 380 · canonical-writer-inventory 297 · integrations 211 · features-recipe-secrets 227 · integrations-getstatus-anyof 337 · integrations-heartbeat-max-age 221 · migrations-v0_12_0 262 · migrations-v0_22_4 254 · upgrade-reference-sweep 501 · cli (VERSION test only) 8017 · scripts/run-verify-parallel 4653 · e2e/qm-provisioning 40319 (e2e). Total ≈ 83 s.

Out-of-lane pointers noticed (source/CI-text pins, for the other lanes): `check-bootstrap-guards > heavy-tests.yml carries the bootstrap Docker e2e placeholder [A7]`; `migrations-v0_12_0 > feature pitch includes the headline benchmark numbers` (marketing numbers in a src string); `mcp-registration-blocks > OAUTH_SECRET_NOTE text is unchanged by the move` (move-regression pin).

## 7. Probe log (all reverted; `git status` clean after each)

| # | Mutation | Target test(s) | Result |
|---|---|---|---|
| P1 | README hero reword (same meaning) | readme-hero-anchors | FAIL (coupled to prose) |
| P2 | drop `GBRAIN_STOP_PUSH` check in `stopPushIfDue` | docs-bootstrap-persistence-table | PASS (blind) |
| P2 | same | hook-command.serial `GBRAIN_STOP_PUSH=0 disables…` | FAIL (real owner) |
| P2b | doc reword "Stop path only" → "Stop hook alone" | docs-bootstrap-persistence-table | FAIL |
| P3a | drop `check:tool-catalog` from CHECKS | tool-catalog wiring / run-verify-parallel generic | FAIL / FAIL |
| P3b | rename script key in package.json + CHECKS (still runs) | tool-catalog wiring / generic | FAIL / PASS |
| P3c | drop 7 guards from CHECKS | 4 per-guard files / generic | all FAIL / FAIL naming all 7 |
| P4 | rename row in rendered template-repo only | ambient rendered pin / check-bootstrap-templates.sh / check-bootstrap-guards "passes on this repo" | FAIL / rc=1 / FAIL |
| P5 | re-add retracted keychain claim, reworded | deadline-and-hermetic #4741 | PASS (blind) |
| P8 | nonce TTL 5 → 60 min | docs-mcp-deploy | PASS 9/9 (blind) |
| P8b | "expires after" → "is valid for" five minutes | docs-mcp-deploy | FAIL |
| Q1 | delete academic-verify RESOLVER row | resolver / check-resolvable | PASS (frontmatter union, by design) |
| Q2 | RESOLVER row → missing SKILL.md | resolver ×2, check-resolvable ×2, check:resolver | all FAIL (4 in-process duplicates + CLI) |
| Q3 | fix type `add_trigger` → `add_row_PROBE` | check-resolvable, check-resolvable-cli, resolver | 231 pass / 0 fail (unguarded) |
| C1 | whitespace-only edit to skill arithmetic | context-audit-skill | FAIL (coupled) |
| C2 | `* 0` breaks the estimate | context-audit-skill | PASS (blind) |

Focused validation commands for a future edit PR: `bun test test/scripts/run-verify-parallel.test.ts test/scripts/ci-gates.test.ts test/check-resolvable.test.ts test/resolver.test.ts test/check-bootstrap-guards.test.ts test/ambient-recall-templates.test.ts test/cli-help-discoverability.test.ts`, plus `bun run check:resolver`, `bash scripts/check-bootstrap-templates.sh`, `bun run verify`.
