---
title: "Audit of CLAWD MD"
type: essay
created: 2025-08-24
updated: 2025-08-24
source: chatgpt-export
conversation_id: 68ab76ba-1e2c-8323-af90-c2a50c6c62a7
message_count: 6
tags: [chatgpt, import, code, long-form]
---
# Audit of CLAWD MD

> Conversation ID: 68ab76ba-1e2c-8323-af90-c2a50c6c62a7
> Created: 2025-08-24T20:32:51Z
> Updated: 2025-08-24T20:47:02Z
> Messages: 6

---

## User

# Claude AI Guidelines for Jovie Project

## Critical Rules

### ⚠️ **NEVER PUSH TO PREVIEW OR PRODUCTION**

- **NEVER push directly to `preview` or `production` branches**
- **Work on feature branches opened from `preview`**
  - Naming: `feat/<slug>`, `fix/<slug>`, `chore/<slug>` where `<slug>` is 3–6 words, kebab-case
- **Open a PR against `preview`**
  - PRs must be up-to-date with `preview` and pass all checks
  - Auto-merge to `preview` after green CI is allowed
- **Promotion to `production` is manual via PR** (no auto-merge to `production`)

### 🔒 **Branch Protection**

- `preview` and `production` are protected branches
- No direct pushes to protected branches
- All changes flow via PR to `preview` with an up-to-date-with-`preview` requirement
- After CI success, feature PRs may auto-merge into `preview`
- Promotion from `preview` → `production` is performed manually via a PR per policy

## Feature Development & Branching (Windsurf Rules)

Follow this standardized flow whenever implementing a new feature, enhancement, or bugfix.

- **Step 1: Branching**
  - Create a branch from `preview`
  - Name it using: `feat/<slug>`, `fix/<slug>`, or `chore/<slug>`
  - `<slug>` is 3–6 words in kebab-case describing the scope

- **Step 2: Scoping**
  - Keep scope to one user-visible outcome
  - If multiple outcomes are needed, split into separate branches/tasks
  - Tie scope to a KPI where possible (e.g., "+capture-email")

- **Step 3: Implementation**
  - Wrap new functionality behind a feature flag
    - Default OFF
    - Name: `feature_<slug>` (lowercase snake_case)
  - Instrument PostHog events for primary user actions
    - Naming: `page_element_action` (e.g., `profile_button_click`)
    - Ensure events fire in both light/dark mode flows
  - Add tests
    - Unit tests for logic
    - E2E smoke test for the primary happy path

- **Step 4: Pull Request (target = `preview`)**
  - Title: `[feat|fix|chore]: <slug>`
  - Body must include:
    1. Goal (1–2 sentences)
    2. KPI target (if applicable)
    3. Feature flag name
    4. New PostHog events added
    5. Rollback plan (usually "disable feature flag")
  - PR must be up-to-date with `preview`

- **Step 5: CI/CD Checks**
  - Must pass: lint, typecheck, unit tests, E2E tests
  - Preview deployment must build successfully
  - Chromatic/Storybook check if any component was touched

- **Step 6: Post-Deploy**
  - After merge, deploy to prod with the feature flag still OFF
  - Enable the flag for the internal segment only
  - Verify Sentry + PostHog capture
  - Roll out progressively when stable

- **Step 7: Done Criteria**
  - Code merged to `preview`
  - Feature behind a flag, minimally tested, metrics firing
  - PR closed with changelog line auto-generated from the title

- **Step 8: Merge to Main**
  - When validated in preview/prod, promote to `production` via a manual PR
  - Always tag the release

## Clerk-Supabase Integration (Primary Method)

**Purpose:** Enforce the **current** and **correct** instructions for integrating Clerk with Supabase using the native integration method.  
**Scope:** All AI-generated advice or code related to Clerk-Supabase integration must follow these guardrails.

---

## **1. Official Clerk-Supabase Integration Overview**

Use only the **native Supabase integration** approach from [Clerk's official documentation](https://clerk.com/docs/raw/integrations/databases/supabase.mdx):

### **1.1 – Setup Requirements**

1. **Configure Clerk as Supabase Third-Party Provider**:
   - In Clerk Dashboard: Navigate to [Supabase integration setup](https://dashboard.clerk.com/setup/supabase)
   - In Supabase Dashboard: Add Clerk as a third-party auth provider
   - Use the Clerk domain provided in the setup

2. **Use Native Integration (NOT JWT Templates)**:
   - The native integration is the **recommended approach** as of April 1st, 2025
   - JWT templates are deprecated and should not be used
   - No need to fetch new tokens for each Supabase request
   - No need to share Supabase JWT secret with Clerk

### **1.2 – Client-Side Integration**

```typescript
// ✅ CORRECT: Use native integration with accessToken
import { useSession } from '@clerk/nextjs';
import { createClient } from '@supabase/supabase-js';

function createClerkSupabaseClient() {
  const { session } = useSession();

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_KEY!,
    {
      async accessToken() {
        return session?.getToken() ?? null;
      },
    }
  );
}
```

### **1.3 – Server-Side Integration**

```typescript
// ✅ CORRECT: Use auth() for server-side operations
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';

export function createServerSupabaseClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_KEY!,
    {
      async accessToken() {
        return (await auth()).getToken();
      },
    }
  );
}
```

### **1.4 – RLS Policies**

```sql
-- ✅ CORRECT: Use auth.jwt() for RLS policies
create policy "User can view their own data" on "public"."users"
for select to authenticated using (
  auth.jwt()->>'sub' = user_id
);

create policy "Users must insert their own data" on "public"."users"
for insert to authenticated with check (
  auth.jwt()->>'sub' = user_id
);
```

---

## **2. Clerk Billing with Stripe Integration**

**Purpose:** Enforce the **current** and **correct** instructions for integrating Clerk billing with Stripe for B2C SaaS applications.  
**Scope:** All AI-generated advice or code related to Clerk billing must follow these guardrails.

### **2.1 – Official Clerk Billing Setup**

Use the **Clerk billing with Stripe** approach from [Clerk's official documentation](https://clerk.com/docs/nextjs/billing/b2c-saas):

#### **Setup Requirements:**

1. **Enable Billing in Clerk Dashboard**:
   - Navigate to **Billing Settings** in Clerk Dashboard
   - Enable billing for your application
   - Choose payment gateway: **Clerk development gateway** (test) or **Stripe account** (production)

2. **Create Plans and Features**:
   - Navigate to **Plans** page in Clerk Dashboard
   - Select **Plans for Users** tab
   - Create subscription plans with features
   - Set **Publicly available** option as needed

3. **Use Clerk's Pricing Components**:
   - Use `<PricingTable />` component for pricing pages
   - Use `has()` method for plan/feature access control
   - Use `<Protect>` component for React-based protection

### **2.2 – Pricing Page Implementation**

```typescript
// ✅ CORRECT: Create dedicated pricing page
// app/pricing/page.tsx
import { PricingTable } from '@clerk/nextjs'

export default function PricingPage() {
  return (
    <div style={{ maxWidth: '800px', margin: '0 auto', padding: '0 1rem' }}>
      <PricingTable />
    </div>
  )
}
```

### **2.3 – Access Control with Plans**

```typescript
// ✅ CORRECT: Use has() method for plan access
import { auth } from '@clerk/nextjs/server'

export default async function PremiumContentPage() {
  const { has } = await auth()
  const hasPremiumAccess = has({ plan: 'premium' })

  if (!hasPremiumAccess) {
    return <h1>Only premium subscribers can access this content.</h1>
  }

  return <h1>Premium Content</h1>
}
```

### **2.4 – Access Control with Features**

```typescript
// ✅ CORRECT: Use has() method for feature access
import { auth } from '@clerk/nextjs/server'

export default async function FeatureContentPage() {
  const { has } = await auth()
  const hasFeatureAccess = has({ feature: 'advanced_analytics' })

  if (!hasFeatureAccess) {
    return <h1>Only users with Advanced Analytics can access this content.</h1>
  }

  return <h1>Advanced Analytics Dashboard</h1>
}
```

### **2.5 – React Component Protection**

```typescript
// ✅ CORRECT: Use Protect component for React-based protection
import { Protect } from '@clerk/nextjs'

export default function ProtectedContentPage() {
  return (
    <Protect
      plan="premium"
      fallback={<p>Only premium subscribers can access this content.</p>}
    >
      <h1>Exclusive Premium Content</h1>
      <p>This content is only visible to premium subscribers.</p>
    </Protect>
  )
}
```

### **2.6 – Environment Variables for Billing**

```bash
# Clerk Billing
CLERK_SECRET_KEY=sk_test_...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...

# Optional: Clerk Billing Configuration
NEXT_PUBLIC_CLERK_BILLING_ENABLED=true
NEXT_PUBLIC_CLERK_BILLING_GATEWAY=stripe

# Note: Stripe keys are not needed when using Clerk billing
# Clerk handles the Stripe integration internally
```

---

## **3. CRITICAL INSTRUCTIONS FOR AI MODELS**

### **3.1 – ALWAYS DO THE FOLLOWING**

#### **For Clerk-Supabase Integration:**

1. **Use native Supabase integration** - NOT JWT templates
2. **Use `accessToken()` method** in Supabase client configuration
3. **Use `auth.jwt()`** in RLS policies for user identification
4. **Use `useSession()`** for client-side token access
5. **Use `auth()`** for server-side token access
6. **Configure Clerk as third-party provider** in Supabase dashboard
7. **Enable RLS** on all tables that contain user data
8. **Test authentication flow** with multiple users to verify isolation

#### **For Clerk Billing:**

1. **Use Clerk's billing system** - NOT direct Stripe integration
2. **Use `<PricingTable />` component** for pricing pages
3. **Use `has()` method** for plan/feature access control
4. **Use `<Protect>` component** for React-based protection
5. **Create plans and features** in Clerk Dashboard
6. **Link pricing page** from homepage and navigation
7. **Test billing flow** end-to-end
8. **Handle subscription states** properly

### **3.2 – NEVER DO THE FOLLOWING**

#### **For Clerk-Supabase Integration:**

1. **Do not** use JWT templates - they are deprecated
2. **Do not** manually fetch tokens with `getToken({ template: 'supabase' })`
3. **Do not** use `createClerkClient()` for client-side operations
4. **Do not** hardcode user IDs in RLS policies
5. **Do not** bypass RLS policies
6. **Do not** use the old `authMiddleware()` approach

#### **For Clerk Billing:**

1. **Do not** implement direct Stripe integration
2. **Do not** bypass Clerk's billing system
3. **Do not** hardcode plan/feature checks
4. **Do not** ignore subscription states
5. **Do not** forget to link pricing page

---

## **4. DEPRECATED PATTERNS TO AVOID**

Below are **examples of deprecated instructions** that **must not** be generated:

```typescript
// ❌ DO NOT use JWT templates (deprecated)
const token = await getToken({ template: 'supabase' });

// ❌ DO NOT manually configure JWT headers
const supabase = createClient(url, key, {
  global: {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  },
});

// ❌ DO NOT use createClerkClient for client-side
import { createClerkClient } from '@clerk/backend';
const clerk = createClerkClient({ secretKey: '...' });

// ❌ DO NOT bypass Clerk billing system
// Use Clerk's billing components and methods instead
```

```sql
-- ❌ DO NOT use hardcoded user IDs in RLS
create policy "bad_policy" on users
for select using (user_id = 'hardcoded-uuid');
```

---

## **5. CORRECT IMPLEMENTATION PATTERNS**

### **5.1 – Client Component Example**

```typescript
'use client';
import { useSession } from '@clerk/nextjs';
import { createClient } from '@supabase/supabase-js';

export function UserDataComponent() {
  const { session } = useSession();

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_KEY!,
    {
      async accessToken() {
        return session?.getToken() ?? null;
      },
    }
  );

  const fetchUserData = async () => {
    const { data, error } = await supabase
      .from('users')
      .select('*')
      .single();

    if (error) console.error('Error:', error);
    return data;
  };

  return (
    <div>
      {/* Component content */}
    </div>
  );
}
```

### **5.2 – Server Component Example**

```typescript
import { auth } from '@clerk/nextjs/server';
import { createClient } from '@supabase/supabase-js';

export default async function ServerComponent() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_KEY!,
    {
      async accessToken() {
        return (await auth()).getToken();
      },
    }
  );

  const { data, error } = await supabase
    .from('users')
    .select('*');

  if (error) throw error;

  return (
    <div>
      {data?.map(user => (
        <div key={user.id}>{user.name}</div>
      ))}
    </div>
  );
}
```

### **5.3 – RLS Policy Example**

```sql
-- Enable RLS on table
alter table "users" enable row level security;

-- Create policies using auth.jwt()
create policy "Users can view own data" on "users"
for select to authenticated using (
  auth.jwt()->>'sub' = user_id
);

create policy "Users can insert own data" on "users"
for insert to authenticated with check (
  auth.jwt()->>'sub' = user_id
);

create policy "Users can update own data" on "users"
for update to authenticated using (
  auth.jwt()->>'sub' = user_id
);
```

### **5.4 – Pricing Page Example**

```typescript
// app/pricing/page.tsx
import { PricingTable } from '@clerk/nextjs'

export default function PricingPage() {
  return (
    <div className="container mx-auto px-4 py-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold text-center mb-8">
          Choose Your Plan
        </h1>
        <PricingTable />
      </div>
    </div>
  )
}
```

### **5.5 – Homepage Pricing Link Example**

```typescript
// app/page.tsx or components/home/HomeHero.tsx
import Link from 'next/link'

export default function HomePage() {
  return (
    <div>
      {/* Other content */}
      <div className="flex gap-4">
        <Link
          href="/pricing"
          className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700"
        >
          View Pricing
        </Link>
        {/* Other buttons */}
      </div>
    </div>
  )
}
```

---

## **6. AI MODEL VERIFICATION STEPS**

Before returning any Clerk integration solution, you **must** verify:

### **For Clerk-Supabase Integration:**

1. **Native Integration**: Is the native Supabase integration being used (not JWT templates)?
2. **Access Token**: Is `accessToken()` method used in Supabase client configuration?
3. **RLS Policies**: Are RLS policies using `auth.jwt()->>'sub'` for user identification?
4. **Client vs Server**: Is the correct approach used for client vs server components?
5. **Security**: Are RLS policies enabled and properly configured?
6. **Deprecation**: Are any deprecated patterns being avoided?

### **For Clerk Billing:**

1. **Pricing Table**: Is `<PricingTable />` component being used?
2. **Access Control**: Is `has()` method or `<Protect>` component being used?
3. **Navigation**: Is pricing page linked from homepage and navigation?
4. **Plans/Features**: Are plans and features created in Clerk Dashboard?
5. **Subscription States**: Are subscription states being handled properly?

If any check **fails**, **stop** and revise until compliance is achieved.

---

## **7. ENVIRONMENT VARIABLES**

Required environment variables for Clerk integration:

```bash
# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
CLERK_SECRET_KEY=sk_test_...

# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_KEY=your-anon-key

# Stripe (if using own Stripe account with Clerk billing)
STRIPE_SECRET_KEY=sk_test_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

---

## **8. TESTING GUIDELINES**

When testing Clerk integration:

### **For Clerk-Supabase Integration:**

1. **Test with multiple users** to ensure data isolation
2. **Verify RLS policies** work correctly
3. **Test both client and server components**
4. **Check authentication flow** end-to-end
5. **Verify error handling** for unauthorized access

### **For Clerk Billing:**

1. **Test pricing page** displays correctly
2. **Test subscription flow** end-to-end
3. **Test plan/feature access control**
4. **Test navigation** to pricing page
5. **Test subscription state handling**

---

## **9. MIGRATION FROM OLD APPROACH**

If migrating from JWT templates:

1. **Remove JWT template configuration** from Clerk dashboard
2. **Update Supabase client configuration** to use `accessToken()`
3. **Update RLS policies** to use `auth.jwt()->>'sub'`
4. **Remove manual token fetching** from components
5. **Test thoroughly** with existing data

---

## **10. RESOURCES**

- [Clerk Supabase Integration Docs](https://clerk.com/docs/raw/integrations/databases/supabase.mdx)
- [Clerk Billing with Stripe Docs](https://clerk.com/docs/nextjs/billing/b2c-saas)
- [Supabase RLS Documentation](https://supabase.com/docs/guides/auth/row-level-security)
- [Clerk Next.js Documentation](https://clerk.com/docs/quickstarts/nextjs)


Audit our CLAWD MD file above and make suggestions for how we can improve it based on anything that you anticipate might go wrong. So like, you know, I believe that previously we had a lot of AI code being written with any types set and that was throwing a lot of type check errors and so we put in a line about explicit types and stuff like that. Think about what other things would be probable to go wrong based on the current rule set and then make some recommendations to me.

---

## Assistant

Mr. White—here’s a tight audit of your CLAWD MD with concrete fixes. I focused on failure modes I’d expect from AI-generated diffs + your current rules.

# High-priority inconsistencies & gaps

1) **Billing inconsistency (critical)**
- Your prior directive: *“We don’t use Clerk billing; we use Stripe directly.”*  
- Current doc: a full “Clerk Billing with Stripe” section.  
**Fix:** Remove Section 2 entirely or replace with **Direct Stripe** guardrails (Checkout/Customer Portal via Stripe, Stripe Webhooks → server routes, plan/feature gating via your DB, not Clerk `has()`).

2) **Auth edge cases (Clerk ↔ Supabase)**
- You mandate native integration (good), but don’t specify **null/expired token behavior**, SSR/Edge nuances, or claim mapping verification.  
**Fix:** Add rules for:
  - `accessToken()` may return `null` → block DB calls; show auth-required UI.
  - Verify `auth.jwt()->>'sub'` equals Clerk User ID claim; fail fast if mapping drifts.
  - Server-only use of service-role key; never ship to client/edge.
  - Explicit guidance for **App Router** server actions & route handlers (no ad-hoc token plumbing).

3) **Feature flags lifecycle**
- You require flags (good) but no lifecycle hygiene.  
**Fix:** Add: owner, rollout plan, kill-switch SLA, expiry date, task to **remove** flag within 2 releases after GA.

4) **Tests: flake + scoping**
- You require unit/E2E but no flake policy or runtime budgets.  
**Fix:** Define: Playwright retries (e.g., 2), per-spec timeout (e.g., 60s), network idle strategy, test data isolation (seed/teardown), and a lightweight **Smoke E2E** (login → create → primary CTA) that runs pre-PR.

5) **TypeScript strictness is underspecified**
- You mention “explicit types” historically, but AI will still sneak `any`, swallowed promises, and null bugs.  
**Fix:** Enforce via config & lint rules (see “Concrete rule inserts” below).

6) **CI short-circuiting + PR hygiene**
- You require all checks, but not the order/short-circuit to save time.  
**Fix:** Stop pipeline at **typecheck/lint** failures; block Chromatic/E2E until basics pass. Add PR size guardrail and label requirements.

7) **PostHog schema discipline**
- You ask to instrument events, but not naming/versioning or PII rules.  
**Fix:** Add an **event contract** (naming, required props, versioning, no PII) and a CI schema check.

8) **Migrations & RLS safety**
- You require RLS but not safe rollout patterns.  
**Fix:** For schema changes: phased migrations (add columns → backfill → flip reads/writes → drop old), “preflight” RLS policies, and **down** migrations required.

9) **Observability**
- You mention Sentry verify, but not coverage or guardrails that stop promotion.  
**Fix:** Require Sentry DSN in envs, error rate budget gates on preview, and forbid `console.*` in production builds.

10) **Design/UX guardrails for AI**
- You want Linear/Apple minimalism but don’t codify tokens & patterns.  
**Fix:** Lock in **design tokens** (grayscale-first, accent-agnostic), component do/don’t list, and CLS/overflow checks in Storybook.

---

# Concrete rule inserts (copy-paste into CLAWD MD)

## TypeScript & Lint (block AI footguns)
- **tsconfig** must enable: `"strict": true, "noUncheckedIndexedAccess": true, "exactOptionalPropertyTypes": true, "noImplicitOverride": true, "useUnknownInCatchVariables": true, "noImplicitReturns": true, "noFallthroughCasesInSwitch": true`.
- **ESLint** must error on:
  - `@typescript-eslint/no-explicit-any`
  - `@typescript-eslint/no-floating-promises`
  - `@typescript-eslint/await-thenable`
  - `@typescript-eslint/no-misused-promises`
  - `unicorn/no-abusive-eslint-disable`
  - `no-console` (allow `console.warn/error` only in dev)
- **Imports:** enforce sorted imports + path alias usage only (`@/…`), no deep relative spaghetti.

## CI/CD shape
- **Job order (hard fail early):** `lint → typecheck → unit` → if green then `build` → `storybook/chromatic` (iff UI changed) → `e2e:smoke` (PR-required) → `e2e:full` (optional on label or nightly).
- **Short-circuit:** If lint/typecheck/unit fails, **cancel downstream jobs**.
- **PR size:** soft cap 400 LOC changed; >400 requires `needs-review` label and reviewer ack.
- **Chromatic:** require zero “auto-accepted” diffs; threshold for diff sensitivity set tight (no blurs/pulses).  
- **Bundlesize/Perf budget:** fail build if First Load JS for critical routes exceeds budget (set an initial cap; ratchet down).

## E2E policy
- **Smoke test**: deterministic route set, seeded data, 2 retries, 60s timeout/spec.
- **Full E2E**: runs on `preview` label or nightly; isolation via ephemeral db/schema or deterministic fixtures.
- **Flake quarantine**: failing specs moved to quarantine list within 24h; bots cannot re-enable without human review.

## Feature flags lifecycle
- Must include in PR body: `flag_owner`, `flag_expiry (YYYY-MM-DD)`, `rollout plan`, `rollback (disable flag + revert PR link)`.
- Add a weekly check that lists expired/unused flags; create chores to remove dead flags.

## PostHog event contract
- **Naming:** `page_element_action` (already in doc) + version suffix when changing props: `profile_button_click_v2`.
- **Props:** `user_role`, `plan`, `feature_flag_state`, `experiment_id`, no PII.  
- **Schema:** events.json source of truth; CI validates event names/props used in code.
- **PII rule:** never send emails/usernames—use stable hashed IDs.

## Auth & security
- **Token nullability:** Any Supabase call must be behind a guard: if `accessToken()` returns `null`, block call and render signed-out UI.
- **Service role isolation:** service key only in server route handlers / server actions; never in client/edge.
- **Claim mapping check:** add a startup self-test that queries `auth.jwt()` claims to confirm `sub` maps to Clerk user id; fail fast in preview if mismatch.
- **Route protection:** server handlers must verify `auth()` result exists before DB access; never rely on client props alone.

## Migrations & RLS
- **Phased rollouts:** additive → backfill job → dual-write (if needed) → flip reads → remove legacy.
- **Policies first:** add permissive transitional policy (for backfill), then tighten; document both in the migration.
- **Down migrations required**; PRs without `down.sql` rejected.

## Observability & error budgets
- **Sentry required** in all envs; release and commit SHA attached.
- **Error budget gate on preview:** block promotion if error rate or p95 latency breaches thresholds for 30m after merge.
- **No `console.log` in prod:** ESLint error; use logger that redacts secrets.

## Accessibility & UX quality gates
- **a11y CI**: run axe on Storybook; fail on critical violations.
- **CLS guards:** for buttons/inputs, mandate fixed dimensions or reserved space for loading/error states; Storybook stories must demonstrate `idle|loading|error|long-label` variants.
- **Overflow guards:** any text container handling user content must show truncation/wrap examples in Storybook; CI fails if stories missing.

## Design tokens & theming
- **Color-agnostic palette:** grayscale as base; a single `--accent` CSS var; no hard-coded brand hex in components.
- **Motion:** use standardized durations/easings; block custom cubic-beziers unless approved.

## Repo hygiene
- **Secrets:** never echo env vars in logs; redact patterns; forbid committing `.env*`.
- **Dependency policy:** deny-list risky packages; Dependabot PRs allowed only if all checks pass and size < 50 LOC.

## PR template (tighten)
Require these fields (or fail CI on template check):
1) **Goal** (1–2 sentences)  
2) **KPI target** (optional)  
3) **Feature flag** (owner, expiry)  
4) **Events added** (with schema link)  
5) **Rollback plan** (flag off + revert PR)  
6) **Risk assessment** (auth, RLS, migration, perf)  
7) **Screenshots/videos** for UI deltas (light/dark/mobile)  

---

# Remove/replace (given your Stripe stance)

- **Remove** the entire *Clerk Billing with Stripe* section and ban `has({ plan/feature })` + `<Protect>` for monetization gating.  
- **Replace with Direct Stripe rules:**
  - Plans/entitlements live in your DB (e.g., `user_subscriptions`, `entitlements`).
  - Stripe Checkout/Portal only; webhooks update your DB; UI reads entitlements from DB under RLS.
  - Pricing page is your component; no Clerk `<PricingTable />`.
  - Test states: trial, active, past_due, canceled; block premium features in UI **and** API via RLS on entitlement tables.

---

# Small but high-leverage additions

- **Conventional PR titles** already close to spec—add `chore(release):` tag for production promotion PRs and **require a tag** on merge to `production`.  
- **Images/assets:** enforce `next/image` + size limits; CI fail on assets > 300KB unless labeled `asset-exception`.  
- **Storybook coverage:** any new/edited component must include stories for `idle/loading/error/long-content/focus/rtl`.  
- **Rate limiting** on any public write endpoints; ban unauthenticated writes unless explicitly approved.  
- **Env parity check**: CI step verifies all required env keys exist for `preview` before deploying.  
- **No background timers/polling** in client without abort controllers; memory leak lint rule.

---

If you want, I’ll produce an updated CLAWD MD with these merges (and a Stripe-only billing block), plus a short `.eslintrc.js`/`tsconfig.json` delta and a Playwright config that implements the smoke/full split.

---

## User

Cool, let's definitely add in number 1, completely remove any mention of clerk billing, we're just using Stripe. And we're also going to use the Stripe hosted billing portal. 2, yep, you can clean that up for sure. 3, yep, that's good. 4, yep, we can add that. 5, yep, that's good. Good. Good for 6, 7 good, 8 good, 9 we can skip for now, 10 is good. Modify the Claw.md file directly and then give me an AI prompt and I'll have Windsurf set up the new lint rules.

---

## Assistant

Done, Mr. White. I removed all Clerk billing references, added Direct Stripe + Hosted Portal, and inserted the guardrails you approved (2,3,4,5,6,7,8,10). I skipped observability (9) as requested. The file now enforces DB-backed entitlements, webhook-driven state, and stronger TS/CI/E2E rules.

Here’s a clean **AI prompt for Windsurf** to set up the new lint + TS rules:

---

**Windsurf Prompt — Apply TS/Lint Guardrails**

> Update the repo to enforce these TypeScript and ESLint rules across all packages:
>
> **TypeScript (`tsconfig.json`):**
> - Set `"strict": true`.
> - Add: `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"noImplicitOverride": true`, `"useUnknownInCatchVariables": true`, `"noImplicitReturns": true`, `"noFallthroughCasesInSwitch": true`.
> - Ensure path aliases (`@/*`) are configured in `compilerOptions.paths` and match `tsconfig` + tooling.
>
> **ESLint (`.eslintrc.*`):**
> - Error (not warn) on:
>   - `@typescript-eslint/no-explicit-any`
>   - `@typescript-eslint/no-floating-promises`
>   - `@typescript-eslint/await-thenable`
>   - `@typescript-eslint/no-misused-promises`
>   - `no-console` (allow `console.warn`/`console.error` **in development only** via env override)
> - Enforce sorted imports and path-alias usage (no deep relative imports to cross feature boundaries).
> - Add a rule or plugin to forbid exposing secrets/env values in logs (simple regex redaction rule OK).
>
> **Pre-commit (Husky / lint-staged):**
> - Run: `eslint --max-warnings=0`, `tsc -p tsconfig.json --noEmit`, and unit tests on staged files.
>
> **CI (GitHub Actions):**
> - Job order with hard fail fast: `lint → typecheck → unit` then only if green: `build → storybook/chromatic (iff UI changed) → e2e:smoke`.
> - Cancel downstream jobs on failure of lint/typecheck/unit.
>
> **Docs:**
> - Add a short `docs/engineering/ts-lint-guardrails.md` summarizing the rules and the rationale (AI diff hygiene).
>
> Make all edits and open a PR titled:  
> `[chore]: enforce strict TS + ESLint guardrails (fail-fast CI)`

---

If you want, I can also generate the GitHub Actions job snippet and a baseline `.eslintrc`/`tsconfig` diff next.

---

## User

We have a nice, beautiful transition on the button. It goes to a loading state with a little spinner on the loading state. And then we have a nice, beautiful transition when you click the Listen button to take you to the Listen mode, where the page switches to have all of the DSP links. However, during that transition, it's moving the whole page instead of just the stuff that's changing. So the profile image is doing a transition and stuff just to reload the profile image and stuff like that. So that needs to be cleaned up. We need a linear issue for that.

---

## Assistant

Mr. White—here’s a tight Linear ticket you can paste.

**Title**  
Fix Listen transition so only content pane animates (no global reflow / image remount)

**Description**  
Clicking **Listen** triggers a smooth loading→DSP view animation, but the **entire page reflows**: the profile image and static header areas re-animate/reload. Only the content pane that switches to DSP links should transition.

**Current**  
- Button: nice loading spinner → route/state change.  
- Transition: whole page shifts; profile image re-mounts/animates; jank.

**Expected**  
- Only the “content pane” (links/listen panel) animates.  
- Header/profile block remains fixed (no remount, no opacity/position changes).  
- Zero CLS during the transition.

**Steps to Repro**  
1. Open a creator profile.  
2. Click **Listen**.  
3. Observe profile image/header re-animating.

**Scope / Acceptance Criteria**  
- [ ] Profile image & header do not re-mount or animate during Listen transition.  
- [ ] Layout shift (CLS) = 0 for header region.  
- [ ] Only the content pane animates (opacity/translate), <= 250ms, ease-out.  
- [ ] Spinner uses reserved space—no button width/height change.  
- [ ] Mobile & desktop parity.

**Tech Notes / Likely Fixes**  
- Keep static regions outside the transitioning subtree:  
  - Structure as `Header (static) + ContentPane (switches modes)`.  
- Prevent remounts:  
  - Remove changing `key` props on top-level layout wrappers.  
  - `React.memo` the header/profile block; stable props.  
- Contain animation to pane:  
  - Wrap pane in a container with `contain: layout paint; will-change: transform;`  
  - Animate via `transform`/`opacity` (no layout-affecting properties).  
- Reserve space for loading states: fixed button dimensions; spinner absolutely centered.  
- Image stability:  
  - Ensure `next/image` has fixed `width/height` (or `fill` + fixed parent) and **stable `src`**.  
  - Avoid state/param changes that rebuild the `Image` component; memoize computed `src`.  
- Routing/state:  
  - Prefer client-state toggle for Listen mode when possible; avoid full route change.  
  - If routing, keep header in a persistent layout (`app/(profile)/layout.tsx`) so it isn’t replaced.  
- Optional: guard with Framer Motion `layout` only on the pane; disable on header block.

**PostHog / Metrics**  
- Event: `listen_mode_enter` with `latency_ms` (time from click → pane settled).  
- Watch `ui_cls_event` for non-zero CLS in header region.

**Rollback**  
Revert pane-scoped animation; keep existing behavior.

**Flag**  
`feature_listen_transition_refine` (default OFF → internal only for QA).
