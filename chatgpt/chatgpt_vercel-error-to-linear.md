---
conversation_id: 69482283-b900-8332-be3e-39716daa0208
created: 2025-12-21
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Vercel error to Linear
type: guide
updated: 2025-12-21
---

# Vercel error to Linear

**Related:** [[coding_devops]]

> Conversation ID: 69482283-b900-8332-be3e-39716daa0208
> Created: 2025-12-21T16:38:28Z
> Updated: 2025-12-21T16:39:46Z
> Messages: 4

---

## User

can i have all vercel ogs that are errors automatically get sent to linear and ai agent assigned?

---

## Assistant

Yes — you can automatically take **Vercel og-image errors (OGs that fail)**, send them to **Linear**, and even have an **AI agent assign the ticket**. The general approach is:

1. **Capture the error event from Vercel/Edge Function**
2. **Filter for og-image failures**
3. **Send a formatted issue to Linear via API**
4. **Use an AI (GPT) to assign/triage the issue**

Below is a clear implementation pattern.

---

## HOW IT WORKS (HIGH LEVEL)
1. **Vercel logs errors** from your OG generator endpoint.
2. A middleware/handler catches errors and posts them to a serverless function.
3. The function calls **Linear’s API** to create a ticket.
4. The function also sends the description to an **AI (ChatGPT) agent** to choose an assignee and labels.

---

## REQUIRED TOOLS
- **Vercel Serverless / Edge Functions**
- **Linear API token**
- (Optional) **OpenAI API token** to run AI assignment logic
- Storage/queue (e.g., Upstash Redis / Cloudflare Queues) if high volume

---

## STEP 1 — CATCH OG ERROR IN YOUR VERCEL HANDLER

In your OG generation endpoint:

```js
// vercel/og.js
export default async function handler(req, res) {
  try {
    // your OG generation
  } catch (error) {
    // send error event
    await fetch(`${process.env.ERROR_WEBHOOK}`, {
      method: "POST",
      body: JSON.stringify({
        path: req.url,
        message: error.message,
        stack: error.stack,
        timestamp: Date.now()
      }),
    });
    res.status(500).send("OG generation failure");
  }
}
```

Set `ERROR_WEBHOOK` to a backend that will create Linear issues.

---

## STEP 2 — CREATE A SERVERLESS FUNCTION TO CREATE LINEAR ISSUES

Example Vercel function:

```js
import fetch from "node-fetch";

export default async function handler(req, res) {
  const { path, message, stack, timestamp } = await req.json();

  const title = `OG Error: ${path}`;
  const body = `
**Error Message:** ${message}

**Stack:**\`\`\`
${stack}
\`\`\`

**Time:** ${new Date(timestamp).toISOString()}
  `;

  // First get AI suggested assignee/labels
  const aiPayload = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4.1",
      messages: [
        { role: "system", content: "You are an expert dev triaging Vercel OG errors into Linear." },
        {
          role: "user",
          content: `Suggest an assignee and labels for this error:\nTitle: ${title}\nBody:\n${body}`
        }
      ],
      max_tokens: 60
    })
  }).then(r => r.json());

  const suggestion = aiPayload.choices[0].message.content.trim();
  const [assignee, labels] = suggestion.split("|").map(s => s.trim());

  // Create the Linear issue
  const linearRes = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.LINEAR_API_KEY}`
    },
    body: JSON.stringify({
      query: `
mutation IssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    issue { id url }
  }
}`,
      variables: {
        input: {
          title,
          description: body,
          assigneeId: assignee || null,
          labelIds: labels ? labels.split(",") : []
        }
      }
    })
  }).then(r => r.json());

  return res.status(201).json(linearRes);
}
```

---

## STEP 3 — SET ENVIRONMENT VARIABLES

| Variable | Purpose |
|----------|---------|
| `LINEAR_API_KEY` | Your Linear personal API Key |
| `OPENAI_API_KEY` | For AI assignment |
| `ERROR_WEBHOOK` | URL of the above function |

---

## OPTIONAL — SMOOTHER ERROR QUEUE (HIGH VOLUME)
If your OG endpoint errors often, send to a **queue** (Upstash Redis / Cloudflare Queue) instead of immediate HTTP. Then a worker picks them up and creates Linear issues in batches.

---

## AI Triage PROMPT EXAMPLE
You want the AI to output something like:

```
assignee: user_linear_id
labels: frontend, og-image
```

Train the system by example:

```
User: OG fails for missing env var OG_FONT_PATH
AI: assignee: 12345678 label: infra, urgent
```

Use the response to set `assigneeId` and `labelIds`.

---

## TEST IT
1. Force an OG error (invalid param).
2. Watch your serverless function receive a webhook.
3. Confirm a ticket appears in Linear with assignee/labels.

---

## MAINTENANCE TIPS
- Rate-limit errors so you don’t spam Linear
- Store dedup keys (Redis) to avoid repeat tickets
- Validate AI assignment suggestions

---

If you want, I can provide a **ready-to-deploy template** (GitHub repo) for this flow.

---

## User

we use sentry. is there a way to do with sentry?

---

## Assistant

Yes, Mr. White — **this is cleanly doable with Sentry**, and it’s actually the *right* place to do it.

You can route **only OG-related errors** from **entity["company","Sentry","error monitoring platform"]** into **entity["company","Linear","issue tracking tool"]**, and use an **AI agent for auto-assignment + labeling**.

Below is the **production-grade setup**.

---

## Architecture (Sentry-native)

**Flow**
1. Vercel OG error → captured by Sentry  
2. Sentry **Alert Rule** filters OG failures  
3. Alert sends **Webhook** to your service  
4. Webhook:
   - deduplicates
   - calls AI for triage
   - creates/updates Linear issue

No log scraping. No Vercel hacks.

---

## Step 1 — Tag OG Errors in Sentry (critical)

In your OG handler, add **structured tags** so Sentry can filter precisely:

```ts
import * as Sentry from "@sentry/nextjs";

try {
  // OG generation
} catch (err) {
  Sentry.captureException(err, {
    tags: {
      feature: "og-image",
      runtime: "edge",
      surface: "vercel-og",
    },
    extra: {
      url: req.url,
      params: Object.fromEntries(req.nextUrl.searchParams),
    },
  });
  throw err;
}
```

This is what enables **surgical routing**.

---

## Step 2 — Create a Sentry Alert Rule

In Sentry:

- **Alerts → Create Alert**
- Type: **Issues**
- Conditions:
  - `event.tags.feature = og-image`
  - (optional) `environment = production`
- Frequency:
  - `>1 event in 5 minutes`
- Action:
  - **Send a webhook**

Webhook payload includes:
- issue title
- stacktrace
- event ID
- environment
- tags
- culprit

---

## Step 3 — Webhook → AI → Linear

Your webhook service does 3 things:

### 1️⃣ Deduplicate
Use:
- `issue.id` (best)
- or `culprit + stacktrace hash`

Avoid Linear spam.

---

### 2️⃣ AI Assignment (deterministic, not vibes)

Prompt example:

```
You are a senior EM.

Given this Sentry OG-image error, return JSON only:
{
  "assignee": "<linear_user_id>",
  "priority": "P0|P1|P2",
  "labels": ["frontend","infra","og"]
}

Rules:
- Font, image, fetch, edge-runtime → frontend
- Timeout, memory, cold start → infra
- Production breakage → P0
```

This keeps it **repeatable and auditable**.

---

### 3️⃣ Create or Update Linear Issue

- Use `externalId = sentry_issue_id`
- If exists → comment + bump priority
- Else → create issue

Key fields:
- Title: `OG Error: ${sentry_issue_title}`
- Description:
  - stacktrace
  - Sentry issue URL
  - affected route(s)
- Labels from AI
- Assignee from AI

---

## Step 4 — Optional: Bi-directional Sync (worth it)

Enhancements:
- When Linear issue is **closed** → auto-resolve Sentry issue
- When error reappears → reopen Linear issue + comment

This keeps signal clean.

---

## Why This Is Better Than Vercel Logs

| Aspect | Sentry | Vercel Logs |
|------|-------|------------|
| Deduplication | ✅ native | ❌ manual |
| Alerting | ✅ | ❌ |
| Stacktraces | ✅ full | ⚠ partial |
| Filtering | ✅ tags | ⚠ brittle |
| Ownership | ✅ | ❌ |

---

## Common Pitfalls (avoid these)

- ❌ Sending *every* Sentry error → Linear  
- ❌ No deduplication  
- ❌ Letting AI choose assignees without constraints  
- ❌ No severity gating  

---

## Bottom Line

**Yes — Sentry is the correct system of record.**  
Use:
- Sentry for **signal**
- AI for **triage**
- Linear for **ownership**

If you want, I can:
- give you a **drop-in webhook service**
- write the **exact Sentry alert JSON**
- or design a **zero-spam dedup strategy**

Just say which.


**Topic:** [[chatgpt-clusters/coding_devops]]
