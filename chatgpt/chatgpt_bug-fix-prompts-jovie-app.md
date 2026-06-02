---
conversation_id: 694f63b5-f92c-8328-bb4c-20aa426099a9
created: 2025-12-27
links:
- '[[chatgpt-clusters/jovie_product_strategy]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
- long-form
title: Bug Fix Prompts Jovie App
type: guide
updated: 2025-12-27
---

# Bug Fix Prompts Jovie App

**Related:** [[jovie-product-strategy]]

> Conversation ID: 694f63b5-f92c-8328-bb4c-20aa426099a9
> Created: 2025-12-27T04:42:42Z
> Updated: 2025-12-27T04:43:23Z
> Messages: 2

---

## User

# Critical Bug Report: Jovie Application

 

**Date:** 2025-12-27

**Analysis Scope:** Full codebase security, database, payment, auth, and business logic review

 

## Executive Summary

 

This report identifies 25 critical bugs in the Jovie codebase, ranked by importance (potential business/security impact) and difficulty to fix. The most severe issues are in the **payment webhook handling** and **database race conditions**, which can cause revenue loss and data integrity problems.

 

---

 

## Top 25 Bugs Ranked by Importance and Difficulty

 

| Rank | Bug | File | Importance | Difficulty | Category |

|------|-----|------|------------|------------|----------|

| 1 | Silent failure in payment success webhook | `app/api/stripe/webhooks/route.ts:483-525` | **CRITICAL** | Easy | Payment |

| 2 | Payment failed webhook doesn't downgrade users | `app/api/stripe/webhooks/route.ts:527-617` | **CRITICAL** | Easy | Payment |

| 3 | Race condition in audience member upsert | `app/api/audience/click/route.ts:256-296` | **CRITICAL** | Medium | Database |

| 4 | Race condition in track API upsert | `app/api/track/route.ts:185-247` | **CRITICAL** | Medium | Database |

| 5 | Fire-and-forget social link click update | `app/api/track/route.ts:327-350` | **CRITICAL** | Easy | Database |

| 6 | Orphaned Stripe customers on concurrent updates | `lib/stripe/customer-sync.ts:154-198` | **HIGH** | Medium | Payment |

| 7 | Module-level CRON_SECRET capture | `app/api/cron/waitlist-invites/route.ts:14` | **CRITICAL** | Easy | Config |

| 8 | Missing userId handling in payment success | `app/api/stripe/webhooks/route.ts:499-512` | **HIGH** | Easy | Payment |

| 9 | Race condition in waitlist invites rate limiting | `app/api/cron/waitlist-invites/route.ts:88-168` | **HIGH** | Medium | Cron |

| 10 | Missing concurrent execution prevention in billing reconciliation | `app/api/cron/billing-reconciliation/route.ts:70-141` | **HIGH** | Medium | Cron |

| 11 | Admin role cache race condition after demotion | `lib/admin/roles.ts:10-27` | **HIGH** | Medium | Auth |

| 12 | Missing RLS session setup in non-transaction context | `lib/db/index.ts:335-345` | **HIGH** | Medium | Auth |

| 13 | Orphaned blobs on avatar update | `app/api/images/upload/route.ts:411-481` | **HIGH** | Medium | Storage |

| 14 | No previous avatar cleanup on dashboard profile update | `app/api/dashboard/profile/route.ts:388-405` | **HIGH** | Medium | Storage |

| 15 | past_due/unpaid status blocks checkout | `app/api/stripe/checkout/route.ts:80-85` | **HIGH** | Easy | Payment |

| 16 | Duplicate tip processing silently ignored | `app/api/capture-tip/route.ts:93-112` | **MEDIUM** | Easy | Payment |

| 17 | Missing transaction isolation for handle availability | `app/api/handle/check/route.ts:205-210` | **MEDIUM** | Medium | Database |

| 18 | Idempotency key storage failure not retried | `app/api/dashboard/social-links/route.ts:147-152` | **MEDIUM** | Easy | Database |

| 19 | Memory leaks - setTimeout without cleanup | `components/dashboard/organisms/AppleStyleOnboardingForm.tsx:149-167` | **MEDIUM** | Easy | React |

| 20 | Memory leaks - nested setTimeout in modal | `components/dashboard/organisms/DashboardFeedbackModal.tsx:44-72` | **MEDIUM** | Easy | React |

| 21 | Timer refs not cleaned on unmount | `components/dashboard/organisms/ListenNowForm.tsx:29-46` | **MEDIUM** | Easy | React |

| 22 | Stack trace information disclosure | `app/api/health/auth/route.ts:76` | **MEDIUM** | Easy | Security |

| 23 | Clerk webhook returns 200 on failure | `app/api/clerk/webhook/route.ts:155-163` | **MEDIUM** | Easy | Auth |

| 24 | Timing attack vulnerability on CRON_SECRET | Multiple cron files | **MEDIUM** | Easy | Security |

| 25 | Non-atomic blob+DB deletion in cleanup | `app/api/cron/cleanup-photos/route.ts:93-120` | **MEDIUM** | Medium | Cron |

 

---

 

## Detailed Bug Descriptions

 

### CRITICAL BUGS (Revenue/Data Loss Risk)

 

#### 1. Silent Failure in Payment Success Webhook

 

**File:** `apps/web/app/api/stripe/webhooks/route.ts` (Lines 483-525)

**Importance:** CRITICAL | **Difficulty:** Easy

 

The `handlePaymentSucceeded` function catches errors but does NOT re-throw them. If any error occurs while updating the user's billing status, the webhook will still be marked as processed successfully by Stripe.

 

```typescript

catch (error) {

  await captureCriticalError('Error handling payment success webhook', error, {...});

  // BUG: No re-throw - Stripe thinks webhook succeeded

}

```

 

**Impact:** Users pay but never receive Pro status. Revenue is collected but service not delivered.

 

**Fix:** Add `throw error;` after logging to ensure Stripe retries failed webhooks.

 

---

 

#### 2. Payment Failed Webhook Doesn't Downgrade Users

 

**File:** `apps/web/app/api/stripe/webhooks/route.ts` (Lines 527-617)

**Importance:** CRITICAL | **Difficulty:** Easy

 

The `handlePaymentFailed` function silently returns if subscription retrieval fails or userId is missing. Users who should be downgraded continue having Pro access.

 

**Impact:** Users with failed payments keep Pro features indefinitely, causing revenue loss.

 

**Fix:** Add error re-throwing and explicit handling for missing userId scenarios.

 

---

 

#### 3. Race Condition in Audience Member Upsert

 

**File:** `apps/web/app/api/audience/click/route.ts` (Lines 256-296)

**Importance:** CRITICAL | **Difficulty:** Medium

 

When `onConflictDoNothing` fails to insert, the code tries to fetch the conflicting record, but another transaction could delete it in between.

 

```typescript

if (!inserted) {

  member = await findAudienceMember(tx, profileId, fingerprint);

  // Race: record could be deleted between conflict and this SELECT

}

if (!member) {

  throw new Error('Unable to resolve audience member'); // This can happen!

}

```

 

**Impact:** Analytics data loss, API errors during high-traffic periods.

 

**Fix:** Use `INSERT ... ON CONFLICT DO UPDATE` instead of `DO NOTHING` to guarantee a row is returned.

 

---

 

#### 4. Race Condition in Track API Upsert

 

**File:** `apps/web/app/api/track/route.ts` (Lines 185-247)

**Importance:** CRITICAL | **Difficulty:** Medium

 

Same race condition pattern as Bug #3. The fallback SELECT after `onConflictDoNothing` can return null.

 

**Impact:** Click tracking fails, analytics gaps, potential 500 errors.

 

**Fix:** Same as Bug #3 - use upsert pattern that guarantees row return.

 

---

 

#### 5. Fire-and-Forget Social Link Click Update

 

**File:** `apps/web/app/api/track/route.ts` (Lines 327-350)

**Importance:** CRITICAL | **Difficulty:** Easy

 

Social link click counter is updated OUTSIDE the transaction with `void socialLinkUpdate` - never awaited.

 

```typescript

const socialLinkUpdate = linkType === 'social' ? db.update(...).catch(...) : null;

if (socialLinkUpdate) {

  void socialLinkUpdate; // Fire-and-forget!

}

```

 

**Impact:** Click counts become inconsistent with actual click events. Analytics unreliable.

 

**Fix:** Move update inside the transaction and await it.

 

---

 

### HIGH BUGS (Significant Impact)

 

#### 6. Orphaned Stripe Customers on Concurrent Updates

 

**File:** `apps/web/lib/stripe/customer-sync.ts` (Lines 154-198)

**Importance:** HIGH | **Difficulty:** Medium

 

After creating a Stripe customer, if the optimistic locking update fails, the function returns success anyway. Customer created but not linked to database.

 

**Impact:** Orphaned Stripe customers, billing issues on retry, potential double charges.

 

**Fix:** Return error on optimistic lock failure or implement cleanup of orphaned customer.

 

---

 

#### 7. Module-Level CRON_SECRET Capture

 

**File:** `apps/web/app/api/cron/waitlist-invites/route.ts` (Line 14)

**Importance:** CRITICAL | **Difficulty:** Easy

 

```typescript

const CRON_SECRET = process.env.CRON_SECRET; // Captured at module load

```

 

If `CRON_SECRET` is undefined at cold start, ALL cron requests fail authorization permanently.

 

**Impact:** All cron jobs fail silently, waitlist invites never sent, cleanup jobs never run.

 

**Fix:** Read `process.env.CRON_SECRET` inside the handler function, not at module level.

 

---

 

#### 8. Missing userId Handling in Payment Success

 

**File:** `apps/web/app/api/stripe/webhooks/route.ts` (Lines 499-512)

**Importance:** HIGH | **Difficulty:** Easy

 

When `userId` is undefined (missing metadata), the function silently returns without processing.

 

**Impact:** Subscriptions without proper metadata never update the user's status.

 

**Fix:** Log critical error and throw when userId is missing to trigger webhook retry/alerting.

 

---

 

#### 9. Race Condition in Waitlist Invites Rate Limiting

 

**File:** `apps/web/app/api/cron/waitlist-invites/route.ts` (Lines 88-168)

**Importance:** HIGH | **Difficulty:** Medium

 

Rate limit check happens OUTSIDE the database transaction. Two concurrent cron instances can both pass the rate limit check.

 

**Impact:** Exceeded rate limits, users receive duplicate invites.

 

**Fix:** Move rate limit check inside transaction with row locking.

 

---

 

#### 10. Missing Concurrent Execution Prevention in Billing Reconciliation

 

**File:** `apps/web/app/api/cron/billing-reconciliation/route.ts` (Lines 70-141)

**Importance:** HIGH | **Difficulty:** Medium

 

No distributed lock or idempotency check to prevent concurrent execution.

 

**Impact:** Same users processed multiple times, unnecessary Stripe API calls.

 

**Fix:** Implement distributed locking or job status tracking.

 

---

 

#### 11. Admin Role Cache Race Condition

 

**File:** `apps/web/lib/admin/roles.ts` (Lines 10-27)

**Importance:** HIGH | **Difficulty:** Medium

 

5-minute cache TTL means demoted admins retain access for up to 5 minutes after demotion.

 

**Impact:** Unauthorized admin access after permission revocation.

 

**Fix:** Reduce TTL or implement cache invalidation on role change.

 

---

 

#### 12. Missing RLS Session Setup in Non-Transaction Context

 

**File:** `apps/web/lib/db/index.ts` (Lines 335-345)

**Importance:** HIGH | **Difficulty:** Medium

 

`setSessionUser()` uses `SET LOCAL` (transaction-scoped) inconsistently with session-scoped `set_config()`.

 

**Impact:** Potential unauthorized data access if RLS bypassed.

 

**Fix:** Standardize on session-scoped `set_config()` for all RLS setup.

 

---

 

#### 13-14. Orphaned Blob Storage

 

**Files:** `images/upload/route.ts:411-481`, `dashboard/profile/route.ts:388-405`

**Importance:** HIGH | **Difficulty:** Medium

 

When users upload new avatars, previous blobs are never deleted from Vercel Blob storage.

 

**Impact:** Storage quota exhaustion, unnecessary costs, orphaned files accumulate.

 

**Fix:** Query for existing avatar URL before update, delete old blob after successful update.

 

---

 

#### 15. past_due/unpaid Status Blocks Checkout

 

**File:** `apps/web/app/api/stripe/checkout/route.ts` (Lines 80-85)

**Importance:** HIGH | **Difficulty:** Easy

 

Users with `past_due` or `unpaid` subscriptions are blocked from creating new checkout sessions.

 

```typescript

const activeSubscriptionStatuses = new Set([

  'active', 'trialing', 'past_due', 'unpaid' // Blocks these users from checkout!

]);

```

 

**Impact:** Users can't pay overdue bills, churn increases, revenue lost.

 

**Fix:** Remove `past_due` and `unpaid` from blocking statuses or redirect to portal.

 

---

 

### MEDIUM BUGS (Moderate Impact)

 

#### 16. Duplicate Tip Processing Silently Ignored

 

**File:** `apps/web/app/api/capture-tip/route.ts` (Lines 93-112)

**Importance:** MEDIUM | **Difficulty:** Easy

 

Duplicate tips are silently ignored with only `console.log`. No way to distinguish legitimate duplicates from system failures.

 

**Fix:** Use structured logging with event type to distinguish scenarios.

 

---

 

#### 17. Missing Transaction Isolation for Handle Availability

 

**File:** `apps/web/app/api/handle/check/route.ts` (Lines 205-210)

**Importance:** MEDIUM | **Difficulty:** Medium

 

Handle availability check doesn't use transaction, allowing race conditions during profile creation.

 

**Fix:** Wrap check in serializable transaction or rely on unique constraint with proper error handling.

 

---

 

#### 18. Idempotency Key Storage Failure Not Retried

 

**File:** `apps/web/app/api/dashboard/social-links/route.ts` (Lines 147-152)

**Importance:** MEDIUM | **Difficulty:** Easy

 

Idempotency key insert failures are only logged, never retried.

 

**Fix:** Consider storing idempotency key before operation, not after.

 

---

 

#### 19-21. React Memory Leaks (setTimeout without cleanup)

 

**Files:**

- `AppleStyleOnboardingForm.tsx:149-167` (250ms timeouts)

- `DashboardFeedbackModal.tsx:44-72` (2000ms + nested 300ms)

- `ListenNowForm.tsx:29-46` (500ms debounce)

 

**Importance:** MEDIUM | **Difficulty:** Easy

 

Multiple components with `setTimeout` not cleaned up on unmount.

 

**Impact:** Memory leaks, "setState on unmounted component" warnings.

 

**Fix:** Store timeout IDs in refs and clear them in useEffect cleanup.

 

---

 

#### 22. Stack Trace Information Disclosure

 

**File:** `apps/web/app/api/health/auth/route.ts` (Line 76)

**Importance:** MEDIUM | **Difficulty:** Easy

 

Error stack traces leaked in API responses.

 

**Fix:** Never return `error.stack` in responses; log it server-side only.

 

---

 

#### 23. Clerk Webhook Returns 200 on Failure

 

**File:** `apps/web/app/api/clerk/webhook/route.ts` (Lines 155-163)

**Importance:** MEDIUM | **Difficulty:** Easy

 

Returns HTTP 200 on processing failure, preventing Clerk retries.

 

**Fix:** Return 500 on failure to trigger webhook retry.

 

---

 

#### 24. Timing Attack on CRON_SECRET

 

**Files:** Multiple cron files

**Importance:** MEDIUM | **Difficulty:** Easy

 

Uses simple string comparison instead of `crypto.timingSafeEqual`.

 

**Fix:** Use timing-safe comparison for all secret validation.

 

---

 

#### 25. Non-Atomic Blob+DB Deletion

 

**File:** `apps/web/app/api/cron/cleanup-photos/route.ts` (Lines 93-120)

**Importance:** MEDIUM | **Difficulty:** Medium

 

Blobs deleted first, then individual DB delete queries without transaction.

 

**Fix:** Delete DB records in batch transaction, then delete blobs.

 

---

 

## Summary Statistics

 

| Category | Count | Severity Distribution |

|----------|-------|----------------------|

| Payment/Billing | 6 | 3 Critical, 2 High, 1 Medium |

| Database/Transactions | 5 | 2 Critical, 1 High, 2 Medium |

| Cron/Background Tasks | 4 | 1 Critical, 2 High, 1 Medium |

| Authentication/Security | 4 | 2 High, 2 Medium |

| Storage/Resources | 3 | 2 High, 1 Medium |

| React/Frontend | 3 | 3 Medium |

 

---

 

## Recommended Fix Priority

 

### Immediate (This Week)

- Bugs 1, 2, 7, 8, 15 - Payment webhook fixes and cron secret capture

- These directly impact revenue and critical system functionality

 

### High Priority (Next Sprint)

- Bugs 3-6, 9-12 - Race conditions and auth issues

- These can cause data loss and security issues under load

 

### Medium Priority

- Bugs 13-18, 22-25 - Storage cleanup and security hardening

- Important for operational efficiency and security posture

 

### Lower Priority

- Bugs 19-21 - React memory leaks

- Non-critical but should be addressed to prevent accumulating technical debt


list out a rpompt to address each abtch

---

## Assistant

Mr. White — here are **ready-to-copy prompts** for each fix batch.

## Batch 1: Immediate (This Week) — Bugs 1, 2, 7, 8, 15
**Prompt:**
> You are a senior full-stack engineer. Fix these revenue-critical issues in a Next.js/TypeScript app with Stripe.
>
> **Targets**
> 1) `apps/web/app/api/stripe/webhooks/route.ts:483-525` — `handlePaymentSucceeded` must re-throw after logging so Stripe retries on failure.  
> 2) `apps/web/app/api/stripe/webhooks/route.ts:527-617` — `handlePaymentFailed` must downgrade users reliably; do not silently return on missing `userId` or subscription fetch failure.  
> 3) `apps/web/app/api/stripe/webhooks/route.ts:499-512` — missing `userId` must be treated as a critical error (log + throw) with enough context to trace the event.  
> 4) `apps/web/app/api/cron/waitlist-invites/route.ts:14` — remove module-level `CRON_SECRET` capture; read env inside handler per request.  
> 5) `apps/web/app/api/stripe/checkout/route.ts:80-85` — allow `past_due`/`unpaid` users to resolve payment (either allow checkout session creation or route them to Stripe portal).  
>
> **Requirements**
> - Preserve correct webhook semantics: failures must return non-2xx so retries happen.  
> - Add structured logging (event id, type, subscription/customer id, userId when present).  
> - Ensure no partial updates leave users in inconsistent billing state.  
> - Add/adjust unit or integration tests for webhook retry behavior and checkout behavior for `past_due`/`unpaid`.
>
> **Deliverables**
> - Code diffs + explanation of each change.  
> - Tests added/updated and what they assert.  
> - Any necessary migration or config notes.

---

## Batch 2: High Priority (Next Sprint) — Bugs 3–6, 9–12
**Prompt:**
> You are a database- and security-focused engineer. Eliminate race conditions and auth/RLS hazards across these endpoints.
>
> **Targets**
> - Upsert race fixes:
>   - `apps/web/app/api/audience/click/route.ts:256-296` — replace `INSERT ... ON CONFLICT DO NOTHING` + follow-up SELECT with an upsert that guarantees a row (e.g., `ON CONFLICT DO UPDATE ... RETURNING *`).  
>   - `apps/web/app/api/track/route.ts:185-247` — same pattern; guarantee row return without race windows.
> - Transaction integrity:
>   - `apps/web/app/api/track/route.ts:327-350` — remove fire-and-forget social link counter update; execute inside the transaction and await it.
> - Stripe customer sync correctness:
>   - `apps/web/lib/stripe/customer-sync.ts:154-198` — if optimistic lock fails after Stripe customer creation, do not return success; implement retry/linking logic or cleanup strategy so no orphaned Stripe customers remain.
> - Cron concurrency + rate limiting correctness:
>   - `apps/web/app/api/cron/waitlist-invites/route.ts:88-168` — move rate limit checks into a transaction with proper locking or atomic counters to prevent concurrent passes.
>   - `apps/web/app/api/cron/billing-reconciliation/route.ts:70-141` — add distributed lock / idempotency guard to prevent concurrent runs.
> - Auth/RLS:
>   - `apps/web/lib/admin/roles.ts:10-27` — eliminate “demoted admins keep access” window (short TTL + invalidation strategy).  
>   - `apps/web/lib/db/index.ts:335-345` — standardize RLS session setup so it’s correct both inside and outside explicit transactions; remove inconsistencies between `SET LOCAL` vs session-scoped config.
>
> **Requirements**
> - Prefer DB-enforced guarantees (constraints, `RETURNING`, row locks) over app-level timing assumptions.
> - Add tests that simulate concurrency (or at least assert atomic behavior) for each previously-racy path.
> - Document any schema/index changes required.
>
> **Deliverables**
> - Code diffs, test diffs, and a short rationale per fix.
> - A “before/after” explanation of the race window and why it’s closed now.

---

## Batch 3: Medium Priority — Bugs 13–18, 22–25
**Prompt:**
> You are an infrastructure-minded engineer. Reduce operational risk, clean up resources, and harden error handling.
>
> **Targets**
> - Blob storage orphan prevention:
>   - `apps/web/app/api/images/upload/route.ts:411-481` — when avatar changes, delete the previous blob after DB update succeeds; ensure failures don’t delete the currently-active avatar.
>   - `apps/web/app/api/dashboard/profile/route.ts:388-405` — same: cleanup previous avatar blob reliably.
> - Payment tip duplicate observability:
>   - `apps/web/app/api/capture-tip/route.ts:93-112` — replace `console.log` with structured logging + clear distinction between true duplicates vs processing failures; consider idempotency semantics.
> - Handle availability race protection:
>   - `apps/web/app/api/handle/check/route.ts:205-210` — make handle claim safe under contention (prefer unique constraint + robust error handling; or serializable transaction if required).
> - Idempotency key robustness:
>   - `apps/web/app/api/dashboard/social-links/route.ts:147-152` — do not ignore idempotency key insert failure; store before side effects or implement retry.
> - Info disclosure:
>   - `apps/web/app/api/health/auth/route.ts:76` — stop returning stack traces in API responses; log server-side only.
> - Webhook retry correctness:
>   - `apps/web/app/api/clerk/webhook/route.ts:155-163` — return non-2xx on failure so Clerk retries.
> - Timing-safe cron secret comparisons:
>   - Multiple cron files — replace string compare with `crypto.timingSafeEqual` (and handle length mismatch safely).
> - Non-atomic cleanup job:
>   - `apps/web/app/api/cron/cleanup-photos/route.ts:93-120` — make DB deletion atomic (batch transaction), then delete blobs; ensure idempotency if blob deletion partially fails.
>
> **Requirements**
> - Avoid destructive operations until DB state is safely updated (or ensure rollback/compensation).
> - Add tests for cleanup/idempotency paths (including partial failure simulation).
> - Add metrics/logs that help ops detect leaks or repeated failures.
>
> **Deliverables**
> - Code diffs, tests, and a quick runbook note for ops (what to monitor).

---

## Batch 4: Lower Priority — Bugs 19–21 (React timers/memory leaks)
**Prompt:**
> You are a frontend React expert. Remove timer-related memory leaks and ensure no state updates happen after unmount.
>
> **Targets**
> - `components/dashboard/organisms/AppleStyleOnboardingForm.tsx:149-167`
> - `components/dashboard/organisms/DashboardFeedbackModal.tsx:44-72`
> - `components/dashboard/organisms/ListenNowForm.tsx:29-46`
>
> **Requirements**
> - Replace unmanaged `setTimeout` usage with `useRef`-stored timer ids and `useEffect` cleanup (`clearTimeout`) on unmount and before re-scheduling.
> - Ensure debounced actions cancel correctly on rapid input changes.
> - Add minimal tests (if your setup supports it) or at least clear reproduction steps + verification checklist.
>
> **Deliverables**
> - Updated components + short explanation per component of what was leaking and how it’s prevented now.

If you want, I can also rewrite each prompt into a **one-file-at-a-time** version (more copy/paste-friendly for tooling that works best on single diffs).


**Topic:** [[chatgpt-clusters/jovie_music]]


## See Also
- [[chatgpt/chatgpt_admin-tools-for-jovie]]
- [[chatgpt/chatgpt_adopting-exaai-for-jovie]]
- [[chatgpt/chatgpt_agent-first-strategy-for-jovie]]
- [[chatgpt/chatgpt_ai-changelog-insights-for-jovie]]
- [[chatgpt/chatgpt_angel-investors-for-jovie]]
