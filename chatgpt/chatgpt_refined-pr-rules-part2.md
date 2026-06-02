
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


{'asset_pointer': 'file-service://file-VTyeckyS6dGfJW5QneQXVN', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 948, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 1052727, 'width': 1470}
{'asset_pointer': 'file-service://file-VFhznQTaFBGBYpfG42RG4s', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 909, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 803169, 'width': 1340}
{'asset_pointer': 'file-service://file-PJPRLniBnZ1h9Ukrmf5br8', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 779, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 623236, 'width': 994}
This feels cheap like a "my first app" project.

Let's make ti themed linear or apple with magical UX.

Lets get it to more of none colored look like apple and linear with only accent colors where needed. Lets ensure we dont lean into any one accent color but stay agnostic. Cta button should probably be white or black with beautiful loading states and transitions.

Let's ensure this looks awesome on mobile AND desktop. Lets keep it clean and concise and magical in every way.

Give me the audit and AI fix prompt


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


## See Also
- [[chatgpt/chatgpt_refined-pr-rules-part1]]
- [[chatgpt/chatgpt_ada-gym-accessibility-rules]]
- [[chatgpt/chatgpt_bikini-rules-in-maldives]]
- [[chatgpt/chatgpt_california-drivers-license-rules]]
- [[chatgpt/chatgpt_diet-app-parameters-rules]]
