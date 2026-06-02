---
title: "Onboarding Chat Plan"
type: essay
created: 2026-05-11
updated: 2026-05-11
source: chatgpt-export
conversation_id: 6a014066-b9e8-83e8-a7d7-0c37389858de
message_count: 2
tags: [chatgpt, import, long-form]
---
# Onboarding Chat Plan

> Conversation ID: 6a014066-b9e8-83e8-a7d7-0c37389858de
> Created: 2026-05-11T02:35:20Z
> Updated: 2026-05-11T04:33:39Z
> Messages: 2

---

## User

harden this plan and generall y improve it. interview me for clarity. shape it based on what you know about jovie and our goals and what world class onbaording is like.<!-- /autoplan restore point: /Users/timwhite/.gstack/projects/JovieInc-Jovie/itstimwhite-onboarding-chat-redesign-autoplan-restore-20260510-191359.md -->
# Jovie Front Door — Unified AI Chat (Interview → Qualify → Waitlist/Onboard → Checkout)

## Context

The current `/waitlist` screen (`apps/web/components/features/waitlist/WaitlistIntakeChat.tsx`) is a rigid 7-step form-in-chat-clothing with a dead "Saved Context: Not Set" sidebar. It feels like a survey, not a conversation, and it dumps users to an email-approval limbo before they ever see the product. Meanwhile the authenticated app already has a fully production-grade AI chat (`apps/web/components/jovie/JovieChat.tsx`) with slash commands, popout pickers, entity chips, tool widgets, streaming, audit logging, and conversation persistence — and it's invisible to anyone pre-account.

This plan consolidates both: **the redesigned front door IS the Jovie AI chat**. An LLM-driven conversation (Stanley-style) interviews/qualifies/objection-handles/mom-tests, uses tool calls for deterministic work (Spotify search, handle check, social linking, plan picking), records the whole transcript for learning, and progressively reveals the Jovie app shell around the conversation as the user builds their profile. By the end, they're already inside the dashboard — checkout is the last natural step, not a wall.

Outcome we want:
- New visitor lands in a calm, near-empty shell. One bubble appears: Jovie says hi.
- LLM drives the conversation, calling tools when it needs facts/actions.
- Lead with a Spotify search wow moment — picking the artist instantly populates an emerging profile preview.
- Handle check, social linking happen via the chat's existing popout pickers, not separate form fields.
- The app shell reveals progressively: nav collapses → profile preview card slides in → tool widgets appear → eventually the full dashboard is around them.
- LLM qualifies via natural conversation (no "what's your biggest blocker" survey field). Waitlist/instant-access decision is a tool call the LLM makes based on signal.
- Checkout proposed as the final reveal, in-flow.
- Every turn logged to `chatConversations` / `chatMessages` so we keep learning.

---

## Architecture

### Single chat surface, multi-mode

Extend `JovieChat` (and `executeChatTurn` in `apps/web/lib/chat/run.ts`) with a `mode` concept:

- `mode: 'onboarding'` — pre-account / pre-payment. Limited tool palette focused on discovery + qualification + profile-build. Conversation persists tied to a `sessionToken` cookie until the user creates a Clerk account mid-flow.
- `mode: 'app'` — existing authenticated mode. Unchanged.

The route `/waitlist` is renamed/aliased to `/start` (keep `/waitlist` as redirect). It renders `JovieChat` in `onboarding` mode inside a new `OnboardingShell` wrapper that handles the cinematic reveal.

### New tools (added to `apps/web/lib/chat/tool-schemas.ts`)

LLM picks when to call these; UI renders them as popout cards. Tool metadata (Zod schema for the JSONB payload of `recordInterviewSignal`) lives in `apps/web/lib/chat/tools/onboarding-signals.ts` so analytics can rely on a defined shape.

| Tool | Purpose | UI surface |
|---|---|---|
| `searchSpotifyArtist` | Inline artist picker (reuses `WaitlistSpotifySearch` popout UX inside chat) | Popout suggestion card with verified badge, follower count, image — keyboard nav |
| `confirmSpotifyArtist` | Lock the picked artist; pulls full enrichment (avatar, monthly listeners, latest release, genres) | Triggers profile-preview reveal via UI state subscription (see "Reveal state derivation" below) |
| `checkHandle` | Live availability check via `/api/handle/check` with debounce + suggested alternates | Inline input chip with green-check / red-x + suggestions |
| `proposeSocialLink` | Already exists. Reuse for socials, but feed it suggested URLs from typed shorthand (`@name` → instagram/tiktok/twitter picker) | Existing card |
| `recordInterviewSignal` | LLM stores qualifying signals to `chatConversations.metadata` JSONB (Zod-shaped) | No UI |
| `evaluateAccessSignal` | **Deterministic server function (not an LLM tool).** Scores accumulated signal + Spotify follower band → returns `instant_access` / `waitlist` / `needs_more_info`. Called by `proposeNextStep`. | None |
| `proposeNextStep` | LLM tool that calls `evaluateAccessSignal` internally, then renders the appropriate next card (checkout, waitlist confirmation, "tell me one more thing"). | Card varies by decision |
| `proposeCheckout` | Renders the checkout card. Default UI is a button opening a `/onboarding/checkout` route handoff; Stripe Embedded Checkout iframe is gated behind a separate flag pending verified CSP `frame-src` + return-URL handling in PR4 QA. | Button → dialog or full route |

`proposeAvatarUpload`, `generateAlbumArt`, `submitFeedback` remain available but gated to authenticated state.

**Deleted from earlier draft:** `revealProfilePreview` was removed. Reveal state is derived purely from accumulated tool-call results, not from an LLM-callable tool. This prevents the model from misfiring choreography (revealing before data exists, double-reveals, etc.).

### Reveal state derivation (single source of truth)

Reveal stage = `f(toolCallHistory)`:

| Stage | Trigger predicate (pure function over tool history) |
|---|---|
| 0 — Hush | Initial mount, before any user message |
| 1 — Listening | First user message sent |
| 2 — Identified | A `confirmSpotifyArtist` result exists |
| 3 — Building | `checkHandle` returned `available: true` AND `proposeSocialLink` resolved at least once |
| 4 — Inhabited | `proposeNextStep` resolved with `instant_access` |
| 5 — Checkout | User accepted the checkout card from `proposeNextStep` |

No LLM tool controls reveal. The shell renders this state machine off the conversation transcript.

### Deterministic fallback per tool (LLM drift containment)

Every tool above has a UI escape hatch that lets the user complete the step deterministically without LLM mediation:

| Tool | Escape hatch |
|---|---|
| `searchSpotifyArtist` | "Let me pick myself" link → static search input with the same `/api/spotify/search` endpoint |
| `checkHandle` | Free-text input in profile preview card; same `/api/handle/check` API |
| `proposeSocialLink` | Platform picker dropdown + URL input |
| `proposeNextStep` | Default to `waitlist` if `evaluateAccessSignal` returns `needs_more_info` after 3 turns; never block forever |
| `proposeCheckout` | Falls back to redirecting to `/onboarding/checkout` (the existing route) |

The kill-switch flag turns off the whole `onboarding_chat_v2` surface and falls back to `/waitlist` (kept alive until PR4 merges — see "PR3 rollback contract").

### LLM prompt / system message

A new system prompt in `apps/web/lib/chat/prompts/onboarding.ts`:
- Voice: confident, warm, sharp — not customer-service polite, not over-eager. Inspired by Stanley.
- Goals in order: (1) make them feel seen in <30s via Spotify pick, (2) mom-test their current workflow with one open question, (3) build a tangible profile preview, (4) qualify access tier, (5) propose checkout or waitlist.
- Handles meta-questions ("what is this?", "how much?", "why should I trust you?") inline without breaking flow.
- Never asks more than one question per turn. Never lists "next steps." Speaks in short messages.
- Knows when to shut up and let a tool widget do the work.

Use existing model selector — Sonnet 4.6 default, Haiku for trivial routing turns. Add an evaluator (post-hoc) that flags transcripts where the LLM strayed from spec for prompt iteration.

### Cinematic shell reveal

New `OnboardingShell` component (`apps/web/components/features/onboarding/OnboardingShell.tsx`) wraps `JovieChat` and exposes a reveal state machine:

| Stage | Trigger | Visible chrome |
|---|---|---|
| 0 — Hush | Initial load | Black canvas, single chat bubble, no nav, no preview, faint Jovie wordmark top-left |
| 1 — Listening | After first user reply | Compose input fades in, transcript area expands |
| 2 — Identified | After `confirmSpotifyArtist` tool resolves | Profile preview card slides in from right (mobile: above chat); avatar + name + monthly listeners populate |
| 3 — Building | After `checkHandle` succeeds + first social linked | Profile preview gains handle, social chip, sample release; faint dashboard nav appears at left edge collapsed |
| 4 — Inhabited | After `proposeAccessDecision = instant_access` | Full app shell renders around chat — nav expands, secondary cards (Analytics, Releases, Audience) fade in muted; chat docks into a side panel |
| 5 — Checkout | After user accepts plan | Stripe checkout card renders inline; on success, full dashboard at `/app/dashboard` |

Each transition uses `motion/react` (already imported in JovieChat) — 240–360ms ease-out, no decorative bounce (per `.claude/rules/ui.md` "No Decorative Hover Motion"). Respect `prefers-reduced-motion`.

The reveal state is derived from accumulated tool-call results in the conversation, not from a separate state machine — single source of truth.

### Pre-account persistence

For unauthenticated visitors:
- Mint a `jovie_onboarding_session` httpOnly cookie on first `/start` GET. Signed with `env.SESSION_SECRET` (validated env var, separate from Clerk keys, rotated independently). 7-day TTL. Contains a `sessionId` UUID v7 (time-ordered).
- `chatConversations` row is created with `userId = null`, `sessionId` set. New optional column `sessionId text` with a UNIQUE constraint that is enforced only once `userId IS NOT NULL` (partial unique index) — single Drizzle migration.
- `/api/chat` already handles auth — extend to accept anonymous sessions when `mode = 'onboarding'`.

### Anonymous abuse containment (mandatory in PR1)

Opening `/api/chat` to anonymous traffic is a token-burn DoS vector. Defenses:

- Rate limit on **IP + ASN** (not sessionId, which is attacker-controlled), Redis-backed, 20 messages/IP/hour and 60 messages/ASN/hour for anonymous mode
- Hard caps: 20 turns per session, 8k input tokens per turn, 2k output tokens per turn
- **Anonymous turns force Haiku** until `confirmSpotifyArtist` resolves with a verified-or-followers>1000 artist. Sonnet only kicks in once we have signal a real artist is on the other end.
- First message requires a Turnstile token (Cloudflare). Token is minted on `/start` page load; bot traffic that scripts `/api/chat` directly hits 401.
- Daily $-ceiling per IP-block at the Vercel edge: budget alert + auto-disable if anonymous mode burns past $50/day.

These caps are independent of the kill-switch flag — if anonymous burn spikes, page on-call regardless of flag state.

### Anonymous→authed claim flow (one-shot, idempotent)

The claim is a single DB transaction with explicit rules:

1. On Clerk sign-up completion, the inline `<SignUp />` tool card calls `/api/onboarding/claim` with the `sessionId` cookie attached.
2. Server runs:
   - SELECT all `chatConversations` rows where `sessionId = ?` AND `userId IS NULL`
   - If 0 rows → no-op success
   - If 1 row → UPDATE userId, record consent timestamp + IP + user agent in `chatAuditLog`
   - If 2+ rows → take the most recent, soft-discard the rest with an audit log entry (rare; happens when the cookie is reused after a previous account claim)
3. The partial unique index guarantees the same `sessionId` cannot be claimed twice onto different users — second claim raises a constraint error, surfaced as a friendly "this conversation is already linked to another account" message.
4. Cross-device collision (same user signs up from two browsers, each with its own sessionId): both transcripts get claimed onto the user; the UI surfaces a "you have 2 saved conversations — which should I continue?" picker in the dashboard.

### Pre-account transcript consent

First chat bubble copy includes the disclosure. At the Clerk inline `<SignUp />` step, an explicit checkbox (default on, labeled "Save this conversation to your account so Jovie can pick up where we left off") with link to privacy policy. The checkbox state and timestamp are written to `chatConversations.metadata.consent` JSONB. Without consent, the conversation is soft-discarded on sign-up (audit log row retained for 30 days).

### Auth integration

Inside the chat, when the LLM is ready to commit a handle / claim a profile / propose checkout, it calls a tool that gates on Clerk sign-up. We use Clerk's inline `<SignUp />` component rendered as a chat tool card — user enters email + verifies, gets back into the flow without a route change. Existing Clerk dev bypass / persona helpers (see `.claude/rules/auth.md`) work for testing.

### Replaces / deletes

- `apps/web/components/features/waitlist/WaitlistIntakeChat.tsx` — deleted
- `apps/web/components/features/waitlist/WaitlistSpotifySearch.tsx` — keep + repurpose as the popout body for `searchSpotifyArtist` tool widget
- `apps/web/app/waitlist/page.tsx` — becomes a thin redirect to `/start`
- `apps/web/app/api/onboarding/intake/route.ts` — deprecated; data now flows through `/api/chat` tool calls. Migration job copies any in-flight intake rows into the chat schema or marks them as legacy.

---

## Critical files

**Modify:**
- `apps/web/lib/chat/run.ts` — add `mode` plumbing, switch system prompt based on mode
- `apps/web/lib/chat/tool-schemas.ts` — add new tool schemas
- `apps/web/lib/chat/tools/` (new dir) — handlers for `searchSpotifyArtist`, `confirmSpotifyArtist`, `checkHandle`, `recordInterviewSignal`, `proposeAccessDecision`, `revealProfilePreview`, `proposeCheckout`
- `apps/web/components/jovie/JovieChat.tsx` — accept `mode` prop; render reveal-aware variants of suggestions/composer when `mode = 'onboarding'`
- `apps/web/components/jovie/components/` — new card components: `ChatArtistPickerCard`, `ChatHandlePickerCard`, `ChatProfilePreviewCard`, `ChatAccessDecisionCard`, `ChatCheckoutCard`
- `apps/web/app/api/chat/route.ts` — accept anonymous `sessionId` for `mode = 'onboarding'`; add Redis rate limit on session+IP
- `apps/web/lib/db/schema/chat.ts` — add `sessionId text` column to `chatConversations` (new immutable migration)

**Create:**
- `apps/web/app/start/page.tsx` — server component that mints/resolves the session cookie, renders `OnboardingShell` + `JovieChat mode="onboarding"`
- `apps/web/components/features/onboarding/OnboardingShell.tsx` — reveal state machine + cinematic layout
- `apps/web/lib/chat/prompts/onboarding.ts` — Stanley-inspired system prompt
- `apps/web/lib/onboarding/session.ts` — cookie mint/verify, conversation claiming on sign-up
- `drizzle/migrations/{next}_chat_session_id.sql` — additive migration

**Reference (read, don't modify):**
- `apps/web/components/features/waitlist/WaitlistSpotifySearch.tsx` — popout UX pattern to fold into `ChatArtistPickerCard`
- `apps/web/app/api/spotify/search/route.ts` — already-hardened Spotify search API
- `apps/web/app/api/handle/check/route.ts` — handle availability w/ rate limiting + timing-attack jitter
- `apps/web/lib/screenshots/registry.ts` + `MarketingPhoneImage` — phone-frame component to wrap the live profile preview
- `apps/web/app/onboarding/checkout/OnboardingCheckoutClient.tsx` — `ProfilePreviewCard` to mirror inside the chat reveal

---

## Build sequence (4 PRs)

1. **PR 1 — Schema + anonymous session plumbing + abuse containment.** Drizzle migration adds `sessionId` to chat tables (with partial unique index), `/api/chat` accepts anonymous sessions in `onboarding` mode with Redis IP+ASN rate limits, hard token/turn caps, Haiku-forced for unverified anonymous turns, Turnstile token required on first message. Edge $/day budget guard. New `/api/onboarding/claim` endpoint (no UI yet). CI green; no public UI change.
2. **PR 2 — Onboarding tools + system prompt + deterministic fallbacks.** Implement the 7 new tools (note: `revealProfilePreview` deleted; `proposeAccessDecision` split into `evaluateAccessSignal` deterministic function + `proposeNextStep` LLM tool). Zod-shaped `recordInterviewSignal` payload. Onboarding system prompt in `apps/web/lib/chat/prompts/onboarding.ts`. Behind `onboarding_chat_v2` Statsig flag (kill switch only). Per-tool escape hatches implemented. Test via the existing `/app/...` chat with `mode='onboarding'` override before exposing to `/start`.
3. **PR 3 — `OnboardingShell` + `/start` route + reveal state machine.** Cinematic shell with reveal state derived purely from tool history. `/start` placed in `app/(dynamic)/start/` (NOT `app/(marketing)/`), exempted from the marketing static rule and documented in the PR body. CSP + middleware nonce verified for this path. First chat bubble includes pre-account transcript disclosure. **PR 3 keeps `WaitlistIntakeChat.tsx` and `/waitlist` alive as the deterministic fallback** — `proposeNextStep` redirects to `/onboarding/checkout` (the existing route) until PR 4 lands the in-chat checkout. Stanley screenshots from Tim must be pinned to `.context/onboarding/stanley-refs/` before PR 3 visual implementation begins (hard block on the PR description). Pre-warm Spotify cache + handle-check cache on `/start` mount to avoid loading jank.
4. **PR 4 — Checkout-in-chat + Clerk inline sign-up tool card + conversation claim on sign-up.** Removes the friction wall. Default checkout UI is a button opening a dialog or routing to `/onboarding/checkout`; Stripe Embedded Checkout iframe is gated behind a separate experiment flag pending Playwright CSP smoke test that asserts no violations across the full happy path (Clerk SignUp + Stripe in one chat). After PR 4 merges and metrics look clean for 48 hours, delete `WaitlistIntakeChat.tsx` and the `/api/onboarding/intake` route.

The Statsig flag `onboarding_chat_v2` is a simple kill switch, not a percentage ramp. Justification: the current funnel has near-zero traffic to protect (verified in office-hours Q4). If real transcripts show LLM drift, flip off, fix prompt, flip back on — that's the cycle.

### PR3 rollback contract

If PR 3 ships and PR 4 slips, the funnel is NOT dead-ended. `proposeNextStep` always has a working path:
- `instant_access` → redirects to `/onboarding/checkout` (the existing Stripe route)
- `waitlist` → renders the waitlist confirmation card
- `needs_more_info` → continues conversation; auto-falls-back to `waitlist` after 3 turns

The old `WaitlistIntakeChat.tsx` stays on disk through PR 3; only PR 4's cleanup commit deletes it.

---

## Verification

Per-PR verification:
- `pnpm --filter @jovie/web run typecheck -- --pretty false`
- `pnpm biome check --write apps/web`
- `pnpm --filter web exec vitest run apps/web/lib/chat` (extend existing test coverage)
- For PR 1: run migration locally against dev Doppler scope, confirm `sessionId` column + index exist (`pnpm run db:web:studio`)
- For PR 2: drive a full transcript through `executeChatTurn` in a test, assert tool call sequence and that `recordInterviewSignal` lands in metadata
- For PR 3: `pnpm run dev:web:browse` + open `/start`, walk through the conversation, screenshot each reveal stage. Run `/qa --exhaustive` on the `/start` route.
- For PR 4: Stripe test card `4242 4242 4242 4242` end-to-end; verify the conversation is claimed by the new Clerk user (`userId` is populated, `sessionId` retained for audit)

End-to-end smoke (post-PR 4):
1. Fresh incognito → `/start` → calm canvas → "hi i'm jovie" bubble appears WITH pre-account disclosure copy
2. Reply with a song title → LLM pivots to Spotify search popout
3. Pick artist → profile preview card slides in with avatar + monthly listeners
4. Pick handle → handle chip lights green; if taken, alternates appear inline
5. Add one social → chip appears on profile preview
6. LLM asks one mom-test question → records signal
7. LLM proposes access decision → renders checkout card OR waitlist confirmation
8. Sign-up renders inline → email verified → conversation claimed
9. Stripe checkout completes → full dashboard reveals around the chat
10. Refresh — conversation persists, dashboard intact, transcript visible in admin
11. **Deterministic fallback path:** in a second incognito session, click the inline "let me pick myself" escape hatch at the Spotify step → static form picker renders, completes flow without LLM involvement, lands at the same dashboard

## Pre-PR3 watch-session protocol (revised gate)

**Revised per independent review User Challenge:** watch sessions run **before PR 3 implementation begins**, not before paid acquisition. PR 3 is the cinematic shell — the most expensive PR to build and the one most shaped by user reaction. Building it without observation is the same "no demand evidence" failure flagged in Premise #3 of the design doc.

Protocol:
1. Before PR 3 starts: schedule 3 watch sessions with real artists not on the Jovie team
2. Drive them through the PR 1 + PR 2 implementation (LLM chat with the new tools, but in the *existing* `JovieChat` shell — no cinematic reveal yet)
3. Sit behind them, do not narrate, do not unblock — observe
4. Record screen + audio if consent allows; never record without explicit consent
5. After each session, log what surprised you to `.context/onboarding/watch-sessions/{date}-{artist-handle}.md`
6. Iterate the system prompt and tool sequence based on what you saw
7. **Only then** start PR 3, with the cinematic reveal stages informed by where real artists naturally paused, hesitated, or got excited

This sequence closes the Q5 gap from /office-hours and ensures PR 3's most expensive choreography is shaped by observation, not assumption.

A second round of watch sessions (3-5 artists) runs after PR 4 lands and before any paid acquisition spend.

---

## Open questions deferred to implementation

- Exact copy for the onboarding system prompt — draft in PR 2, iterate via real transcripts in PR 3 QA
- Whether the LLM should be able to dynamically choose model (Sonnet vs Opus for complex objection handling) — start Sonnet-only, add Opus fallback if real transcripts show drift
- Stanley screenshots referenced by Tim — request and pin to `.context/onboarding/stanley-refs/` before PR 3 visual implementation

## Out of scope (Linear follow-ups required)

- Mobile-native reveal choreography polish (file Linear issue if PR 3 mobile QA finds gaps)
- Admin dashboard for reviewing onboarding transcripts (existing `chatAuditLog` covers the data; UI is a separate ticket)
- Auto-promotion of high-signal waitlisted users to instant access via background eval (separate ticket; the data path lands in PR 2 via `recordInterviewSignal`)
- Stripe Embedded Checkout iframe inside chat bubble — gated behind a second flag; PR 4 ships with the route-handoff fallback. Embedded experiment lands as a separate ticket once CSP smoke test passes.
- Composition-based separation of `executeChatTurn` into `runOnboardingTurn` / `runAppTurn` (L1 from review) — file Linear issue if the `mode` enum grows past 2 variants.

<!-- AUTONOMOUS DECISION LOG -->
## Decision Audit Trail

| # | Phase | Decision | Classification | Principle | Rationale |
|---|-------|----------|----------------|-----------|-----------|
| 1 | Pre-flight | Skip /office-hours offer initially → user overrode → ran inline | User-decided | — | User chose to run /office-hours |
| 2 | Office-hours Q5 | No watch evidence → flag as hypothesis-driven | User-decided | — | Honest answer logged in design doc |
| 3 | Office-hours Q4 | Full plan as wedge (no A/B control) | User Challenge accepted (user explicit) | P6 bias-to-action | "no one is using this thing. just go all in right now." |
| 4 | Office-hours Q6 | Smart-skip (already implicitly answered) | Mechanical | P3 pragmatic | Future-fit answered by "this is the jovie ai chat" framing |
| 5 | Phase 3 premise | Add deterministic fallback paths per tool | Auto | P1 completeness | Premise #3 (LLM drift) unverified at Jovie |
| 6 | Phase 3 premise | Add pre-account transcript consent | Auto | P1 completeness | Premise #6 (legal sufficiency) gap |
| 7 | Phase 3 premise | Kill switch flag, not ramp | Auto | P3 pragmatic | No traffic to protect → ramp is overhead |
| 8 | Eng C1 | IP+ASN rate limit, Haiku-forced, Turnstile, $/day cap | Auto | P1 completeness | Token-burn DoS is critical risk |
| 9 | Eng C2 | Partial unique index + one-shot claim transaction | Auto | P5 explicit | Race conditions need explicit contract |
| 10 | Eng C3 | `/start` in `app/(dynamic)/start/`, not marketing | Auto | P5 explicit | Marketing-static invariant requires explicit exception |
| 11 | Eng C4 | Stripe Embedded behind second flag, route-handoff default | Auto | P3 pragmatic | Unverified iframe-in-chat too risky for PR4 default |
| 12 | Eng C5 | Delete `revealProfilePreview`, derive reveal from tool history | Auto | P5 explicit | Tool that controls UI choreography violates single-source-of-truth |
| 13 | Eng C6 | Split `proposeAccessDecision` into deterministic eval + LLM render | Auto | P5 explicit | LLM should not own scoring logic |
| 14 | CEO C7 | PR3 keeps `WaitlistIntakeChat` alive; PR4 cleanup commit deletes | Auto | P1 completeness | Eliminates dead-end funnel between PR3 and PR4 |
| 15 | Security C8 | Explicit consent checkbox at sign-up + audit log | Auto | P1 completeness | One-line disclosure legally thin |
| 16 | Design C9 | Pre-warm Spotify + handle caches on `/start` mount | Auto | P1 completeness | Tim's own memory rule: loading jank = design failure |
| 17 | Eng L3 | Zod-shaped `recordInterviewSignal` payload | Auto | P1 completeness | Schemaless JSONB = future analytics pain |
| 18 | Eng L4 | `env.SESSION_SECRET` for cookie signing | Auto | P5 explicit | Cookie signing key source must be explicit |
| 19 | CEO C10 | **USER CHALLENGE — surface at gate** | Pending user | — | Watch sessions before PR3, not before paid acquisition |

<!-- GSTACK REVIEW REPORT -->
## GSTACK REVIEW REPORT

| Skill | Status | Findings | Verdict |
|---|---|---|---|
| office-hours | done | Q5 (no watch evidence), Q4 (no traffic, go all-in), Q6 (smart-skipped) | Hypothesis-driven plan validated; watch-session gate added |
| plan-ceo-review | done (auto) | 6 dimensions evaluated; C7 dead-end funnel fixed; C10 watch-gate surfaced as User Challenge | 5/6 confirmed, 1 user challenge |
| plan-design-review | done (auto) | C9 loading-jank contradiction fixed; cinematic reveal hydration noted (deferred to PR3 QA) | 3/4 confirmed |
| plan-eng-review | done (auto) | C1 (DoS), C2 (claim race), C3 (CSP/marketing rule), C4 (Stripe iframe), C5+C6 (tool surface), L1-L4 fixed | 5/6 confirmed |
| autoplan-voices | done (degraded) | Single independent Opus reviewer (Codex skipped for velocity per Tim's "go all in") | subagent-only mode |


---

## User

{'asset_pointer': 'sediment://file_000000000eac71f5854f0737cdd347fa', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1098149, 'width': 944}
{'asset_pointer': 'sediment://file_00000000cab471f58ad4644aa760f56f', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1317043, 'width': 944}
{'asset_pointer': 'sediment://file_0000000077a071f59b03ece0d3bf3103', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1063075, 'width': 944}
{'asset_pointer': 'sediment://file_00000000a99471f5bfb256e601ddd838', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1222898, 'width': 944}
{'asset_pointer': 'sediment://file_000000000cb4720c9f3a3fc7f0d000c6', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1024528, 'width': 944}
{'asset_pointer': 'sediment://file_00000000a51c722f8f5bf3de26350da8', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1297357, 'width': 944}
{'asset_pointer': 'sediment://file_000000002cb871f5bda222a642310b9c', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1177030, 'width': 944}
{'asset_pointer': 'sediment://file_00000000722c720c8d5861cacee16eb8', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1236311, 'width': 944}
{'asset_pointer': 'sediment://file_00000000143071f587bc5449c2cdd1a8', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1357906, 'width': 944}
{'asset_pointer': 'sediment://file_00000000084871f58c629853b1ad4b70', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1059892, 'width': 944}
{'asset_pointer': 'sediment://file_00000000e45071f5912be182dc77638a', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1116762, 'width': 944}
{'asset_pointer': 'sediment://file_00000000f6b4722fbfd8af6160c5f23b', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1046158, 'width': 944}
{'asset_pointer': 'sediment://file_00000000f380720c9c8fd3dfe06824a5', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1572931, 'width': 944}
{'asset_pointer': 'sediment://file_00000000313c720cb3ddca9901380e33', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1091130, 'width': 944}
{'asset_pointer': 'sediment://file_000000008dec71f597d079baed64da31', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1012123, 'width': 944}
{'asset_pointer': 'sediment://file_000000009a0c722f91d29d4507f147a3', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 592731, 'width': 944}
{'asset_pointer': 'sediment://file_00000000ee28722f93fab1eb0310215b', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1176808, 'width': 944}
{'asset_pointer': 'sediment://file_000000009514722fb9a85f890df2c89b', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 2048, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 722262, 'width': 944}
This is stanley for twitter. Jovie is free artist profiles and then limited ai usage and then we charge for anything more complex. we reverse trial users on the pro plan. 
