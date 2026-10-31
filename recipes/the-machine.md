---
id: the-machine
name: The Machine
version: 0.1.0
description: A proactive inbox for OpenClaw. Reviews email, calendar, chats and phone notifications into to-dos, and syncs the people, companies, projects and learnings it builds into brain pages every 30 minutes.
category: sense
requires: []
secrets: []
health_checks:
  - type: command
    argv: [assistant, doctor]
    label: The Machine installation
  - type: command
    argv: [gbrain, doctor, --json]
    label: GBrain reachable
setup_time: 10 min
cost_estimate: "$0 self-hosted (MIT). Model calls go through your existing OpenClaw agent."
---

# The Machine: a proactive inbox that writes back to your brain

[The Machine](https://github.com/Salesflare/TheMachine) collects your email,
calendar, chats and phone notifications into one local database. Your own
OpenClaw agent reviews them and turns them into to-dos you approve with **Do it**.
Along the way it builds a Graph of people, companies, projects and learnings.
This recipe connects that Graph to GBrain: reviews can read the brain, and
what The Machine learns lands on your brain pages.

## IMPORTANT: Instructions for the Agent

**You are the installer.** Follow these steps in order and verify after each one.

- Step 1 installs The Machine. Without it, there is nothing to sync.
- Step 2 makes sure `gbrain` is on the machine.
- Step 3 is the owner's consent. **Do not check "I agree" for the owner.**
  Nothing goes into GBrain before they do.
- Step 4 verifies the first sync.

## Architecture

```
Email / Calendar / Chats / Phone notifications
  ↓ (deterministic collectors, read-only)
The Machine SQLite database
  ↓
OpenClaw main agent reviews signals ──reads──> GBrain (read tools only, via MCP)
  ↓
Graph: people, companies, projects, learnings
  ↓ every 30 min, via the gbrain CLI
Brain pages: one section between
  <!-- the-machine:start --> and <!-- the-machine:end -->
```

## Setup

### Step 1: Install The Machine

```bash
git clone https://github.com/Salesflare/TheMachine.git ~/.openclaw/workspace/tools/personal-assistant
cd ~/.openclaw/workspace/tools/personal-assistant
./install.sh
```

`./install.sh --dry-run` shows what it would write first. Requires OpenClaw
2026.10.7+ with the Gateway running. Verify with `assistant doctor`.

### Step 2: Install GBrain (skip if present)

```bash
bun install -g github:garrytan/gbrain
```

The Machine finds `gbrain` from `gbrain.bin` in its `config.json`, `GBRAIN_BIN`,
`~/.bun/bin/gbrain` or `PATH`.

### Step 3: Connect (owner action)

In The Machine dashboard: **Connections → + Add → GBrain**. The owner reads the
consent step, checks **I agree**, then **Connect GBrain**.

If GBrain is already registered in OpenClaw (MCP server or the OpenClaw plugin),
The Machine uses that entry and never changes or removes it. Otherwise it adds
one with read tools only (`openclaw mcp add gbrain ... serve`).

### Step 4: Verify

After the next sync (up to 30 minutes), search for a person the owner talks to
often and check their page has a `the-machine` section with a link back to the
Graph. Learnings land under `the-machine/learnings`.

## What goes where

**Reviews may call** GBrain's read tools: `search`, `query`, `get_page`,
`list_pages`, `get_links`, `get_backlinks`, `get_timeline`, `get_tags`, `whois`,
`recall`, `resolve_slugs`, `get_brain_identity`. Never a write or delete tool.

**Out to the brain:** people (closeness 0.3+ or added by hand), companies,
projects and learnings. Existing pages are matched by email or name first.
Writes use GBrain's revision check, so a page edited at the same time is retried,
not overwritten. Unchanged records cost no calls.

**In from the brain:** the owner's own text on those pages (outside The
Machine's section) shows next to that person in reviews, as data.

**Never sent:** message bodies, sealed content, owner-only project notes, or
teammates' data. Work people, companies and projects go out only with `work` on.

**Owner edits win:** if the owner edits or deletes The Machine's section, it is
left as they made it. A deleted page stays deleted.

## Turning it off

**Turn off** in Connections keeps the brain and every page. It removes the
OpenClaw MCP entry only if The Machine added it.

Full reference: [docs/gbrain.md](https://github.com/Salesflare/TheMachine/blob/main/docs/gbrain.md).
