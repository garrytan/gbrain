---
title: "CI vs Local Checks"
type: guide
created: 2026-04-29
updated: 2026-04-29
source: chatgpt-export
topic: music-production
message_count: 6
tags: [chatgpt, knowledge, music-production]
---
**Topic:** [[chatgpt-knowledge/_topics/music-production]]

# CI vs Local Checks

> **Source:** ChatGPT conversation
> **Date:** 2026-04-29T23:24:33Z
> **Messages:** 6
> **Topic:** music-production

## Question

Seems like our biggest thing that's slowing down multiple workspaces on our laptops is type check running incredibly slow, and builds are generally slow on my machine. Now, we have a mono repo, but we're using Turbo repo and stuff, and we pushed a recent thing that was supposed to speed it up, but I don't know that it did. But I'm just trying to figure out, like, should we pull linting and type check from local and just have it happen in CI where we have, you know, the ability for it to, it's not bottlenecking our computer then, or is that just kind of like clog up CI because a few things are going to be like sitting there unfixxed? Or do we put it in CI and have auto-fixing happen in CI, or is that just going to burn costs and stuff? Like how do we think about this?

## Answer

Mr. White, I’ll treat this as a workflow design decision: keep developers unblocked locally, make CI authoritative, and optimize Turbo/TypeScript caching before shifting checks wholesale.

## Answer

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

Use Turbo to run **affected work**, not everything. Turbo’s `--affected` flag filters to packages affected by changes on the current branch, and Turbo warns that CI needs enough git history or shallow checkouts may make everything app

*(Answer truncated — 8888 chars total)*

## Question

then what are the push/ship/commit policies. all code is written by ai.

## Answer

Mr. White, I’d treat AI-written code as requiring stronger gates at merge and ship, while keeping local iteration fast enough that people still use it.

## Answer

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

GitHub branch protection can require approving reviews and passing status checks before merge, and merge queues can retest the P

*(Answer truncated — 8341 chars total)*
