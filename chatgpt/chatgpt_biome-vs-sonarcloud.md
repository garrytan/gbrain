---
title: "Biome vs SonarCloud"
type: guide
created: 2025-12-31
updated: 2025-12-31
source: chatgpt-export
conversation_id: 69555e6d-0c64-832e-9f52-19fb098e87f2
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Biome vs SonarCloud

> Conversation ID: 69555e6d-0c64-832e-9f52-19fb098e87f2
> Created: 2025-12-31T17:34:36Z
> Updated: 2025-12-31T19:34:58Z
> Messages: 6

---

## User

We have biome and it's so fast.
We also have sonar cloud
We have playwright for e2e.
And we have storybook and could add the vitest for a11y and other stuff.

Are there things that sonar catches that we could add to biome for speed?
Biome works well in all environments with little setup and is so fast that id love to expand its coverage.

thoughts?

---

## Assistant

Mr. White — yup, there’s overlap, but also a hard boundary: **Biome can only be as “smart” as what it can see locally in code**. SonarCloud catches a bunch of things that come from **semantic analysis + cross-file reasoning + security rulepacks + historical/project context**. That said, you *can* pull a meaningful slice of Sonar’s value “left” into Biome-land (fast, local) by pairing Biome with a couple other **fast** local analyzers.

## What SonarCloud catches that Biome generally won’t (today)
Think of these as “not just formatting/linting”:

### 1) Security-focused static analysis (SAST)
- Injection patterns, SSRF-like flows, weak crypto, risky deserialization, hardcoded secrets patterns, insecure random, etc.
- Taint-style reasoning (data from request → dangerous sink) is the big one.

**Biome:** doesn’t try to be a SAST engine.

### 2) Deeper semantic / cross-file correctness
- Subtle null/undefined paths, unreachable states, mistaken assumptions across modules, etc.
- Some of this overlaps with TypeScript, but Sonar rules can be more opinionated about code health.

**Biome:** some semantic lint, but it’s not trying to compete with TS type-checker or Sonar’s rule suite.

### 3) Code-smell / maintainability rules with heuristics
- Complexity thresholds, duplication detection, “this pattern is probably wrong”, etc.
- “Cognitive complexity”, duplication, overly complex conditions, etc.

**Biome:** will catch certain complexity-ish patterns, but not full Sonar-style maintainability analytics.

### 4) Coverage/quality gate aggregation
- Coverage %, new code gate, PR decoration, trend metrics.

**Biome:** local tool; not a quality gate platform.

## What you *can* shift into fast local checks (Biome-first philosophy)
If your goal is “make CI and local dev fast, minimize setup”, the best approach is:

### A) Let Biome own: format + lint + import hygiene
This is already its sweet spot. Make sure you’re using:
- `biome check` in CI on changed files / staged files
- `biome lint --write` (where safe)
- import sorting / unused imports rules (if enabled in your config)

### B) Add TypeScript compiler as the “semantic engine” (still fast)
A huge chunk of Sonar’s “bug” value is actually just **type errors and strictness**.
- Turn on stricter TS flags (`strict`, `noUncheckedIndexedAccess`, etc.) where feasible.
- Run `tsc --noEmit` (or per-package) in CI.

This is usually the biggest ROI move to “replace Sonar bug rules locally”.

### C) Add **targeted** fast security checks (don’t try to clone Sonar)
For JS/TS, the pragmatic combo is:
- **eslint-plugin-security** / or similar lightweight ruleset (if you still run eslint anywhere)
- **semgrep** for high-signal security patterns (can be pretty fast when scoped to diff)
- dependency scanning (GitHub dependabot/Snyk/etc.) for vuln DB stuff (Sonar doesn’t replace this anyway)

If you want “Biome-like simplicity”, Semgrep on changed files is often the closest vibe.

### D) Add duplication/complexity where it matters
Sonar’s duplication and complexity gates are hard to reproduce purely with Biome. If you care:
- keep Sonar’s maintainability gates
- or add a small dedicated tool for complexity thresholds (often language-specific)

## Direct answer to your question
> “Are there things Sonar catches that we could add to Biome for speed?”

**Some, but not by “porting Sonar rules into Biome”** (Biome won’t become a SAST platform overnight). The *effective* replacement strategy is:

1) **Biome** for style + lint
2) **tsc (strict)** for a big portion of correctness
3) **Vitest a11y** + **Playwright a11y** for runtime accessibility regressions (great complement)
4) optionally **Semgrep** (diff-scoped) for the security slice Sonar is best at

That gets you “fast by default” while keeping Sonar for the stuff that’s inherently centralized/heuristic.

## A practical “speed-max” pipeline suggestion
- **pre-commit / pre-push:** `biome check --staged` (or on changed paths)
- **PR CI:** `biome check` + `tsc --noEmit` (and unit tests)
- **nightly / main branch:** SonarCloud full analysis + duplication + quality gates
- **a11y:** Vitest/Storybook checks on PR; Playwright a11y smoke on PR or nightly depending on runtime cost

## If you paste your current `biome.json`
…I can point out concrete rule gaps (e.g., unused imports, suspicious comparisons, unsafe optional chaining patterns) and suggest the smallest set of extra tools to cover the “Sonar-only” categories without slowing you down.

---

## User

What about post-tool hook in windsurf

---

## Assistant

Mr. White — Windsurf *does* have the equivalent of a “post-tool hook”: **Cascade Hooks** let you run a shell command **after** specific agent actions (tools) like writing code or running a command. citeturn1view0

### The key “post-*” events you’ll care about
From the Hooks docs, you can hook **after** these actions (examples shown in the docs):  
- **`post_write_code`** → fires after Cascade modifies/writes code (perfect place to run Biome) citeturn1view0  
- **`post_read_code`** → after reading code (mostly for logging/auditing) citeturn1view0  
- **`post_cascade_response`** → after the full response/turn (good for logging, less for “fix files now”) citeturn1view0  

Also: **pre-hooks can block** an action (exit code `2`), but post-hooks are for “do something after.” citeturn1view0

### Where to put it
Hooks can be configured at:
- **Workspace**: `.windsurf/hooks.json` (best for team-enforced repo behavior) citeturn1view0  
- **User**: `~/.codeium/windsurf/hooks.json` (best for your personal setup) citeturn1view0  

### Concrete use case: run Biome after Cascade edits
Drop a workspace hook so every Cascade write triggers a fast check/format:

```json
{
  "hooks": {
    "post_write_code": [
      {
        "command": "bash .windsurf/scripts/post_write_biome.sh",
        "show_output": true
      }
    ]
  }
}
```

Then in `.windsurf/scripts/post_write_biome.sh`, you typically:
- read stdin JSON (it includes event + `tool_info`) citeturn1view0  
- run something like `biome check --write` scoped to the touched file(s) (if you extract them), or fall back to repo-wide on small repos.

Windsurf’s docs explicitly call out “running code formatters after edits” as a first-class use case for `post_write_code`. citeturn1view0

### One gotcha (important)
A post-hook **can’t stop** the write that already happened. If you want “don’t allow Cascade to do X”, that’s a **pre-** hook (exit code `2`). citeturn1view0

If you tell me whether you want **format-only**, **lint-only**, or **lint+tests**, I’ll sketch the tightest post-write hook pattern (including diff-scoping so it stays fast).

---

## User

Recommend a set of pre and post hooks for facade that a yc startup should have 

---

## Assistant

Mr. White — assuming you mean **Windsurf Cascade** (sometimes people say “facade” loosely), here’s a **high-signal, YC-style** hook set: minimal friction, strong guardrails, and fast feedback.

All of these are first-class hook events in Windsurf: `pre_*` hooks can **block** by exiting `2`; `post_*` hooks can’t block. citeturn1view0

## Team (workspace) hooks every YC startup should ship
Put these in `.windsurf/hooks.json` so they’re versioned and consistent. citeturn1view0

### 1) `pre_run_command` — block obviously dangerous shell commands
**Goal:** prevent “rm -rf”, credential exfil, curl|bash, messing with ~/.ssh, etc.  
**Why:** highest downside, lowest cost.

Block patterns like:
- `rm -rf /`, `sudo rm`, `chmod -R 777`, `mkfs`, `dd if=`
- `curl … | bash`, `wget … | sh`
- reading `~/.ssh`, `~/.aws`, `.env*` then piping output somewhere

This hook is explicitly designed to block commands. citeturn1view0

### 2) `pre_read_code` — denylist sensitive paths
**Goal:** stop the agent from reading secrets-by-default locations.  
Block reads of:
- `.env`, `.env.*`, `**/secrets/**`, `**/*key*`, `**/*pem*`
- `~/.ssh/**`, `~/.aws/**`, `~/.gnupg/**` (if those appear in a workspace via symlinks)
- `terraform.tfstate`, `*.p12`, production config dumps

Windsurf calls out restricting file access as a primary use case. citeturn1view0

### 3) `pre_write_code` — protect “blast radius” files
**Goal:** prevent accidental edits to files that can break prod/security quickly.
Common protected files:
- CI/CD: `.github/workflows/**`
- auth/permissions: `infra/**`, `terraform/**`, `k8s/**`
- dependency lockfiles (optionally): `pnpm-lock.yaml`, `package-lock.json`
- security policy: `SECURITY.md`, `.npmrc`, `.yarnrc`, `.gitconfig` (if present)

`pre_write_code` exists specifically for blocking/protecting files. citeturn1view0

### 4) `post_write_code` — run Biome (fast) on touched file(s)
**Goal:** guarantee formatting/lint baseline after any agent edit.
- Run `biome check --write` scoped to the changed file if you parse `tool_info.file_path`
- If parsing is annoying, run on the package directory (still usually fast)

This is a documented use case: “Run linters/formatters after edits.” citeturn1view0

### 5) `post_write_code` (optional second step) — run fast “sanity” tests on touched area
**Goal:** catch obvious breakage immediately, but keep it cheap.
Examples:
- If file is in `/packages/ui/**` → `vitest -r` or `pnpm test --filter ui`
- If playwright test files changed → run only a small smoke tag
Keep it *small*, because slow hooks hurt responsiveness. citeturn1view0

## Personal (user-level) hooks worth having
Put these in `~/.codeium/windsurf/hooks.json` so each dev can opt in. citeturn1view0

### 6) `post_run_command` — log failures + auto-open last error context
**Goal:** when a command fails, surface the relevant log tail or annotate the response (dev UX).

### 7) `post_cascade_response` — lightweight telemetry / audit log
**Goal:** keep an internal record of what the agent changed/ran (helps debugging + compliance).  
Windsurf explicitly supports logging responses and actions this way. citeturn1view0

### 8) `pre_user_prompt` — block high-risk prompts (optional but useful)
**Goal:** prevent “dump all env vars”, “show secrets”, “run destructive ops” style prompts.  
This hook can block prompts via exit code `2`. citeturn1view0

## Recommended “starter” `.windsurf/hooks.json` structure
- Workspace: guardrails + Biome
- User/system: logging/telemetry

Windsurf merges system → user → workspace, and all run in order. citeturn1view0

---

If you tell me your stack (monorepo? pnpm? turborepo? next? backend language?) I’ll tailor the exact command set and the “protected paths” list so you don’t block legitimate workflows while still preventing catastrophic mistakes.


## See Also
- [[chatgpt/chatgpt_ai-first-companies-biome-usage]]
- [[chatgpt/chatgpt_ally-biome]]
- [[chatgpt/chatgpt_biome-react-hooks-linter]]
- [[chatgpt/chatgpt_biome-vs-eslint-nextjs]]
- [[chatgpt/chatgpt_enforcing-biome-rules]]
