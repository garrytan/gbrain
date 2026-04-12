---
type: essay
title: "Thin Harness, Fat Skills"
subtitle: "How to Make AI Agents Actually Understand Your Data"
author: Garry Tan
created: 2026-04-09
updated: 2026-04-11
tags: [ai, agents, gstack, harness-engineering, skills, architecture]
status: draft-v4
talk: "YC Spring 2026 -- Thin Harness, Fat Skills"
thread: https://x.com/garrytan/status/2042925773300908103
---

# Thin Harness, Fat Skills

Steve Yegge says people using AI coding agents are "10x to 100x as productive as engineers using Cursor and chat today, and roughly 1000x as productive as Googlers were back in 2005."

That's a real number. I've seen it. I've lived it. But when people hear 100x, they think: better models. Smarter Claude. More parameters.

That's the wrong frame entirely. The 2x people and the 100x people are using the same models. The difference is five concepts that fit on an index card.

## The harness is the secret sauce

On March 31, 2026, Anthropic accidentally shipped the entire source code for Claude Code to the npm registry. 512,000 lines. When I read it, it confirmed everything I'd been teaching at YC. The secret sauce isn't the model. It's the thing wrapping the model: the harness. Live repo context. Prompt caching. Purpose-built tools. Context bloat minimization. Structured session memory. Parallel sub-agents.

None of that is about making the model smarter. All of it is about giving the model the right context, at the right time, without drowning it in noise.

That's the only question that matters. And the answer has a specific shape. I call it **thin harness, fat skills**.

## Five definitions

The bottleneck is never the model's intelligence. The bottleneck is whether the model understands your schema. Models already know how to reason, synthesize, and write code. They fail because they don't know your data. Five definitions fix this.

### Definition 1: Skill File

A skill file is a reusable markdown procedure that teaches the model HOW to do something. Not WHAT to do. The user supplies the specifics. The skill supplies the process.

**Markdown is actually code.** A skill file is a more perfect encapsulation of capability than rigid source code, because it describes process, judgment, and context in the language the model already thinks in.

On the left is a skill called `/investigate`. Seven steps: scope the dataset, build a timeline, diarize every document, synthesize, argue both sides, cite sources. It takes three parameters: TARGET, QUESTION, and DATASET.

On the right are two completely different invocations of the same skill. One points at Dr. Sarah Chen and 2.1 million discovery emails, asking whether a safety scientist was silenced. The other points at Pacific Corporate Services and FEC filings, asking whether shell companies are coordinating campaign donations.

Same skill. Same seven steps. Same markdown file. In one case it's a medical research analyst. In the other it's a forensic investigator. The skill describes a process of judgment. The invocation supplies the world.

**This is the key insight most people miss: a skill file works like a method call.** It takes parameters. You invoke it with different arguments. The same procedure produces radically different capabilities depending on what you pass in. This is not prompt engineering. This is software design, using markdown as the programming language and human judgment as the runtime.

### Definition 2: Harness

The harness is the program that runs the LLM. It does four things: runs the model in a loop, reads and writes your files, manages context, and enforces safety. That's the "thin."

The anti-pattern is a fat harness with thin skills: 40+ tool definitions eating half the context window. God tools with 2 to 5 second MCP round-trips. REST API wrappers that turn every endpoint into a tool. 3x the tokens, 3x the latency, 3x the failure rate.

What you should build instead: a Playwright CLI that does each browser operation in 100 milliseconds. Compare: Chrome MCP takes 15 seconds for screenshot + find + click + wait + read. Playwright CLI takes 200 milliseconds for screenshot + assert. 75x faster. Software doesn't have to be precious anymore. Build exactly what you need.

### Definition 3: Resolver

A resolver is a routing table for context. When task type X appears, load document Y first.

Skills say HOW. Resolvers say WHAT to load WHEN. A developer changes a prompt. Without the resolver, they ship it. With the resolver, the model reads `docs/EVALS.md` first, which says: run the eval suite, compare scores, if accuracy drops more than 2%, revert and investigate. The developer didn't know the eval suite existed. The resolver loaded the right context at the right moment.

Claude Code has a built-in resolver. Every skill has a description field, and the model matches user intent to skill descriptions automatically. You never have to remember `/ship` exists. The description IS the resolver. It's like Clippy. Except it actually works.

A confession: my CLAUDE.md was 20,000 lines. Every single thing I ran across went in there. Every quirk, every pattern, every lesson. Completely ridiculous. The model's attention degraded. Claude Code literally told me to cut it back. The fix: about 200 lines. Just pointers to documents. The resolver loads the right one when it matters.

### Definition 4: Latent vs. Deterministic

Every step in your system is one or the other.

**Latent space** is where intelligence lives. The model reads, interprets, decides. Judgment. Synthesis. Pattern recognition.

**Deterministic** is where trust lives. Same input, same output. Every time. SQL. Code. Numbers.

An LLM can seat 8 people at a dinner table. Ask it to seat 800 and it will hallucinate a seating chart that looks plausible but is completely wrong. That's a deterministic problem forced into latent space. The worst systems put the wrong work on the wrong side.

### Definition 5: Diarization

The model reads everything about a subject and writes a structured profile. Read 50 documents, produce 1 page of judgment.

No SQL query produces this. No RAG pipeline produces this. The model has to actually read, hold contradictions in mind, notice what changed and when, and write structured intelligence. This is what makes AI useful for real knowledge work.

## The architecture

Three layers:

**Fat skills** on top. Markdown procedures that encode judgment, process, and domain knowledge. This is where 90% of the value lives.

**Thin CLI harness** in the middle. About 200 lines. JSON in, text out. Read-only by default. CLI first, add MCP later.

**Your app** on the bottom. QueryDB. ReadDoc. Search. Timeline. The deterministic foundation.

Push intelligence UP into skills. Push execution DOWN into deterministic tooling. Keep the harness THIN.

## The system that learns: YC Startup School

Let me show you all five definitions working together. Not in theory. In an actual system we're building at YC.

Chase Center. July 2026. 6,000 founders. Each one has a structured application, questionnaire answers, transcripts from 1:1 advisor chats, and public signals: X posts, GitHub commits, Claude Code transcripts showing how fast they ship.

The traditional approach: a program team of 15 reads applications, makes gut calls, updates a spreadsheet. It works at 200 founders. It breaks at 6,000.

No human can hold 6,000 profiles in working memory and notice that the three best candidates for the infrastructure-for-AI-agents cohort are a dev tools founder in Lagos, a compliance founder in Singapore, and a CLI-tooling founder in Brooklyn who all described the same pain point in different words during their 1:1 chats.

The model can.

**Step 1: Enrich every founder.**

The `/enrich-founder` skill: pull all sources, run enrichments, diarize, highlight what they SAY vs what they're ACTUALLY BUILDING. On the right, the deterministic calls: SQL to find stale profiles, GitHub stats, browser test on the demo URL, social signal pulls, CrustData for company intel.

Cron runs nightly at 2am. 6,000 profiles, every night, always fresh.

The diarization output catches things no keyword search would find:

```
FOUNDER: Maria Santos
COMPANY: Contrail (contrail.dev)
SAYS: "Datadog for AI agents"
ACTUALLY BUILDING: 80% of commits are in billing module.
  She's building a FinOps tool disguised as observability.
```

"SAYS" vs "ACTUALLY BUILDING." That requires reading the GitHub commit history, the application, and the advisor transcript and holding all three in mind at once.

**Step 2: Match 6,000 founders. Make judgment calls.**

This is where skill-as-method-call really shines. Three invocations:

`/match-breakout`: 1,200 founders, cluster by sector affinity, 30 per room. Embed + deterministic assign.

`/match-lunch`: 600 founders, serendipity matching (cross-sector), 8 per table, no repeats. The LLM invents the themes, then assigns.

`/match-live`: whoever is in the zone, nearest-neighbor embedding, real-time at 200ms, 1:1 pairs, not already met.

Same skill. Three invocations. Three completely different matching strategies. Different parameters, different strategies, different group sizes. The skill describes the process. The arguments shape the output.

And the model's judgment calls: "Santos and Oram are both AI infra, but they're not competitors. Santos is cost attribution, Oram is orchestration. Put them in the same group." And: "Kim applied as 'developer tools' but his 1:1 transcript reveals he's building compliance automation for SOC2. Move him to FinTech/RegTech."

No embedding captures the Kim reclassification. No algorithm can do it. The model has to read the entire profile.

**Step 3: The self-learning loop.**

After the event, the `/improve` skill reads NPS surveys, diarizes the "OK" responses (not the bad ones, the mediocre ones), and extracts patterns. Then it proposes new rules and writes them back into the matching skills:

```
When attendee says "AI infrastructure"
    but startup is 80%+ billing code:
    -> Classify as FinTech, not AI Infra.

When two attendees in same group
    already know each other:
    -> Penalize proximity.
       Prioritize novel introductions.
```

These rules get written back into the skill file. Next run uses them automatically. The skill rewrites itself.

July event: 12% "OK" ratings. Next event: 4%. The skill file learned what "OK" actually meant.

Same pattern as every other domain: retrieve, read, diarize, count, synthesize. Then: survey, investigate, diarize, rewrite the skill. It transfers everywhere.

## OpenClaw: where the skills live

I want to tell you about one more harness. Not for coding. For everything else.

I run a personal AI agent on OpenClaw. It has a persona, knows who I am, and maintains a knowledge base of thousands of interconnected files. But the thing that makes it work is the exact same principle. Thin harness, fat skills.

I tweeted about this a few days ago:

> *You are not allowed to do one-off work. If I ask you to do something and it's the kind of thing that will need to happen again, you must: do it manually the first time on 3 to 10 items. Show me the output. If I approve, codify it into a skill file. If it should run automatically, put it on a cron.*

> *The test: if I have to ask you for something twice, you failed.*

That resonated: a thousand likes, twenty-five hundred bookmarks. People thought it was a prompt engineering trick. It's not. It's the same architecture.

Claude Code is the best harness for coding. OpenClaw is the best harness for everything else: email, calendar, meetings, people, research, alerts. Same principle. Thin harness. Fat skills. The skills are method calls. The parameters change. The process stays.

Every skill I write is a permanent upgrade. It never degrades. It never forgets. It runs at 3 AM while I sleep. And when the next model drops, every skill instantly gets better, because the judgment in the latent steps improves while the deterministic steps stay perfectly reliable.

That's how you get Yegge's 10x to 100x. Not a smarter model. Fat skills, thin harness, and the discipline to codify everything.

The system compounds. Build it once. It runs forever.

Five definitions. Three layers. One principle. Thin harness, fat skills.

---

## Agent Decision Guide: Skill or Code?

When building GBrain features, use this decision guide:

| Question | If YES | If NO |
|----------|--------|-------|
| Does the agent need to think, adapt, or ask questions? | **Skill** (recipe markdown) | Code |
| Same input always produces same output? | **Code** (CLI command) | Skill |
| Does it require judgment about the user's environment? | **Skill** | Code |
| Is it a lookup, list, or status check? | **Code** | Probably skill |
| Does it change behavior based on conversation context? | **Skill** | Code |

**GBrain examples:**
- `gbrain integrations list` = **Code** (reads files, checks env vars, deterministic)
- `gbrain integrations status` = **Code** (checks env vars + heartbeat, deterministic)
- `gbrain integrations doctor` = **Code** (runs health checks, deterministic)
- `gbrain integrations stats` = **Code** (aggregates JSONL, deterministic)
- Recipe setup flow = **Skill** (asks for API keys, adapts to environment, validates)
- Recipe changelog surfacing = **Skill** (agent describes changes conversationally)
- Entity detection = **Skill** (reads message, decides what's important, creates pages)
- Meeting ingestion = **Skill** (reads transcript, extracts entities, updates pages)

**The rule:** If it's a lookup table, it's code. If the agent needs to think, it's a skill.
