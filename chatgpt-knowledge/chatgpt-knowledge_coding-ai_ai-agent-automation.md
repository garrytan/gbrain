---
title: "AI Agent Automation"
type: guide
created: 2026-04-18
updated: 2026-04-18
source: chatgpt-export
topic: coding-ai
message_count: 6
tags: [chatgpt, knowledge, coding-ai]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-ai]]

# AI Agent Automation

> **Source:** ChatGPT conversation
> **Date:** 2026-04-18T17:29:18Z
> **Messages:** 6
> **Topic:** coding-ai

## Question

Yo, diggity dog. I just installed Aramie's agent on my PC, and the, I guess, most immediate thing I'd like to do with it, I'm running QN 3.5 or whatever, local model, and I guess, basically, here's the deal, is like, I have $200 a month subscriptions to Codex and to Claude, and I have a couple other paid accounts for various AI tools, $20, $40 a month. So we're spending a decent amount of money on AI shit. What I'm looking for right now is the ability for me to, I basically want to take, you know, I wanna take this startup, right? What am I trying to say? Okay, so I'm currently coding in Gstack, and I guess the first immediate, you know, using Gstack with, dude, go. Oh my God. Or drive. I'm currently using Gstack. conductor to orchestrate a bunch of coding agents in parallel with org trees. And so, I guess what I'm looking to do with Air Musician is basically run a couple things. So one is I'd like to run an agent that, and this is why I'm doing it, kind of like trying to do a model th

## Answer

Mr. White, I’m treating “Aramie / Air Musician / Emmy’s agent” as **Nous Hermes Agent**, and “Quinn” as **Qwen / Qwen3-Coder**.

## The setup I’d build

Use **Hermes as an agent worker**, and build a small **Jovie agent control plane** around it. The control plane receives GitHub webhooks, CI health events, cron jobs, and business-data jobs; it creates deterministic tasks; Hermes, Claude Code, Codex, or local Qwen execute those tasks inside isolated git worktrees.

Hermes already has the pieces for this: terminal backends across local, Docker, SSH, Modal, Daytona, and Singularity; cron jobs that can run recurring tasks with attached skills; isolated subagents with their own terminal sessions; and a skills system stored under `~/.hermes/skills/`. citeturn853899view0turn853899view1turn127051view0turn853899view3

The shape should be:

```txt
GitHub / CI / Sentry / cron / bank / analytics / Gmail / Calendar
                 |
                 v
        jovie-agent-control-plane
        - webhook receiver
        - queue
        - state database
        - policy router
        - audit log
                 |
                 v
        jovie-agent-worker(s)
        - creates git worktree
        - chooses model/tool
        - runs tests
        - commits/pushes branch
        - comments on PR
        - cleans up worktree
```

## Where it should live

Put it in a **separate private ops repo**, not inside the normal app repo.

Recommended layout on the PC, ideally inside WSL2 Ubuntu:

```txt
~/jovie-agent/
  ops/                         # private repo: jovie-agent-ops
    orchestrator/              # webhook receiver, queue worker, job router
    prompts/                   # durable task prompts
    policies/                  # model-routing and safety rules
    skills/                    # custom Hermes/Claude/Codex skills
    scripts/                   # worktree, git, CI, GitHub helpers
  repos/
    jovie.git                  # bare/mirror clone of product repo
    ops.git
  worktrees/
    pr-123-remediate/
    main-red-2026-04-18/
    qa-staging-2026-04-18-0900/
  state/
    agent.sqlite               # tasks, attempts, comment IDs, decisions
  logs/
  artifacts/
    screenshots/
    traces/
    patches/
```

Keep the app repo clean. The app repo should only contain project instructions such as `AGENTS.md`, `CLAUDE.md`, `.gstack`, GitHub workflows, and maybe bot labels/config. Hermes memory and agent state belong outside the product repo.

## PC reality check: Qwen on a 2080 Ti

Your 2018 PC with 64 GB RAM and a 2080 Ti can be useful, but it should be treated as a **cheap triage and first-pass worker**, not the only brain for high-risk code changes.

Qwen3-Coder-30B-A3B-Instruct is designed for agentic coding, browser-use, repository-scale context, and has 30.5B total parameters with 3.3B active parameters and 262K native context according to the model card. citeturn853899view4 Your 2080 Ti likely has 11 GB VRAM, so larger Qwen variants will 

*(Answer truncated — 19927 chars total)*

## Question

Okay, and then we have GitHub Actions already doing some of this stuff, and we have a Joby GitHub bot. Now GitHub Actions is gonna be... Currently, our repo on there is public, so our runs are free. So, you know, for something like the nightly QA run, if you're telling me that, you know, we should use Claude for that, then I don't know if it's saving us any money or just not just run it on GitHub for now until we make our repo private. But, or is it a thing that we could run with one? I guess that's my question, is like, is Quinn good enough for any of these, like, coding tasks or remediation tasks? Or do we need to have Claude code or codex using it? And if that is the point, then is there any benefit to me even doing this versus just using the cloud desktop app, which already has built-in cron jobs and stuff like that? I guess the main question is just like, cost. Although, if we can use the local model to do the orchestration, I guess it would more efficiently use our Claude Mac sub

## Answer

Mr. White, the practical answer is:

**Use GitHub Actions + Claude/Codex for serious coding automation. Use Qwen/local models for routing, triage, summaries, cheap first-pass fixes, and business ops. Do not bet the core coding loop on local Qwen yet.**

Your local setup is still useful, but mostly as a **cost-control and orchestration layer**, not as a replacement for Claude/Codex.

## 1. Public GitHub repo changes the cost math

Since your repo is public, GitHub-hosted Actions minutes are already free for standard GitHub-hosted runners. GitHub’s docs say Actions usage is free for public repositories and self-hosted runners; private repos get free quotas and then paid overage. citeturn511137view4

So for things like:

```txt
- nightly test matrix
- Playwright / E2E
- lint/typecheck
- build validation
- main-health check
- scheduled QA scaffolding
```

there is little reason to move the runner workload onto your PC right now. You save almost no runner money, and you add reliability/security complexity.

The main cost lever is **model usage**, not compute.

## 2. Is Qwen good enough for coding remediation?

**Yes, for narrow tasks. No, for the important autonomous coding tasks you described.**

Qwen3-Coder-30B-A3B is a real coding model: the model card says it has 30.5B total parameters, 3.3B activated parameters, native 262K context, and is built for agentic coding/browser-use/repository understanding. citeturn945937view0 The larger Qwen3-Coder-480B model claims performance comparable to Claude Sonnet among open models, but that is not what you are running locally on a 2080 Ti. citeturn945937view2

Your PC can run useful local Qwen, but your 2080 Ti is the limiter. With 11 GB-ish VRAM, local Qwen will usually be quantized, context-limited, and slower than hosted frontier coding agents. It is good for:

```txt
Good Qwen tasks:
- classify PR comments
- summarize failed CI logs
- decide whether a review comment is actionable
- detect duplicate CodeRabbit/Greptile comments
- propose simple lint/type/typecheck fixes
- update snapshots
- fix obvious import/path errors
- write PR summaries
- generate branch names / issue labels
- score investors
- dedupe CRM rows
- summarize Gmail/calendar context
```

It is weak/risky for:

```txt
Do not rely on local Qwen alone:
- auth changes
- payments/billing
- DB migrations
- security/permissions
- multi-file app logic
- complex merge conflicts
- production main-red fixes
- flaky E2E debugging
- GStack /qa browser repair loops
- anything where a wrong patch wastes an hour of your time
```

The correct use is **Qwen as the cheap bouncer at the door**, then Claude/Codex for the real surgery.

## 3. Is there any benefit versus Claude Desktop / Claude Code scheduled tasks?

Yes, but only if you need **workflow-level orchestration**.

Claude Code already has scheduled tasks. Its docs say scheduled tasks can poll deployments, babysit PRs, check long-running builds, and run on intervals; desktop tasks run on your

*(Answer truncated — 16152 chars total)*

## Question

Is there existing software or skills for fundraising that are great? Or better to build myself.

Best CRM? Could be an air table could be a spreadsheet could be notion or obsidian or something like that or I could just live in the ops repo.

Give me the highest leverage things to setup with your recommend split as bullet points in a single list


## Answer

Mr. White, use **existing tools for CRM/outbound/enrichment**, and build the **agent workflow glue yourself**.

My recommendation: **Airtable as the fundraising CRM source of truth**, **ops repo for automation code/prompts/skills**, **Clay for enrichment later**, **Instantly/Gmail for outbound**, and **Claude/Qwen/OpenRouter for agent work**. Airtable is the best balance of speed, API access, human-editable views, relational data, and low ceremony; Airtable even has a free fundraising CRM template, and its newer AI app builder can generate app structure from natural language. citeturn434671search12turn434671search0

- **Set up Airtable as the investor CRM, not Notion/Obsidian/spreadsheet.** Use tables for `Investors`, `Firms`, `Relationships`, `Touches`, `Meetings`, `Intros`, `Updates`, and `Tasks`. Airtable gives you the human UI, filters, Kanban stages, forms, and API; your ops repo gives you versioned automation code. Spreadsheet is too brittle, Notion is fine for docs but weaker as an automation-heavy CRM, Obsidian is for personal notes, and living only in the ops repo gives you bad visibility.

- **Use the ops repo as the fundraise automation brain.** Store schemas, prompts, scoring rubrics, scripts, skills, Airtable sync code, Gmail/Calendar importers, investor enrichment jobs, and daily report generation there. Do not make the ops repo the primary CRM UI.

- **Add Foundersuite only if you want a purpose-built fundraising product immediately.** Foundersuite is built specifically around investor CRM, investor database, pipeline management, outreach, updates, and investor relations. It is the most “just use a fundraising tool” option. citeturn211722search1turn211722search20 My read: useful if you want less DIY; less ideal if you want agents/custom workflows tightly integrated with your codebase, Gmail, Calendar, metrics, and Jovie ops.

- **Use Visible if investor updates/data room become the center of gravity.** Visible is strong for investor updates, pitch deck/data room sharing, and monitoring a fundraise process. citeturn211722search2turn211722search10 I would use it for polished investor updates, not as the main automation CRM unless you like its workflow better than Airtable.

- **Use Attio if you want one modern CRM for fundraising + customers + partnerships.** Attio is a flexible CRM with custom objects, workflows, deals, reports, and email/calendar sync; its help docs say email/calendar sync imports past and future emails/events and keeps new ones synced. citeturn434671search1turn434671search5 Attio is probably the best “real CRM” choice if you expect this to become a sales/customer CRM too. Airtable is faster and more hackable for v1.

- **Do not use Affinity unless relationship intelligence is worth enterprise-style complexity/cost.** Affinity is excellent for relationship intelligence, intro paths, automated activity capture, and private-capital workflows. citeturn211722search3turn211722search7 It is aimed more

*(Answer truncated — 9894 chars total)*
