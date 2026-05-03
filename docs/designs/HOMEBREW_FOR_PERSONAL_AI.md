# Homebrew for Personal AI Infrastructure

The 10-star vision for GBrain's integration system. Ship Approach B (v0.7.0),
build toward this over subsequent releases.

## The Vision

GBrain becomes a personal infrastructure operating system where every signal in
your life flows through the brain automatically. Integrations are **senses**
(data inputs) and **reflexes** (automated responses to patterns). Users subscribe
to the creator's actual operating system, then customize it.

```
$ gbrain integrations

  SENSES (data inputs)                          STATUS
  -------------------------------------------------------
  voice-to-brain    Phone calls -> brain pages  ACTIVE    last call: 2h ago
  email-to-brain    Gmail -> entity updates     ACTIVE    47 emails today
  x-to-brain        Twitter -> media pages      ACTIVE    312 tweets tracked
  calendar-to-brain Google Cal -> meeting prep  ACTIVE    3 meetings tomorrow
  photos-to-brain   Camera roll -> visual mem   AVAILABLE
  slack-to-brain    Slack -> conversation index  AVAILABLE
  rss-to-brain      RSS feeds -> media pages     AVAILABLE

  REFLEXES (automated responses)                STATUS
  -------------------------------------------------------
  meeting-prep      Brief me before meetings    ACTIVE    next: 9am tomorrow
  entity-enrich     Auto-enrich new contacts    ACTIVE    12 enriched today
  dream-cycle       Overnight brain maintenance ACTIVE    last run: 3am
  deal-tracker      Alert on deal changes       AVAILABLE
  follow-up-nudge   Remind on stale threads     AVAILABLE

  This week: 1,247 signals ingested. Top: email (47%), voice (23%), X (18%).
  34 new entity pages created. 7 calls transcribed.

  Run 'gbrain integrations show <id>' for setup details.
```

The user feels: "My brain is alive. It's watching everything I care about, and
it's getting smarter every day. I didn't have to write any code. I just said yes
when the agent asked."

## Architecture: Senses & Reflexes

### Recipe Format (YAML frontmatter + markdown body)

```yaml
---
id: voice-to-brain
name: Voice-to-Brain
version: 0.7.0
description: Phone calls create brain pages via Twilio + OpenAI Realtime + GBrain MCP
category: sense
requires: [credential-gateway]
secrets:
  - name: TWILIO_ACCOUNT_SID
    description: Twilio account SID
    where: https://console.twilio.com
  - name: OPENAI_API_KEY
    description: OpenAI API key (for Realtime voice)
    where: https://platform.openai.com/api-keys
health_checks:
  - curl -s https://api.twilio.com/2010-04-01 > /dev/null
  - curl -s https://api.openai.com/v1/models > /dev/null
setup_time: 30 min
---

[Opinionated setup instructions the agent executes...]
```

### Dependency Graph

Recipes declare `requires` in frontmatter. The CLI resolves dependencies before
setup. If voice-to-brain requires credential-gateway, the agent sets up
credential-gateway first.

```
google-tools-mcp (Gmail, Calendar, Drive, Docs, Sheets, Forms, Slides)
  │
  └── (no dependencies — single OAuth, self-contained)

# Legacy (deprecated):
# credential-gateway
#   ├── email-to-brain
#   └── calendar-to-brain
```

### Health Dashboard

`gbrain integrations doctor` runs health_checks from every configured recipe:
```
$ gbrain integrations doctor
  voice-to-brain:   ✓ Twilio reachable  ✓ OpenAI key valid  ✓ ngrok tunnel up
  email-to-brain:   ✓ Gmail auth valid   ✗ No emails in 48h (check cron)
  OVERALL: 1 warning
```

### Sense Analytics

`gbrain integrations stats` aggregates heartbeat data:
```
$ gbrain integrations stats
  This week: 1,247 signals ingested
  Top sources: email (47%), voice (23%), X (18%), calendar (12%)
  34 new entity pages created
  7 calls transcribed
  Brain growth: 12,400 → 12,834 pages (+434)
```

### Reflex Rules Engine (future)

Reflexes are recipes that trigger on brain state changes:

```yaml
---
id: deal-tracker
category: reflex
triggers:
  - type: page_updated
    filter: {type: deal, field: status}
  - type: timeline_entry
    filter: {source: email, mentions: deal}
action: alert
---

When a deal page's status changes or a new email mentions a deal,
alert the user with context from the brain.
```

## Roadmap

| Version | What Ships | Key Recipe |
|---------|-----------|------------|
| v0.7.0 | Recipe format, CLI, SKILLPACK breakout | voice-to-brain |
| v0.8.0 | 3 more senses, reflex format | email, X, calendar |
| v0.9.0 | Community recipes, install executor | community submissions |
| v1.0.0 | Full senses/reflexes, health dashboard | meeting-prep, dream-cycle |

## Key Design Decisions

1. **GBrain is deterministic infrastructure.** Cross-sense correlation, pattern
   detection, and intelligent responses are the agent's job (OpenClaw/Hermes).
   GBrain provides the plumbing.

2. **Agents ARE the runtime.** No npm packages, Docker images, or deterministic
   scripts. The recipe markdown IS the installer. The agent reads it and does
   the work.

3. **Very opinionated defaults.** Ship the creator's exact production setup as
   the default. Users customize from there. Unknown callers get screened. Quiet
   hours are enforced. Brain-first lookup happens on every call.

4. **Agent-readable outputs.** All CLI output must be parseable by agents (--json
   flag). Migration files include agent instructions. The agent is the primary
   consumer, not the human.
