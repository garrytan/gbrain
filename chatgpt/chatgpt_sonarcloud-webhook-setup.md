---
title: "SonarCloud Webhook Setup"
type: note
created: 2026-01-12
updated: 2026-01-12
source: chatgpt-export
conversation_id: 6965356b-7924-8330-bc09-388247b86bbd
message_count: 2
tags: [chatgpt, import, code]
---
# SonarCloud Webhook Setup

> Conversation ID: 6965356b-7924-8330-bc09-388247b86bbd
> Created: 2026-01-12T17:54:52Z
> Updated: 2026-01-12T17:55:30Z
> Messages: 2

---

## User

claude code sonarcloud hook

---

## Assistant

Mr. White — here’s how **SonarCloud webhooks/hooks work** and how you *code/integrate* them (including using Claude-style tools if that’s part of your flow).

---

## What a SonarCloud Webhook Is

A **webhook** in SonarCloud is simply an HTTP callback that SonarCloud calls (HTTP POST with JSON) when an analysis finishes (like after a pull request scan). This lets your own service listen for results and act on them (e.g., update a status dashboard, trigger other automation). citeturn0search8

SonarCloud supports webhooks similar to SonarQube — you create them in the project **Administration → Webhooks** and provide:

- **Name**
- **URL** (your listener endpoint)
- **Secret** (optional, for verifying payloads)
- **Signature header (`x-sonar-webhook-hmac-sha256`)** and **algorithm** (usually `sha256`) citeturn0search8

---

## Setting Up a SonarCloud Webhook

1. **Create Your Endpoint (receiver)**  
   A simple Node/Express example:

   ```js
   import express from 'express';
   import crypto from 'crypto';

   const app = express();
   app.use(express.json());

   const secret = process.env.WEBHOOK_SECRET;

   function verifySignature(req) {
     const sig = req.headers['x-sonar-webhook-hmac-sha256'];
     const hmac = crypto.createHmac('sha256', secret);
     hmac.update(JSON.stringify(req.body), 'utf8');
     return sig === hmac.digest('hex');
   }

   app.post('/sonarcloud-webhook', (req, res) => {
     if (!verifySignature(req)) {
       return res.status(401).send('Invalid signature');
     }
     // Handle payload
     console.log('SonarCloud webhook:', req.body);
     res.status(200).send('OK');
   });

   app.listen(8080);
   ```

   - Verify with the secret and `x-sonar-webhook-hmac-sha256`.
   - Return `200 OK` so SonarCloud stops retries. citeturn0search8

2. **Configure in SonarCloud**
   - In your project’s **Administration → Webhooks** create a new one.
   - Enter your listener URL and secret.
   - Save it — SonarCloud will POST payloads when analyses complete. citeturn0search8

3. **Test**  
   Use `curl` or a tool like ngrok to test delivery.

---

## If You Mean “SonarCloud Hook in CI/CD”

Sometimes “hook” means **blocking a merge until SonarCloud quality gate passes**. With GitHub Actions, Azure DevOps, GitLab CI, etc., that’s done through:

- Built-in integrations that register webhooks automatically when you configure SonarCloud analysis. citeturn0search15

---

## Claude Code Integration (AI-Assisted)

There’s a thing called an **MCP Server** that can let tools like **Claude Code fetch SonarCloud issues programmatically** (not strictly a webhook, but related automation). Put a JSON/Markdown tool file under Claude’s tools folder to let Claude query SonarCloud APIs for issues and act on them. citeturn0search0turn0search23

Example (in `.claude/tools/sonarcloud-issues.md`):

```
# Fetch SonarCloud issues for a PR
# usage: sonarcloud-issues org=<org> project=<key> pr=<number> token=<token>
```

This package lets Claude pull issues and suggest fixes automatically.

Also useful: **npm package `sonarqube-claude-tools`** for CLI interactions via Claude. citeturn0search19

---

## Summary

- **Webhook = HTTP POST** from SonarCloud after analysis.  
- **Configure it in UI** (Administration → Webhooks). citeturn0search8  
- Your server must **receive, verify HMAC, and respond 200**.  
- “Claude Code hook” usually means using **MCP tools to query SonarCloud APIs** programmatically. citeturn0search0

---

If you want a **specific CI example** (e.g., GitHub Actions YAML that sets up SonarCloud and webhook logic), just tell me your CI platform.
