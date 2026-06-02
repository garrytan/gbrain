---
title: "Sentry in CI for E2E"
type: note
created: 2026-02-24
updated: 2026-02-24
source: chatgpt-export
conversation_id: 699e002b-2afc-8328-9183-6c1324db24eb
message_count: 2
tags: [chatgpt, import]
---
# Sentry in CI for E2E

> Conversation ID: 699e002b-2afc-8328-9183-6c1324db24eb
> Created: 2026-02-24T19:47:34Z
> Updated: 2026-02-24T19:48:01Z
> Messages: 2

---

## User

Yo, iPhone, if I'm running E2E tests in CI, would it be a good idea to add Sentry coverage in CI and then have, like, the E2E tests run in chaos mode so that everything is sent to Sentry on every CI run prior to deployment, or is that a bad idea?

---

## Assistant

Mr. White — sending **everything** to Sentry on **every CI E2E run** (especially in “chaos mode”) is usually a **bad idea**.

### Why it’s usually bad
- **Signal gets drowned**: You’ll create tons of expected errors/exceptions that look like real regressions unless you build heavy filtering.
- **Cost + rate limits**: Sentry quotas get eaten fast; events can get dropped right when you actually need them.
- **Flaky pipelines**: Chaos + E2E is already variance-heavy; adding “must report to Sentry” makes failures harder to interpret and increases false alarms.
- **Misleading health metrics**: You’ll pollute release health, crash-free rates, and alert baselines with synthetic failures.
- **Security/PII risk**: Test data often includes fake-but-realistic payloads that you don’t want stored long-term unless scrubbed perfectly.

### What *is* a good idea
Use CI to validate that **Sentry instrumentation works**, but keep it **intentional and scoped**:

1. **Have a dedicated “CI/Testing” Sentry project or environment** (`environment=ci`), separate from prod/stage.
2. **Send only what you need** during CI:
   - A small number of **intentional, tagged test exceptions** (e.g., one per suite) to prove end-to-end wiring.
   - Optionally a **performance transaction** or two to confirm tracing is hooked up.
3. **Hard-tag everything from CI**: `ci_run_id`, `git_sha`, `test_name`, `build_url`, `synthetic=true`.
4. **Keep CI mostly “clean”**: Use E2E to catch functional regressions; don’t turn the run into a firehose of errors.
5. **Do chaos testing separately**:
   - Run chaos/fault-injection **nightly** or on-demand (or for release candidates), not on every PR.
   - Send chaos results to the **ci/stress** environment and create **separate alerts/dashboards** for it.

### A practical setup that works well
- **PR CI**: normal E2E + *one* synthetic Sentry error and *one* synthetic transaction (to prove integration).
- **Main branch / nightly**: chaos E2E (timeouts, dropped requests, retries, injected 5xx, killed dependencies) with Sentry enabled in `environment=chaos`.
- **Pre-deploy gate (optional)**: run a smaller chaos smoke set (5–10 minutes) if you really want a safety net.

### Key guardrails if you do chaos + Sentry
- Disable/segregate **alerts** for chaos env.
- Use **sampling** aggressively (errors 100% if you must, but transactions sampled; breadcrumbs limited).
- Ensure **scrubbing** is correct (headers, tokens, user data) before any of this.

If you tell me your stack (web/mobile/backend) and whether you use Sentry performance + replays, I can suggest the exact minimum CI events/transactions that give high confidence without turning your Sentry into a dumpster fire.
