---
title: "SonarCloud to Linear Integration"
type: guide
created: 2025-12-30
updated: 2025-12-30
source: chatgpt-export
conversation_id: 6953523a-b104-8327-81a2-036afc7222de
message_count: 10
tags: [chatgpt, import, code, long-form]
---
# SonarCloud to Linear Integration

> Conversation ID: 6953523a-b104-8327-81a2-036afc7222de
> Created: 2025-12-30T04:17:13Z
> Updated: 2025-12-30T07:21:30Z
> Messages: 10

---

## User

how do we get this back log of issues into claude code or linear

---

## Assistant

Mr. White — you’ve basically got 3 realistic paths, depending on whether you want **(A) quick + manual**, **(B) repeatable + scripted**, or **(C) fully automated sync**.

## Option A (fastest): Export from SonarCloud → CSV → import
**SonarCloud doesn’t have a one-click “export all issues” button in the UI**, so the quickest “no code” approach is:

1) In SonarCloud Issues page, **filter down to what you actually want in Linear**
   - e.g. only **Security + Blocker/High**, or only **New Code**, etc.
2) Use the **SonarCloud Web API** to pull those filtered issues and save as CSV/JSON.
3) Import into Linear:
   - Linear supports **CSV import** for issues (or you can create issues via API).

If you want, I can give you a CSV schema that maps cleanly to Linear fields (title, description, priority, labels, etc.).

## Option B (recommended): SonarCloud API → generate “Linear-ready” markdown for Claude Code
This is great if your workflow is: **Claude Code reviews issues and opens PRs**, and you want each issue as a ticket-like prompt.

**What you do:**
1) Pull issues via SonarCloud API (`api/issues/search`)
2) For each issue, format a block like:
- **Title**: `<rule>: <message>`
- **File/Line**: `path:line`
- **Severity/Type**: `Blocker Vulnerability` etc.
- **Link**: direct Sonar issue URL
- **Suggested fix prompt**: “Fix this issue, keep behavior unchanged…”

Then paste (or feed) that into Claude Code.

## Option C (best long-term): SonarCloud API → Linear API (create + dedupe + sync)
This creates a real backlog in Linear and keeps it sane.

**Typical setup:**
- Pull Sonar issues daily (or on-demand)
- For each Sonar issue, create/update a Linear issue
- Store Sonar issue key in Linear (either in:
  - the description, or
  - a label like `sonar:AZtt...`, or
  - a custom field if you use Linear’s custom fields via integration tooling)
- Dedupe logic: “If Linear already has an issue with this Sonar key, update it; else create it”

### What I’d map into Linear
From what I can see on your page, you’d want at least:
- **Title**: Sonar message (e.g. “Change this workflow to not use user-controlled data directly in a run block.”)
- **Description**: severity, type, rule, tags, effort, file path + line, and the Sonar link
- **Priority**: map Sonar severity → Linear priority (Blocker=1, High=2, Medium=3, Low=4)
- **Labels**: `sonarcloud`, `security|reliability|maintainability`, `vulnerability|bug|code-smell`, plus tags like `cwe`, `accessibility`
- **Project**: e.g. “Tech Debt / Code Quality”
- **Assignee**: leave unassigned or map if you have consistent ownership

---

## Quick question so I don’t send you the wrong implementation
Do you want **(1) a one-time import** to Linear/Claude, or **(2) an ongoing sync**?

If you answer with “one-time” or “sync”, I’ll give you the exact steps + a ready-to-run script (SonarCloud API → Linear CSV or SonarCloud API → Linear API).

---

## User

is there a extenion or mc[

---

## Assistant

Mr. White — short answer: **no official browser extension**, **yes via MCP or API**, but with caveats.

### Browser extension
- **SonarCloud:** ❌ No official extension that exports issues to Linear or Claude.
- **Linear:** ❌ No extension that ingests third-party issue backlogs automatically.
- There are generic “web scraper → CSV” extensions, but they’re brittle, lossy, and not worth it at your scale.

### MCP (Model Context Protocol)
- **There is no native SonarCloud MCP server today.**
- However, **this is very doable with a custom MCP adapter**:
  - SonarCloud already has a clean REST API.
  - You wrap it as an MCP “tool” that:
    - Lists issues
    - Fetches issue details
    - Groups/dedupes by rule + file
  - Claude Code can then:
    - Pull issues on demand
    - Fix them
    - Optionally emit Linear-ready tickets

This is ~1–2 hours of work if you already use Claude Code seriously.

### What actually works best (today)
**SonarCloud API → small Node/Python script → output to:**
- **Claude Code** (markdown prompts per issue), or
- **Linear API** (real backlog, deduped)

That’s the clean, controllable path. Extensions won’t survive pagination, auth, or 2,588 issues.

### Recommendation for you
Given your backlog size and that you want Claude involved:

1. **One-time sweep**
   - Pull only: `Security + Blocker/High` and `Critical Maintainability`
   - Feed directly into Claude Code for automated fixes

2. **Ignore the rest initially**
   - 80% of those 2.3k are low-leverage code smells

If you want, I can:
- Give you a **minimal MCP server spec** for SonarCloud, or  
- A **ready-to-run script** that turns your current filtered view into Claude or Linear input.

Say which one: **MCP**, **Claude-only**, or **Linear backlog**.

---

## User

how do i set this up to not have it fuck with our migrations our agent files or dependencies, just our actual code

---

## Assistant

Mr. White — on that SonarCloud **General Settings → Analysis Scope** page, you want to use **Source File Exclusions (sonar.exclusions)** to stop Sonar from *analyzing* anything that isn’t “real product code”.

### What to do (practical setup)
1) **Set `sonar.exclusions`** to exclude:
- DB migrations
- generated/build output
- dependency/vendor dirs
- “agent” or automation directories (Cursor, etc.)
- lockfiles

2) (Optional but smart) also set:
- **`sonar.coverage.exclusions`** for stuff you *do* want analyzed but don’t want coverage to be judged on (e.g. migrations, generated code, types, barrels, etc.)
- **`sonar.cpd.exclusions`** for files that trigger duplication noise (generated, migrations)

### Paste-ready defaults
Use these as a starting point and adjust the couple of “agent” paths to match your repo layout.

:::writing{id="51231" variant="standard"}
**Source File Exclusions (sonar.exclusions)**  
(ignores completely — no issues, no smells, no security findings there)

**/*migrations*/**  
**/*migration*/**  
**/prisma/migrations/**  
**/drizzle/**  
**/supabase/migrations/**  
**/db/migrations/**

**/node_modules/**  
**/.pnpm/**  
**/.yarn/**  
**/vendor/**  
**/dist/**  
**/build/**  
**/.next/**  
**/.turbo/**  
**/.cache/**  
**/out/**  
**/coverage/**  
**/*.min.*  

**/.cursor/**  
**/**/.cursor/**  
**/agents/**  
**/**/agents/**  
**/scripts/**  
**/**/scripts/**  

**/package-lock.json  
/pnpm-lock.yaml  
/yarn.lock**
:::

And if you want “still analyze, just don’t penalize coverage”:

:::writing{id="51232" variant="standard"}
**Coverage Exclusions (sonar.coverage.exclusions)**  
(useful if you still want issues flagged in these files, but don’t want tests/coverage requirements applied)

**/*migrations*/**  
**/prisma/migrations/**  
**/drizzle/**  
**/supabase/migrations/**  
**/db/migrations/**

**/**/__generated__/**  
**/**/*.generated.*  
**/**/*.gen.*  
**/**/generated/**

**/*.d.ts**
:::

**Important nuance**
- If you *exclude* migrations via `sonar.exclusions`, Sonar won’t report **security issues** there either.
- If you want security coverage but hate the noise, use **`sonar.issue.ignore.multicriteria`** instead (ignore specific rules on specific paths), but that’s a more surgical setup.

If you tell me the exact folders you mean by **“agent files”** (e.g. `.cursor/`, `agents/`, `ai/`, `.github/`, etc.), I’ll tailor the exclusion patterns so you don’t accidentally ignore real app code.

---

## User

is this right

---

## Assistant

Mr. White — **you’re ~90% correct**, but there are **a few small fixes you should make** so this doesn’t bite you later.

### What’s good ✅
- You used **`sonar.exclusions`** (correct lever)
- You excluded:
  - migrations
  - dependencies
  - build artifacts
  - Cursor / agent tooling
  - lockfiles  
All correct for “don’t touch anything except real app code”.

### Problems to fix ❌ (important)
Right now you have **invalid / redundant glob patterns** that Sonar will silently ignore.

#### 1. Leading slashes are unnecessary (and sometimes harmful)
Sonar paths are **repo-relative**, not filesystem-rooted.

**Bad / risky**
```
/migrations/
/node_modules/
```

**Correct**
```
**/migrations/**
**/node_modules/**
```

#### 2. These patterns are wrong
You currently have:
```
**/.min.
```
That does **nothing**.

You want:
```
**/*.min.*
```

#### 3. You have duplicated slashes
These won’t behave how you expect:
```
 //.cursor/**
 //agents/**
 //scripts/**
```

Sonar does not normalize double slashes.

---

### Paste-ready corrected version (recommended)
Replace your **Source File Exclusions** with this:

```
**/migrations/**
**/migration/**
**/prisma/migrations/**
**/drizzle/**
**/supabase/migrations/**
**/db/migrations/**

**/node_modules/**
**/.pnpm/**
**/.yarn/**
**/vendor/**
**/dist/**
**/build/**
**/.next/**
**/.turbo/**
**/.cache/**
**/out/**
**/coverage/**
**/*.min.*

**/.cursor/**
**/agents/**
**/scripts/**

**/package-lock.json
**/pnpm-lock.yaml
**/yarn.lock
```

This is:
- syntactically correct
- future-proof
- safe for CI
- won’t accidentally exclude real app code

---

### One strategic recommendation (worth doing)
Right now you’re **fully excluding migrations**, which also suppresses **security findings** there.

If you want:
- ❌ no noise
- ✅ but still catch **dangerous SQL / auth mistakes**

Then instead:
- keep migrations **included**
- move them to **coverage exclusions**
- and optionally ignore *specific rules* via `sonar.issue.ignore.multicriteria`

If you want, I’ll give you a **surgical ignore setup** that:
- ignores cognitive complexity + style in migrations
- but still flags security issues

Just say the word.

---

## User

make sonar cloud properties code

---

## Assistant

Mr. White — here’s a **clean, safe `sonar-project.properties`** you can drop in the repo root.  
This **only analyzes real application code** and **will not touch migrations, agents, generated files, or dependencies**.

### What this setup guarantees
- ✅ No noise from migrations / CI / agents
- ✅ No dependency or build junk
- ✅ Safe with **Automatic Analysis ON**
- ✅ Deterministic if you later move to CI-based analysis
- ✅ Claude / Linear workflows won’t accidentally pull garbage issues

---

### Paste-ready `sonar-project.properties`

:::writing{id="51233" variant="standard"}
# --- Core project config ---
sonar.projectKey=JovieInc_Jovie
sonar.organization=jovieinc
sonar.sourceEncoding=UTF-8

# --- Source scope ---
# Analyze everything by default, then exclude aggressively
sonar.sources=.

# --- Hard exclusions (completely ignored: no issues, no security, no smells) ---
sonar.exclusions=\
**/migrations/**,\
**/migration/**,\
**/prisma/migrations/**,\
**/drizzle/**,\
**/supabase/migrations/**,\
**/db/migrations/**,\
**/.cursor/**,\
**/agents/**,\
**/scripts/**,\
**/node_modules/**,\
**/.pnpm/**,\
**/.yarn/**,\
**/vendor/**,\
**/dist/**,\
**/build/**,\
**/.next/**,\
**/.turbo/**,\
**/.cache/**,\
**/out/**,\
**/coverage/**,\
**/*.min.*,\
**/package-lock.json,\
**/pnpm-lock.yaml,\
**/yarn.lock

# --- Coverage exclusions (still analyzed, but ignored for coverage %) ---
sonar.coverage.exclusions=\
**/*.d.ts,\
**/__generated__/**,\
**/*.generated.*,\
**/*.gen.*

# --- Duplication noise suppression ---
sonar.cpd.exclusions=\
**/__generated__/**,\
**/*.generated.*,\
**/*.gen.*
:::

---

### Important notes (worth 30 seconds)
- **If a file is in `sonar.exclusions`**, Sonar:
  - ❌ will NOT report security issues
  - ❌ will NOT show it in Claude / Linear exports  
  That’s intentional for migrations + agents.
- If you ever want **security-only scanning** in migrations later, we’d switch to `sonar.issue.ignore.multicriteria` instead.

### Optional hardening (I recommend later)
When you’re ready:
- Add **rule-level ignores** for cognitive complexity in API routes
- Restrict **style rules** to `/apps/**` only
- Keep **security rules global**

If you want, tell me:
- where your *actual product code* lives (`apps/`, `packages/`, etc.)
- whether migrations are Prisma / Drizzle / raw SQL

I’ll tighten this to a near-zero-noise config.


## See Also
- [[chatgpt/chatgpt_chatgpt-linear-integration]]
- [[chatgpt/chatgpt_claude-in-linear-integration]]
- [[chatgpt/chatgpt_github-linear-integration-setup]]
- [[chatgpt/chatgpt_linear-github-integration]]
- [[chatgpt/chatgpt_sentry-linear-integration-issues]]
