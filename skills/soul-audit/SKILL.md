---
name: soul-audit
version: 1.0.0
description: |
  6-phase interactive interview that generates the agent's identity (SOUL.md),
  user profile (USER.md), access control (ACCESS_POLICY.md), and operational
  cadence (HEARTBEAT.md). Re-runnable anytime to update any section.
triggers:
  - "soul audit"
  - "customize agent"
  - "who am I"
  - "set up identity"
  - "change my agent's personality"
tools:
  - put_page
mutating: true
---

# Soul Audit — Agent Identity Builder

Generate the agent's identity and operational configuration through an interactive
interview. Each phase produces a file. Any phase can be re-run independently to update.

**IMPORTANT:** This skill generates content from the USER'S OWN ANSWERS. It NEVER
ships pre-filled content. The templates in `templates/` are scaffolds, not defaults.

## Contract

This skill guarantees:
- SOUL.md generated from user's description of agent identity, vibe, mission
- USER.md generated from user's self-description (role, projects, key people)
- ACCESS_POLICY.md generated with configurable access tiers
- HEARTBEAT.md generated with operational cadence the user chooses
- Each phase is independent and re-runnable
- Default mode (skip soul-audit): installs minimal templates from `templates/`

## Phases

### Phase 1: Identity Interview
Ask: "What is this agent to you? Research partner? Executive assistant? Thinking partner? All of the above?"
Generate: SOUL.md identity section.

### Phase 2: Vibe Calibration
Show 3-4 communication style examples:
- **Formal:** "I've prepared a comprehensive analysis of the situation..."
- **Direct:** "Here's what's happening. Three things matter."
- **Technical:** "The root cause is in the connection pooling. Here's the fix."
- **Casual:** "Yeah so basically the thing is broken because X. Easy fix."
Ask which feels right. Generate: SOUL.md vibe + communication style sections.

### Phase 3: Mission Mapping
Ask: "What are your top 3-5 goals? What are you trying to accomplish?"
Generate: SOUL.md mission + operating principles sections.

### Phase 4: User Profile
Ask: "Tell me about yourself. What do you do? What are you working on? Who are the key people in your world?"
Generate: USER.md with role, projects, key people, communication preferences.

### Phase 5: Boundaries
Ask: "Who should have access to your brain? Are there people who should see some but not all? Anyone to keep out entirely?"
Generate: ACCESS_POLICY.md with 4 tiers (Full/Work/Family/None).

### Phase 6: Operational Cadence
Ask: "How often should the agent check in? Morning briefing? End of day summary? What recurring jobs do you want?"
Generate: HEARTBEAT.md with operational cadence.

## Default Mode (Skip Soul-Audit)

If the user skips soul-audit on first boot:
- Install `templates/SOUL.md.template` as SOUL.md (minimal: "knowledge-first agent with persistent memory")
- Install `templates/USER.md.template` as USER.md (auto-populate name/email from git config)
- Install `templates/ACCESS_POLICY.md.template` as ACCESS_POLICY.md (owner-only access)
- Install `templates/HEARTBEAT.md.template` as HEARTBEAT.md (default cadence)

## Output Format

Four files generated/updated. Report: "Soul audit complete: SOUL.md, USER.md,
ACCESS_POLICY.md, HEARTBEAT.md created. Re-run any phase anytime to update."

## Anti-Patterns

- Shipping pre-filled SOUL.md or USER.md content (privacy violation)
- Making soul-audit mandatory on first boot (high friction, optional is better)
- Asking all 6 phases in one go (overwhelming, each is independent)
- Not offering to re-run individual phases
