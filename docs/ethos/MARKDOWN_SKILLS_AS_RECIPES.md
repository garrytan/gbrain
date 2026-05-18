---
type: essay
title: "Homebrew for Personal AI"
subtitle: "Why Markdown is Code and Your Agent is a Package Manager"
author: Garry Tan
created: 2026-04-11
updated: 2026-04-11
tags: [ai, gbrain, gstack, markdown-is-code, open-source, software-distribution, agents, openclaw]
status: draft-v2
prior: "Thin Harness, Fat Skills"
---

# Homebrew for Personal AI

`brew install` gives you someone else's binary. `npm install` gives you someone else's source code. Both require you to understand the tool, configure it, integrate it, maintain it.

What if software distribution worked differently? What if you could describe a capability in plain English, hand that description to an AI agent, and the agent built a native implementation tailored to your setup?

That's what happens when markdown is code.

## Markdown is code

Here's a real skill file. This one teaches an AI agent to screen phone calls:

```markdown
# Voice Agent — Your Phone Number

Caller → Twilio → <Stream> WebSocket → Voice Server (port 8765)
                                            ↕ audio
                                      OpenAI Realtime API
                                            ↓ tool calls
                                      Brain / Calendar / Telegram

## Call Routing

Every inbound call routes based on caller phone number + brain lookup:

### Owner → Authenticated Mode
- Send crypto-random 6-digit code to secure channel
- Caller reads it back
- Match → full assistant mode (brain, calendar, scheduling)
- No match → treated as unknown caller

### Known Person, Inner Circle (brain score ≥ 4) → Forward
- Greet by name with brain context
- Transfer to cell
- If no answer (30s timeout), take message
- Text Telegram with who called and context

### Unknown Caller → Screen
- Get their name, look them up in brain
- If inner circle → offer to transfer
- Otherwise → take message
- Create brain entry with phone number (marked UNVERIFIED)
```

That's not pseudocode. That's not documentation. That's a working specification that a model like Claude Opus 4.6 with a million-token context window can read and implement. The architecture diagram tells it the components. The routing table tells it the logic. The security model tells it the constraints. The agent reads this file, understands it, and builds the Twilio integration, the WebSocket server, the Telegram bot hooks, the brain lookup, all of it, shaped to whatever infrastructure the user already has.

A skill file is a method call. It takes parameters (your phone number, your brain, your preferred messaging app). Same skill, different arguments, different implementation. The procedure is the package. The model is the runtime.

## The distribution mechanism

Traditional package managers distribute artifacts: compiled binaries, source tarballs, container images. The consumer runs someone else's code.

GBrain distributes recipes: markdown files that describe capabilities with enough specificity that an AI agent can implement them from scratch. The consumer gets a native implementation. No dependency hell. No version conflicts. No transitive vulnerability chains. Because there is no upstream code. There's a description of what to build and why.

Here's how it works:

1. **Build a feature.** Implement a voice agent, meeting ingestion pipeline, email triage system, investment diligence workflow, whatever.

2. **GBrain captures the recipe.** Not just the code. The architecture, the integration points, the failure modes, the judgment calls. A markdown file that encodes the full capability.

3. **Push to the repo.** Open source. Anyone can read it.

4. **Someone else's agent pulls the recipe.** Reads the markdown. Says: "New recipe available: AI voice agent with caller screening. Want it?" User says yes. The agent reads the spec and builds it.

No installation. No configuration wizard. No README. The agent read a document and figured it out.

## Why this works now

This didn't work two years ago. Two things changed.

**Context windows hit a million tokens.** A real skill file for meeting ingestion is 200+ lines. The enrichment skill that calls it references a brain schema, a resolver, a citation standard, five external APIs, and a cross-linking protocol. An agent implementing this recipe needs to hold all of that in working memory simultaneously while also understanding the user's existing setup. At 8K tokens, impossible. At 128K, marginal. At 1M, comfortable.

**Models crossed the judgment threshold.** Here's a snippet from a real enrichment recipe:

```markdown
## Philosophy

A brain page should read like an intelligence dossier crossed
with a therapist's notes, not a LinkedIn scrape. We want:

- What they believe — ideology, worldview, first principles
- What they're building — current projects, what's next
- What motivates them — ambition drivers, career arc
- What makes them emotional — angry, excited, defensive, proud
- Their trajectory — ascending, plateauing, pivoting, declining?
- Hard facts — role, company, funding, location, contact info

Facts are table stakes. Texture is the value.
```

A model implementing this recipe has to understand the difference between a LinkedIn scrape and an intelligence dossier. That's a judgment call about what information is worth capturing and how to weight it. GPT-3 couldn't do this. GPT-4 could sort of do it. Opus 4.6 does it well. The enabling technology is models that are smart enough to interpret intent, not just follow instructions.

## What a recipe actually contains

A good recipe has five sections:

**Architecture.** The component diagram. What talks to what, over what protocol, with what data flow. This is the skeleton the agent builds first.

**Routing logic.** The decision tree. When X happens, do Y. When Z fails, fall back to W. This is where domain knowledge lives. A voice agent recipe encodes call routing. A diligence recipe encodes how to process pitch decks vs. financial models vs. cap tables. A meeting ingestion recipe encodes how to turn a raw transcript into actionable intelligence.

**Integration points.** What external systems does this touch? Twilio, Telegram, Gmail, Circleback, Slack, GitHub, Supabase, whatever. The recipe names the integrations; the agent figures out how to connect them given what the user already has configured.

**Judgment calls.** The hard part. Not "send an email" but "decide whether this email is worth surfacing to the user based on sender importance, time sensitivity, and whether it requires a decision." Recipes that skip the judgment calls produce shallow implementations. The judgment calls are the actual value.

**Failure modes.** What goes wrong and what to do about it. "If Circleback token expires, message the user and ask them to reconnect. Don't silently skip." "If caller ID is spoofed, never trust it for authentication. Use a challenge-response code via a separate channel." Recipes without failure modes produce brittle systems.

Here's a real example. This is the diligence recipe's detection logic:

```markdown
## Detection

Recognize data room materials by:
- PDF filenames: "Data Deck", "Intro Deck", "Cap Table",
  "Financial Model", "Pitch Deck", "Series [A-D]"
- Spreadsheets with tabs: Revenue, Retention, Cohorts,
  CAC, Gross Margin, Unit Economics, ARR
- User saying: "data room", "diligence", "deck", "pitch"
- Context: shared in the Diligence topic
```

That's a pattern matcher expressed in English. An agent reads this and knows how to classify incoming documents. No regex. No file type configuration. Just a description of the pattern and the model's judgment about whether a given document matches.

## Pick and choose

GBrain is not monolithic. Recipes are independent. Take what you want:

- **Voice agent** — phone screening, caller ID, brain lookup, message routing
- **Meeting ingestion** — transcript processing, entity extraction, action item capture, timeline updates
- **Email triage** — inbox sweep, priority classification, draft replies, scheduling extraction
- **Enrichment pipeline** — people and company research from multiple data sources, diarized into brain pages
- **Diligence processing** — data room ingestion, PDF extraction, financial model analysis
- **Social monitoring** — X/Twitter timeline analysis, mention tracking, narrative detection
- **Content pipeline** — idea capture, link ingestion, article summarization

Each recipe is self-contained. Your agent knows what you already have. GBrain pings daily: "Three new recipes since last sync. Want any?" You pick. It builds.

And because the source code is English, forking is trivial. Don't like how the voice agent handles unknown callers? Edit the markdown. Change "take a message" to "ask three screening questions first." The behavior changes because the spec changed.

## The thin harness, fat skills connection

This essay is a sequel. The prequel was "Thin Harness, Fat Skills," which argued that the secret to 100x AI productivity isn't better models but better context management. Keep the harness thin (the program running the model). Make the skills fat (markdown procedures encoding judgment and process).

"Markdown is code" is the distribution corollary. If the skills are fat markdown files, and if models are smart enough to implement from markdown, then the skills are distributable software. The skill file is simultaneously:

- **Documentation** for humans reading it
- **Specification** for the implementing agent
- **Package** for the distribution system
- **Source code** for the resulting capability

Four artifacts collapsed into one. That's why this is different from every previous package manager. `brew install` separates the formula from the binary from the docs from the source. GBrain collapses them. The markdown is all four.

## The architecture underneath

Three layers, same as the talk:

**Fat skills** on top. Markdown recipes encoding judgment, process, failure modes, and domain knowledge. This is where 90% of the value lives. This is what gets distributed.

**Thin harness** in the middle. The program running the model. File operations, tool dispatch, context management, safety enforcement. About 200 lines. OpenClaw or any equivalent. The less the harness constrains, the more the recipes can express.

**Deterministic foundation** on the bottom. Databases, APIs, CLIs. Same input, same output, every time. SQL queries, HTTP calls, file reads. The skills describe WHEN to call these; the harness executes them.

Push intelligence UP into skills. Push execution DOWN into deterministic tooling. Distribute the skills. That's the whole system.

## What this means

When implementation cost approaches zero, the bottleneck shifts. It's no longer "can we build this?" It's "should we build this?" and "what exactly should it do?"

Taste, vision, and domain knowledge become the scarce resources. The person who deeply understands call screening and writes a precise recipe creates more value than the person who can implement a Twilio integration from scratch. The recipe IS the implementation.

This also means the best AI agent setups will be open source by default. Closed, proprietary agent configurations are competing against a world where someone publishes a recipe and a thousand agents implement it overnight. The recipe propagates at the speed of a git push. The moat is taste, not code.

Software distribution reimagined: the package is a markdown file, the runtime is a sufficiently smart model, the package manager is your AI agent, and the app store is a git repo.

`gbrain install voice-agent`

That's it.
