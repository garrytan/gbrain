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

---

## User

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


---

## Assistant

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

---

## User

We dont use clerk billing, we use stripe billing directly

---

## Assistant

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

---

## User

Update our claude md file to remove clerk billing and add stripe mentions

---

## Assistant

Mr. White — the in-editor patch tool errored, so here’s a clean, copy-pasteable patch you can apply. It removes all Clerk Billing content and adds direct Stripe billing rules, examples, envs, and checks.

# Unified diff (apply to `CLAUDE.md`)
```diff
@@
-## **2. Clerk Billing with Stripe Integration**
-...
-# (entire Clerk Billing section removed)
+## **2. Stripe Billing (Direct Integration)**
+
+**Purpose:** Use **direct Stripe Billing** (Checkout + Webhooks + Customer Portal). Keep billing separate from auth.
+
+### **2.1 – Core Principles**
+1. **Server-only** creation of Checkout Sessions; never expose secrets client-side.
+2. **Webhooks are mandatory** for lifecycle: `checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.payment_succeeded|failed`, `customer.subscription.trial_will_end`.
+3. **Persist subscription state** in our DB (user ↔ customer ↔ subscription ↔ price). Stripe = source of truth; DB = fast authz cache.
+4. **Server-side enforcement** of access; never trust client checks.
+5. **Price IDs** come from env (e.g., `STRIPE_PRICE_BASIC`, `STRIPE_PRICE_PRO`); no hardcoding.
+6. **Customer Portal** for self-serve management (payment method, plan changes, cancel).
+7. **Idempotent handlers** with logging/alerts on failures.
@@
 ### **3.1 – ALWAYS DO THE FOLLOWING**
 #### **For Clerk-Supabase Integration:**
 ...
-#### **For Clerk Billing:**
-1. **Use Clerk's billing system** - NOT direct Stripe integration
-2. **Use `<PricingTable />` component** for pricing pages
-3. **Use `has()` method** for plan/feature access control
-4. **Use `<Protect>` component** for React-based protection
-5. **Create plans and features** in Clerk Dashboard
-6. **Link pricing page** from homepage and navigation
-7. **Test billing flow** end-to-end
-8. **Handle subscription states** properly
+#### **For Stripe Billing (Direct):**
+1. **Use direct Stripe Billing** (Checkout + Webhooks + Customer Portal); do **not** use Clerk billing.
+2. **Create Checkout Sessions server-side** only; never expose secrets client-side.
+3. **Handle webhooks** for: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`, `customer.subscription.trial_will_end`.
+4. **Persist subscription state** in our DB (user ↔ customer ↔ subscription ↔ price). Treat Stripe as source of truth; cache locally.
+5. **Enforce access server-side** (middleware/API) by checking our DB-backed subscription status.
+6. **Use env price IDs** (e.g., `STRIPE_PRICE_BASIC`, `STRIPE_PRICE_PRO`).
+7. **Offer Customer Portal** for self-serve billing.
+8. **Log & alert** on webhook failures; implement idempotency.
@@
 ### **3.2 – NEVER DO THE FOLLOWING**
 #### **For Clerk-Supabase Integration:**
 ...
-#### **For Clerk Billing:**
-1. **Do not** implement direct Stripe integration
-2. **Do not** bypass Clerk's billing system
-3. **Do not** hardcode plan/feature checks
-4. **Do not** ignore subscription states
-5. **Do not** forget to link pricing page
+#### **For Billing:**
+1. **Do not** use Clerk billing components or `<PricingTable />`.
+2. **Do not** put subscription logic on the client; server-verify against Stripe + our DB.
+3. **Do not** hardcode plan/feature checks; derive from subscription/flags.
+4. **Do not** skip webhook handling for lifecycle events.
+5. **Do not** expose `STRIPE_SECRET_KEY` or webhook secrets to the client.
@@
 ## **4. DEPRECATED PATTERNS TO AVOID**
 ```typescript
 // ❌ DO NOT use JWT templates (deprecated)
 ...
-// ❌ DO NOT bypass Clerk billing system
-// Use Clerk's billing components and methods instead
+// ❌ DO NOT use Clerk billing components; use direct Stripe integration with server-side enforcement
 ```
@@
-### **5.4 – Pricing Page Example**
-```typescript
-// app/pricing/page.tsx
-import { PricingTable } from '@clerk/nextjs'
-...
-```
-
-### **5.5 – Homepage Pricing Link Example**
-```typescript
-// app/page.tsx ...
-```
+### **5.4 – Stripe Checkout: Minimal Server Route (Next.js App Router)**
+```ts
+// app/api/stripe/checkout/route.ts
+import Stripe from 'stripe';
+import { NextResponse } from 'next/server';
+
+const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' });
+
+export async function POST(req: Request) {
+  const { priceId, customerId, success_url = '/billing/success', cancel_url = '/billing/cancel' } = await req.json();
+
+  const session = await stripe.checkout.sessions.create({
+    mode: 'subscription',
+    customer: customerId, // optional if creating new customer
+    line_items: [{ price: priceId, quantity: 1 }],
+    success_url: `${process.env.NEXT_PUBLIC_APP_URL}${success_url}?s={CHECKOUT_SESSION_ID}`,
+    cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}${cancel_url}`,
+    allow_promotion_codes: true,
+    automatic_tax: { enabled: true },
+  });
+
+  return NextResponse.json({ url: session.url });
+}
+```
+
+### **5.5 – Stripe Webhook Handler (Next.js App Router)**
+```ts
+// app/api/stripe/webhook/route.ts
+import Stripe from 'stripe';
+import { NextResponse } from 'next/server';
+
+export const runtime = 'nodejs';
+export const dynamic = 'force-dynamic';
+
+const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: '2024-06-20' });
+
+export async function POST(req: Request) {
+  const sig = req.headers.get('stripe-signature')!;
+  const buf = Buffer.from(await req.arrayBuffer());
+
+  let event: Stripe.Event;
+  try {
+    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET!);
+  } catch {
+    return new NextResponse('Webhook Error', { status: 400 });
+  }
+
+  switch (event.type) {
+    case 'checkout.session.completed':
+    case 'customer.subscription.created':
+    case 'customer.subscription.updated':
+    case 'customer.subscription.deleted':
+    case 'invoice.payment_succeeded':
+    case 'invoice.payment_failed':
+      // TODO: upsert subscription state in DB (user ↔ customer ↔ subscription ↔ price)
+      break;
+    default:
+      break;
+  }
+
+  return NextResponse.json({ received: true });
+}
+```
@@
 ## **6. AI MODEL VERIFICATION STEPS**
 ...
-### **For Clerk Billing:**
-1. **Pricing Table**: Is `<PricingTable />` component being used?
-2. **Access Control**: Is `has()` method or `<Protect>` component being used?
-3. **Navigation**: Is pricing page linked from homepage and navigation?
-4. **Plans/Features**: Are plans and features created in Clerk Dashboard?
-5. **Subscription States**: Are subscription states being handled properly?
+### **For Stripe Billing (Direct):**
+1. **Checkout sessions are server-created**, not client-side.
+2. **Webhook handlers exist** for all key lifecycle events.
+3. **Subscription state is stored** in our DB and cross-checked against Stripe.
+4. **Server-side access control** verifies subscription/feature access.
+5. **Env-configured price IDs** are used; no hardcoded plan logic.
+6. **Customer Portal** link/route exists for self-serve management.
@@
 ## **7. ENVIRONMENT VARIABLES**
 ```bash
 # Clerk
 NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_...
 CLERK_SECRET_KEY=sk_test_...
 
 # Supabase
 NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
 NEXT_PUBLIC_SUPABASE_KEY=your-anon-key
 
-# Stripe (if using own Stripe account with Clerk billing)
-STRIPE_SECRET_KEY=sk_test_...
-NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
+# Stripe (Direct Billing)
+STRIPE_SECRET_KEY=sk_test_...
+NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_...
+STRIPE_WEBHOOK_SECRET=whsec_...
+
+# Stripe Prices (examples)
+STRIPE_PRICE_BASIC=price_...
+STRIPE_PRICE_PRO=price_...
 ```
@@
 ## **8. TESTING GUIDELINES**
 ...
-### **For Clerk Billing:**
-1. **Test pricing page** displays correctly
-2. **Test subscription flow** end-to-end
-3. **Test plan/feature access control**
-4. **Test navigation** to pricing page
-5. **Test subscription state handling**
+### **For Stripe Billing:**
+1. Test pricing page → Checkout → Webhook → DB upsert → access-gate end-to-end.
+2. Simulate subscription status changes in Stripe Dashboard and verify server authz.
+3. Validate idempotency keys and retry behavior on webhook delivery.
+4. Confirm Customer Portal flows (upgrade/downgrade/cancel) update DB state.
+5. Ensure no client-only plan checks; break the client and verify server denies.
@@
 ## **9. MIGRATION FROM OLD APPROACH**
 ...
+**If migrating from Clerk Billing:**
+1. Remove Clerk billing usage and components (e.g., `<PricingTable />`).
+2. Add Stripe Checkout + Webhook handlers and DB subscription tables.
+3. Replace `has({ plan/feature })` checks with server-side subscription verification.
+4. Migrate users to Stripe customers; backfill `customer_id` and active subscription rows.
+5. QA full lifecycle (trial → active → past_due → canceled) before rollout.
@@
 ## **10. RESOURCES**
 - [Clerk Supabase Integration Docs](https://clerk.com/docs/raw/integrations/databases/supabase.mdx)
-- [Clerk Billing with Stripe Docs](https://clerk.com/docs/nextjs/billing/b2c-saas)
 - [Supabase RLS Documentation](https://supabase.com/docs/guides/auth/row-level-security)
 - [Clerk Next.js Documentation](https://clerk.com/docs/quickstarts/nextjs)
+- [Stripe Billing Quickstart](https://stripe.com/docs/billing/quickstart)
+- [Stripe Checkout](https://stripe.com/docs/checkout)
+- [Stripe Webhooks](https://stripe.com/docs/webhooks)
```

If you want, I can re-run the in-editor patch once Windsurf’s tool is behaving; otherwise, paste the diff or just copy the inserted sections directly.

---

## User

{'asset_pointer': 'file-service://file-VTyeckyS6dGfJW5QneQXVN', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 948, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1052727, 'width': 1470}
{'asset_pointer': 'file-service://file-VFhznQTaFBGBYpfG42RG4s', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 909, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 803169, 'width': 1340}
{'asset_pointer': 'file-service://file-PJPRLniBnZ1h9Ukrmf5br8', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 779, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 623236, 'width': 994}
This feels cheap like a "my first app" project.

Let's make ti themed linear or apple with magical UX.

Lets get it to more of none colored look like apple and linear with only accent colors where needed. Lets ensure we dont lean into any one accent color but stay agnostic. Cta button should probably be white or black with beautiful loading states and transitions.

Let's ensure this looks awesome on mobile AND desktop. Lets keep it clean and concise and magical in every way.


Give me the audit and AI fix prompt

---

## Assistant

Mr. White — here’s a tight UX audit and a copy-paste AI fix prompt your agent can run.

# UX Audit (Linear/Apple, color-agnostic)

**Overall**
- Visual weight is dominated by purple accents; feels “template-y.” Go neutral first, accent last.
- Card has mixed shadows, blur, and strong gradients → noisy. Prefer flat/soft surfaces with 1px keylines.
- Stepper and timers add color + motion noise; hierarchy isn’t crisp (too many headings, emojis).
- Buttons use saturated brand color; loading states cause layout shift and spinner misalignment.
- Error state in handle field pushes layout and uses red icon without inline hint text.
- Mobile density isn’t tuned: large paddings force scrolling; CTA not sticky; keyboard overlap risk.

**Specifics**
- **Typography:** Too many sizes/weights; H1 + “Welcome to Jovie!” repeats. Use 1 H1, 1 section title, body M.
- **Color system:** Unscoped purple. Move to grayscale tokens (`--bg`, `--surface`, `--text`, `--muted`, `--keyline`) + `--accent` that can be swapped.
- **Surfaces:** Card blur + gradient background grid compete. Use plain dark/neutral surface with subtle grid at 5–8% opacity or remove it on mobile.
- **Stepper:** Use neutral track with accent only on current step. Replace circles with tiny ticks + step labels.
- **Form:** Inline validation (no reflow); helper text reserved space; 1-line error.
- **Buttons:** CTA should be **black** (light theme) or **white** (dark theme) with inner spinner overlay, no width change.
- **Timer:** Reduce to subtle text “~2 min” (muted), not a progress bar.
- **Motion:** 150–200ms ease-out for micro transitions; no bouncy curves; crossfade between steps; preserve height.
- **A11y:** 16px min target, 4.5:1 contrast, proper aria-live for errors, focus ring consistent.
- **Mobile:** Sticky bottom CTA, header collapses on scroll, safe-area paddings, keyboard-avoidance.
- **No layout shift:** Reserve heights for error/help; spinner overlays; story checks for long names + error states.

---

# AI Fix Prompt (drop into Windsurf/Claude/Cursor)

**Title:** Overhaul Onboarding to Linear/Apple-grade, Color-Agnostic UX (no layout shift)

**Goal:** Re-skin and harden `/onboarding` (steps 1–4) to a neutral, premium style (Linear/Apple) with color-agnostic theming. Preserve copy brevity. Zero layout shift across states. Mobile + desktop both world-class.

**Constraints**
- Tailwind v4 + Headless UI. No new deps.
- Keep accent color configurable; default to system accent but UI must look great in pure grayscale.
- CTA: white in dark mode / black in light mode. Spinner overlays; width never changes.
- Avoid gradients, heavy shadows, and emojis. Subtle keylines over shadows.
- Respect branch rules: feature branch from `preview`, small diff, no infra edits.

**Deliverables**
1. **Theme tokens (CSS vars in `globals.css`):**
   ```css
   :root {
     --bg: #0b0c0e;         /* page */
     --surface: #111214;    /* cards */
     --keyline: #1e2023;    /* 1px borders */
     --text: #e7e9ee;
     --muted: #9aa0a6;
     --accent: var(--accent-fallback, #6e6e73); /* neutral by default */
     --danger: #ff5a52;
     --focus: #2680ff;
   }
   .card { @apply rounded-xl border border-[var(--keyline)] bg-[var(--surface)]; }
   .h1   { @apply text-[28px] font-semibold tracking-[-0.01em] text-[var(--text)]; }
   .sub  { @apply text-sm text-[var(--muted)]; }
   ```
2. **Onboarding layout (`app/onboarding/page.tsx` and children):**
   - Single H1 “Create your artist profile”.
   - Remove big hero repeat; keep one concise intro line.
   - Card max-w: `max-w-[520px]` desktop; full-bleed with 16px padding mobile.
   - Replace gradient grid with subtle neutral (or remove on mobile).
3. **Stepper component (`components/ui/Stepper.tsx`):**
   - Neutral track with 1px keyline; ticks for completed; current step label in `--text`; others `--muted`.
   - Optional tiny time hint text `~2 min` (muted), no progress bar.
4. **Fields (`HandleInput.tsx`):**
   - Reserve help/error slot height (`min-h-[20px]`); `aria-live="polite"`.
   - Error pattern: small red dot + 1-line text; no layout shift.
   - Long handle cases: ellipsis in preview URL; enforce 3–15 chars; show rule before typing.
5. **Buttons (`Button.tsx`):**
   - Variants: `primary` (neutral fill), `secondary` (keyline).
   - Primary dark theme: white fill, black text; focus ring `--focus`; `disabled:opacity-60`.
   - Loading: overlay spinner centered; keep label in DOM but opacity 0 → **no width change**.
6. **Motion:**
   - Step transition: `opacity/translate-y` 150ms, shared height container to prevent shift.
   - Button press: 98% scale 100ms.
7. **Mobile polish:**
   - Sticky bottom action bar with safe-area insets.
   - Keyboard avoidance (iOS): scroll into view and extra bottom padding when input focused.
8. **Accessibility:**
   - All interactive elements focusable; `Enter` submits; `Esc` goes Back.
   - Contrast checks pass 4.5:1.
9. **Storybook stories** for onboarding steps:
   - Default, long artist name, validation error, loading submit, slow network skeleton.
10. **Tests (playwright + vitest):**
   - No layout shift (measure bounding boxes) when:
     - typing invalid → valid handle,
     - toggling loading on CTA,
     - showing inline error.
   - Handle max length and invalid chars produce inline error without reflow.

**Copy (short, on-brand)**
- Step 1 title: “Create your artist profile”
- Subtitle: “A few quick steps.”
- Handle help: “3–15 letters, numbers, or hyphens.”
- Error: “Use 3–15 characters. Letters, numbers, or hyphens.”

**Acceptance Criteria**
- Page + card use neutral tokens; only current step uses `--accent`.
- CTA white/black; spinner overlay; **no width change**.
- Error/helper area never changes container height.
- Mobile sticky CTA; keyboard doesn’t cover inputs.
- All stories render without overflow, wrapping, or truncation bugs.
- E2E passes; CLS in stories ~0.

**Files to touch**
- `app/onboarding/*` (no routing changes)
- `components/ui/{Button.tsx,Stepper.tsx,Input.tsx}`
- `styles/globals.css` (add tokens)
- `stories/onboarding/*.stories.tsx`
- `tests/e2e/onboarding.spec.ts`

**Do NOT**
- Add new brand colors or gradients.
- Introduce heavy shadows/blur.
- Edit CI/infra.

**PR Body Template Snippets**
- **Why:** Align onboarding with Linear/Apple patterns and remove color dependence.
- **What:** Neutral theming, new Button/Stepper, reserved error slots, sticky CTA, no-shift loading.
- **Risk:** Low (styling + small component refactors).
- **UX:** Faster, quieter, premium; mobile first.

**Smoke commands to run before PR**
```
pnpm lint --max-warnings=0
pnpm typecheck
pnpm test:unit --run -t "smoke|happy|render"
pnpm build -n || vite build --emptyOutDir false
pnpm story:build || true
```

Want me to generate the Button/Stepper code and the Playwright test skeleton inline next?
