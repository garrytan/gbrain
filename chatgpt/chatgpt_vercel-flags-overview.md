---
conversation_id: 6993cd3e-0ae8-8333-89fe-6a96e0313684
created: 2026-02-17
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Vercel Flags Overview
type: note
updated: 2026-02-17
---

# Vercel Flags Overview

**Related:** [[coding_devops]]

> Conversation ID: 6993cd3e-0ae8-8333-89fe-6a96e0313684
> Created: 2026-02-17T02:06:58Z
> Updated: 2026-02-17T02:08:26Z
> Messages: 2

---

## User

vercel flags

---

## Assistant

**Vercel Flags (Feature Flags)** — this is Vercel’s feature-flagging system that lets you control, test, and roll out features without redeploying your app. It includes both dashboard UI and CLI support. citeturn0search1turn0search6

### What “flags” are in Vercel  
Feature flags let you toggle application behavior at runtime — e.g., enable/disable features per environment or users, run A/B experiments, or roll out gradually. citeturn0search1

### `vercel flags` CLI commands  
Vercel CLI has a **`vercel flags`** subcommand for managing flags: citeturn0search6
```
vercel flags list             # List all feature flags
vercel flags add [slug]       # Create a new feature flag
vercel flags inspect [flag]   # Show details about a flag
vercel flags enable [flag]    # Enable a boolean flag
vercel flags disable [flag]   # Disable a boolean flag
vercel flags archive [flag]   # Archive a flag
vercel flags rm [flag]        # Delete a flag
```

### CLI options/flags you can use  
**Creation / management options:** citeturn0search6
- **`--kind, -k`** — type of flag (`boolean`, `string`, `number`)
- **`--description, -d`** — description text when adding a flag
- **`--environment, -e`** — target environment (`production`, `preview`, `development`)
- **`--variant, -v`** — when disabling, set the variant to serve
- **`--state, -s`** — filter flags by state (`active`, `archived`)
- **`--yes, -y`** — skip confirmation prompts (useful for scripting)
  
**SDK key management:**  
```
vercel flags sdk-keys ls                   # List SDK keys
vercel flags sdk-keys add --type server ... # Create an SDK key
vercel flags sdk-keys rm [hash-key]         # Remove an SDK key
```
SDK keys authenticate flag evaluations from your app. citeturn0search6

**Global CLI switches** (work with `vercel flags` too):  
```
--cwd, --debug, --token, --scope, --no-color
```
These adjust context, logging, and authentication. citeturn0search6

### Quick summary  
- **Purpose:** manage feature flags from CLI and dashboard. citeturn0search1  
- **Flags:** allow toggling features without redeploys. citeturn0search1  
- **CLI:** create/list/enable/disable/archive/remove flags, plus manage SDK keys. citeturn0search6

If you want examples of how to use flags in Next.js or how to integrate the Flags SDK in code, I can provide those too.


**Topic:** [[chatgpt-clusters/coding_devops]]
