---
title: "CI vs Local Checks"
type: guide
created: 2026-04-29
updated: 2026-04-30
source: chatgpt-export
conversation_id: 69f29330-79c8-83e8-a111-025c41abf56a
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# CI vs Local Checks

> Conversation ID: 69f29330-79c8-83e8-a111-025c41abf56a
> Created: 2026-04-29T23:24:33Z
> Updated: 2026-04-30T00:17:43Z
> Messages: 6

---

## User

Seems like our biggest thing that's slowing down multiple workspaces on our laptops is type check running incredibly slow, and builds are generally slow on my machine. Now, we have a mono repo, but we're using Turbo repo and stuff, and we pushed a recent thing that was supposed to speed it up, but I don't know that it did. But I'm just trying to figure out, like, should we pull linting and type check from local and just have it happen in CI where we have, you know, the ability for it to, it's not bottlenecking our computer then, or is that just kind of like clog up CI because a few things are going to be like sitting there unfixxed? Or do we put it in CI and have auto-fixing happen in CI, or is that just going to burn costs and stuff? Like how do we think about this?

---

## Assistant

Mr. White, I’ll treat this as a workflow design decision: keep developers unblocked locally, make CI authoritative, and optimize Turbo/TypeScript caching before shifting checks wholesale.

---

## Assistant

Mr. White, I would **avoid moving type-check/lint entirely out of local dev**. The better setup is:

**Local = fast, targeted guardrails. CI = authoritative full/affected gate.**

### Recommendation

Keep these **local**:

1. **Editor TypeScript diagnostics**
   Developers should still see type errors while coding.

2. **Pre-commit staged-file formatting/linting**
   Run `prettier --write` and `eslint --fix` only on staged files via `lint-staged`. `lint-staged` is explicitly designed to pass only staged files to tasks, which keeps hooks small instead of scanning the whole monorepo. citeturn394504view3

3. **Optional local “am I safe?” command**
   Example: `pnpm check` or `pnpm check:affected`, but this should be developer-invoked or pre-push at most, not part of every build/dev loop.

Move these to **CI as required gates**:

1. Full or affected **typecheck**
2. Full or affected **lint**
3. Build/test/deploy validation

Do **not** have normal CI auto-fix PR code during the required check. Use auto-fix locally, or use a separate bot workflow that opens a formatting PR. CI should generally fail with the exact command to fix.

---

## Why

### 1. Typecheck is safety-critical, but it should not block every local build

TypeScript typechecking is inherently expensive on large projects. TypeScript’s own performance guidance says large workspaces should be split into smaller projects, often mirroring monorepo package boundaries, and that project references can improve build/editor times. citeturn394504view1turn110097view0

So the answer is not “delete local typecheck.” The answer is:

**Remove full-repo typecheck from hot local paths. Keep it available locally. Enforce it in CI.**

Hot local paths include:

```bash
pnpm dev
pnpm build:local
pnpm test:watch
pre-commit
```

Those should be fast.

---

### 2. Linting probably has two different costs hiding under one name

Split lint into:

```bash
lint:fast      # syntax/static lint, no type-aware rules
lint:typed     # type-aware eslint rules
format         # prettier
```

Type-aware ESLint rules can be roughly as slow as TypeScript typechecking because they call TypeScript’s type-checking APIs. The typescript-eslint docs explicitly call out that typed linting asks TypeScript to analyze the whole project and can take longer on large projects. citeturn436580view1turn436580view0

My default would be:

Local pre-commit:

```bash
prettier --write
eslint --cache --fix
```

CI:

```bash
turbo run lint:fast lint:typed check-types build test --affected
```

ESLint’s `--cache` option exists specifically to avoid reprocessing unchanged files and can dramatically improve lint runtime. citeturn394504view2

---

### 3. CI will clog only if you run too much unnecessary work

Use Turbo to run **affected work**, not everything. Turbo’s `--affected` flag filters to packages affected by changes on the current branch, and Turbo warns that CI needs enough git history or shallow checkouts may make everything appear changed. citeturn388635view2

A PR check should look more like:

```bash
turbo run check-types lint:fast lint:typed test build --affected
```

Then run a full-repo check on:

```bash
main
nightly
release branches
```

That gives you fast PRs without losing repo-wide confidence.

---

## CI auto-fixing: mostly no

I would not make the main CI pipeline mutate PR code.

Reasons:

1. It creates extra commits and reruns.
2. It can create annoying race conditions if the developer pushes while CI is also pushing.
3. It hides the source of formatting/lint failures.
4. It costs CI minutes for work that should be near-free locally.
5. It can produce “CI passed after modifying the code,” which is less clean than “the code submitted passed.”

Good uses of auto-fix:

```bash
lint-staged + eslint --fix + prettier --write
```

Acceptable bot use:

```text
A separate scheduled/triggered formatting bot opens a PR.
```

Main CI should say:

```text
Formatting failed. Run: pnpm format
Lint failed. Run: pnpm lint:fix
Typecheck failed. Run: pnpm check-types
```

---

## Turbo-specific setup I would check

Your `turbo.json` should distinguish build outputs, lint/typecheck status tasks, and dependency-aware typechecking.

Example shape:

```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"]
    },

    "lint:fast": {
      "outputs": []
    },

    "lint:typed": {
      "outputs": []
    },

    "check-types": {
      "dependsOn": ["transit"],
      "outputs": []
    },

    "transit": {
      "dependsOn": ["^transit"]
    },

    "test": {
      "dependsOn": ["build"],
      "outputs": ["coverage/**"]
    }
  }
}
```

Turbo’s docs specifically call out that typecheck tasks need dependency-awareness for correctness, but depending directly on `^check-types` can reduce parallelism. Their recommended pattern is a “transit” node so typecheck tasks can run in parallel while still being aware of package dependency changes. citeturn388635view0

Also confirm outputs are configured correctly. Turbo only restores file outputs that are declared in `outputs`; for lint-like tasks with no file outputs, `outputs: []` is fine. citeturn388635view0turn994032view0

---

## Remote cache is probably the biggest missing lever

If you are not getting reliable remote cache hits across laptops and CI, Turbo is leaving a lot on the table.

Turbo’s remote caching is intended to share task results across the team and CI, so the same task does not need to be re-executed on every machine when inputs are identical. citeturn434776view0turn994032view0

I would set policy like this:

```bash
# Local developer machines
turbo run ... --cache=local:rw,remote:r

# CI
turbo run ... --cache=local:rw,remote:rw
```

Meaning: CI writes trusted cache results; developers mostly read from remote and write local. Turbo supports controlling local/remote read-write behavior through `--cache`. citeturn388635view2

---

## How to know whether the recent “speed-up” worked

Measure four scenarios, separately:

```bash
# 1. Cold local
rm -rf .turbo/cache
time pnpm turbo run check-types lint:typed build --affected --summarize

# 2. Warm local
time pnpm turbo run check-types lint:typed build --affected --summarize

# 3. Remote cache hit after CI
rm -rf .turbo/cache
time pnpm turbo run check-types lint:typed build --affected --summarize

# 4. Small leaf-package change
touch packages/some-leaf/src/foo.ts
time pnpm turbo run check-types lint:typed build --affected --summarize
```

Turbo’s `--summarize` helps explain cache inputs, outputs, and why cache misses are happening. citeturn994032view0

For TypeScript specifically, run:

```bash
tsc -b --extendedDiagnostics
```

TypeScript’s performance docs recommend `--extendedDiagnostics` to see where compiler time is going, and `--generateTrace` when you need deeper investigation. citeturn110097view0

You want to know:

```text
Are we slow because:
1. Turbo is missing cache?
2. TypeScript is checking too much?
3. ESLint is using type-aware rules everywhere?
4. Build artifacts/node_modules are accidentally included?
5. A shared package change invalidates the whole graph?
6. CI checkout is too shallow, so Turbo thinks everything changed?
```

---

## One current thing worth testing: TypeScript 7 beta

As of April 21, 2026, TypeScript 7.0 Beta is available through `@typescript/native-preview@beta` and uses the `tsgo` binary. Microsoft says it is often about 10x faster than TypeScript 6.0 and can run side-by-side with existing TypeScript tooling. citeturn366580view0

I would not blindly switch everything, because the same post says the stable programmatic API is expected later, around TypeScript 7.1+. But I would absolutely benchmark it:

```bash
npm install -D @typescript/native-preview@beta

npx tsc -b --extendedDiagnostics
npx tsgo -b
```

If your bottleneck is pure TypeScript checking, this may be the highest-leverage experiment.

---

## Practical policy I would implement

### Local

```text
pnpm dev
  No full typecheck. No full lint.

pre-commit
  prettier --write staged files
  eslint --fix staged files
  maybe lightweight tests for changed files only

pnpm check
  affected typecheck + affected lint + affected unit tests
  optional before opening PR
```

### CI on PR

```text
1. format check
2. lint:fast --affected
3. check-types --affected
4. lint:typed --affected
5. tests --affected
6. build --affected
```

### CI on main/nightly

```text
Full repo check
Full build
Full test suite
```

### Auto-fix

```text
Local: yes
Main CI: no
Separate bot PR: okay for formatting-only cleanup
```

The core decision: **do not make every laptop pay the full monorepo correctness cost on every local action. Make CI the required correctness gate, and make local checks targeted enough that developers actually keep them on.**

---

## User

then what are the push/ship/commit policies. all code is written by ai.

---

## Assistant

Mr. White, I’d treat AI-written code as requiring stronger gates at merge and ship, while keeping local iteration fast enough that people still use it.

---

## Assistant

Mr. White, for an AI-written-code shop, I’d use this policy:

> **AI can write the code. Humans own the merge. CI owns the truth. Production owns the final proof.**

The workflow should be optimized around **cheap local iteration**, **strict PR gates**, and **safe shipping**.

## 1. Commit policy

Commits should be cheap. Do **not** run full monorepo typecheck or full build on commit.

### On commit, run only:

```text
format staged files
lint/fix staged files
secret scan staged files
basic generated-file checks
```

Example:

```bash
lint-staged
```

Good commit hook:

```bash
prettier --write <staged files>
eslint --fix --cache <staged files>
detect-secrets / gitleaks on staged diff
```

Bad commit hook:

```bash
turbo run check-types build test
```

### Commit rules

Use this:

```text
Small commits are allowed.
Messy local commits are allowed.
Generated AI code is allowed.
Broken local typecheck is allowed temporarily.
Secrets are never allowed.
Direct commits to main are never allowed.
```

The goal is to keep AI/human iteration fast. A commit is a checkpoint, not a quality certification.

---

## 2. Push policy

Pushes should be stricter than commits, but still targeted.

### On push, run affected checks only:

```bash
turbo run lint:fast check-types test --affected
```

I would **not** require full build on every push unless the repo is small enough. For a monorepo, this becomes painful.

### Push rules

```text
Push only to feature branches.
No pushing directly to main.
No force-push after review unless the PR is clearly stale or being rewritten.
No huge AI-generated diffs without a human-written PR explanation.
```

The push gate should catch obvious mistakes before CI, while letting CI remain the authority.

---

## 3. PR policy

Every meaningful change goes through a PR.

Because all code is AI-written, the PR should document **intent, risk, and verification**, not “who wrote it.”

### Required PR template

```md
## What changed?

## Why?

## How was this verified?
- [ ] Affected typecheck passed
- [ ] Affected tests passed
- [ ] Affected build passed
- [ ] Manual check, if needed

## Risk
Low / Medium / High

## Rollback plan
```

### PR size limits

Set a soft size limit:

```text
Preferred: <300 changed lines
Needs explanation: 300–800 changed lines
Needs approval from tech lead/founder: >800 changed lines
```

AI makes giant diffs easy. Giant diffs are where bugs hide.

### PR review rule

For AI-written code:

```text
Reviewer reviews behavior, tests, edge cases, security, and blast radius.
Reviewer does not line-edit every AI line.
```

A human review should answer:

```text
Does this solve the right problem?
Could this break auth, billing, data, permissions, or production flows?
Are tests meaningful?
Is the diff unnecessarily large?
Is there dead/generated-looking code?
Are dependencies justified?
```

GitHub branch protection can require approving reviews and passing status checks before merge, and merge queues can retest the PR against the current target branch before merging. Use both for main. citeturn836807search6turn836807search0

---

## 4. CI policy

CI should be the real quality gate.

### Required PR checks

For every PR:

```bash
pnpm format:check
turbo run lint:fast --affected
turbo run check-types --affected
turbo run test --affected
turbo run build --affected
```

For risky PRs:

```bash
turbo run lint:typed --affected
e2e tests
security/dependency scan
migration dry run
```

For main/nightly:

```bash
turbo run lint:fast lint:typed check-types test build
full e2e
```

GitHub required status checks can block merging until checks pass, and merge queue waits for required checks before merging queued changes. citeturn836807search7turn836807search3

---

## 5. Auto-fix policy

Use auto-fix locally. Avoid normal CI auto-committing fixes.

### Good

```text
pre-commit: prettier --write
pre-commit: eslint --fix
developer/agent runs pnpm lint:fix
```

### Acceptable

```text
separate bot opens formatting-only PR
```

### Avoid

```text
main PR CI mutates the branch
CI pushes hidden fixes into feature branches
CI auto-merges AI-generated fixes
```

CI should fail clearly:

```text
Format failed. Run pnpm format.
Lint failed. Run pnpm lint:fix.
Typecheck failed. Run pnpm check-types.
```

This keeps ownership clean.

---

## 6. Merge policy

Use a merge queue for main.

### Main branch rules

```text
No direct pushes.
PR required.
Required checks must pass.
At least one human approval required.
High-risk areas require owner approval.
Merge queue required.
Squash merge by default.
```

GitHub’s merge queue is designed for branches with many PRs and ensures queued changes pass required checks when applied to the latest target branch plus earlier queued PRs. citeturn836807search0

### Merge method

Use:

```text
Squash merge for normal feature PRs.
Rebase/merge commits only for exceptional cases.
```

Reason: AI-generated commits are often noisy. The merged history should be clean.

---

## 7. Ship policy

Separate **merge** from **ship**.

A PR passing CI means:

```text
Safe to merge.
```

It does not automatically mean:

```text
Safe to expose to all users.
```

### Default ship path

```text
PR merged to main
↓
staging deploy
↓
smoke tests
↓
preview/manual check for product changes
↓
production deploy
↓
monitor errors, logs, metrics
```

### Feature flags

Any meaningful product, pricing, onboarding, auth, billing, or data behavior change should ship behind a flag.

Policy:

```text
Small UI/text changes: can ship directly.
Logic changes: ship behind flag when practical.
Auth/billing/data changes: must ship behind flag or staged rollout.
Database migrations: must have rollback or forward-fix plan.
```

---

## 8. Risk tiers

Use tiers so the process does not become bloated.

### Tier 0: trivial

Examples:

```text
copy change
CSS tweak
small non-shared component change
```

Policy:

```text
1 PR
affected CI
1 approval optional if trusted
ship normally
```

### Tier 1: normal product/code change

Examples:

```text
new component
API handler change
normal bug fix
small package change
```

Policy:

```text
1 PR
affected CI
1 human approval
staging deploy
ship
```

### Tier 2: risky

Examples:

```text
auth
billing
permissions
database writes
background jobs
shared packages
infra
large AI-generated refactor
```

Policy:

```text
human approval required
owner approval required
tests required
staging verification required
feature flag preferred
rollback plan required
```

### Tier 3: dangerous

Examples:

```text
data migration
payment flow
security-sensitive change
production config
large dependency upgrade
```

Policy:

```text
design note or implementation plan
two approvals
full CI
staging test
explicit ship window
rollback/forward-fix plan
post-ship monitoring
```

---

## 9. AI-specific rules

Because all code is AI-written, add these hard rules:

```text
AI may generate code.
AI may generate tests.
AI may generate PR descriptions.
AI may propose fixes.
AI may not approve its own PR.
AI may not bypass CI.
AI may not merge without human approval.
AI may not introduce new dependencies without explanation.
AI may not touch auth/billing/data/security code without explicit task scope.
```

If you use Copilot or similar agents, they can create PRs and request review; GitHub also supports Copilot code review on PRs. Treat AI review as advisory, not an approval. citeturn836807search15turn836807search5

---

## 10. The policy I’d actually implement

### Local commit

```bash
lint-staged
secret scan staged diff
```

### Local push

```bash
turbo run lint:fast check-types test --affected
```

### PR CI

```bash
format check
lint:fast affected
check-types affected
test affected
build affected
lint:typed affected for relevant packages
```

### Main/nightly CI

```bash
full lint
full typecheck
full test
full build
full e2e
```

### Main branch protection

```text
PR required
human approval required
required CI checks
merge queue
no direct pushes
squash merge
```

### Ship

```text
staging first
feature flags for risky changes
production deploy
monitor
rollback/forward-fix plan for risky changes
```

The key decision: **commits are cheap checkpoints, pushes are targeted sanity checks, PRs are quality gates, and shipping is a separate controlled release step.**
