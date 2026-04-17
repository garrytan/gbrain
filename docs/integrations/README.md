# Getting Data Into Your Brain

GBrain is the retrieval layer. But retrieval is only as good as what you put in.
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
GBrain indexes it (chunking, embedding, search-ready)
  ↓
Next query is smarter (the compounding effect)
```

## Available Integrations

### Self-Installing Recipes

These are integration recipes your agent can set up for you. Run
`gbrain integrations` to see what's available and their status.

| Recipe | Category | Requires | What It Does | Setup Time |
|--------|----------|----------|-------------|------------|
| [ngrok-tunnel](../../recipes/ngrok-tunnel.md) | Infra | — | Fixed public URL for MCP + voice ($8/mo) | 10 min |
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
health_checks:                  # typed DSL to verify the integration is working
  - type: http
    url: "https://api.twilio.com/2010-04-01/Accounts/$TWILIO_ACCOUNT_SID.json"
    auth: basic
    auth_user: "$TWILIO_ACCOUNT_SID"
    auth_token: "$TWILIO_AUTH_TOKEN"
    label: "Twilio account"
setup_time: 30 min              # estimated time to complete setup
---

[Setup instructions the agent follows step by step...]
```

**The recipe IS the installer.** Your agent (OpenClaw, Hermes, Claude Code) reads
the markdown body and executes the setup steps. It asks you for API keys, validates
each one, configures the integration, and runs a smoke test.

### Recipe trust boundary

Only recipes shipped inside the gbrain package itself (the `recipes/` directory in
a source install, or the global install copy) are trusted. Recipes discovered at
runtime from `$GBRAIN_RECIPES_DIR` or a cwd-local `./recipes/` are marked untrusted:
they cannot run `command` health checks, cannot run `http` health checks (SSRF
defense), and cannot use the deprecated string health_check form. Untrusted recipes
can still use `env_exists` and `any_of` compositions. To ship a recipe that runs
live checks, contribute it upstream so it becomes package-bundled.

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
