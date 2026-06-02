---
title: "Ingest claim system design"
type: essay
created: 2025-12-06
updated: 2025-12-10
source: chatgpt-export
conversation_id: 69346c35-9638-8329-9274-e4b7b3cbaf50
message_count: 86
tags: [chatgpt, import, code, long-form]
---
# Ingest claim system design

> Conversation ID: 69346c35-9638-8329-9274-e4b7b3cbaf50
> Created: 2025-12-06T17:50:42Z
> Updated: 2025-12-10T20:21:25Z
> Messages: 86


# Admin Creator Ingest & Claim System

This document explains the current admin creator ingestion flow and the claim system for Jovie.

---

## Overview

Jovie supports two paths for creator profiles to exist:

1. **Admin-ingested profiles** – Admins paste a Linktree URL; the system scrapes the profile, creates an unclaimed `creator_profile`, and generates a claim token.
2. **User-claimed profiles** – A creator visits a unique claim link, authenticates via Clerk, and takes ownership of the pre-built profile.

---

## Current Implementation

### 1. Admin Ingest Flow

**Entry point:** `/admin` panel → "Add Creator" action  
**API route:** `POST /api/admin/creator-ingest`  
**Source:** `app/api/admin/creator-ingest/route.ts`

#### How it works

1. Admin pastes a Linktree URL (e.g., `https://linktr.ee/artistname`).
2. The API validates the URL and extracts the handle.
3. If a profile with that normalized handle already exists → 409 conflict.
4. The system fetches the Linktree HTML and extracts:
   - Display name
   - Avatar URL
   - Social links (Spotify, Instagram, TikTok, etc.)
5. A new `creator_profile` row is inserted with:
   - `isClaimed = false`
   - `userId = null`
   - `ingestionStatus = 'processing'` → `'idle'`
6. Extracted links are normalized via `detectPlatform` / `canonicalIdentity` and inserted into `social_links` with:
   - `state = 'active'` or `'suggested'` based on confidence
   - `sourceType = 'ingested'`
   - `sourcePlatform = 'linktree'`
   - Confidence score (0.00–1.00)

#### Key files

| File | Purpose |
|------|---------|
| `app/api/admin/creator-ingest/route.ts` | API endpoint for ingestion |
| `lib/ingestion/processor.ts` | `normalizeAndMergeExtraction()` – link dedup & merge |
| `lib/ingestion/strategies/linktree.ts` | Linktree HTML fetch & parse |
| `lib/ingestion/confidence.ts` | Confidence scoring rules |
| `lib/ingestion/profile.ts` | Avatar/display name enrichment |

---

### 2. Claim Token Generation

**Source:** `lib/admin/creator-profiles.ts` → `getAdminCreatorProfiles()`

When the admin panel loads creator profiles, any unclaimed profile without a `claimToken` is automatically assigned one:

```ts
if (!row.isClaimed && !row.claimToken) {
  const token = randomUUID();
  await db.update(creatorProfiles).set({ claimToken: token });
}
```

Admins can then copy the claim link from the admin table actions menu.

---

### 3. Claim Flow (Creator Side)

**Entry point:** `/claim/[token]`  
**Source:** `app/claim/[token]/page.tsx`

#### Flow

1. Creator clicks the claim link (e.g., `https://jov.ie/claim/abc123-uuid`).
2. If not authenticated → redirect to `/sign-in?redirect_url=/claim/[token]`.
3. After Clerk auth, the page:
   - Looks up the profile by `claimToken`.
   - If already claimed or invalid token → redirect to `/dashboard`.
   - Creates or finds the `users` row for the Clerk user.
   - Updates the `creator_profile`:
     - `userId = dbUserId`
     - `isClaimed = true`
     - `claimToken = null`
     - `claimedAt = now()`
4. If onboarding not completed → redirect to `/onboarding?handle=<handle>`.
5. Otherwise → redirect to `/dashboard/overview`.

#### Post-claim state

- The creator now owns the profile and can edit links, avatar, display name.
- Admin-ingested links remain but can be modified or deleted.
- The profile appears as "claimed" in the admin panel.

---

### 4. Admin Panel Actions

**Source:** `app/admin/actions.ts`, `components/admin/CreatorProfilesTable.tsx`

| Action | Description |
|--------|-------------|
| **Copy claim link** | Copies `/claim/[token]` URL for unclaimed profiles |
| **Toggle verified** | Sets `isVerified` flag (shows badge on public profile) |
| **Toggle featured** | Sets `isFeatured` flag (shows on homepage carousel) |
| **Toggle marketing opt-out** | Sets `marketingOptOut` flag |
| **Rerun ingestion** | Re-scrapes the Linktree source to refresh links |
| **Delete** | Unclaimed: hard delete. Claimed: soft delete user (`deletedAt`) |
| **Update avatar** | Admin can override avatar URL |

---

### 5. Ingestion Job System

**Source:** `lib/ingestion/processor.ts`

The system supports background ingestion jobs via `ingestion_jobs` table:

- `claimPendingJobs()` – polls for pending jobs by `run_at` and priority
- `processJob()` – dispatches to the correct strategy (currently only `import_linktree`)
- `processLinktreeJob()` – fetches, extracts, and merges links

Jobs track:
- `status`: pending → processing → succeeded/failed
- `attempts`: retry count
- `error`: failure reason

---

### 6. Confidence & State System

**Source:** `lib/ingestion/confidence.ts`

Links have a confidence score (0.00–1.00) and state:

| State | Meaning |
|-------|---------|
| `active` | Shown on public profile |
| `suggested` | Shown as suggestion pill in dashboard (behind flag) |
| `rejected` | Hidden; user dismissed |

Confidence signals:
- Manual add (user): +0.6
- Manual add (admin): +0.5
- Linktree source: +0.2
- Handle similarity: +0.1–0.2
- Multi-source bonus: +0.15 per additional source

---

## Planned Additions

### Near-term

| Feature | Status | Notes |
|---------|--------|-------|
| **Spotify ingestion strategy** | Planned | API-based; higher confidence for artist profiles |
| **Instagram bio parsing** | Planned | HTTP meta parse for bio links |
| **Dashboard suggestion pills** | In progress | Accept/dismiss UI for `state='suggested'` links |
| **Recursive ingestion** | Planned | Follow discovered profile URLs up to depth 3 |
| **Scraper config admin UI** | Planned | Toggle enabled, strategy, rate limits per network |

### Medium-term

| Feature | Status | Notes |
|---------|--------|-------|
| **Smart link routing** | Designed | Geo/device/app-aware redirects via `/l/[slug]` |
| **Sensitive link protection** | Designed | Hide OnlyFans/Fansly from social crawlers |
| **AI link classification** | Future | Classify generic links/titles |
| **Bulk ingest CSV** | Future | Admin uploads CSV of Linktree URLs |

### Claim system enhancements

| Feature | Status | Notes |
|---------|--------|-------|
| **Email claim invites** | Planned | Send claim link via email with preview |
| **Claim expiration** | Planned | Tokens expire after N days |
| **Claim analytics** | Planned | Track claim funnel (link clicked → auth → claimed) |
| **Handle reservation** | Designed | Homepage handle-claim form (see `future_features/claim-handle.md`) |

---

## Database Schema (Key Tables)

### `creator_profiles`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `userId` | uuid | FK to `users`; null if unclaimed |
| `username` | text | Display handle |
| `usernameNormalized` | text | Lowercase, unique |
| `isClaimed` | boolean | |
| `claimToken` | uuid | Null after claim |
| `claimedAt` | timestamp | |
| `isVerified` | boolean | Admin-set |
| `isFeatured` | boolean | Admin-set |
| `ingestionStatus` | enum | idle/pending/processing/failed |
| `avatarLockedByUser` | boolean | Prevents ingestion override |
| `displayNameLocked` | boolean | Prevents ingestion override |

### `social_links`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `creatorProfileId` | uuid | FK |
| `platform` | text | e.g., spotify, instagram |
| `url` | text | Normalized |
| `state` | enum | active/suggested/rejected |
| `confidence` | numeric(3,2) | 0.00–1.00 |
| `sourceType` | enum | manual/admin/ingested |
| `sourcePlatform` | text | e.g., linktree |
| `evidence` | jsonb | `{ sources: [], signals: [] }` |

### `ingestion_jobs`

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `jobType` | text | e.g., import_linktree |
| `payload` | jsonb | `{ creatorProfileId, sourceUrl }` |
| `status` | enum | pending/processing/succeeded/failed |
| `attempts` | int | |
| `runAt` | timestamp | Scheduled execution time |
| `priority` | int | Lower = higher priority |

---

## Security & RLS

- Admin actions require `requireAdmin()` check (email allowlist).
- Ingestion jobs set `app.clerk_user_id = 'system_ingestion'` for RLS bypass.
- Claim tokens are UUIDs; invalidated on use.
- Avatar URLs validated against allowlist of hosts.

---

## Related Documentation

- `docs/link_ingestion_and_suggestions.md` – Full design doc for ingestion system
- `future_features/claim-handle.md` – Handle-first claim flow design
- `docs/STATSIG_FEATURE_GATES.md` – Feature flags for rollout


Help me harden this plan and lay out exactly which should be implemented next. We are mvp. And the admin claim flow is our GTM strategy. We make the profiles for creator then email them and invite them to claim them. Eventually we should have admin panel set automated emails that come from the founder and use AI to write unique but similar email messages for every link and send X per hour between 9-5pm PST mon-fri. Withsending controls in admin panel and one click "invite" buttons to add creators to the sending queue.


You’re already 80% of the way to a pretty powerful GTM, Mr. White. Let’s turn this into something robust and shippable *in order*.

I’ll do three things:
1. Harden what you’ve already designed (ingest + claim).
2. Design the invite system you described (emails, queue, AI copy).
3. Give a concrete implementation order for MVP vs later.

---

## 1) Hardening the Existing Ingest + Claim System

### A. Creator ingest (admin Linktree flow)

**Gaps / hardening steps**

1. **Strict URL + handle validation**
   - Only allow `https://linktr.ee/*` / `https://linktree.com/*` etc.
   - Normalize handles (`toLowerCase`, strip leading `@`, trailing slashes).
   - Enforce a unique constraint on `usernameNormalized` at DB level to backstop the 409 check.

2. **Idempotency / race safety**
   - Wrap ingest in a transaction.
   - Before insert, re-check if profile exists by `usernameNormalized`.
   - Optionally support an idempotency key per Linktree URL to avoid duplicate profiles on double-click.

3. **Ingestion status & error visibility**
   - On failure, set `ingestionStatus = 'failed'` and persist `lastIngestionError` (new column) rather than silently failing.
   - Admin table: show a small badge for `failed` with tooltip / modal showing the last error.

4. **Profile field overwrite rules**
   - You already have `avatarLockedByUser` and `displayNameLocked`.
   - Enforce this logic centrally:
     - In `normalizeAndMergeExtraction()` or `profile.ts`, never overwrite locked fields.
     - Require explicit admin action (“Update avatar”) to bypass.

5. **Link dedup & integrity**
   - Enforce unique-ish constraint on `(creatorProfileId, platform, url)` to avoid duplicates.
   - Ensure `detectPlatform` + canonicalization is consistent across admin-ingest and user-manual adds.
   - If you aren’t already, normalize URLs (https, no tracking params, trailing slash rules).

6. **Ingestion jobs**
   - Cap `attempts` and add simple backoff (e.g., 3 attempts, exponential delay).
   - If `status = 'failed'`, the admin “Rerun ingestion” should:
     - Reset `status` → `pending`
     - Clear `error` and increment a `runVersion` / log row so you can debug repeated failures.

### B. Claim token generation + flow

**Gaps / hardening steps**

1. **Generate tokens on create instead of on read**
   - Today: `getAdminCreatorProfiles()` backfills missing `claimToken`.
   - Safer: generate `claimToken` at profile creation time in the ingest flow.
   - Keep the backfill logic temporarily for legacy rows, but remove once migrated.

2. **Token uniqueness & constraints**
   - DB: `claimToken` `UNIQUE` where not null.
   - Index `claimToken` for lookup performance.

3. **Token expiration**
   - Add columns:
     - `claimTokenExpiresAt` (timestamp, nullable).
   - For now:
     - MVP: optional, but add the field so you don’t need a migration later.
     - Near-term: set default, e.g. 30 days from creation.

4. **Race conditions / double-claim safety**
   - In claim handler, perform an atomic update:
     - `WHERE claimToken = $token AND isClaimed = false`
   - Use the DB `UPDATE … RETURNING *` as the source of truth.
   - If it returns 0 rows, treat as invalid/expired/already-claimed and redirect to `/dashboard`.

5. **RLS / security checks**
   - Ensure `claim` endpoint:
     - Is public for GET (view), but POST/claim mutations run with service role or a safe RLS bypass that only touches that `creator_profile` row.
   - Log `claimedAt`, `claimedByUserId` (userId), and ideally an `claimedFromIp` / `claimedUserAgent` for audit if you care about abuse.

6. **User onboarding guardrails**
   - After claim, ensure:
     - If profile was soft-deleted, prevent claim or force admin restore.
     - If user already owns another claimed profile, either:
       - Disallow or
       - Support multi-profile per user intentionally (decide now; default: 1 user ↔ 1 profile).

---

## 2) Email Invite System (Your GTM Engine)

You want: admin builds profiles → email from “founder” inviting them to claim → eventually automated, AI-personalized, throttled.

### A. Data model additions

Add an `creator_claim_invites` table:

| Column | Type | Notes |
|--------|------|-------|
| `id` | uuid | PK |
| `creatorProfileId` | uuid | FK to `creator_profiles` |
| `email` | text | Target email |
| `status` | enum | pending/scheduled/sending/sent/bounced/failed/unsubscribed |
| `sendAt` | timestamp | When to send (in UTC) |
| `sentAt` | timestamp | Actual send time |
| `error` | text | Error from provider |
| `subject` | text | Final subject used |
| `body` | text | Final rendered HTML/text |
| `aiVariantId` | text | Optional for A/B/testing |
| `meta` | jsonb | `{ source: 'admin_click' | 'auto', notes: ... }` |

Also:
- `creator_profiles.email` (nullable) if you want to store a canonical email for the profile.
- `email_unsubscribes` table keyed by email and/or profile.

### B. Basic invite flow (MVP, manual trigger)

1. **Admin manually adds creator email**
   - In admin table row:
     - Email field (or inline edit).
     - “Send invite” button.

2. **When admin clicks “Send invite”**
   - Server:
     - Validate email.
     - Create `creator_claim_invites` row with:
       - `status = 'pending'`
       - `sendAt = now()` (or next legal window if you enforce).
     - Enqueue a job in your existing ingestion/job system or a separate `email_jobs`.

3. **Background worker / job**
   - Fetches `pending`/`scheduled` invites whose `sendAt <= now`, within throttle.
   - Generates email body (see AI section below).
   - Sends via provider (e.g., SendGrid/Resend/SES).
   - Updates `status` to `sent` or `failed`, logs `error`.

4. **Email content (v0)**
   - Simple deterministic template:
     - From: `Founder Name <founder@jov.ie>`
     - Subject: `"I built you a free Jovie profile"`
     - Body: References their Linktree handle, includes the claim URL.

5. **Compliance basics (even for “cold-ish” outreach)**
   - Footer:
     - Physical mailing address.
     - One-click unsubscribe link (`/unsubscribe?token=...`).
   - When clicked → mark email/unsubscribe in `email_unsubscribes`.

### C. Sending window + throttling (9–5pm PST, X per hour)

1. **Window handling**
   - Assume server operates in UTC; PST = UTC-8 (or UTC-7 with DST — if you want to be exact, use a proper timezone lib).
   - A simple rule in the worker:
     - Convert `now` to America/Los_Angeles.
     - Only send if:
       - DayOfWeek ∈ [Mon–Fri]
       - Hour ∈ [9..16] (inclusive of 9, exclusive of 17, depending on exact definition).

2. **Throttling**
   - Config in DB or env:
     - `MAX_INVITES_PER_HOUR = X`.
   - Worker:
     - Compute how many invites were `sentAt` in the last hour.
     - Only send up to `(MAX_INVITES_PER_HOUR - alreadySent)` more.
   - For queued invites exceeding the cap:
     - Keep them in `scheduled` with the same `sendAt`, they’ll be picked next run.

3. **Admin controls**
   - In admin UI:
     - Global toggle: “Pause all invite sending”.
     - Sliders/inputs:
       - `X invites per hour`.
       - Active time window (default 9–5 PST).
     - Queue view:
       - Table of `pending/scheduled/sent` with filters.
       - Per-invite actions: cancel, resend.

### D. Queue + “one-click invite” UX

In `CreatorProfilesTable`:

- Add:
  - “Invite” button that:
    - Opens a small modal:
      - Shows pre-filled email (from `creator_profiles.email`, or blank).
      - Shows preview of subject/body.
      - Has “Send now” / “Schedule for next window”.
- Quick action:
  - If email is already stored and not unsubscribed:
    - Single “Invite” button that directly creates a `pending` invite.

---

## 3) AI-Generated, Unique-but-Similar Emails

You don’t need this for MVP, but you should design it so adding later doesn’t break anything.

### A. Where AI fits in the pipeline

1. **Template spec**
   - Store a base “prompt template” (in code or DB) that includes:
     - Context: what Jovie is, what you want the email to say.
     - Variables: `{creator_name}`, `{platform}`, `{linktree_url}`, `{claim_url}`, `{founder_name}`, `{style}` etc.
   - Store `style` presets for tone, length, etc.

2. **Generation step**
   - In the email worker, before sending:
     - Call the LLM with:
       - The base prompt + variables.
     - Receive `{subject, body_text, body_html}` (or text only, then convert).

3. **Determinism + guardrails**
   - Use:
     - A low-ish temperature but not zero (e.g., 0.4–0.6) for variation.
   - Post-process:
     - Ensure claim link is present.
     - Ensure unsubscribe link is appended.
     - Enforce max length and ban certain phrases if needed.

4. **Storing the result**
   - Persist the final `subject` and `body` in `creator_claim_invites` before send.
   - That way:
     - Resend uses the exact same content.
     - You have a record for audits and debugging.

5. **Admin controls**
   - Admin UI:
     - Toggle: “Use AI personalization” (on/off).
     - Preview:
       - Generate and show a sample email for the selected profile; allow “Regenerate” before scheduling.

---

## 4) “What should we build next?” – Concrete Order

Given everything above and that this is your GTM, here’s the order I’d implement:

### Step 1 – Harden core ingest + claim (must-have, before scaling)

1. **Ingest hardening**
   - Strict Linktree URL validation.
   - Unique constraints on `usernameNormalized` and link dedup.
   - Proper error handling / `failed` state in ingestion jobs.
2. **Claim hardening**
   - Generate `claimToken` on profile creation.
   - Add `claimTokenExpiresAt` column (even if not enforced yet).
   - Atomic “claim” update with `WHERE isClaimed = false`.
3. **Admin UX**
   - Clear state badges (`claimed`, `unclaimed`, `failed`).
   - “Copy claim link” and “Rerun ingestion” fully wired and safe.

> At this point: you can safely hand-craft claim emails manually and trust the system.

---

### Step 2 – v1 Email invites (manual trigger, no AI yet)

1. **Tables**
   - Implement `creator_claim_invites` (+ optional `email_unsubscribes`).
2. **Email sending**
   - Integrate with an email provider.
   - Simple static founder-style template (no AI yet).
3. **Admin UI**
   - Add email field and “Send invite” action per profile.
   - Basic invite status display per profile: `never invited` / `invited` / `bounced` / `unsubscribed`.
4. **Compliance**
   - Unsubscribe endpoint and DB tracking.
   - Footer with physical address + opt-out.

---

### Step 3 – Scheduling, throttling, and 9–5 PST batching

1. **Worker logic**
   - Implement send window logic (Mon–Fri, 9–5 PST).
   - Add per-hour throttle with configurable limit in DB/env.
2. **Admin controls**
   - “Pause all sending” toggle.
   - Editable:
     - `maxInvitesPerHour`
     - Time window, if you want it adjustable.
3. **Queue mgmt UI**
   - Page or panel to:
     - View upcoming invites.
     - Cancel / reschedule (change `sendAt`).

> Now you have a real outbound engine that can scale.

---

### Step 4 – AI personalization of invites

1. **Prompt template system**
   - Add configuration for:
     - Base tone/persona (the founder’s voice).
     - Optional per-network flavor.
2. **LLM integration in worker**
   - Generate subject/body for each invite before sending.
   - Post-process & validate.
3. **Admin preview**
   - Allow generating a preview for a single profile in the UI.
   - Toggle AI on/off.

---

### Step 5 – Analytics + claim funnel (nice but powerful)

1. **Funnel metrics**
   - Track:
     - Invite sent → email opened (via provider) → login → claim complete.
2. **Admin analytics view**
   - Simple charts:
     - Invite-to-claim conversion rate.
     - Per-source (Linktree vs others in future).
     - Per-email variant (if you A/B test AI prompts).

---

### What I’d *defer* for now (not core to GTM MVP)

- Spotify ingestion strategy
- Instagram bio parsing
- Recursive ingestion
- Smart link routing
- Sensitive link protection, AI link classification
- Bulk ingest CSV (unless you already have a large list of Linktrees ready)

Those are great for v2+ but don’t move the GTM needle as directly as “we can ingest → email → get creators claiming profiles every day”.

---

If you’d like, next step I can draft:

- Exact DB migrations for `creator_claim_invites` + token expiration.
- A simple email worker pseudo-implementation with the time-window + throttling logic wired in.


One thing we should do, is when importing try to scrape emails and attach them to the creator profile on the backend as a contact that only we can see. Then we make in the table if it has a contact email and the invite button gets disabled if no email is attached. That automates the email part of it. And we can manually add emails to missing ones later.

The email scraper should filter out junk emails or generic emails and try to intelligently tag them as personal emails or manager/agent emails.  And prioritize personal.
It should also support adding multiple email but when we send we always send to the top priority one. If a manual one is added it becomes the default email for sending.

We currently use resend but eventually well add amazon ses.

Email should be plan text as if written from gmail by the ffounder.


Got it, Mr. White — this is exactly the right direction: auto-harvest contact emails at ingest, rank them, and make invites as close to “one click” as possible.

I’ll fold your ideas into something concrete you can implement:

---

## 1. Data Model for Emails (Hidden Contacts)

### A. New table: `creator_contacts`

You want multiple emails, classification, priority, manual override. Something like:

**`creator_contacts`**

| Column            | Type           | Notes |
|-------------------|----------------|-------|
| `id`              | uuid           | PK |
| `creatorProfileId`| uuid           | FK → `creator_profiles` |
| `email`           | text           | Unique per `(creatorProfileId, email)` |
| `label`           | text           | Optional: “Personal”, “Manager”, “Agent”, “Press”, etc. |
| `type`            | enum           | `personal` / `manager_agent` / `generic` / `junk` |
| `sourceType`      | enum           | `ingested` / `manual` |
| `sourcePlatform`  | text           | `linktree`, `website`, `instagram_bio`, etc |
| `confidence`      | numeric(3,2)   | 0.00–1.00 |
| `isPrimary`       | boolean        | Only one `true` per profile (DB constraint or trigger) |
| `isActive`        | boolean        | For soft-disable without deleting |
| `createdAt`       | timestamp      | |
| `updatedAt`       | timestamp      | |

And optionally, in `creator_profiles`:

- `hasContactEmail boolean` – denormalized for cheap filtering in the admin table.

> **RLS:** only exposed to the backend/admin API; never to public/creator-side API. Treat this as “internal CRM data.”

---

## 2. Email Scraping During Ingest

### A. Where it plugs in

Extend your Linktree ingestion:

- In `lib/ingestion/strategies/linktree.ts`:
  - After fetching the HTML, run an `extractEmailsFromHtml(html, sourceMeta)` function.
- In `lib/ingestion/processor.ts`:
  - Merge these into `creator_contacts` via a `mergeContacts()` step, similar to social link merging.

### B. How to extract emails

Simple v1:

1. **From `<a href="mailto:...">`**
   - Strip `mailto:` and query params (`?subject=…`).
2. **From raw text**
   - Regex for `[\w.+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}`.
   - Dedup between mailto + raw text.

Later you can add:
- Scraping external links like “official site” for emails (but I’d defer that until base system is stable).

---

## 3. Classifying Emails: Personal vs Manager vs Generic vs Junk

You don’t need AI here to get 80% accuracy. Use rule-based scoring.

### A. Heuristics

For each candidate email, compute:

- Local-part = before `@`
- Domain = after `@` (without subdomain if you want).

**1. Junk (drop or mark as junk)**

Mark as `type = 'junk'` if:

- Local-part matches:  
  `noreply`, `no-reply`, `do-not-reply`, `mailer-daemon`
- Or contains obvious automated patterns like:
  - `notifications@`, `updates@`, `mailer@`
- Or domain looks like bulk services (Mailchimp, SendGrid, etc.), if you care.

These should never be used for invites, just stored as low-value signals (or even discarded).

**2. Generic**

`type = 'generic'` when:

- Local-part in: `info`, `contact`, `support`, `hello`, `team`, `press`, `booking`, `business`, `management`, `office`.
- Or it’s at a generic brand domain: `@gmail.com` with local part like `artistnameofficial`, `artistnamemusic` could still be personal-ish, so treat carefully (see below).

**3. Manager/Agent**

`type = 'manager_agent'` if:

- Local-part or surrounding text contains:
  - `manager`, `mgmt`, `agent`, `booking`, `bookings`, `agency`, `label`, `pr`, `press`.
- Or the link context you found the email in (if you parse anchor text/section labels) contains those words.

**4. Personal**

`type = 'personal'` if:

- Local-part includes the handle / creator name (or a close match):
  - `artistname@domain`, `artist.name@domain`, `artistname.music@domain`, etc.
- And:
  - It **doesn't** contain the generic/manager keywords above.
- Or the email is in a “personal” context (e.g., found in a “about me” / “contact me personally” section if you ever parse that).

### B. Confidence scoring

You can reuse the scoring idea you have for links:

- Start at base 0.5 for any non-junk email.
- Add:
  - +0.2 if classified as `personal`.
  - +0.15 if context/anchor text is clearly “email me” / “business email”.
  - +0.1 if domain is custom (e.g., `@artistname.com`).
- Subtract:
  - −0.2 if `generic`.
  - −0.1 if manager_agent and you want to prioritize personal.

Persist `confidence` as a hint for ordering but always obey `isPrimary` + `type` rules first.

---

## 4. Priority & Sending Rules

You already described the behavior; let’s make it explicit:

### A. Priority order when picking an email

When sending an invite, pick the **first** that matches:

1. Any `creator_contacts` where `isPrimary = true` and `isActive = true`.
2. If none, the highest priority among:
   - `type = 'personal' AND isActive = true`
   - then `type = 'manager_agent'`
   - then `type = 'generic'`
3. Exclude `type = 'junk'` and `isActive = false`.

Within the same type, sort by:
- Higher `confidence`
- Then earliest `createdAt` (or doesn’t matter much).

### B. Manual override

Rules:

- When an admin **manually adds** an email:
  - `sourceType = 'manual'`
  - `isPrimary = true`
  - Flip all other `isPrimary` to `false` for that profile.
- If admin manually changes primary via the UI:
  - Update `isPrimary`, leave `sourceType` as is.
- If admin disables an email:
  - Set `isActive = false`, don’t delete unless you’re sure.

---

## 5. Admin Panel Behavior

### A. Table behaviour

For `CreatorProfilesTable`:

- Show a chip/column:
  - `Email: personal`, `Email: manager`, `Email: generic`, or `No email`.
- **Invite button state:**
  - **Enabled** if there is at least one `creator_contacts` with:
    - `isActive = true` AND `type != 'junk'`.
  - **Disabled** + tooltip: “No contact email found. Add one to send an invite.”

Clicking the email cell could open a detail modal:

- List of emails with:
  - Email address
  - Type badge (`Personal`, `Manager`, etc.)
  - Source (`manual`/`linktree`)
  - Confidence
  - Toggle: Active/inactive
  - Star: set as primary

### B. Manual email entry

- In the modal or row actions:
  - “Add email” → small form:
    - Email input.
    - Optional label (free text) or dropdown for type.
  - On save:
    - Create `creator_contacts` record with:
      - `sourceType = 'manual'`
      - `type` from dropdown (default `personal`).
      - `isPrimary = true`.
    - Recompute primary as described above.

---

## 6. Sending Layer (Resend now, SES later)

### A. Abstraction

Wrap the email provider behind a small interface, so switching from Resend to SES later is painless:

```ts
// lib/email/sendClaimInvite.ts
type ClaimInviteEmail = {
  to: string;
  subject: string;
  bodyText: string; // plain text only
};

export async function sendClaimInviteEmail(payload: ClaimInviteEmail) {
  if (process.env.EMAIL_PROVIDER === 'resend') {
    // call Resend SDK with text-only
  } else if (process.env.EMAIL_PROVIDER === 'ses') {
    // call SES SDK
  }
}
```

All your invite worker does is:

1. Pick the primary contact email.
2. Generate the text email content.
3. Pass it into `sendClaimInviteEmail`.

### B. Plain text founder-style email

You already know what you want: looks like a personal Gmail from the founder, no HTML fluff.

For now (no AI), hard-coded template:

```txt
Subject: I set up a Jovie profile for you

Hey {first_name_or_handle},

I made a Jovie profile for you based on your Linktree.

You can claim it here:
{claim_url}

Once you claim it, you can edit your links and customize how fans find your stuff.

If you don’t want this, you can just ignore this email.

– {founder_name}
```

When you later add AI, you still output plain text (no HTML), just more varied phrasing.

---

## 7. How This Fits Into the Earlier Roadmap (Concrete Next Steps)

For **next implementation iteration**, I’d do this in order:

1. **DB migrations**
   - Add `creator_contacts` table (+ indexes + constraints).
   - Add `hasContactEmail` to `creator_profiles` (optional but useful).
2. **Ingestion updates**
   - Implement `extractEmailsFromHtml` in the Linktree strategy.
   - Implement `classifyEmailType` & scoring.
   - Implement `mergeContacts(profileId, candidates)` with dedup + priority logic.
   - Set `hasContactEmail` after merge.
3. **Backend selection logic**
   - Implement `getPrimaryContactEmail(creatorProfileId)` utility with the priority rules.
   - Make the invite creation endpoint use this to decide if “Invite” is allowed and which email is used.
4. **Admin UI**
   - Show email presence/type per profile.
   - Disable Invite button if no usable email.
   - Add “Add email” modal.
5. **Sending**
   - Wire Resend with plain-text emails through a provider abstraction, ready for SES later.

Once that’s done, you’ve effectively automated the hardest part of the GTM: finding and prioritizing who to email. The AI and analytics layers are just multipliers on top.


We should add basic analytics on messages sent and profiles claimed and the conversion rate. Throw that in a widget right on the admin dashboard.


Perfect, this is exactly the next layer you want on top of the invite engine, Mr. White.

I’ll keep it tight and concrete: what to track, how to calculate it, and how to render it as a simple dashboard widget.

---

## 1. Metrics to Show in the Admin Dashboard

Right on `/admin`, one compact widget with:

**All-time (headline row)**  
- **Invites sent (all-time)**  
- **Profiles claimed (all-time)**  
- **Invite → claim conversion (all-time)** = claimed / invited

**Recent performance (secondary row)**  
For each of these windows:

- **Last 7 days**  
- **Last 30 days**

Show for each window:

- Invites sent  
- Profiles claimed  
- Conversion rate

You can render it as:

- Left side: big numbers (all-time)  
- Right side: small “Last 7d / Last 30d” comparison  

This gives you immediate signal if the GTM efforts are working without overbuilding.

---

## 2. Data You Already Have vs What You Need

With what we’ve designed:

- `creator_claim_invites`:
  - `id`
  - `creatorProfileId`
  - `status` (we care about `sent`)
  - `sentAt`
- `creator_profiles`:
  - `isClaimed`
  - `claimedAt`

That’s enough for **basic** conversion:

> “Of all profiles we’ve invited, how many are now claimed?”

For MVP, you don’t need perfect attribution (invite A vs invite B). It’s fine if conversion means: profile claimed at any time after we started sending invites.

If you later want **per-invite** attribution, add:

- `inviteId` as a query param in the claim link  
- `claimedFromInviteId` on `creator_profiles` (or a separate log table)

But I’d skip that now.

---

## 3. Core Aggregation Queries (Pseudo-SQL)

### A. All-time totals

```sql
-- Total invites sent
SELECT COUNT(*) AS invites_sent_all_time
FROM creator_claim_invites
WHERE status = 'sent';

-- Total profiles claimed
SELECT COUNT(*) AS profiles_claimed_all_time
FROM creator_profiles
WHERE isClaimed = true;

-- Conversion rate (compute in app code)
conversion_all_time = profiles_claimed_all_time / invites_sent_all_time
```

### B. Windowed stats (Last 7d / Last 30d)

Use the invite `sentAt` as the anchor for “in period”:

```sql
-- Invites sent in window
SELECT COUNT(*) AS invites_sent
FROM creator_claim_invites
WHERE status = 'sent'
  AND sentAt >= NOW() - INTERVAL '7 days';   -- or '30 days'
```

For claimed profiles “touched” in that window, you have two options:

1. **Simple (good enough MVP):**  
   Count profiles with `claimedAt` in the window:

   ```sql
   SELECT COUNT(*) AS profiles_claimed
   FROM creator_profiles
   WHERE isClaimed = true
     AND claimedAt >= NOW() - INTERVAL '7 days';
   ```

2. **Slightly more precise (still simple):**  
   Only consider profiles that have **ever** been invited:

   ```sql
   SELECT COUNT(DISTINCT cp.id) AS profiles_claimed
   FROM creator_profiles cp
   JOIN creator_claim_invites ci
     ON ci.creatorProfileId = cp.id
   WHERE cp.isClaimed = true
     AND cp.claimedAt >= NOW() - INTERVAL '7 days'
     AND ci.status = 'sent';
   ```

Then in app code:

```ts
conversion_7d = profiles_claimed_7d / invites_sent_7d;
conversion_30d = profiles_claimed_30d / invites_sent_30d;
```

Guard `division by zero` of course.

---

## 4. Backend API Shape

Add an admin-only endpoint, e.g.:  
`GET /api/admin/stats`

**Response:**

```json
{
  "allTime": {
    "invitesSent": 1234,
    "profilesClaimed": 321,
    "conversion": 0.26
  },
  "last7d": {
    "invitesSent": 80,
    "profilesClaimed": 20,
    "conversion": 0.25
  },
  "last30d": {
    "invitesSent": 270,
    "profilesClaimed": 60,
    "conversion": 0.22
  }
}
```

Lock this endpoint behind `requireAdmin()` just like the rest of the admin panel.

---

## 5. Admin Dashboard Widget UX

On `/admin`:

### A. Layout

A single card:

- **Top row (big text)**  
  - “Invites sent” — value  
  - “Profiles claimed” — value  
  - “Conversion” — `26%`

- **Bottom row (small text or tiny sub-cards)**  
  - “Last 7 days: 80 invites, 20 claims, 25%”  
  - “Last 30 days: 270 invites, 60 claims, 22%”

You can color conversion:

- Green if last 7d > last 30d.
- Red if it’s dropping.

### B. Nice-to-have (still minimal)

- Tiny label under the title:
  - “Last updated: just now” (you’re just hitting a live endpoint).
- Click-through:
  - Clicking the widget could navigate to a `/admin/analytics` page later, but you don’t need that yet.

---

## 6. Implementation Order (Tiny Increment)

To plug this into what you already have planned:

1. **Queries / service function**
   - Implement a server function `getAdminStats()` that runs the SQL above.
2. **API route**
   - `app/api/admin/stats/route.ts` → calls `requireAdmin()` and returns JSON.
3. **Dashboard widget**
   - New component `DashboardStatsWidget`:
     - Calls `/api/admin/stats` via SWR/React Query or server component fetch.
     - Renders the card with all-time + 7d/30d numbers.

That’s it — small incremental change, but you immediately see if your “build profiles → email → claim” engine is producing actual ownership, not just emails fired into the void.


With this go-to-market system as we start to build, as we start to launch, does it make sense to disable sign-ups publicly and put everyone on the waitlist? And make it like invite-only so that everyone that we're emailing this to like feels more special and stuff and it's invite-only as we get the first few people in there and then we build the... we can like iterate on their feedback and then invite more people and then invite more people and iterate on the feedback and keep going? Or is it more beneficial for us to just open the doors and let anyone sign up with the assumption that probably not that many people are going to sign up right away and you know just open it for people signing up and deal with the fact that we have people's emails then even if they sign up and hit a broken product we can always email them to re-engage. What would be the better method of doing it? Each one seems like it has its pros and cons. What would you say? Knowing that like we're a single developer MVP and like I fully expect that the initial launch is going to be like a rough product but we're iterating very quickly and we'll get it stable you know very quickly and as soon as someone gives feedback I mean we're pushing new code within the hour you know. What would Y Combinator say about this? What do you think?


**Topic:** [[chatgpt-clusters/design_ux]]
