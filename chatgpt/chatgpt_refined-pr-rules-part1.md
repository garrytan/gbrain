---
title: "Refined PR rules"
type: essay
created: 2025-08-23
updated: 2025-08-24
source: chatgpt-export
conversation_id: 68aa50d4-bf3c-8324-b730-84131050a8c5
message_count: 8
tags: [chatgpt, import, code, long-form]
---
# Refined PR rules

> Conversation ID: 68aa50d4-bf3c-8324-b730-84131050a8c5
> Created: 2025-08-23T23:38:07Z
> Updated: 2025-08-24T00:15:04Z
> Messages: 8


Consolidate and refine these rules

## intent
Run a fast, deterministic **smoke test** before opening a PR. **Always open the PR** afterward (pass or fail) with a structured checklist so it can enter the Merge Queue when ready. Follow **Y Combinator best practices** (ship fast, small diffs, tighten feedback loops), take **Linear**-style design inspiration (clarity, minimalism), and aim for **Apple-level UX polish and copywriting** (concise, humane, on-brand).

## triggers
- on: linear.issue_labeled(codegen|ready) OR local.command("prepare-pr") OR vcs.branch_created("feat/*","fix/*","chore/*")

## env
- NODE_VERSION: 20
- PACKAGE_MANAGER: pnpm

## steps
1. checkout → new branch if needed  
2. install: `pnpm i --frozen-lockfile`  
3. **smoke-lint:** `pnpm lint --max-warnings=0`  
4. **smoke-types:** `pnpm typecheck`  // `tsc --noEmit`  
5. **smoke-tests:** `pnpm test:unit --run -t "smoke|happy|render"`  
6. **smoke-build:** `pnpm build -n || vite build --emptyOutDir false`  
7. **ui-snapshot (fast optional):** `pnpm story:build || true`  
8. summarize results → generate PR body

## policy
- Do **not** reformat large files beyond the change-set.
- Touch **no infra/pipeline** files (e.g., `.github/workflows/**`, `infra/**`) unless the issue explicitly requires it.
- Keep diffs **small & focused** (YC principle: ship in narrow slices).
- Prefer clear names, **no TODOs** without context.
- Copywriting: short, specific, benefit-oriented (Apple-level tone; no filler).

## failure-behavior
- If any smoke step fails, **still open the PR**.
- Add labels: `needs-human`, `smoke-failed`; remove `automerge`.
- Prepend ❌ status to PR title; include failing sections + logs summary in PR body.
- Never enable auto-merge on failed smoke; queue only after green.

## success-behavior
- Labels: `ready-for-review`, `automerge-candidate`.
- Title prefixes: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `perf:`, `test:`.
- Auto-enable native **auto-merge** (squash) if required checks are green.

## pr-open
- always: true
- title: |
  {{ status_emoji }} {{ type_prefix }}{{ concise_title }}
- body: |
  ## Summary
  - **Why**: {{ problem_statement }}  
  - **What**: {{ solution_slice }}  
  - **Risk**: {{ risk_note }}  
  - **UX**: Apple-level polish target; copy trimmed for clarity.

  ## Smoke Result
  - Lint: {{ lint_status }}
  - Types: {{ types_status }}
  - Unit (smoke): {{ unit_status }}
  - Build (smoke): {{ build_status }}
  - Storybook (fast): {{ story_status }}

  ## Checklists (YC + Linear-inspired)
  - [ ] Small, reviewable diff (≤ ~300 LOC touched)
  - [ ] Clear, actionable acceptance criteria met
  - [ ] Tests updated/added for changed behavior
  - [ ] UX text is concise & on-brand (no filler)
  - [ ] Screens/flows avoid layout shift & spinners overlap
  - [ ] Public profile path stays <100ms p95 (no regressions)

  ## Notes for Reviewers
  - Logs/excerpts:  
    {{ short_logs }}
  - Follow-ups (if any): {{ followups }}

- labels-default: ["triage"]
- reviewers: ["@owner-or-codeowners"]

## outputs
- status_emoji: "✅" | "❌"
- type_prefix: infer from branch or commit scope
- concise_title: first line of issue title or commit subject

## post-open
- If ❌, post comment with actionable next steps and point to failing smoke stage/logs.
- If ✅, link issue → PR and move Linear ticket to "In Review".

# Claude AI Guidelines for Jovie Project

## Critical Rules

### ⚠️ **NEVER PUSH TO PREVIEW OR MAIN**

- **NEVER push directly to `preview` or `main` branches**
- **Work on feature branches opened from `preview`**
  - Naming: `feat/<slug>`, `fix/<slug>`, `chore/<slug>` where `<slug>` is 3–6 words, kebab-case
- **Open a PR against `preview`**
  - PRs must be up-to-date with `preview` and pass all checks
  - Auto-merge to `preview` after green CI is allowed
- **Promotion to `main` is manual via PR** (no auto-merge to `main`)

### 🔒 **Branch Protection**

- `preview` and `main` are protected branches
- No direct pushes to protected branches
- All changes flow via PR to `preview` with an up-to-date-with-`preview` requirement
- After CI success, feature PRs may auto-merge into `preview`
- Promotion from `preview` → `main` is performed manually via a PR per policy

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
    - E2E smoke test for the main happy path

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
  - When validated in preview/prod, promote to `main` via a manual PR
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


Here’s a consolidated and refined version of your ruleset — I collapsed duplication, clarified sequence, and kept everything tight but complete.  

---

# 🚦 Jovie PR & Integration Rules

## 1. Intent
- Always run a **fast, deterministic smoke test** before opening a PR.  
- **Always open the PR** (pass or fail) with structured output so it can enter Merge Queue when ready.  
- Follow **YC best practices** (ship small, fast, tighten loops), design like **Linear** (clarity, minimalism), and hold bar for **Apple-level UX & copywriting** (concise, humane, benefit-oriented).  

---

## 2. Triggers
Open PR when:  
- `linear.issue_labeled(codegen|ready)`  
- `local.command("prepare-pr")`  
- `vcs.branch_created("feat/*","fix/*","chore/*")`  

---

## 3. Environment
- `NODE_VERSION=20`  
- `PACKAGE_MANAGER=pnpm`  

---

## 4. Smoke Steps
1. Checkout → new branch if needed  
2. Install deps: `pnpm i --frozen-lockfile`  
3. **Lint:** `pnpm lint --max-warnings=0`  
4. **Types:** `pnpm typecheck` (`tsc --noEmit`)  
5. **Unit (smoke):** `pnpm test:unit --run -t "smoke|happy|render"`  
6. **Build:** `pnpm build -n || vite build --emptyOutDir false`  
7. **UI snapshot (optional):** `pnpm story:build || true`  
8. Summarize → PR body  

---

## 5. Policy
- Don’t reformat files beyond the change set.  
- Don’t touch infra/pipeline files (`.github/workflows/**`, `infra/**`) unless issue requires.  
- Keep diffs **small, focused slices** (≤300 LOC touched).  
- No naked TODOs; clear names only.  
- Copywriting: short, specific, no filler.  

---

## 6. Failure Behavior
- Still open PR.  
- Labels: `needs-human`, `smoke-failed`. Remove `automerge`.  
- Title prepended with ❌. Include logs summary in body.  
- Never queue auto-merge until smoke passes.  

---

## 7. Success Behavior
- Labels: `ready-for-review`, `automerge-candidate`.  
- Title prefix: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `perf:`, `test:`.  
- Auto-enable squash auto-merge if all checks are green.  

---

## 8. PR Template
**Always open PRs with:**  

**Title**  
```txt
{{ status_emoji }} {{ type_prefix }}{{ concise_title }}
```

**Body**  
```md
## Summary
- **Why**: {{ problem_statement }}
- **What**: {{ solution_slice }}
- **Risk**: {{ risk_note }}
- **UX**: Apple-level polish; copy trimmed for clarity.

## Smoke Result
- Lint: {{ lint_status }}
- Types: {{ types_status }}
- Unit: {{ unit_status }}
- Build: {{ build_status }}
- Storybook: {{ story_status }}

## Checklists (YC + Linear-inspired)
- [ ] Small, reviewable diff (≤300 LOC)
- [ ] Clear acceptance criteria met
- [ ] Tests updated/added
- [ ] UX text concise & on-brand
- [ ] No layout shifts/spinner overlap
- [ ] Public profile <100ms p95

## Notes for Reviewers
- Logs: {{ short_logs }}
- Follow-ups: {{ followups }}
```

- Default labels: `["triage"]`  
- Reviewers: `@owner-or-codeowners`  

---

## 9. Post-Open Flow
- ❌ → Post comment with actionable next steps + failing stage/log link.  
- ✅ → Link PR to issue and move Linear ticket to **In Review**.  

---

## 10. Branching & Protection
- **Never push directly** to `preview` or `main`.  
- Work only on feature branches from `preview`:  
  - Naming: `feat/<slug>`, `fix/<slug>`, `chore/<slug>` (3–6 word kebab-case).  
- All changes flow via PR → `preview`.  
- Auto-merge to `preview` allowed after green CI.  
- Promotion `preview → main` is manual PR + release tag.  

---

## 11. Feature Development Flow
1. **Branch** from `preview`, name properly.  
2. **Scope**: one user-visible outcome; split otherwise.  
3. **Implementation**  
   - Behind feature flag (`feature_<slug>`, default OFF).  
   - Add PostHog events (`page_element_action`).  
   - Unit + E2E smoke test main path.  
4. **PR** to `preview`:  
   - Title `[feat|fix|chore]: <slug>`  
   - Body includes goal, KPI, flag name, events, rollback plan.  
5. **Checks**: lint, types, unit, E2E, preview deploy, Chromatic if UI.  
6. **Post-Deploy**: deploy w/ flag OFF → enable internal only → verify metrics/errors → progressive rollout.  
7. **Done**: code in `preview`, feature flagged, metrics firing.  
8. **Merge to main**: via manual PR + release tag.  

---

## 12. Clerk-Supabase Integration
- Use **native integration**, **NOT JWT templates**.  
- Client: `useSession() → session.getToken()` via `accessToken()`.  
- Server: `auth() → getToken()`.  
- RLS policies: `auth.jwt()->>'sub' = user_id`.  
- Enable RLS on all user tables.  
- Test multi-user isolation.  

---

## 13. Clerk Billing
- Use Clerk’s built-in billing w/ Stripe.  
- Plans & features defined in Clerk dashboard.  
- Pricing page uses `<PricingTable />`.  
- Access control via `has()` or `<Protect>`.  
- Handle subscription states.  
- Never bypass Clerk billing w/ direct Stripe code.  

---

## 14. Deprecated Patterns (🚫 Never Use)
- JWT templates (`getToken({ template: 'supabase' })`).  
- `createClerkClient()` client-side.  
- Hardcoded user IDs in RLS.  
- Direct Stripe integration outside Clerk billing.  
- Manual token headers for Supabase.  

---

## 15. Env Vars
```bash
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_KEY=...
```
(+ Stripe keys only if Clerk billing → Stripe).  

---

This unified version keeps your workflow crisp, YC/Linear/Apple-aligned, and removes duplication.  

---

Do you want me to also **shrink this into a one-page “rules card”** (minimal bullets only) for AI agents to follow blindly, separate from the detailed doc?


We dont use clerk billing, we use stripe billing directly


Got it. I’ll strip out the Clerk Billing section entirely and refine the rules to reflect **direct Stripe billing** instead. Here’s the cleaned and consolidated version:  

---

# 🚦 Jovie PR & Integration Rules

## 1. Intent
- Always run a **fast, deterministic smoke test** before opening a PR.  
- **Always open the PR** (pass or fail) with structured output so it can enter Merge Queue when ready.  
- Follow **YC best practices** (ship small, fast, tighten loops), design like **Linear** (clarity, minimalism), and hold bar for **Apple-level UX & copywriting** (concise, humane, benefit-oriented).  

---

## 2. Triggers
Open PR when:  
- `linear.issue_labeled(codegen|ready)`  
- `local.command("prepare-pr")`  
- `vcs.branch_created("feat/*","fix/*","chore/*")`  

---

## 3. Environment
- `NODE_VERSION=20`  
- `PACKAGE_MANAGER=pnpm`  

---

## 4. Smoke Steps
1. Checkout → new branch if needed  
2. Install deps: `pnpm i --frozen-lockfile`  
3. **Lint:** `pnpm lint --max-warnings=0`  
4. **Types:** `pnpm typecheck` (`tsc --noEmit`)  
5. **Unit (smoke):** `pnpm test:unit --run -t "smoke|happy|render"`  
6. **Build:** `pnpm build -n || vite build --emptyOutDir false`  
7. **UI snapshot (optional):** `pnpm story:build || true`  
8. Summarize → PR body  

---

## 5. Policy
- Don’t reformat files beyond the change set.  
- Don’t touch infra/pipeline files (`.github/workflows/**`, `infra/**`) unless issue requires.  
- Keep diffs **small, focused slices** (≤300 LOC touched).  
- No naked TODOs; clear names only.  
- Copywriting: short, specific, no filler.  

---

## 6. Failure Behavior
- Still open PR.  
- Labels: `needs-human`, `smoke-failed`. Remove `automerge`.  
- Title prepended with ❌. Include logs summary in body.  
- Never queue auto-merge until smoke passes.  

---

## 7. Success Behavior
- Labels: `ready-for-review`, `automerge-candidate`.  
- Title prefix: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `perf:`, `test:`.  
- Auto-enable squash auto-merge if all checks are green.  

---

## 8. PR Template
**Always open PRs with:**  

**Title**  
```txt
{{ status_emoji }} {{ type_prefix }}{{ concise_title }}
```

**Body**  
```md
## Summary
- **Why**: {{ problem_statement }}
- **What**: {{ solution_slice }}
- **Risk**: {{ risk_note }}
- **UX**: Apple-level polish; copy trimmed for clarity.

## Smoke Result
- Lint: {{ lint_status }}
- Types: {{ types_status }}
- Unit: {{ unit_status }}
- Build: {{ build_status }}
- Storybook: {{ story_status }}

## Checklists (YC + Linear-inspired)
- [ ] Small, reviewable diff (≤300 LOC)
- [ ] Clear acceptance criteria met
- [ ] Tests updated/added
- [ ] UX text concise & on-brand
- [ ] No layout shifts/spinner overlap
- [ ] Public profile <100ms p95

## Notes for Reviewers
- Logs: {{ short_logs }}
- Follow-ups: {{ followups }}
```

- Default labels: `["triage"]`  
- Reviewers: `@owner-or-codeowners`  

---

## 9. Post-Open Flow
- ❌ → Post comment with actionable next steps + failing stage/log link.  
- ✅ → Link PR to issue and move Linear ticket to **In Review**.  

---

## 10. Branching & Protection
- **Never push directly** to `preview` or `main`.  
- Work only on feature branches from `preview`:  
  - Naming: `feat/<slug>`, `fix/<slug>`, `chore/<slug>` (3–6 word kebab-case).  
- All changes flow via PR → `preview`.  
- Auto-merge to `preview` allowed after green CI.  
- Promotion `preview → main` is manual PR + release tag.  

---

## 11. Feature Development Flow
1. **Branch** from `preview`, name properly.  
2. **Scope**: one user-visible outcome; split otherwise.  
3. **Implementation**  
   - Behind feature flag (`feature_<slug>`, default OFF).  
   - Add PostHog events (`page_element_action`).  
   - Unit + E2E smoke test main path.  
4. **PR** to `preview`:  
   - Title `[feat|fix|chore]: <slug>`  
   - Body includes goal, KPI, flag name, events, rollback plan.  
5. **Checks**: lint, types, unit, E2E, preview deploy, Chromatic if UI.  
6. **Post-Deploy**: deploy w/ flag OFF → enable internal only → verify metrics/errors → progressive rollout.  
7. **Done**: code in `preview`, feature flagged, metrics firing.  
8. **Merge to main**: via manual PR + release tag.  

---

## 12. Clerk-Supabase Integration
- Use **native integration**, **NOT JWT templates**.  
- Client: `useSession() → session.getToken()` via `accessToken()`.  
- Server: `auth() → getToken()`.  
- RLS policies: `auth.jwt()->>'sub' = user_id`.  
- Enable RLS on all user tables.  
- Test multi-user isolation.  

---

## 13. Stripe Billing
- Use **direct Stripe integration** (not Clerk billing).  
- Handle subscriptions, invoices, and plan logic directly with Stripe API.  
- Keep billing logic modular and isolated from auth.  
- All subscription state checks (active, canceled, trialing) must be enforced server-side.  
- Pricing page: custom-built (not `<PricingTable />`).  
- Webhooks: mandatory for subscription lifecycle events.  
- Never bypass subscription checks client-side.  

---

## 14. Deprecated Patterns (🚫 Never Use)
- JWT templates (`getToken({ template: 'supabase' })`).  
- `createClerkClient()` client-side.  
- Hardcoded user IDs in RLS.  
- Direct pushes to `preview` or `main`.  
- Manual subscription checks on client (must be server-verified).  

---

## 15. Env Vars
```bash
# Clerk
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...

# Supabase
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_KEY=...

# Stripe
STRIPE_SECRET_KEY=sk_test_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
```

---

Mr. White — do you want me to also rewrite the **Stripe billing section** into a **one-page implementation checklist** (branch → API setup → webhook handling → plan enforcement) so your AI agents can follow it without ambiguity?


Update our claude md file to remove clerk billing and add stripe mentions
