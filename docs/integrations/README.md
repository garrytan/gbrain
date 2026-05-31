# Getting Data Into Your Brain

MBrain is the retrieval layer. But retrieval is only as good as what you put in.
This directory covers how to get data flowing into your brain automatically.

## How Data Flows In

```
Signal arrives (phone call, email, tweet, calendar event)
  ↓
Collector captures it (deterministic code, reliable)
  ↓
Agent analyzes it (LLM, judgment, entity detection)
  ↓
Brain pages created/updated (compiled truth + timeline)
  ↓
MBrain indexes it (chunking, embedding, search-ready)
  ↓
Next query is smarter (the compounding effect)
```

## Available Integrations

### Self-Installing Recipes

These are integration recipes your agent can set up for you. Run
`mbrain integrations` to see what's available and their status.

| Recipe | Category | Requires | What It Does | Setup Time |
|--------|----------|----------|-------------|------------|
| [ngrok-tunnel](../../recipes/ngrok-tunnel.md) | Infra | — | Fixed public URL for MCP + voice ($8/mo) | 10 min |
| [fly-app-hosting](../../recipes/fly-app-hosting.md) | Infra | — | Always-on public hosting for webhook and collector services on Fly.io | 20 min |
| [railway-app-hosting](../../recipes/railway-app-hosting.md) | Infra | — | Always-on public hosting for webhook and collector services on Railway | 20 min |
| [credential-gateway](../../recipes/credential-gateway.md) | Infra | — | Gmail + Calendar access (ClawVisor or Google OAuth) | 15 min |
| [voice-to-brain](../../recipes/twilio-voice-brain.md) | Sense | ngrok-tunnel | Phone calls create brain pages via Twilio + OpenAI Realtime | 30 min |
| [email-to-brain](../../recipes/email-to-brain.md) | Sense | credential-gateway | Gmail messages flow into entity pages via deterministic collector | 20 min |
| [x-to-brain](../../recipes/x-to-brain.md) | Sense | — | Twitter timeline, mentions, keyword monitoring with deletion detection | 15 min |
| [calendar-to-brain](../../recipes/calendar-to-brain.md) | Sense | credential-gateway | Google Calendar events become searchable daily brain pages | 20 min |
| [meeting-sync](../../recipes/meeting-sync.md) | Sense | — | Circleback meeting transcripts auto-import with attendee propagation | 15 min |

### Manual Integration Guides

These require manual setup (no self-installing recipe yet):

| Guide | What It Does |
|-------|-------------|
| [Credential Gateway](credential-gateway.md) | Set up ClawVisor or Hermes for Gmail, Calendar, Contacts access |
| [Meeting & Call Webhooks](meeting-webhooks.md) | Circleback meeting transcripts + Quo/OpenPhone SMS/calls |

## How to Read a Recipe

Integration recipes are markdown files with YAML frontmatter. Your agent reads
the recipe and walks you through setup.

```yaml
---
id: voice-to-brain              # unique identifier
name: Voice-to-Brain            # human-readable name
version: 0.7.0                  # recipe version
description: Phone calls...     # what it does
category: sense                 # sense (data input) or reflex (automated response)
requires: []                    # other recipes that must be set up first
secrets:                        # API keys and credentials needed
  - name: TWILIO_ACCOUNT_SID
    description: Twilio account SID
    where: https://console.twilio.com    # exact URL to get this key
health_checks:                  # typed checks, never shell commands
  - type: env_exists
    name: TWILIO_ACCOUNT_SID
    label: Twilio account SID
  - type: url_responds
    url: http://localhost:4040/api/tunnels
    label: Local tunnel API
    timeout_ms: 2000
  - type: heartbeat_fresh
    max_age: 24h
    label: Collector heartbeat
setup_time: 30 min              # estimated time to complete setup
---

[Setup instructions the agent follows step by step...]
```

**The recipe IS the installer.** Your agent (OpenClaw, Hermes, Claude Code) reads
the markdown body and executes the setup steps. It asks you for API keys, validates
each one, configures the integration, and runs a smoke test.

Health checks are a constrained DSL so community recipes cannot smuggle shell
commands into `mbrain integrations doctor`. Supported checks are `env_exists`,
`env_any_exists`, `url_responds`, and `heartbeat_fresh`. `url_responds` is
limited to localhost loopback targets for local service smoke checks.

## Community Recipe Preflight

Before opening a PR for a custom recipe, run:

```bash
mbrain integrations submit path/to/your-recipe.md
```

This is a local preflight only. It does not run health checks, call `git` or
`gh`, open network connections, write files, or create a pull request. It checks
frontmatter shape, semver, safe recipe IDs, existing recipe collisions,
dependencies, recipe body length, and the constrained `health_checks` DSL.
On success it prints the intended `recipes/<id>.md` target path, PR title/body
template, included files, and review checklist. The generated package is
deterministic and does not include secret values, setup logs, or local machine
paths. Use `--json` for machine-readable output.

If you explicitly want MBrain to create the contribution branch, commit, push,
and draft PR, run:

```bash
mbrain integrations submit path/to/your-recipe.md --create-pr
```

That mode is intentionally side-effecting. It runs only after the same preflight
passes, then copies the recipe to `recipes/<id>.md`, creates
`mbrain/recipe-<id>`, commits the recipe, pushes the branch, and opens a draft
PR with `gh`. Run it from a clean MBrain repository clone with GitHub CLI
authentication already configured.

## The Deterministic Collector Pattern

When an LLM keeps failing at a mechanical task despite repeated prompt fixes,
stop fighting the LLM. Move the mechanical work to code.

**Code for data. LLMs for judgment.**

- Email collection: code pulls emails with baked-in links (100% reliable).
  LLM reads the digest, classifies, enriches brain entries (judgment).
- Tweet collection: code pulls timeline, detects deletions, tracks engagement
  (deterministic). LLM extracts entities, writes brain updates (judgment).
- Calendar sync: code pulls events and attendees (deterministic). LLM enriches
  attendee brain pages (judgment).

This pattern prevents the "LLM forgot the links" failure mode. Mechanical work
must be 100% reliable. Judgment work is where LLMs shine.

See [Deterministic Collectors](../guides/deterministic-collectors.md) for the
full pattern.

## Architecture

For details on the shared infrastructure that all integrations build on
(import pipeline, chunking, embedding, search), see the
[Infrastructure Layer](../architecture/infra-layer.md).

For the philosophy behind thin harness + fat skills, see
[Thin Harness, Fat Skills](../ethos/THIN_HARNESS_FAT_SKILLS.md).
