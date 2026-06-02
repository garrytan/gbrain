---
title: "Claude code api errors"
type: guide
created: 2025-09-02
updated: 2025-09-02
source: chatgpt-export
conversation_id: 68b75bbc-ae80-8323-a7df-6380fa901408
message_count: 2
tags: [chatgpt, import, code]
---
# Claude code api errors

> Conversation ID: 68b75bbc-ae80-8323-a7df-6380fa901408
> Created: 2025-09-02T21:04:02Z
> Updated: 2025-09-02T21:04:58Z
> Messages: 2

---

## User

Claude code is throwing lots of api errors

---

## Assistant

Mr. White — here’s a fast, ruthless triage to kill “API errors” from Claude Code.

# 1) Identify the failure class
- **Open the Claude Code log** (VS Code): `⌘⇧P → Developer: Toggle Developer Tools → Console` and `View → Output → Claude Code`.
- Note the exact HTTP status + snippet. Map it:

**401/403 (auth/org)**
- Wrong/expired key or wrong org.
- Fix: ensure `ANTHROPIC_API_KEY` is set in the *environment that launches VS Code/CI*, not just a shell.
- If you have multiple Anthropic orgs, export: `ANTHROPIC_ORG_ID=org_...`.

**429 (rate limit)**
- You’re bursting too hard (local + CI agents).
- Fix: enable client-side backoff: jittered exponential retry (e.g., 200ms → 3.2s, max 5 tries). Stagger CI agent calls.

**400 (bad request / schema)**
- Common: missing required fields, invalid `max_tokens`, tool schema errors, or sending streams + non-stream handler.
- Fix: validate payloads; keep tool schemas strictly JSON-schema compatible; don’t exceed context window; ensure `max_tokens` > 0.

**413/422 (context/output too big)**
- You’re stuffing giant diffs or logs.
- Fix: chunk files; summarize before send; cap attachment bytes.

**5xx/529 (upstream)**
- Temporary provider issue.
- Fix: retry w/ backoff; fail soft in CI; show user-facing toast, keep queue.

# 2) Quick health checks
- **Key sanity**  
  ```bash
  echo $ANTHROPIC_API_KEY | wc -c   # should be ~ 48–56 chars (not empty)
  ```
- **Minimal curl** (rules out extension bugs):
  ```bash
  curl https://api.anthropic.com/v1/messages \
    -H "x-api-key: $ANTHROPIC_API_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d '{"model":"<valid-model>","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'
  ```
  If this fails, it’s auth/network, not your code editor.

- **Network**  
  VPN/proxy/corp TLS can block websockets/HTTP2. Try a different network or `HTTP/1.1` fallback if your client supports it.

# 3) VS Code / Claude Code setup pitfalls
- **Workspace trust**: VS Code must “Trust” the workspace or the extension won’t read env vars.
- **Env propagation**: If you launch VS Code from the Dock, it may not inherit shell envs. Fix by:
  - macOS: `launchctl setenv ANTHROPIC_API_KEY <key>` then restart, or launch VS Code from a terminal that has the env.
- **Conflicting extensions**: Temporarily disable other AI extensions to rule out interception.
- **Tooling permissions**: If Claude Code is set to “apply edits / run commands,” ensure it isn’t blocked by VS Code settings (`security.workspace.trust.enabled`, `git` permissions).

# 4) CI-specific gotchas (you’ve got a busy pipeline)
- **Secrets scope**: In GitHub Actions, ensure secrets are available to *pull_request from forks* only if you intend to (usually no). For internal PRs:
  ```yaml
  permissions:
    contents: read
    pull-requests: write
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  ```
- **Retry & budget**:
  ```yaml
  # pseudo
  with_retries: 5  # backoff 0.2, 0.4, 0.8, 1.6, 3.2s
  max_tokens: 2048 # keep conservative in CI
  ```
- **Concurrency**: Limit parallel jobs invoking the API (e.g., `concurrency: claude-ci`).

# 5) Payload hygiene (most common 400s)
- **Token/length control**: Don’t dump full repos; send file slices. Summarize large diffs before asking for refactors.
- **JSON correctness**: Ensure no trailing commas, correct types, valid tool schemas.
- **Streaming**: If you set `stream=true`, actually consume the SSE stream; otherwise server may drop.

# 6) Guardrails you can ship today
- **Global client wrapper** with:
  - Standard headers and model name in one place.
  - Jittered exponential retries on 429/5xx.
  - Circuit breaker: after N hard failures in 60s, degrade gracefully.
  - Telemetry: log `status`, `rate_limit-remaining`, `context_tokens`, `output_tokens`.
- **Rate-limit policy**:
  - Editor: 1 req/user at a time; queue others.
  - CI: serialize Claude steps or cap to 2 concurrency.
- **Redaction**: Strip secrets from prompts/logs.

# 7) Fast decision tree
1) **Curl succeeds** but VS Code fails → env/extension config. Fix workspace trust + env propagation.  
2) **Curl fails 401/403** → key/org. Rotate key; set `ANTHROPIC_ORG_ID`.  
3) **429s** → add backoff + reduce concurrency.  
4) **400s** → shrink/request; validate payload; cap `max_tokens`; fix tool schemas.  
5) **5xx/529** → retries + graceful degradation.

If you paste one concrete error line (status code + first line of the message), I’ll pinpoint the exact fix.
