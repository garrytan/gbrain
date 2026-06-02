---
title: "Integration test coverage"
type: note
created: 2025-08-25
updated: 2025-08-25
source: chatgpt-export
conversation_id: 68acee01-b058-832d-b03a-54be7a40f5a4
message_count: 2
tags: [chatgpt, import]
---
# Integration test coverage

> Conversation ID: 68acee01-b058-832d-b03a-54be7a40f5a4
> Created: 2025-08-25T23:13:30Z
> Updated: 2025-08-25T23:14:00Z
> Messages: 2

---

## User

What parts of our app need integration tests

---

## Assistant

Mr. White — here’s the tight list. Integration tests = verify our modules talk to each other (no browser), with real DB schema and HTTP boundaries mocked via MSW.

# Must-cover (critical paths)
- **Auth handoff (Clerk ↔ App state)**
  - `POST /api/auth/webhook` → user created/linked → session propagated → protected pages render.
  - Token refresh/expired session → redirects to sign-in (we’ve had issues here).
- **Onboarding flow (multi-step)**  
  - Create account → pick handle → server-side handle uniqueness check → profile scaffolded in DB → lands on dashboard with correct initial data.
- **Profile media import (Instagram fallback)**
  - Provide IG handle with no avatar → service fetches image → stored (Cloudinary/S3) → profile shows cached URL.
- **Link ingestion & suggestions**
  - Paste Linktree/URL → scraper parses links → “Suggested links” appear in edit UI → save persists normalized records.
- **Creator public page build**
  - Given creator + links in DB → SSR route renders without console errors → canonical/OG tags present.
- **Stripe billing (we use Stripe directly)**
  - Create checkout session → webhook `checkout.session.completed` → plan applied → features unlocked.  
  - Billing portal return → plan unchanged.
- **Feature flags / plans**
  - Free vs Pro gating for advanced link types/analytics → server and client both enforce.
- **Analytics events pipeline**
  - Public “Listen/CTA click” → event queued (Upstash/queue) → worker writes to DB → dashboard query returns counts.
- **Webhook security**
  - Stripe + Clerk webhooks reject bad signatures; accept good → idempotency upheld.
- **File uploads**
  - Avatar/link artwork: client → upload endpoint → storage adapter → URL persisted; oversized/invalid type rejected.
- **Search/handle lookup**
  - `/api/handles/:name` fast path used by onboarding & edit → debounced UI uses same endpoint and respects reserved names list.

# Nice-to-have (high ROI)
- **Dashboard data model**
  - New user with 0 links → empty states render; with N links → cards render; pagination.
- **Edge/ISR cache correctness**
  - Publish update → revalidate path → public page shows new links within SLA; stale-while-revalidate doesn’t leak old data.
- **Error boundaries**
  - Upstream 5xx from scrapers/Stripe → user sees friendly state; no data loss.

# How to implement (quick)
- **Framework:** Vitest + React Testing Library + **MSW** for HTTP; run against a **real local DB schema** (Supabase/Postgres test db) via migrations.
- **Contracts:** Pact (or snapshot schemas) for Stripe/Clerk webhooks payloads.
- **Fixtures:** Factory/seed for `User`, `Creator`, `Link`, `Plan`, `Event`.
- **Files (example):**
  - `tests/integration/auth/webhooks.clerk.spec.ts`
  - `tests/integration/onboarding/flow.spec.ts`
  - `tests/integration/profile/instagram-import.spec.ts`
  - `tests/integration/links/suggestions.spec.ts`
  - `tests/integration/billing/stripe-checkout.spec.ts`
  - `tests/integration/webhooks/stripe-signature.spec.ts`
  - `tests/integration/analytics/pipeline.spec.ts`
  - `tests/integration/storage/uploads.spec.ts`
  - `tests/integration/render/public-profile-ssr.spec.ts`

# Mocks vs real
- **Real:** DB (test instance), server routers/validators, ISR/route handlers.
- **Mock:** Clerk SDK, Stripe SDK + webhooks (sign with test secret), IG/Linktree HTTP, Cloudinary/S3, Upstash/queue.

# Pass criteria (add to PR checklist)
- Seeded user can finish onboarding in one run.
- Webhooks are idempotent and signature-verified.
- No console errors during SSR of public/creator pages.
- Plan gating enforced server-side (API rejects) and client-side (UI hides).

If you want, I’ll stub these test files with MSW handlers and a test DB harness next.


## See Also
- [[chatgpt/chatgpt_test-coverage-for-atoms]]
- [[chatgpt/chatgpt_test-coverage-goal-design]]
- [[chatgpt/chatgpt_test-coverage-strategy]]
- [[chatgpt/chatgpt_accident-timing-and-coverage-part1]]
- [[chatgpt/chatgpt_accident-timing-and-coverage-part2]]
