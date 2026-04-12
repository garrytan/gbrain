<!-- skillpack-version: 0.7.0 -->
<!-- source: https://raw.githubusercontent.com/garrytan/gbrain/master/docs/GBRAIN_SKILLPACK.md -->
# GBrain Skillpack: Reference Architecture for AI Agents

This is a reference architecture for how a production AI agent uses gbrain as its
knowledge backbone. Based on patterns from a real deployment with 14,700+ brain
files, 40+ skills, and 20+ cron jobs running continuously.

**The memex vision, realized.** Vannevar Bush imagined a device where an individual
stores everything, mechanized so it may be consulted with exceeding speed. GBrain is
that device, except the memex builds itself. The agent detects entities, enriches
pages, creates cross-references, and maintains compiled truth automatically.

Each section below is a standalone guide. Click through to the full content.

---

## Core Patterns

The foundational read-write loop and data model.

| Guide | What It Covers |
|-------|---------------|
| [The Brain-Agent Loop](guides/brain-agent-loop.md) | The read-write cycle that makes the brain compound over time |
| [Entity Detection](guides/entity-detection.md) | Run it on every message. Capture original thinking + entity mentions |
| [The Originals Folder](guides/originals-folder.md) | Capturing WHAT YOU THINK, not just what you found |
| [Brain-First Lookup](guides/brain-first-lookup.md) | Check the brain before calling any external API |
| [Compiled Truth + Timeline](guides/compiled-truth.md) | Above the line: current synthesis. Below: append-only evidence |
| [Source Attribution](guides/source-attribution.md) | Every fact needs a citation. Format and hierarchy |

## Data Pipelines

Getting data in and keeping it current.

| Guide | What It Covers |
|-------|---------------|
| [Enrichment Pipeline](guides/enrichment-pipeline.md) | 7-step protocol, tier system (Tier 1/2/3 by importance) |
| [Meeting Ingestion](guides/meeting-ingestion.md) | Always pull complete transcript, propagate to all entity pages |
| [Content & Media Ingestion](guides/content-media.md) | YouTube, social media bundles, PDFs/documents |
| [Diligence Ingestion](guides/diligence-ingestion.md) | Data room materials: pitch decks, financial models, cap tables |
| [Deterministic Collectors](guides/deterministic-collectors.md) | Code for data, LLMs for judgment. The collector pattern |
| [Idea Capture & Originals](guides/idea-capture.md) | Depth test, originality distribution, deep cross-linking |
| [Getting Data In](integrations/README.md) | Integration recipes: voice, email, X, calendar |

## Operations

Running a production brain.

| Guide | What It Covers |
|-------|---------------|
| [Reference Cron Schedule](guides/cron-schedule.md) | 20+ recurring jobs, quiet hours, dream cycle |
| [Quiet Hours & Timezone](guides/quiet-hours.md) | Hold notifications during sleep, timezone-aware delivery |
| [Executive Assistant Pattern](guides/executive-assistant.md) | Email triage, meeting prep, scheduling |
| [Operational Disciplines](guides/operational-disciplines.md) | Signal detection, brain-first, sync-after-write, heartbeat, dream cycle |
| [Skill Development Cycle](guides/skill-development.md) | 5-step cycle: concept, prototype, evaluate, codify, cron |

## Architecture

How to structure your system.

| Guide | What It Covers |
|-------|---------------|
| [Two-Repo Architecture](guides/repo-architecture.md) | Agent repo vs brain repo, boundary rules, decision tree |
| [Sub-Agent Model Routing](guides/sub-agent-routing.md) | Which model for which task, signal detector pattern, cost optimization |
| [The Three Search Modes](guides/search-modes.md) | Keyword, hybrid, direct. When to use each |
| [Brain vs Agent Memory](guides/brain-vs-memory.md) | 3 layers: GBrain (world knowledge), agent memory, session |

## Integrations

Wiring up your life.

| Guide | What It Covers |
|-------|---------------|
| [Credential Gateway](integrations/credential-gateway.md) | ClawVisor / Hermes for Gmail, Calendar, Contacts |
| [Meeting & Call Webhooks](integrations/meeting-webhooks.md) | Circleback transcripts + Quo/OpenPhone SMS/calls |
| [Voice-to-Brain](../recipes/twilio-voice-brain.md) | Phone calls + WebRTC browser calls create brain pages. 25 production patterns: identity separation, bid system, conversation timing, proactive advisor, prompt compression, caller routing, dynamic VAD, real-time logging, belt-and-suspenders post-call |
| [Email-to-Brain](../recipes/email-to-brain.md) | Gmail messages flow into entity pages via deterministic collector |
| [X-to-Brain](../recipes/x-to-brain.md) | Twitter monitoring with deletion detection + engagement velocity |
| [Calendar-to-Brain](../recipes/calendar-to-brain.md) | Google Calendar events become searchable daily brain pages |
| [Meeting Sync](../recipes/meeting-sync.md) | Circleback transcripts auto-import with attendee propagation |

## Administration

Keeping it running and up to date.

| Guide | What It Covers |
|-------|---------------|
| [Upgrades & Auto-Update](guides/upgrades-auto-update.md) | check-update, agent notifications, migration files |
| [Live Sync](guides/live-sync.md) | Keep the index current: cron, --watch, webhook approaches |

---

## Appendix: GBrain CLI Quick Reference

| Command | Purpose |
|---------|---------|
| `gbrain search "term"` | Keyword search across all brain pages |
| `gbrain query "question"` | Hybrid search (vector + keyword + RRF) |
| `gbrain get <slug>` | Read a specific brain page by slug |
| `gbrain sync` | Sync local markdown repo to gbrain index |
| `gbrain import <path>` | Import files into the brain |
| `gbrain embed --stale` | Re-embed pages with stale or missing embeddings |
| `gbrain integrations` | Manage integration recipes (senses + reflexes) |
| `gbrain stats` | Show brain statistics (page count, last sync, etc.) |
| `gbrain doctor` | Diagnose brain health issues |
| `gbrain check-update` | Check for new versions and integration recipes |

Run `gbrain --help` for the full command reference.

---

## Architecture & Philosophy

- [Infrastructure Layer](architecture/infra-layer.md) — Import pipeline, chunking, embedding, search
- [Thin Harness, Fat Skills](ethos/THIN_HARNESS_FAT_SKILLS.md) — Architecture philosophy
- [Markdown Skills as Recipes](ethos/MARKDOWN_SKILLS_AS_RECIPES.md) — Why markdown is code and your agent is a package manager
- [Homebrew for Personal AI](designs/HOMEBREW_FOR_PERSONAL_AI.md) — The 10-star vision
- [Recommended Schema](GBRAIN_RECOMMENDED_SCHEMA.md) — Directory structure for your brain repo
- [Verification Runbook](GBRAIN_VERIFY.md) — End-to-end installation verification
