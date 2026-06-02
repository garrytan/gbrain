---
title: "Validation of System Prompts"
type: guide
created: 2026-04-21
updated: 2026-04-21
source: chatgpt-export
topic: coding-ai
message_count: 7
tags: [chatgpt, knowledge, coding-ai]
---
# Validation of System Prompts

> **Source:** ChatGPT conversation
> **Date:** 2026-04-21T19:53:25Z
> **Messages:** 7
> **Topic:** coding-ai

## Question

is this real https://github.com/elder-plinius can you validate at least 2 system prompts in here and tell me if theyre actually from the companies own prompt files or if these are made up by a third party

## Answer

I’ll inspect the GitHub account, pick at least two claimed system prompts, and trace their provenance against official company sources, commit history, extraction notes, and independent corroboration.

## Answer

The repository itself is real, but its own README frames it as a collection of extracted or reverse-engineered prompts rather than an official company archive. I already have one strong official match to test against: OpenAI’s published Codex system message overlaps with the version in the repo, while other entries appear more like dumps or reconstructions than company prompt files.

## Answer

Mr. White, **yes, the GitHub repo is real, but it is a third-party archive, not an official company source.** Its own README describes the collection as “extracted” prompts from many AI systems and invites people to contribute prompts they “leak, extract, or reverse-engineer,” which means provenance varies by file. citeturn824063view0

### Validation of 2 prompts

| Prompt in `elder-plinius/CL4R1T4S` | Verdict | Why |
|---|---:|---|
| **OPENAI / `Codex.md`** | **Partially official / company-source-backed** | The main Codex system-message sections match the Codex system message OpenAI published in its own Codex launch appendix. OpenAI explicitly says it is sharing the `codex-1` system message, and the same “Instructions,” Git, AGENTS.md, and citation sections appear there. citeturn888186view0turn421913view0 |
| **CLINE / `Cline.md`** | **Source-derived / likely real snapshot, not a clean official prompt file** | Cline’s official GitHub repo contains the prompt-building source. The Elder file starts with “You are Cline…” and tool-use instructions; the official Cline repo has the same agent-role text in `agent_role.ts`, and its prompt architecture assembles the final prompt from components/templates/tools. citeturn547954view0turn992395view1turn453526view0 |

### Important nuance

**OpenAI Codex:** The Elder file is **not a pure copy of only OpenAI’s published system message**. The official OpenAI appendix ends after the Codex system-message content, while the Elder file also includes a tool namespace block, a developer prompt, and a user prompt from a specific extraction session. Those extra parts are not shown in OpenAI’s official appendix. citeturn888186view0turn421913view0

**Cline:** The Elder Cline file is **not simply “the company’s prompt file” copied verbatim**. Cline’s official repo shows a modular prompt system with components like agent role, tool use, MCP, rules, system info, objective, and user instructions; the final prompt is assembled dynamically. The Elder file looks like a flattened runtime snapshot, including a specific local working directory path, which makes it session-specific. citeturn453526view0turn204777view0turn204777view1turn547954view0

### Bottom line

Treat `elder-plinius/CL4R1T4S` as a **mixed-provenance prompt archive**:

Some entries are backed by official company-controlled sources, like **OpenAI Codex’s published system message**.

Some entries are derived from open-source product code, like **Cline**, but may be flattened runtime snapshots.

Closed-source prompts in the repo, such as many ChatGPT, Claude, Gemini, Cursor, Grok, Perplexity, Devin, or Replit entries, should be treated as **unverified third-party extractions** unless the file links to a first-party source or can be matched to company-owned code/docs.

## Question

go thorugh our own agents.md file and other prompt files and see if there is anything we can improve based on the source repo i shared and anuything they do that is great. particulary look at antrhopic, open ai, and google

## Answer

I’ll inspect any accessible `AGENTS.md` and prompt files, compare them against Anthropic, OpenAI, and Google patterns from the shared archive, then return concrete edits, gaps, and a fallback checklist if your repo isn’t accessible.

## Answer

Mr. White, I inspected the public `JovieInc/Jovie` repo, including `AGENTS.md`, `CLAUDE.md`, `CODEX.md`, `.claude`, `.cursor`, `.windsurf`, `.agents/skills/gstack`, and `prompts`. Main conclusion: **your agent setup is already strong, but it has one urgent security issue and several prompt-authority/staleness problems.**

## 0. Urgent security issue

A tracked public file, `.claude/settings.local.json.backup`, appears to contain database connection strings / credentials. Your `.claude/README.md` says `settings.local.json` is for personal overrides and should be gitignored, but both `.claude/settings.local.json` and `.claude/settings.local.json.backup` are present in the public tree; `.gitignore` currently does not ignore those exact paths. citeturn879597view1turn879597view2turn532071view1turn532071view0

Recommended immediate action:

1. Rotate every credential exposed in `.claude/settings.local.json.backup`, especially database credentials.
2. Remove `.claude/settings.local.json` and `.claude/settings.local.json.backup` from the repo.
3. Add this to `.gitignore`:

```gitignore
.claude/settings.local.json
.claude/settings.local.json.*
```

4. Check GitHub Secret Scanning alerts and provider audit logs.
5. Decide whether to rewrite git history. GitHub’s own guidance says leaked secrets should be treated as compromised and revoked; simply deleting the file or pushing a new commit does not prevent exploitation. citeturn234050view1

GitHub’s docs also say secret scanning scans full git history and that high-risk/public/active secrets should be revoked immediately; history rewriting is possible with `git-filter-repo`, but it has operational side effects and requires coordination. citeturn234050view0turn234050view2

## 1. Biggest prompt-system improvement: shrink and split `AGENTS.md`

Your root `AGENTS.md` is around **89.4 KB / 1,740 lines**. OpenAI’s Codex docs say project instruction files are read into an instruction chain, but the default project-doc cap is **32 KiB**, with closer nested `AGENTS.md` files overriding broader ones. That means Codex-like agents may silently miss or truncate a large portion of your canonical instructions unless you raise the cap or split the file. citeturn393355view1turn656397view0

Recommended structure:

```text
AGENTS.md                         # <= 25–30 KB, canonical invariants only
CLAUDE.md                         # Claude shim: shortcuts + points to AGENTS.md
CODEX.md                          # Codex shim: points to AGENTS.md
docs/agents/environment.md         # Node/pnpm/Doppler/local setup
docs/agents/design.md              # UI/design rules
docs/agents/auth-e2e.md            # Clerk auth, E2E bypass, cookies
docs/agents/db-migrations.md       # Neon/Drizzle/migration safety
docs/agents/release.md             # PR, bot review, ship flow
apps/web/AGENTS.md                 # Next.js app-specific rules
apps/web/tests/AGENTS.md           # Playwright/Vitest/E2E rules
```

This matches OpenAI’s r

*(Answer truncated — 10765 chars total)*
