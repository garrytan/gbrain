# Releasing & contributing (gbrain)

The full release + contributor process. CLAUDE.md keeps the ship-critical IRON RULES
inline (the Version-locations table, branch=workspace, post-ship `/document-release`,
the Privacy + Responsible-disclosure rules, PR-title-version-first, never-hand-roll-ship)
and points here for everything else. **Before any ship, read this in full. Use `/ship` —
never hand-roll a release.**

## Pre-ship requirements

Before shipping (/ship) or reviewing (/review), always run the full test suite.
Two equivalent paths:

**Path A — local CI gate (recommended, v0.23.1+):**
- `bun run ci:local` runs the entire stack inside Docker: gitleaks (host),
  guards + typecheck, then 4-shard parallel unit + E2E against four pgvector
  containers plus a transaction-mode PgBouncer service (unit phase keeps
  `DATABASE_URL` unset; `--no-shard` for the legacy sequential flow). Stronger
  than PR CI's four-file Tier 1 job; closer to what nightly Tier 1 catches. Spins
  up + tears down postgres automatically via `docker-compose.ci.yml`. Override
  the host port with `GBRAIN_CI_PG_PORT=5435 bun run ci:local` if 5434 collides.
- `bun run ci:local:diff` checks a doc-only diff in seconds (gitleaks plus
  `scripts/ci-doc-checks.sh`) and runs the full gate for any other diff: E2E
  narrowing is retired (see docs/TESTING.md "E2E selection").
- `bun run ci:ubicloud` (and `ci:ubicloud:diff`) runs the same lanes across ten
  ephemeral Ubicloud VMs in about five minutes instead of one Docker host. Needs
  `UBICLOUD_API_KEY` or `UBICLOUD_API_TOKEN`; see "Ubicloud fan-out" in
  [docs/TESTING.md](TESTING.md).

**Path B — manual lifecycle (still supported):**
- `bun test` — unit tests (no database required)
- Follow the "E2E test DB lifecycle" steps in
  [docs/TESTING.md](TESTING.md) to spin up the test DB, run
  `bun run test:e2e`, then tear it down.

Both must pass. Do not ship with failing E2E tests. Do not skip E2E tests.

**Always run typecheck before pushing.** Neither `bun test` (the bun runner)
nor `bun run test` gates on types — `bun run test` is just
`bash scripts/run-unit-parallel.sh` (the sharded unit runner; no typecheck,
no shell pre-checks — see the test-tier table in [docs/TESTING.md](TESTING.md)).
Three ways to actually gate on types:

1. `bun run verify` — runs the shell guard checks (privacy, jsonb, source-id,
   progress-to-stdout, …) plus `bun run typecheck` in parallel
   (`scripts/run-verify-parallel.sh`). Use this mid-branch.
2. `bun run typecheck` — standalone TypeScript checking with native incremental
   analysis in ignored `node_modules/.cache/gbrain-typecheck.tsbuildinfo`. Cold
   checks still analyze the whole project; repeated checks reuse compiler state
   while retaining input invalidation and diagnostics. See [Testing](TESTING.md).
3. `bun run ci:local` — the full local CI gate from Path A.

The trap is: writing a new test, running `bun test test/foo.test.ts`,
seeing it pass, pushing — and CI's separate typecheck stage rejects an
invalid type literal that the runner accepted. Caught one of these
shipping the v0.23.2 round-trip E2E (`type: 'reflection'` is not a
member of `PageType`). Run `bun run typecheck` once before push, even
when only test files changed.


## Generated artifacts

`bun run regen:all` regenerates every generated artifact offline and keyless
(schema bundles, error-code and agent-protocol blocks, harness reference, tool
catalog, skills manifest, metric glossary, CLI flag registry, plugin tree and
persona variants, structural-suites manifest, then `llms.txt`/`llms-full.txt`
last) and lists the files it changed. Run it before pushing whenever a
freshness gate could fail; a second run changes nothing. `bun run verify`
runs the read-only half, `check:regen-all`, whose failure names each stale
artifact and the same fix. Contract goldens (export surface, CLI goldens, SQL
text) are behavior pins, so `regen:all` leaves them alone unless you pass
`--goldens`, and each changed golden needs a reason in the PR body. Goldens
that need Postgres are named in its output with their own command.

## Nightly-red issues

`.github/workflows/nightly-watch.yml` runs `scripts/nightly-issue.ts` after every
scheduled workflow and keeps one issue per workflow titled `Nightly red: <workflow>`
(label `nightly-red`). The issue body lists the failing job and step pairs, the
first red run and the commits since the last green one, the `gh workflow run`
re-check, and a "Next step for the agent" block plus a JSON block.

- **Owner:** the agent on release duty owns every open `nightly-red` issue; Garry is
  the escalation for owner-only actions (secrets, repository settings).
- **Response within 24 hours:** a repair PR, or a row in
  `.github/nightly-known-red.tsv` (job, failure signature, the owning TODOS.md entry,
  a review-by date). The file holds at most 3 rows; fix one before adding another.
  A matching cell keeps the issue open with the `known-red` label; a new failure in
  the same job opens a new incident; a passed review-by date asks for a fix again.
- **Closing:** nightly-watch closes the issue only when a later scheduled run is
  green and every previously failing job executed. A skipped job never closes it.
- **Re-check after a fix:** `gh workflow run <workflow>.yml --ref master`, then
  `gh workflow run nightly-watch.yml -f run_id=<that scheduled run id>` to preview
  (`-f dry_run=true`) or apply the issue update.
- **Dependency advisories:** pull requests block on `bun audit` only when they change
  `bun.lock`, `admin/bun.lock`, `patches/` or a package.json dependency field, or
  carry the `dependency-audit` label; pushes and the nightly run always block, so a
  new upstream advisory shows up as one red nightly instead of every open PR.

## Merge queue

`test.yml` and `e2e.yml` carry `merge_group` triggers. They are inert until the
merge queue is enabled for `master` in the repository settings; check with
`gh api repos/garrytan/gbrain/rulesets` (or the branch protection page). Queue runs use
the pull-request profile against the queued merge commit: primary native scope,
the newest Bun version only in the security and persistence matrices, the
2,500-write soak and the 10,001-page export scale; the E2E selector diffs the
queued commit against `master`.

- Without the queue, a release rebases onto the latest `origin/master` and re-runs
  the full CI (`test.yml`, `e2e.yml`, persistence-validation) immediately before
  merging, because a stale base can break master even when the PR was green.
- With the queue on, `gh pr merge` only enqueues the PR. Wait until the PR is
  actually merged (`gh pr view <n> --json state,mergedAt`) before tagging,
  announcing or starting dependent work.

## CHANGELOG + VERSION are branch-scoped

**VERSION and CHANGELOG describe what THIS branch adds vs master, not how we got
here.** Every feature branch that ships gets its own version bump and CHANGELOG
entry. The entry is product release notes for users; it is not a log of internal
decisions, review rounds, or codex findings.

**Write the CHANGELOG entry at /ship time, not during development.** Mid-branch
iterations, review rounds (CEO/Eng/Codex/DX), and implementation detours belong
in the plan file at `~/.claude/plans/`, not in the CHANGELOG. One unified entry
per branch, covering what the branch added vs the base branch.

**Never edit a CHANGELOG entry that already landed on master.** If master has
v0.18.2 and your branch adds features, bump to the next version (v0.19.0, not
editing master's v0.18.2). When merging master into your branch, master may
bring new CHANGELOG entries above yours — push your entry above master's
latest and verify:

- Does CHANGELOG have your branch's own entry separate from master's entries?
- Is VERSION higher than master's VERSION?
- Is your entry the topmost `## [X.Y.Z]` entry?
- `grep "^## \[" CHANGELOG.md` shows a contiguous version sequence?

If any answer is no, fix it before continuing.

**CHANGELOG is for users, not contributors.** Write like product release notes:

- Lead with what the user can now **do** that they couldn't before. Sell the capability.
- Plain language, not implementation details. "You can now..." not "Refactored the..."
- **Never mention internal artifacts**: plan file IDs, decision tags (D-CX-#, F-ENG-#),
  review rounds, codex findings, subcontractor credits. These are invisible to users.
- Put contributor-facing changes in a separate `### For contributors` section at the bottom.
- Every entry should make someone think "oh nice, I want to try that."

**What to omit:**
- "Codex caught X that the CEO review missed" — private process detail.
- "D-CX-3 split errors/warnings" — tag is meaningless to users; name the feature instead.
- "Fix-wave PR #N supersedes #M" — supersede chains belong in PR bodies, not release notes.
- "215 new cases, 3 decisions applied, 7 reviews cleared" — these are planning-mode metrics.

**What to keep:**
- The user-facing change: what commands exist now, what flag was added, what behavior fixed.
- Numbers that mean something to the user: TTHW, commands that timed out before, detection counts.
- Upgrade instructions: `gbrain upgrade` + any manual step if needed.
- Credit to external contributors when a community PR was incorporated.

## CHANGELOG voice + release-summary format

**IRON RULE: the CHANGELOG describes what the user gets, not how the work
happened.** Nobody reading release notes cares that codex caught a bug, that
the plan went through CEO + eng review, that the migration was originally
numbered v68 and renumbered to v79 during master merge, or that two
review rounds caught architectural mistakes. The reader cares what
`gbrain brainstorm` does and how to use it. If a fact only exists because
of the development process, it does NOT belong in the CHANGELOG.

**Specifically forbidden in CHANGELOG entries:**

- Any mention of review processes (CEO review, eng review, codex review,
  plan-eng-review, outside voice, adversarial review, autoplan, /review).
- "What we caught and fixed before merging" sections. Bugs found pre-merge
  are not changes — they're things that didn't ship.
- Plan file references, plan IDs, plan decision tags (D1, D14, D-CDX-3).
- Migration version drama ("originally v68", "renumbered to v77", "claimed
  by parallel waves") — just say "Migration v79 adds X." If the user
  cares about migration ordering, they read the diff.
- Round counts, finding counts, decision counts ("25 findings across 2
  rounds", "8 architectural decisions", "5/6 expansions accepted").
- Names of internal collaborators ("codex caught", "the reviewer flagged",
  "Claude noticed").
- "Plan + reviews" summary bullets. The plan lives in `~/.claude/plans/`;
  if a future reader wants the backstory they can grep there.
- Any wording that frames a shipped feature as a *recovery* from a planning
  mistake ("the first plan was wrong", "we corrected the approach", "the
  shipped version supersedes the original design").

**Smell test:** read the entry as a stranger who has never touched gbrain.
If any sentence makes them think "why are you telling me this?", cut it.
Every sentence in the release-summary AND in the itemized changes must
answer one of three questions: *What can I now do? How do I use it? What
should I watch for after I upgrade?*

Every version entry in `CHANGELOG.md` MUST start with a release-summary section in
the GStack/Garry voice — one viewport's worth of prose + tables that lands like a
verdict, not marketing. The itemized changelog (subsections, bullets, files) goes
BELOW that summary, separated by a `### Itemized changes` header.

The release-summary section gets read by humans, by the auto-update agent, and by
anyone deciding whether to upgrade. The itemized list is for agents that need to
know exactly what changed.

### Release-summary template

**Iron rule: lead ELI10, get precise after.** The first ~150 words of every entry
must be readable by someone who does NOT know gbrain's internals. No file paths,
no function names, no internal constants, no acronyms (no "RRF", no "knobsHash",
no "MODE_BUNDLES", no "CDX-4"), no jargon that requires reading the codebase to
parse. Lead with the user-visible behavior change, in everyday English, like
you're explaining it to a smart engineer who has never opened the repo.

THEN, once the reader knows what shipped and why they'd care, drill into the
precise details: real file paths, real function names, real config keys, real
numbers. The precision part is required (the entry is also the technical record
of what changed), but it lives AFTER the plain-English lead, never before it.

The shape:

1. **One-line bold headline.** What changed for the user, in human English. No
   jargon. No internal terms. Example good: "Your search stops boosting weak
   pages just because they have a lot of links pointing at them." Example bad:
   "PostFusionOpts gains floorRatio; KNOBS_HASH_VERSION bumped 2→3."
2. **Plain-English opener** (~3-5 sentences). Describe the problem this fixes in
   everyday terms. Pretend the reader has a brain full of meeting notes and
   people pages and wants to know if this release helps them. Concrete example
   beats abstract description.
3. **A "How to turn it on" or "How to use it" section** with paste-ready
   commands. Real flags, real config keys. This is where precision starts.
4. **A "What you'd see in a concrete example" or "The X numbers that matter"
   section** with a table. Use everyday-language column headers ("Page",
   "Match quality", "Has many backlinks?") even when the underlying mechanism
   is technical. The table teaches what the feature does without requiring the
   reader to understand how.
5. **A "What's safe to know about" or "Things to watch" section** for caveats,
   side effects, cache invalidation, mid-deploy notes. Still in plain language.
6. **A "What we caught and fixed before merging" section** if the work went
   through review (CEO/eng/codex/outside-voice). Translate review findings into
   plain English. "We caught a stale-cache bug" beats "knobsHash() did not
   include floorRatio in the v=2 hash input."
7. **`### Itemized changes`** (precision lives here). File paths, function
   names, types, constants, line numbers. This section is for engineers who
   need to know exactly what moved.

Voice rules (apply throughout):
- No em dashes (use commas, periods, "...").
- No AI vocabulary (delve, robust, comprehensive, nuanced, fundamental, etc.) or
  banned phrases ("here's the kicker", "the bottom line", etc.).
- Real numbers, real file names, real commands AFTER the ELI10 lead. Not "fast"
  but "~30s on 30K pages." In the ELI10 lead, "fast enough that you won't
  notice" or "~30 seconds even on a big brain."
- Short paragraphs, mix one-sentence punches with 2-3 sentence runs.
- Connect to user outcomes: "the agent does ~3x less reading" beats "improved
  precision."
- Be direct about quality. "Well-designed" or "this is a mess." No dancing.

**The smell test:** if someone who has never opened gbrain reads the first 150
words and walks away knowing what shipped and whether they care, the entry
passes. If they need to grep the codebase to follow along, rewrite the lead.

**Canonical examples in this CHANGELOG:** v0.35.6.0 (floor-ratio gate, written
ELI10-lead-first), v0.34.4.0 (embed stale fix wave). Use those shapes when in
doubt. Avoid the shape of entries that lead with internal constants or release
mechanics; those exist in older history but should not be the model for new
work.

Source material to pull from:
- CHANGELOG.md previous entry for prior context
- Latest `gbrain-evals/docs/benchmarks/[latest].md` for headline numbers (sibling repo)
- Recent commits (`git log <prev-version>..HEAD --oneline`) for what shipped
- Don't make up numbers. If a metric isn't in a benchmark or production data, don't
  include it. Say "no measurement yet" if asked.

Target length: ~250-350 words for the summary. Should render as one viewport.

### "To take advantage of v[version]" block (required, v0.13+)

After the release-summary and BEFORE `### Itemized changes`, every `## [X.Y.Z]`
entry MUST include a human-readable self-repair block under the heading
`## To take advantage of v[version]`.

Why: `gbrain upgrade` runs `gbrain post-upgrade` which runs `gbrain apply-migrations`.
This chain has a known weak link — `upgrade.ts` catches post-upgrade failures as
best-effort (so the binary still works). When that chain silently fails, users end
up with half-upgraded brains. The self-repair block gives them a paste-ready
recovery path; the v0.13+ `~/.gbrain/upgrade-errors.jsonl` trail + `gbrain doctor`
integration close the loop.

Template (adapt the verify commands per release):

```markdown
## To take advantage of v[version]

`gbrain upgrade` should do this automatically. If it didn't, or if `gbrain doctor`
warns about a partial migration:

1. **Run the orchestrator manually:**
   ```bash
   gbrain apply-migrations --yes
   ```
2. **Your agent reads `skills/migrations/v[version].md` the next time you interact with it.**
   [One sentence on whether headless agents need manual action, or whether the
   orchestrator already handled the mechanical side.]
3. **Verify the outcome:**
   ```bash
   [release-specific verify commands, e.g. `gbrain graph ... --depth 2`]
   gbrain stats
   ```
4. **If any step fails or the numbers look wrong,** please file an issue:
   https://github.com/garrytan/gbrain/issues with:
   - output of `gbrain doctor`
   - contents of `~/.gbrain/upgrade-errors.jsonl` if it exists
   - which step broke

   This feedback loop is how the gbrain maintainers find fragile upgrade paths. Thank you.
```

**Skip this block** for patches that are pure bug fixes with zero user-facing action
(rare). If the release has a schema migration, data backfill, or new feature the
user needs to verify, the block is required.

The v0.13.0 entry in CHANGELOG.md is the canonical example.

### Itemized changes (the existing rules)

Below the release summary, write `### Itemized changes` and continue with the
detailed subsections (Knowledge Graph Layer, Schema migrations, Security hardening,
Tests, etc.). Same rules as before:

- Lead with what the user can now DO that they couldn't before
- Frame as benefits and capabilities, not files changed or code written
- Make the user think "hell yeah, I want that"
- Bad: "Added GBRAIN_VERIFY.md installation verification runbook"
- Good: "Your agent now verifies the entire GBrain installation end-to-end, catching
  silent sync failures and stale embeddings before they bite you"
- Bad: "Setup skill Phase H and Phase I added"
- Good: "New installs automatically set up live sync so your brain never falls behind"
- **Always credit community contributions.** When a CHANGELOG entry includes work from
  a community PR, name the contributor with `Contributed by @username`. Contributors
  did real work. Thank them publicly every time, no exceptions.

### Reference: v0.12.0 entry as canonical example

The v0.12.0 entry in CHANGELOG.md is the canonical example of the format. Match its
structure for every future version: bold headline, lead paragraph, "numbers that
matter" with BrainBench-style before/after table, "what this means" closer, then
`### Itemized changes` with the detailed sections below.

## Version migrations

Create a migration file at `skills/migrations/v[version].md` when a release
includes changes that existing users need to act on. The auto-update agent
reads these files post-upgrade (see `docs/guides/upgrades-auto-update.md`)
and executes them.

**You need a migration file when:**
- New setup step that existing installs don't have (e.g., v0.5.0 added live sync,
  existing users need to set it up, not just new installs)
- New SKILLPACK section with a MUST ADD setup requirement
- Schema changes that require `gbrain init` or manual SQL
- Changed defaults that affect existing behavior
- Deprecated commands or flags that need replacement
- New verification steps that should run on existing installs
- New cron jobs or background processes that should be registered

**You do NOT need a migration file when:**
- Bug fixes with no behavior changes
- Documentation-only improvements (the agent re-reads docs automatically)
- New optional features that don't affect existing setups
- Performance improvements that are transparent

**The key test:** if an existing user upgrades and does nothing else, will their
brain work worse than before? If yes, migration file. If no, skip it.

Write migration files as agent instructions, not technical notes. Tell the agent
what to do, step by step, with exact commands. See `skills/migrations/v0.5.0.md`
for the pattern.

## Migration is canonical, not advisory

GBrain's job is to deliver a canonical, working setup to every user on upgrade.
Anything that looks like a "host-repo change" — AGENTS.md, cron manifests,
launchctl units, config files outside `~/.gbrain/` — is a GBrain migration
step, not a nudge we leave for the host-repo maintainer. Migrations edit host
files (with backups) to make the canonical setup real. Exceptions: changes
that require human judgment (content edits, renames that break semantics,
host-specific handler registration where shell-exec would be an RCE surface).
Everything mechanical ships in the migration.

**Test:** if shipping a feature requires a sentence that starts with "in
your AGENTS.md, add…" or "in your cron/jobs.json, rewrite…", the migration
orchestrator should be doing that edit, not the user.

**The exception is host-specific code.** For custom Minion handlers
(host-specific integrations like inbox sweeps or third-party API scanners), shipping them as a
data file the worker would exec is an RCE surface. Those get registered in
the host's own repo via the plugin contract (`docs/guides/plugin-handlers.md`);
the migration orchestrator emits a structured TODO to
`~/.gbrain/migrations/pending-host-work.jsonl` + the host agent walks the
TODOs using `skills/migrations/v0.11.0.md` — stays host-agnostic, still
canonical.


## Schema state tracking

`~/.gbrain/upgrade-state.json` tracks which recommended schema directories the user
adopted, declined, or added custom. The auto-update agent
(`docs/guides/upgrades-auto-update.md`) reads this during upgrades to suggest new schema additions without re-suggesting
things the user already declined. The setup skill writes the initial state during
Phase C/E. Never modify a user's custom directories or re-suggest declined ones.

## GitHub Actions SHA maintenance

All GitHub Actions in `.github/workflows/` are pinned to commit SHAs. Before shipping
(`/ship`) or reviewing (`/review`), check for stale pins and update them:

```bash
for action in actions/checkout oven-sh/setup-bun actions/upload-artifact actions/download-artifact softprops/action-gh-release gitleaks/gitleaks-action; do
  tag=$(grep -r "$action@" .github/workflows/ | head -1 | grep -o '#.*' | tr -d '# ')
  [ -n "$tag" ] && echo "$action@$tag: $(gh api repos/$action/git/ref/tags/$tag --jq .object.sha 2>/dev/null)"
done
```

If any SHA differs from what's in the workflow files, update the pin and version comment.

## GitHub releases (binary assets + self-update) — #3521

`.github/workflows/release.yml` publishes a GitHub release automatically for
**every VERSION bump that lands on master** (trigger: push to master touching
`VERSION`, plus `workflow_dispatch` for a manual first run or repair). No
manual tag push is part of the ship flow — the workflow reads `VERSION` (the
single source of truth), mints tag `v<VERSION>` at the pushed commit, titles
the release the same, uses that version's `CHANGELOG.md` entry as the notes
(`scripts/changelog-entry.sh`; falls back to a CHANGELOG link if the entry is
missing), and attaches the compiled binaries.

The executable build job pins Bun 1.4.2 and verifies the Darwin artifact with
strict native `codesign` before publishing it. A source merge does not repair
already-published bad binaries; an affected release needs its own explicitly
approved recovery and asset verification. The template and plugin publishing
jobs pin the same Bun version.

### The `latest-stable` tag

The **final step of the release job** force-advances the `latest-stable` tag to
the release commit (`git push origin "+${GITHUB_SHA}:refs/tags/latest-stable"`).
`latest-stable` is the single sanctioned distribution ref: the README paste
block, the `BOOTSTRAP_FOR_AGENTS.md` fetch URL, and
`bun install -g github:garrytan/gbrain#latest-stable` all reference it
permanently, so paste blocks copied into the wild never rot and there is no 404
window between VERSION landing and assets publishing.
`scripts/check-bootstrap-tag.sh` keeps the entry docs pinned to this ref.

Because it moves ONLY after binaries + provenance attestation have fully
published, a half-built release never advances it. If the tag-advance step
alone fails, re-advance by hand (a full workflow re-run would skip — the
release already exists with all assets):

```bash
git push origin "+refs/tags/v<VERSION>^{commit}:refs/tags/latest-stable"
```

### The `publish-template` job

After the release job, a `publish-template` job force-pushes the rendered
agent-workspace template repo (the GitHub "Use this template" door,
`vars.TEMPLATE_REPO`, default `garrytan/gbrain-agent-template`) from CI only —
no human pushes it by hand, so what adopters clone is exactly what this repo
reviewed. It is guarded three ways: the release above fully published; the
vendored tree `templates/bootstrap/template-repo/` exists (skip, never fail,
if not); and the `TEMPLATE_REPO_PAT` secret is configured (skip if not).
Before pushing, it regenerates the template tree
(`bun run scripts/generate-template-repo.ts`) and byte-diffs it against the
vendored copy — a mismatch fails the job; regenerate + commit the vendored
tree (`scripts/check-bootstrap-templates.sh` runs the same diff offline in
`bun run verify`).

**`TEMPLATE_REPO_PAT` scope:** a fine-grained PAT with `contents: write` on
the template repository ONLY — no other repositories, no other permissions.
Configure it as a repo secret; when absent, template publishing is disabled
and the job skips cleanly.

Why every bump, not selective: `gbrain check-update` resolves the latest
version from `VERSION` on master, while binary self-update
(`src/core/binary-self-update.ts`) downloads assets from `releases/latest`.
Any release that lags `VERSION` tells binary installs an upgrade exists that
self-update cannot apply. `releases/latest` must track `VERSION`.

Invariants:

- **Asset names are a contract.** The build matrix's `artifact:` names must
  equal what `expectedAssetName()` in `src/core/binary-self-update.ts`
  returns (`gbrain-darwin-arm64`, `gbrain-linux-x64` today). Adding a
  platform means updating BOTH plus the version job's completeness check;
  `test/release-workflow.test.ts` pins all of it.
- **Idempotent + self-repairing.** The version job skips when a release for
  `v<VERSION>` already exists with all expected assets; a partial release
  (tag but no release, or missing assets) is completed on re-run. Racing
  master pushes queue via the `release` concurrency group — a skipped
  intermediate version is fine, latest is what matters.
- **Historical tags are never rewritten.** Old 3-segment versions keep their
  history; every new 4-segment `VERSION` mints a fresh tag.
- **Permissions stay scoped.** `contents: write` lives on the release job
  only; everything else runs read-only.
- **Never advance `latest-stable` on a partial release.** The tag moves only
  as the final release-job step, after every asset has published. Manual
  re-advances must point at a fully published `v<VERSION>` release.

## PR descriptions cover the whole branch

Pull request titles and bodies must describe **everything in the PR diff against the
base branch**, not just the most recent commit you made. When you open or update a
PR, walk the full commit range with `git log --oneline <base>..<head>` and write the
body to cover all of it. Group by feature area (schema, code, tests, docs) — not
chronologically by commit.

This matters because reviewers read the PR body to understand what's shipping. If
the body only covers your last commit, they miss everything else and can't review
properly. A 7-commit PR with a body that describes commit 7 is worse than no body
at all — it actively misleads.

When in doubt, run `gh pr view <N> --json commits --jq '[.commits[].messageHeadline]'`
to see what's actually in the PR before writing the body.

## Community PR wave process

Never merge external PRs directly into master. Instead, use the "fix wave" workflow:

1. **Categorize** — group PRs by theme (bug fixes, features, infra, docs)
2. **Deduplicate** — if two PRs fix the same thing, pick the one that changes fewer
   lines. Close the other with a note pointing to the winner.
3. **Collector branch** — create a feature branch (e.g. `garrytan/fix-wave-N`), cherry-pick
   or manually re-implement the best fixes from each PR. Do NOT merge PR branches directly —
   read the diff, understand the fix, and write it yourself if needed.
4. **Test the wave** — verify with `bun test && bun run test:e2e` (full E2E lifecycle).
   Every fix in the wave must have test coverage. Run
   `bun run audit:contributors <base>..<collector-head> --prs <manifest>` to re-prove,
   per merged change and per open PR (trial-merged), that its tests fail with its product
   hunks reversed; the tool pins the PR heads into `prs.pinned.json` so a rerun tests the
   same code, and its Markdown table keeps mechanical results apart from your verdicts
   (see [Contributor audit](TESTING.md#contributor-audit)). Paste the table into the wave
   PR body.
5. **Security review** — run `bun run wave-security-scan <base>..<collector-head>` over the
   collector branch (the repeatable mechanical sweep). It ALARMS on newly-introduced
   obfuscation/eval in code, secrets found by gitleaks **with the test/skills allowlist
   stripped**, and any committed `admin/dist` change (the bundle-backdoor artifact); new
   outbound endpoints, spawns, env reads, and dependency changes print as context. Exit 1
   means "eyeball before shipping," not "unsafe" — read the ALARM rows and the context lists,
   and confirm each is benign. Link the result (or a one-line "clean") in the wave PR body.
   This is the standard's teeth: a wave PR body that claims "security reviewed" must have run
   this. It is a net, not a proof — a human still reads the diffs.
6. **Close with context** — every closed PR gets a comment explaining why and what (if
   anything) supersedes it. Contributors did real work; respect that with clear communication
   and thank them. In the wave PR body, put each folded-in contributor PR on a
   `Supersedes #N` line and each fixed issue on a `Fixes #N` line: when the wave merges,
   the [fix-wave closeout](#fix-wave-closeout) closes those PRs with a thank-you comment and
   GitHub closes the issues. Write `Addresses #N` or `Refs #N` for anything only partly
   done, so it stays open. Close declined or duplicate PRs by hand, with the reason.
7. **Ship as one PR** — single PR to master with all attributions preserved via
   `Co-Authored-By:` trailers. Include a summary of what merged and what closed.

**Community PR guardrails:**
- Always AskUserQuestion before accepting commits that touch voice, tone, or
  promotional material (README intro, CHANGELOG voice, skill templates).
- Never auto-merge PRs that remove YC references or "neutralize" the founder perspective.
- Preserve contributor attribution in commit messages.

### Fix-wave gate

`.github/workflows/fix-wave-gate.yml` (job `contributor-gate`) fails every PR into
master unless its head repository is `garrytan/gbrain` or the `maintainer-override`
label counts. Only maintainers can push to `garrytan/gbrain`, so GBRA thread PRs
(`capy/*`) and `garrytan/*` branches pass; fork PRs fail whatever their branch is
called. When a contributor PR opens, a second job posts one comment with the same
text as the failure: the work is welcome and the PR stays open, it lands through a
fix wave with credit (`Contributed by @handle` plus a `Co-Authored-By:` trailer), and
CONTRIBUTING.md "Where does my change go?" explains where changes belong.

The workflow uses `pull_request_target`, so the workflow and
`scripts/fix-wave-gate.ts` always come from the default branch: a PR that edits
either cannot change its own result. It reads only the event payload and the PR
timeline, never PR code, with `permissions: {}` at the top, `pull-requests: read`
for the gate and `pull-requests: write` only for the comment job. A null head
repository (deleted fork) fails closed. The check re-runs on `opened`, `edited`,
`reopened`, `synchronize`, `labeled` and `unlabeled`.

**`maintainer-override` label.** Who: a human on `MAINTAINERS` in
`scripts/fix-wave-gate.ts` (starts as `garrytan`; changing it is a reviewed PR to
master). When: only for a PR a maintainer has decided may land from its fork, such as
a fix wave a maintainer opened from a fork; record the reason in a PR comment. How it
is checked: the label counts only when the most recent `labeled` timeline event for it
was made by an allowlisted `User`; bots (`capy-ai[bot]`, `github-actions[bot]`, any
`[bot]` login) never qualify, and removing the label fails the PR again. Audit: the run
log prints a `notice` naming who applied the label, when, and the timeline event id,
and the step summary repeats it.

**Turning it on (repository settings, maintainer only).** The guard is active only
after this step; until then the check is advisory. Settings → Rules → Rulesets (or
Settings → Branches → the `master` protection rule) → Require status checks to pass →
add `contributor-gate` with GitHub Actions as the source → save. The check must have
run once on any PR before GitHub offers it in the picker.

**Residual risk.** A same-repo branch (`capy/*` or `garrytan/*`) that carries
contributor commits passes by design. Keeping contributor work inside a revised fix
wave on those branches stays a policy rule, enforced by review, not by this check.

### Fix-wave closeout

`.github/workflows/fix-wave-closeout.yml` (job `close-superseded`) runs when a PR
into master closes. If it merged and its head repository is `garrytan/gbrain`,
`scripts/fix-wave-closeout.ts` reads the merged PR's body and closes every open pull
request named on a `Supersedes #N` line (`Supersedes #5085`, `- Supersedes #5089,
#5096 and #5107`, `**Supersedes:** #5113`). Only the list right after the keyword
counts, so `Supersedes #5140, which conflicts with #5000` closes #5140 alone. Each
closed PR gets one comment, keyed by `<!-- fix-wave-closeout -->`, that thanks the
contributor, links the wave, and says the work landed with credit when the wave body
contains `Contributed by @<their handle>`. Numbers that are issues or already-closed
PRs are skipped. A failed close is a warning in the run log, and the step summary
lists every number with what happened to it. One run closes at most 50 PRs.

Issues need nothing extra: `Fixes #N` in the same body closes them through GitHub.
Before this workflow, contributor PRs stayed open after their wave merged, which is
most of why the open-PR count grew. To preview a body locally without writing
anything, save the event payload and run
`bun scripts/fix-wave-closeout.ts --event <payload.json> --dry-run`.

Like the gate, it uses `pull_request_target`: the workflow and script come from the
default branch, it sparse-checks-out only the script, and it never checks out or
runs PR code. Permissions are `{}` at the top and `contents: read` plus
`pull-requests: write` for the one job.

## Checking out PRs from garrytan-agents

`garrytan-agents` is the AI-authored PR account and is NOT a collaborator on
this repo. Its PRs live in a fork, so GitHub Actions triggered by
`pull_request` events on those PRs do not receive base-repo secrets. Any CI
job that needs `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or similar will fail
with empty-env auth errors, regardless of what's set on the base repo. This
is a GitHub security default, not a config bug.

When the user says "check out <PR link>" and the PR is from `garrytan-agents`
(or any other non-collaborator fork), move the branch into the base repo
before running CI:

1. `gh pr checkout <N>` — pull down the fork's branch. Note the PR number and
   head branch name (`gh pr view <N> --json headRefName --jq .headRefName`).
2. `git push origin HEAD:<branch-name>` — push the same branch to the base
   repo (origin points at `garrytan/gbrain`, not the fork). This is the move
   that gives CI access to secrets.
3. `gh pr close <N> --comment "moving to base-repo branch for secret access"`
   — close the fork PR so the queue stays clean.
4. `gh pr create --base master --head <branch-name>` — open the replacement
   PR from the base-repo branch. **Preserve the original PR's title and body
   verbatim** (`gh pr view <N> --json title,body`); contributor attribution
   moves to a `Co-Authored-By:` trailer if needed.

Why this over alternatives: adding `garrytan-agents` as a collaborator, or
flipping the repo-wide "send secrets to fork PRs" toggle, both broaden
secret distribution to every fork PR from that account or any fork. Moving
the branch keeps secret scope tight to just the one PR being shipped.

## ClawHub bundle plugin publish (manual)

`openclaw.plugin.json` makes this repository a ClawHub bundle plugin (see
[docs/mcp/OPENCLAW.md](mcp/OPENCLAW.md)). Publishing a new version to ClawHub is
a manual step outside `release.yml`, run from a clean checkout of the release
tag by an owner with an authenticated `clawhub` CLI:

```bash
bun run prepublish:clawhub   # bun run build:all: bin/gbrain-darwin-arm64 + bin/gbrain-linux-x64
bun run publish:clawhub      # clawhub package publish . --family bundle-plugin
```

`build:all` compiles only those two targets; the full binary matrix ships
through the GitHub release job above. ClawHub users upgrade with
`clawhub update gbrain`, which `gbrain upgrade` runs for ClawHub installs.

## Plugin dist tree (codex/claude lanes)

The committed `plugin/` and `plugin-variants/` trees embed the VERSION stamp
(the variants' generated plugin manifests carry it too), so a release bump
drifts them. After bumping VERSION/package.json, run `bun run
scripts/generate-plugin-tree.ts --out plugin --variants-out plugin-variants`
and stage `plugin/` + `plugin-variants/` + `skills/plugin-lanes.json`.
`scripts/check-plugin-tree.sh` (in `bun run verify`) and the release
`publish-codex-plugin` job both fail on drift.

When personas change in `skills/plugin-lanes.json#personas`, also hand-edit
`.claude-plugin/marketplace.json`: the variant entries must match the
personas block exactly (`test/codex-plugin-manifest.test.ts` pins the
mapping, so a persona added without a marketplace entry fails the suite).
