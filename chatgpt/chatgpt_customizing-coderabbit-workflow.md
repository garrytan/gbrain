---
title: "Customizing CodeRabbit Workflow"
type: note
created: 2026-01-09
updated: 2026-01-09
source: chatgpt-export
conversation_id: 69616640-5610-8329-a6d5-e99d374522ec
message_count: 2
tags: [chatgpt, import]
---
# Customizing CodeRabbit Workflow

> Conversation ID: 69616640-5610-8329-a6d5-e99d374522ec
> Created: 2026-01-09T20:34:38Z
> Updated: 2026-01-09T20:35:26Z
> Messages: 2

---

## User

Help me get the most out of CodeRabbit by customizing this perfectly for our org and our workflow.

---

## Assistant

Mr. White — on this **Pre-merge Checks** page, you can make CodeRabbit enforce your workflow *without* turning PRs into paperwork. Here’s a “high-signal, low-noise” setup that works well for most orgs, with a clean ramp from **Warning → Error** as the team adapts.

## Recommended settings on this screen

### 1) Docstring Coverage
- **Mode:** `Warning` (for 2–4 weeks), then flip to `Error`
- **Threshold:** `70`
  - If you ship mostly internal libs / SDKs: use **80**
  - If you ship mostly product app code: **60–70** is usually right

### 2) Pull Request Title
- **Mode:** `Error` (titles are cheap to fix and hugely improve history/search)
- Paste this into **Requirements**:

:::writing{id="51231" variant="standard"}
**PR title rules**
- Must be **imperative** (e.g., “Add…”, “Fix…”, “Improve…”) and describe the outcome.
- Must include a scope prefix: **feat|fix|chore|refactor|docs|test|perf|build|ci|revert**
  - Format: `<type>(<scope>): <short description>`
  - Example: `fix(auth): prevent token refresh loop`
- No vague titles like: “updates”, “wip”, “stuff”, “changes”.
- If it’s a hotfix, include: `hotfix:` at the start.
- If it’s breaking, include: `!` after type (e.g., `feat!:`) and mention breaking details in the PR description.
:::

### 3) Pull Request Description
- **Mode:** `Error`
- Paste this as your description standard (keeps reviews fast and consistent):

:::writing{id="51232" variant="standard"}
**PR description must include:**
1) **What / Why**
- What changed and why now (1–3 bullets).

2) **How**
- Key implementation notes and any tradeoffs.

3) **Testing**
- What you tested + how to reproduce.
- Include commands, environment, and any relevant screenshots/logs.

4) **Risk & Rollout**
- Risk level: Low/Med/High.
- Rollout plan (feature flag, canary, migration steps) if applicable.

5) **Dependencies**
- Linked PRs, migrations, config changes, or follow-ups.

If any section is not applicable, explicitly write **N/A**.
:::

### 4) Issue Assessment
- **Mode:** `Warning` (start here; flip to `Error` once linking issues is habitual)
- This check is *only* useful if you force link coverage elsewhere—so pair it with the description rules above.
- (No text box here, so just keep it enabled.)

## A strong “perfect for org workflow” add-on (click **Add**)
Add 2–4 custom checks that enforce what actually hurts you in production. These are the ones that consistently pay off:

1) **Breaking Changes / Migration Notes**
- Error if DB schema, API contracts, auth, or config changes are present without a “Migration/Rollout” section filled out.

2) **Observability**
- Warning if meaningful backend changes have no logs/metrics/traces notes, or if new endpoints lack basic telemetry.

3) **Security Footguns**
- Error if secrets, private keys, tokens, or credentials appear in diffs.
- Error if authz-related files change without tests or explicit reviewer tag.

4) **Changelog / Release Notes**
- Warning if user-visible changes don’t include release notes (or a “No user impact” statement).

If you want, paste what your team ships (backend/frontend/mobile, monorepo vs multi, CI provider, whether you use Linear/Jira/GitHub Issues, and whether you require conventional commits) and I’ll tailor the thresholds + add-on checks to match your exact workflow.
