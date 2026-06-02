---
title: "Sentry to GitHub/Linear Integration"
type: note
created: 2025-12-29
updated: 2025-12-29
source: chatgpt-export
conversation_id: 6951c85a-818c-8328-b94c-14b43e170729
message_count: 6
tags: [chatgpt, import, long-form]
---
# Sentry to GitHub/Linear Integration

> Conversation ID: 6951c85a-818c-8328-b94c-14b43e170729
> Created: 2025-12-29T00:16:48Z
> Updated: 2025-12-29T00:24:36Z
> Messages: 6

---

## User

Create a github or linear issue everytime sentry picks up an error.

^best way to achieve?

---

## Assistant

Mr. White — best pattern is **Sentry → Alert rule → Webhook → small “issue-creator” service → GitHub/Linear API**. That gives you control (dedupe, routing, severity mapping) and avoids creating thousands of duplicate tickets.

### The recommended architecture
1. **In Sentry:** create an **Alert Rule** (typically “Issue Alert” / “Metric Alert” depending on your setup) that triggers on:
   - first seen, or
   - spikes/regressions, or
   - only when it becomes “new + high severity”
2. **Send to a webhook** you control (Cloudflare Worker / AWS Lambda / GCP Cloud Run / tiny Express app).
3. **In the webhook handler:**
   - **Deduplicate** (key on `project + issue_id` or `fingerprint`) so you create *one* ticket per Sentry issue (and optionally reopen/update instead of creating new).
   - **Map fields**: Sentry title, culprit, environment, release, tags, stacktrace URL, event URL.
   - **Route**: choose repo/project/team based on Sentry project, environment, service name.
4. **Create the ticket**
   - **GitHub:** Create Issue via REST API (or GraphQL), add labels, assignees, link back to Sentry issue.
   - **Linear:** Create Issue via GraphQL, set team, priority, labels, and store Sentry issue link.
5. **Persist a mapping table** `{sentry_issue_id → github_issue_number}` or `{→ linear_issue_id}` in KV/DB so repeats update the existing ticket.

### Why not “direct integration only”?
- Sentry does have built-in integrations for many tools, but **the moment you want sane dedupe + routing + only-create-once behavior**, a thin webhook layer is usually cleaner and more reliable.
- It also lets you implement rules like:
  - only create tickets for `prod`
  - only if `level >= error` and `events > N`
  - auto-close ticket when Sentry issue is resolved (optional)

### Practical “best” implementation options (pick one)
**A) Cloudflare Worker (fastest + cheap)**
- Webhook endpoint + KV store for dedupe mapping.
- Call GitHub REST or Linear GraphQL.

**B) AWS Lambda + DynamoDB**
- Very standard enterprise pattern; solid reliability.

**C) Small service in your backend**
- If you already have an API service, add `/webhooks/sentry` and a small DB table.

### Key details to get right
- **Trigger condition:** don’t create on every event; create on “new issue” or “issue becomes critical”.
- **Idempotency:** store a dedupe key; otherwise you’ll spam issues.
- **Security:** verify webhook signature (or at least shared secret header) and rate-limit.
- **Noise controls:** ignore known flaky errors, filter by environment/release, threshold by event count.

### If you want the simplest starting setup
1) Sentry alert → webhook  
2) webhook creates issue only if `sentry_issue_id` not seen before  
3) add Sentry link + environment + release into the ticket body  
4) store mapping in KV/DB

If you tell me which you prefer (**GitHub**, **Linear**, or **both**) and what runtime you’d rather use (**Cloudflare Worker, Lambda, or your existing backend**), I’ll give you the exact webhook payload assumptions + a ready-to-deploy handler template (with dedupe + labels + priorities).

---

## User

Do other startups do that? Do you have examples of how they use it

---

## Assistant

Yes, lots of startups do some version of this — but almost none create a ticket for **every single error event**. They usually create **one ticket per new Sentry issue (fingerprint)**, with guardrails to keep noise down.

### Common real-world patterns startups use

**1) “Auto-create a Linear issue when a new Sentry issue hits prod (and is serious)”**
- Typical rule: *new issue OR regression* + `environment=prod` + severity/volume threshold.
- Create the Linear ticket with priority/labels/team set, and include the Sentry issue link + release + top stacktrace.
- Many teams then rely on the integration’s bidirectional behavior (e.g., closing the Linear issue can resolve the Sentry issue). citeturn0search2turn0search9turn0search12

**2) “Create GitHub issues from Sentry alerts (and route via CODEOWNERS)”**
- Flow: Sentry alert fires → action “Create a new GitHub issue” in the right repo, with labels like `bug`, `sentry`, `prod`.
- Teams often pair this with ownership routing (CODEOWNERS) so the right squad gets it quickly. citeturn0search5turn0search1turn0search25

**3) “Auto-create Jira tickets only when impact is proven” (high signal, lower noise)**
- A lot of orgs use “issue impact / users affected / frequency spike” conditions before creating a ticket, rather than first-seen.
- Sentry’s Jira integration explicitly supports “Automatically Create Jira Tickets” based on Issue Alerts. citeturn0search3turn0search7

**4) “Custom webhook service for smarter dedupe + routing”**
- Common once they have multiple services/teams: Sentry → webhook → small service that:
  - dedupes (one ticket per Sentry issue)
  - routes by `service`, `team`, `environment`
  - updates an existing ticket instead of creating new
- Sentry supports issue webhooks for “issue created / state changes” type events for building this. citeturn0search0turn0search8

**5) “No-code automation for early-stage teams”**
- Some teams prototype with tools like n8n to wire Sentry ↔ Linear without writing the webhook service. citeturn0search22

### The practical takeaway
If your goal is “every time Sentry picks up an error,” startups usually interpret that as **every new Sentry issue** (unique problem), not every occurrence. Otherwise you’ll drown in tickets within a day.

If you tell me whether you’re leaning **Linear or GitHub**, I’ll give you a best-practice rule set (conditions + dedupe key + labels/priorities) that matches what most teams do in production.

---

## User

We use linear. Every new issue should create a linear issue

---

## Assistant

Mr. White — yes. If you want **every new Sentry Issue (fingerprint) → create a Linear issue**, the cleanest way is the **native Sentry↔Linear integration + an “Issue Alert” with “WHEN: A new issue is created.”** citeturn1view2turn1view1turn4view1

## Setup (native, no code)

### 1) Enable Sentry in Linear
- Linear → **Settings → Workspace → Integrations → Sentry → Enable**. citeturn1view1  
**Gotchas:**
- The integration **doesn’t support private Linear teams** (only public teams show up). citeturn1view1  
- It’s **cloud-only** (not self-hosted Sentry). citeturn1view1  

### 2) Install/authorize Linear in Sentry
- In Sentry, add the **Linear** integration (you’ll authorize access). citeturn1view2turn2search5  

### 3) Create an Issue Alert that fires on “new issue”
For each Sentry project:
- Sentry → **Project Settings → Alerts → Issue Alerts**
- Create rule:
  - **WHEN:** *A new issue is created*
  - **THEN:** notify the integration (Linear) / create Linear issue
- Use **Send Test Notification** to confirm it’s working. citeturn4view1turn1view1  

That’s it: with **WHEN = new issue**, you’ll get **one Linear issue per new Sentry Issue** (not one per event). citeturn4view1turn1view2

## Two quick knobs (optional, but usually worth it)
- Filter to `environment=production` to avoid dev noise (unless you truly want everything).
- Decide routing: which **Linear team / labels / priority** Sentry should set on creation. citeturn1view2turn2search5  

If you tell me your Sentry project list (or naming convention) and which Linear team should own each, I’ll give you a tight routing scheme (labels/priorities) that stays low-noise while still being “every new issue.”


## See Also
- [[chatgpt/chatgpt_sentry-ai-sdk-integration]]
- [[chatgpt/chatgpt_sentry-csp-integration]]
- [[chatgpt/chatgpt_sentry-linear-integration-issues]]
- [[chatgpt/chatgpt_ai-command-palettes-integration]]
- [[chatgpt/chatgpt_analytics-integration-advice]]
