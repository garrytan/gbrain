---
title: "Type Checker Speedup Options"
type: guide
created: 2026-02-23
updated: 2026-02-23
source: chatgpt-export
topic: misc
message_count: 12
tags: [chatgpt, knowledge, misc]
---
# Type Checker Speedup Options

> **Source:** ChatGPT conversation
> **Date:** 2026-02-23T06:11:38Z
> **Messages:** 12
> **Topic:** misc

## Question

Yeah, we use Biome for speed. Is there a type checker we can switch to that would get us faster results? We're currently at 80 seconds on normal PR.

## Answer

Mr. White — yes: the main “switch type checker for speed” option right now is **TypeScript’s native compiler preview (`tsgo`)** (the Go port / “TypeScript 7” preview). Microsoft is publishing it on npm as **`@typescript/native-preview`**, and you run it like `tsc`. citeturn1view0turn1view1

### What to switch to
- **`tsgo` (via `@typescript/native-preview`)**: meant to be a drop-in for type-checking, and Microsoft has shown **~10× speedups** on a large real-world repo (example: ~73s → ~6.8s in their blog). citeturn1view0  
- **Don’t bother with `stc`** as an alternative today; that repo is archived/read-only. citeturn0search2turn0search14  
- **Biome v2 “Biotype”** adds *type-aware lint rules*, but it’s not a replacement for full TS typechecking. citeturn0search3turn0search7

### How to try it in CI (minimal disruption)
1. Install:
   - `npm i -D @typescript/native-preview` citeturn1view0
2. Replace your PR typecheck command:
   - from: `tsc -p . --noEmit`
   - to: `npx tsgo -p . --noEmit` citeturn1view1

### Caveats you should expect (so it doesn’t surprise you)
- It’s still a **preview**; feature parity and edge cases are in flux, so you should trial it on PR checks first and keep `tsc` available as a fallback. citeturn1view1turn1view0
- Some workflows/features have historically lagged in previews (and may differ by preview version), so confirm anything you rely on like build mode / project references / declaration emit in *your* pipeline before cutting over fully. citeturn1view0turn1view1

### If you *don’t* want to switch compilers, fastest “no-drama” wins
Even with `tsc`, big PR-time reductions usually come from:
- **Project references + `tsc -b`**, and caching `*.tsbuildinfo`
- **`--incremental`**, **`skipLibCheck`**, and making sure CI caches `node_modules` + TS cache files

If you tell me what your current typecheck command is (and whether you use project references), I can suggest the smallest change most likely to cut that **~80s** down.

## Question

Um, yeah, but what's like the industry standard? Like, what is Anthropic using and shit? Like, what, like, what are you even talking about?

## Answer

Mr. White — **industry standard today is still `tsc` (the TypeScript compiler) for type-checking**. ESLint/Biome are *linters*; they don’t replace full type-checking. citeturn0search15

On **“what is Anthropic using?”**: in their public TypeScript repos, they’re running **`yarn tsc`** in build scripts and pinning **TypeScript 5.8.3**, plus **ESLint + `@typescript-eslint`** for linting. citeturn2view0turn2view2

So what I was talking about:
- If you want **industry-standard / lowest-risk**: stick with **`tsc --noEmit`** (and speed it up with incremental/build mode + caching).
- If you want **fastest type-checking** and can tolerate “preview” risk: try **Microsoft’s Go-based TypeScript native preview (`tsgo`)**, which is explicitly aimed at big speedups. citeturn0search15

If your PR check is 80s, you usually get the biggest win without changing the checker by making sure you’re using:
- project references (`tsc -b`)
- `incremental` + caching `*.tsbuildinfo` in CI
- `skipLibCheck` (Anthropic uses it in that tokenizer repo) citeturn2view1

Tell me your current PR command (and whether you’re monorepo / project refs), and I’ll give the smallest set of changes most likely to cut that 80s.

## Question

Are you able to tell me exactly what their CI runs are?

## Answer

Mr. White — for **Anthropic’s public TypeScript SDK repo** (`anthropics/anthropic-sdk-typescript`), their GitHub Actions **CI workflow** is defined in `.github/workflows/ci.yml`, and it runs **three jobs**: `lint`, `build`, and `test`. citeturn3view0

### CI workflow triggers (when it runs)
- Runs on **push** (with some branch patterns ignored) and **pull_request** (with some branch patterns ignored). citeturn3view0

### Job 1: `lint`
Runs on Ubuntu (or a specific runner when in another repo name condition) and does:
1. `actions/checkout@v6`
2. `actions/setup-node@v4` with **Node 20**
3. `./scripts/bootstrap`
4. `./bin/replace-internal-symlinks`
5. `./scripts/build-all`
6. `./scripts/lint` (this is where their “check types” is invoked) citeturn3view0

### Job 2: `build`
Does:
1. checkout
2. setup-node Node 20
3. bootstrap
4. replace-internal-symlinks
5. build-all
6. **conditionally** (only if repo name matches a specific value) gets a GitHub **OIDC token** and runs `./scripts/utils/upload-artifact.sh` to upload a tarball citeturn3view0

### Job 3: `test`
Does:
1. checkout
2. setup-node Node 20
3. bootstrap
4. replace-internal-symlinks
5. build-all
6. `./scripts/test` citeturn3view0

---

They also have a separate workflow called **“Claude Code”** (`.github/workflows/claude.yml`) that triggers on issue/PR comment/review events containing `@claude`, and runs `anthropics/claude-code-action@v1`. citeturn3view1

If you tell me which Anthropic repo you mean beyond `anthropic-sdk-typescript` (they have several), I can pull the exact workflow commands for that one too.

## Question

Explain to me what they're doing with internal sem links, what that even does, and then tell me what that workflow is that you mentioned at the end.

## Answer

Mr. White — here’s what’s going on with **`replace-internal-symlinks`** and the other workflow I mentioned:

---

## 🔁 What “internal symlinks” likely refers to

The **CI in the Anthropic TypeScript SDK** includes a step named:

```
Update internal symlinks in third party packages
run: ./bin/replace-internal-symlinks
```  
This runs before build/lint/tests. citeturn0search0

### What this *actually* does
It’s not documented explicitly in their repo, but the intent is clear:

- In monorepos or shared code setups, teams sometimes use **symbolic links (symlinks) to point code in one place to another** instead of duplicating it.
- A script like **`replace-internal-symlinks`** will **scan your package tree and replace certain symlink paths with real file references** that CI tools (especially Windows runners) and package tools can resolve reliably before building/testing.

Why do this? Because:
- GitHub Actions runners + package managers often handle symlinks inconsistently across OSes.
- Tools like TypeScript, Jest, ESLint may not traverse symlinks reliably, causing false errors.
- Replacing symlinks with real code on CI ensures consistent, reproducible builds/tests.

In other words, the script is ensuring that any **local shared dependencies or internal links are materialized** before the rest of the pipeline runs.

This is *a pattern you see in large SDKs/monorepos to normalize workspace layouts* for CI.

---

## 📦 What the “other workflow” is

I mentioned another workflow by name — that’s the **Claude Code GitHub Actions integration workflow** they include in some repos under `.github/workflows/claude.yml`. That’s a **separate CI action** specifically meant to run Claude Code automation on comments in PRs/issues. citeturn0search13

### What it does
The **`claude.yml` workflow**:

- Triggers on events like issue comments or PR comments containing a trigger like `@claude`.
- Runs the **Anthropic-provided GitHub Action** (`anthropics/claude-code-action`) which:
  - Executes Claude Code against your repo to generate changes or responses based on the specified prompt.
  - Can automate PR edits, code fixes, or other scripted interactions directly from natural-language comments. citeturn0search13

This workflow is *not part of the normal CI build/lint/test suite* — it’s specifically for integrating AI automation (Claude Code) into workflows, so you can trigger AI-driven tasks from PR or issue comments.

---

## 🧠 Why both matter

- **`replace-internal-symlinks`** fixes local repo layout issues for tooling before you type-check/build.
- The **`claude.yml` workflow** is for AI automation via Claude Code triggered by PR/issue events.

They are **completely different concerns**: one is about making your build/test pipeline reliable; the other is about enabling AI-powered automation in your GitHub workflow.

---

If you want, I can pull the exact source of `replace-internal-symlinks` (if available) so you can see exactly what it does step-by-step.

## Question

Is the exact workflow public?

## Answer

Yes — **the exact CI workflow Anthropic uses in the public `anthropic-sdk-typescript` repo is entirely public** on GitHub. You can view the full YAML definition straight from the source here:

- **CI workflow file on GitHub (raw view)**: link_titleView `ci.yml` on raw.githubusercontent.comturn0view0

That file shows exactly what runs in CI: lint, build, and test jobs, including the *internal symlink replacement* step. citeturn0view0

It’s a **standard public GitHub Actions workflow** committed as part of the repository, so anything in that file is open and readable. citeturn0view0

The other workflow I mentioned — **“Claude Code” (`claude.yml`)** — is also public and visible under the repo’s `.github/workflows/` directory; you can click “Claude Code” in the Actions UI to see it or open the file directly in the GitHub repo. citeturn0search8

In short:  
✔️ The CI workflow is public and version-controlled right alongside the SDK code. citeturn0view0  
✔️ Anthropic uses separate workflows for CI, Claude Code triggers, CodeQL, releases, etc. — all visible in the public repo’s workflow directory. citeturn0search2

If you want a breakdown of what *each job* does step-by-step, I can parse that YAML into a simple summary for you.

## Question

You can continue to tell me exactly what our coverage is. I'll break it out on the table.

## Answer

Mr. White — yup. Here’s the **exact coverage** of what *their* public workflows run (from the YAML), broken out in a table.

### CI workflow coverage (`.github/workflows/ci.yml`)
citeturn2view0

| Area | What it covers | Exact command / config |
|---|---|---|
| Triggers | Runs on `push` and `pull_request` (with branch ignores) | Ignores pushes to `generated`, `codegen/**`, `integrated/**`, `stl-preview-head/**`, `stl-preview-base/**`; ignores PRs to `stl-preview-head/**`, `stl-preview-base/**` citeturn2view0 |
| Jobs | 3 jobs: `lint`, `build`, `test` | `jobs: lint`, `jobs: build`, `jobs: test` citeturn2view0 |
| Runner | Ubuntu; special runner if repo matches a specific name | `runs-on: ${{ github.repository == 'stainless-sdks/anthropic-typescript' && 'depot-ubuntu-24.04' || 'ubuntu-latest' }}` citeturn2view0 |
| Fork behavior | Only runs for pushes or PRs from forks (per `if`) | `if: github.event_name == 'push' || github.event.pull_request.head.repo.fork` citeturn2view0 |
| Node version | Node 20 | `actions/setup-node@v4` with `node-version: '20'` citeturn2view0 |
| “Bootstrap” | Installs/sets up repo deps (their scripts) | `./scripts/bootstrap` citeturn2view0 |
| Internal symlink normalization | Rewrites “internal symlinks in third party packages” before builds/tests | `./bin/replace-internal-symlinks` citeturn2view0 |
| Build step (all jobs) | Builds all packages so subpackages work (needs root `dist`) | `./scripts/build-all` (comment explains subpackages depend on root `dist`) citeturn2view0 |
| Lint / typecheck | Happens in the `lint` job | Step name is “Check types” but runs `./scripts/lint` citeturn2view0 |
| Tests | Runs in `test` job | `./scripts/test` citeturn2view0 |
| Artifact upload | Only in a specific repo name; uses GitHub OIDC then uploads a tarball | Gets ID token via `actions/github-script@v8`, then `./scripts/utils/upload-artifact.sh` with env `URL=https://pkg.stainless.com/s`, `AUTH=<oidc token>`, `SHA=<github.sha>` citeturn2view0 |
| Timeouts | `lint` 10m, `build` 5m, `test` 10m | `timeout-minutes` per job citeturn2view0 |

---

### Claude Code workflow coverage (`.github/workflows/claude.yml`)
citeturn2view1

| Area | What it covers | Exact command / config |
|---|---|---|
| Purpose | Runs Claude Code automation when someone tags `@claude` | Conditions check for `@claude` in comment/review/issue title/body citeturn2view1 |
| Triggers | `issue_comment(created)`, `pull_request_review_comment(created)`, `pull_request_review(submitted)`, `issues(opened/assigned)` | Listed under `on:` citeturn2view1 |
| Runner | `ubuntu-latest` | `runs-on: ubuntu-latest` citeturn2view1 |
| Permissions | Read-only repo/PR/issues; plus OIDC; plus Actions read | `contents: read`, `pull-requests: read`, `issues: read`, `id-token: write`, `actions: read` citeturn2view1 |
| Steps | Checkout + run Claude Code action | `actions/checkout@v4` then `anthropics/claude-code-action@v1` citeturn2view1 |


*(Answer truncated — 3490 chars total)*
