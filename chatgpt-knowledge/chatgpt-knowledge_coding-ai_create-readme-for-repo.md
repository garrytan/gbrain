---
title: "Create README for repo"
type: essay
created: 2025-08-05
updated: 2025-08-05
source: chatgpt-export
topic: coding-ai
message_count: 26
tags: [chatgpt, knowledge, coding-ai]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-ai]]

# Create README for repo

> **Source:** ChatGPT conversation
> **Date:** 2025-08-05T23:51:42Z
> **Messages:** 26
> **Topic:** coding-ai

## Question

Create a comprehensive readme file for our accelerator application repo. The repo exists purely to let friends and AI agents collaborate on writing our ycombinator, a16z start, and other accelerator applications.  We'll start with n application.md file that has all the questions and answers in it and we'll keep working on them til they are world class ycombinator approved answers that maximize chances of acceptance. We will eventually add context to the repo and extract common answers to their own files breaking up the repo into md files for each application and a folder of answers for each question, eventually point ai agents to the repo to have them fill out applications on our behalf.

## Answer

README added to the repo canvas—feel free to tweak anything and we’ll iterate.

## Question

Great now give me a prompt to make an ai start building out the repo start extraccting answers and questions and source context

## Answer

**Copy-paste the block below into your favorite AI agent (ChatGPT, Claude, etc.) and run it from the repo root.** It assumes `application.md` already exists there.

```text
# Role
You are “RepoBuilder-AI,” an autonomous agent whose sole job is to refactor this accelerator-application repo.

# Objective
1. Parse **application.md** – it contains every question and the current answer.
2. For each unique question:
   • Create **/answers/common/<slug>.md** containing ONLY the answer.  
   • Keep file names kebab-cased, 30 chars max.
3. Inside **application.md** replace each full answer with:
   ```md
   {{ include("./answers/common/<slug>.md") }}
   ```
4. Detect duplicate answers (identical text). Deduplicate by pointing all refs to the first slug.
5. Append a JSON manifest **answers/manifest.json** with:
   ```json
   {
     "<slug>": {
       "question": "...",
       "accelerators": ["yc", "a16z-start", ...],
       "words": 123
     },
     ...
   }
   ```
6. Leave untouched any answer blocks tagged `<!-- LOCK --> … <!-- /LOCK -->`.
7. Commit changes branch `feat/extract-answers` and open a pull request with a summary of what changed.

# Constraints
* No answer text is ever duplicated—single source of truth in `/answers/common`.
* Do not alter wording/punctuation of existing answers.
* Manifest must be valid JSON (use snake_case keys).
* Max run-time per execution: 5 min.

# Tools
You can:
* Read & write files.
* Execute shell commands (`git`, `mdlint`).
* Use regex/string processing.

# Deliverables
1. Updated **application.md** with include tags.
2. New **answers/** files + manifest.
3. PR titled “Extract common answers.”

# Success Metric
All CI checks pass and the PR diff shows 0 duplicate answer bodies in the repo.
```

This prompt turns the agent loose to slice the repo into reusable answer modules while keeping `application.md` assembly-friendly.

## Question

Layout our new /tips pages for jovie link in bio

## Answer

**/tips page architecture for Jovie (Vue + Nuxt, Tailwind)**  

---

### 1. Page variants  
| Route | Audience | Purpose |
|-------|----------|---------|
| `/tips/<handle>` | Fans | Send a tip |
| `/tips/<handle>/success` | Fans | Thank-you + social share |
| `/creator/tips` | Creator (auth) | Dashboard: earnings, payouts, settings |

---

### 2. Public tip page (`/tips/<handle>`)  

1. **Sticky header** (dark by default, adaptive like the main header)  
   - Avatar + name ↗ back-to-main link  
2. **Hero block**  
   - Creator avatar (96 px), display name, tagline  
   - Optional cover photo (16:9) → blurred edge background
3. **Tip amount grid** (preset buttons)  
   ```$1  $3  $5  $10  $25  Custom```  
   - Highlight on hover / active  
4. **Custom amount input**  
   - Numeric, min $1, auto-focus when “Custom” picked
5. **Message textarea** (optional)  
   - 140-char limit, live counter
6. **Payment section**  
   - Primary CTA: **Pay with Card/Apple Pay/Google Pay**  
   - Secondary: **Crypto** (USDC/ETH) toggle if wallet detected
7. **Security & policy footer**  
   - “Secured by Stripe” badge, refund policy link, legal links

> **Mobile flow**: All above fits in one scroll; CTA stays fixed bottom once amount selected.

---

### 3. Success page (`/tips/<handle>/success`)  

- Confetti animation (CSS, 2 s)  
- “Thanks, you just made <Name>’s day!”  
- Social share buttons (X, IG story sticker)  
- **Follow** link to creator’s social / Jovie link-in-bio  
- Auto-redirect to creator’s main page after 10 s

---

### 4. Creator dashboard (`/creator/tips`)  

1. **Metrics cards** (today, 7-day, all-time)  
2. **Tips table** (payer name, amount, message, date)  
3. **Payout status** (connected Stripe account prompt or balance & payout schedule)  
4. **Preset amounts editor** (drag-reorder, add/delete)  
5. **Personal message & cover image uploader**  
6. **Share link generator** (QR code + copy link button)

---

### 5. Component taxonomy (Atomic Design)  

- **Atoms:** Button, Input, Avatar, Badge  
- **Molecules:** TipAmountCard, PaymentMethodIconGroup  
- **Organisms:** TipForm, MetricsCardGrid, TipsTable  
- **Templates:** PublicTipLayout, DashboardLayout  
- **Pages:** tips/index.vue, tips/success.vue, creator/tips.vue  

---

### 6. Tech notes  

- **State:** Pinia store for selected amount & message (persists across success redirect).  
- **Payments:** Stripe Checkout session (card/Apple Pay/Google Pay) + Stripe Link; Wagmi for crypto.  
- **SEO:** `/tips/<handle>` uses `defineOgImage()` with avatar + name overlay.  
- **Accessibility:** All interactive elements reachable via keyboard, ARIA labels on tip buttons.  

This structure keeps the user flow frictionless for fans while giving creators a clean dashboard that matches Jovie’s minimal, high-conversion vibe.

## Question

Our map mode it just opens Venmo and inserts the users venmo handle into a custom url with predefined money values 

## Answer

Got it—replace the Stripe/crypto section with a single **“Pay on Venmo”** CTA that fires a deep-link. Everything else in the /tips flow stays the same.

---

### Venmo deep-link spec  

```
venmo://paycharge?
  txn=pay&
  recipients=<HANDLE>&
  amount=<AMOUNT>&
  note=Thanks%20for%20the%20content
```

| Param      | Value                     |
|------------|---------------------------|
| `txn`      | `pay` (always)            |
| `recipients` | Creator’s Venmo handle   |
| `amount`   | One of the preset amounts |
| `note`     | URL-encoded default note  |

---

### UI tweaks  

1. **Tip amount grid** – same preset buttons.  
2. **Primary CTA**  
   ```vue
   <Button @click="openVenmo(amount)">
     Pay ${{ amount }} on Venmo
   </Button>
   ```
3. **Success page** – trigger after `window.location` change fails (user cancelled) or on manual “I’ve paid” click.

```ts
function openVenmo(amt:number){
  const h = creatorHandle.value
  const url = `venmo://paycharge?txn=pay&recipients=${h}&amount=${amt}&note=Thanks%20for%20the%20support`
  window.location.href = url
}
```

---

### State / validation  

- Disable CTA until an amount is chosen.  
- Optional custom amount input → validate `>=1 && <=2000` (Venmo limit).  
- If Venmo app isn’t installed, deep-link falls back to web; show a toast: “If nothing happens, make sure Venmo is installed.”

---

### Creator dashboard changes  

- “Connected Venmo handle” field (text, required).  
- Earnings analytics removed (Venmo gives no API); show static instructions to export statements manually.

Everything else in the page architecture remains as previously outlined.

## Question

Mvp not map mode


## Answer

Got it — here’s the **ultra-lean MVP scope** for `/tips`:

---

### What ships in v0 (MVP)

| Item | Scope | Cut / Defer |
|------|-------|-------------|
| **Public page** `/tips/<handle>` | • Creator avatar + name  <br>• Six preset $ buttons (e.g. 1, 3, 5, 10, 25, Custom)  <br>• Single CTA **“Pay $X on Venmo”**  <br>• Deep-link function *(below)* | No success page, no Stripe/crypto, no confetti |
| **Creator settings** `/creator/tips` | • Text input to store Venmo handle  <br>• List editor for preset amounts | No analytics, no payout info |
| **State** | Local Pinia store: `selectedAmount`, `creatorHandle` | No manifest/metrics yet |
| **Design** | Uses existing Jovie header/footer + Tailwind; mobile-first | Adaptive header, SEO OG images later |

---

### Deep-link helper (Vue/TS)

```ts
function payWithVenmo (amount: number, handle: string) {
  const url = `venmo://paycharge?txn=pay&recipients=${handle}&amount=${amount}&note=Thanks%20for%20the%20support`
  window.location.href = url
}
```

*Disable the CTA until an amount is chosen.  Validate custom amounts `1 ≤ x ≤ 2000` (Venmo limit).*

---

### Folder / file plan

```
pages/
  tips/[handle].vue          // public tip page
  creator/tips.vue           // simple settings panel
stores/
  tips.ts                    // Pinia store
components/
  TipAmountGrid.vue
  VenmoButton.vue
```

That’s the whole MVP: one public page, one settings page, one deep-link. Iterate from there.

## Question

So currently you have jov.ie/tim/list and jov.ie/tim is the profile. I want to have a jov.ie/tim/tip that is the profile page but instead of a cat button it has 3 predefined tip amounts and a $3, $5, $10. And 5 is pre-highlisend and then there's a cta that opens venmo. That's the whole page. Make the ai prompt to create this feature

## Answer

Here’s a single copy-paste prompt you can drop into your coding agent (ChatGPT, Claude, etc.) from the repo root to add **`/<handle>/tip`**:

```text
# Role
You are “Jovie-Tip-Page-Builder,” an autonomous dev tasked with adding a tipping page.

# Objective
1. Create a new public route **pages/[handle]/tip.vue** that clones the existing profile page layout (`/pages/[handle]/index.vue`) but replaces the “cat” button with:
   • A 3-button grid: **$3, $5, $10**  
   • The **$5** button is pre-selected / highlighted on load.  
   • A single CTA: **“Pay $<amount> on Venmo”** (disabled until an amount is chosen).

2. Implement the Venmo deep-link:
   ```
   venmo://paycharge?txn=pay&recipients=<handle>&amount=<amount>&note=Thanks%20for%20the%20support
   ```

3. Add a Pinia store **stores/tip.ts** with:
   ```ts
   selectedAmount: 5, // default
   creatorHandle: '', // populated from route param
   ```
   Expose `setAmount()`.

4. Components:
   - **TipAmountGrid.vue** (atoms: TipButton)
   - **VenmoButton.vue**

5. Styling:
   - Tailwind; match profile theme.
   - Tip buttons: `rounded-lg border px-4 py-2`  
     • Selected = `bg-primary text-white`  
     • Hover = `ring-2 ring-primary/50`
   - CTA: full-width primary button at bottom.

6. Validation:
   - Custom amount input *not* required for MVP.
   - If Venmo app missing, fallback shows toast “Install Venmo to complete tip.”

7. Update router to support dynamic nested route.

8. Tests:
   - Unit: clicking each amount updates store and button highlight.
   - E2E (Cypress): visit `/tim/tip`, click `$10`, verify deep-link URL.

9. Commit on branch **feat/tip-page**, open PR with summary.

# Constraints
* Do NOT modify existing profile logic.
* Keep all strings i18n-ready.
* Follow Atomic Design folder structure.
* Complete in ≤ 90 min of agent runtime.

# Success Criteria
Visiting **/tim/tip** shows the new UI, $5 pre-selected, CTA deep-links to Venmo with correct handle and amount.
```

Run the prompt → review the PR → merge.

## Question

Were not in vue were in next.js 15 with tailwind 4 and supabase and clerk auth

## Answer

**Copy-paste the block below into your coding agent (ChatGPT Code Interpreter, Claude, etc.) while sitting at the repo root.**  
It assumes you’re on **Next.js 15 (App Router)** with **Tailwind CSS v4**, **Supabase** for data, and **Clerk** for auth.

```text
# Role
You are “Jovie-Next-Tip-Page-Builder,” an autonomous dev tasked with adding a Venmo-tip page.

# Objective
Create **/<handle>/tip** (e.g., jov.ie/tim/tip) that mirrors the existing profile page but swaps the cat-button for three preset tip amounts ($3, $5 - pre-selected, $10) and a single CTA that deep-links to Venmo.

# Tasks
1. **Routing & File Structure**
   • Add `app/[handle]/tip/page.tsx` (React Server Component).  
   • Use `generateStaticParams` to pre-render known handles; otherwise fall back to on-demand ISR.

2. **Data Fetch**
   • Fetch creator record from Supabase by `handle` (`select avatar_url, display_name, venmo_handle`).  
   • Page is public—no auth required.

3. **State**
   • In a nested Client Component (`TipClient.tsx`) use React `useState` to track `selectedAmount` (default 5).  
   • No global store needed for MVP.

4. **UI (Tailwind v4)**
   ```
   <div class="mx-auto max-w-sm space-y-6 px-4 py-10 text-center">
     <!-- Avatar -->
     <img ... class="h-24 w-24 rounded-full mx-auto" />
     <h1 class="text-2xl font-semibold">@{handle}</h1>

     <!-- Amount grid -->
     <div class="grid grid-cols-3 gap-4">
       { [3,5,10].map(...) => (
         <button
           class="rounded-lg border px-4 py-2 font-medium
                  data-[active=true]:bg-primary data-[active=true]:text-white
                  hover:ring-2 hover:ring-primary/50"
           data-active={amt===selectedAmount}
           onClick={() => setSelectedAmount(amt)}
         >${amt}</button>
       )}
     </div>

     <!-- CTA -->
     <button
       disabled={!selectedAmount}
       class="w-full rounded-lg bg-primary py-3 text-white font-semibold disabled:opacity-50"
       onClick={handlePay}
     >Pay ${selectedAmount} on Venmo</button>
   </div>
   ```

5. **Venmo Deep-Link**
   ```
   function handlePay() {
     const url = `venmo://paycharge?txn=pay&recipients=${venmoHandle}&amount=${selectedAmount}&note=Thanks%20for%20the%20support`;
     window.location.href = url;
   }
   ```
   • If `navigator.userAgent` lacks “Venmo”, show toast: “Install Venmo to complete your tip.”

6. **TypeScript**
   • Add `types/profile.ts` if none exists.  
   • Strict mode on.

7. **Testing**
   • **Jest/React-Testing-Library**: clicking each amount sets `aria-pressed=true`.  
   • **Playwright**: visit `/tim/tip`, click `$10`, assert `page.url()` contains `venmo://paycharge?...amount=10`.

8. **Git Workflow**
   • Branch: `feat/tip-page-next`.  
   • Include `E2E.yml` in GitHub Actions to run Playwright on PRs.

# Constraints
* Do **not** alter existing `/[handle]/page.tsx`.
* Keep all strings in `public/locales/en/common.json` for future i18n.
* Tailwind classes only—no custom CSS files.
* Finish in

*(Answer truncated — 3209 chars total)*

## Question

tip should only be enabled if that artists venmo handle is set. For /Tim in the seed db the venmo handle is "itstimwhite".

## Answer

**Patch your prompt with this guard clause so tips only show when a Venmo handle exists.**  
(Tim already has `itstimwhite` in the seed DB, so his page stays live.)

```diff
@@  // Data Fetch
- const { data } = await supabase
-   .from('profiles')
-   .select('avatar_url, display_name, venmo_handle')
-   .eq('handle', params.handle)
-   .single()

+ const { data } = await supabase
+   .from('profiles')
+   .select('avatar_url, display_name, venmo_handle')
+   .eq('handle', params.handle)
+   .single()

+ // ⛔️ No Venmo? 404.
+ if (!data?.venmo_handle) {
+   notFound()        // Next.js 15 helper – triggers 404 page
+ }

@@  // CTA (Client Component)
- const venmoHandle = props.venmoHandle
+ const venmoHandle = props.venmoHandle                     // always truthy now

```

### What this does
1. **Fetch once** in the RSC; bail out with `notFound()` if `venmo_handle` is `null` or empty.  
2. Tip page never builds for artists without Venmo, so no orphan routes or disabled CTAs.  
3. Existing logic (preset amounts + deep-link) stays unchanged for handles like `itstimwhite`.

Drop this diff into your agent’s prompt (or PR directly) and you’re done.

## Question

Simply describe this feature to me now in detail

## Answer

Mr. White, here’s the feature in plain English:

**What it is**  
A dedicated tipping page at **`/<handle>/tip`** (e.g., `jov.ie/tim/tip`). It shows three preset amounts— $3, $5 (pre-selected), $10—and a single **“Pay $X on Venmo”** button that deep-links straight into Venmo.

**When it appears**  
- The page is generated only if that creator’s profile row in Supabase has a non-empty `venmo_handle`.  
- If the handle is missing, hitting `/<handle>/tip` returns the normal 404.

**How it works under the hood**  
1. **Route & data** – Next.js 15 App Router file `app/[handle]/tip/page.tsx` fetches `avatar_url`, `display_name`, and `venmo_handle` for the requested handle.  
2. **Guard clause** – If `venmo_handle` is falsy, it immediately calls `notFound()`, so the page never renders without a Venmo destination.  
3. **Client component** – A lightweight React client component manages `selectedAmount` state (defaults to 5).  
4. **Deep-link** – Clicking the CTA sets `window.location.href` to  
   ```
   venmo://paycharge?txn=pay&recipients=<venmo_handle>&amount=<selectedAmount>&note=Thanks%20for%20the%20support
   ```  
   Venmo opens pre-filled; user confirms payment there.  
5. **UI** – Tailwind 4 only. Grid of amount buttons highlights the active choice; CTA is full-width, primary-colored. Everything is mobile-first and mirrors the existing profile styling.  
6. **Tim’s seed data** – Your profile already has `venmo_handle: "itstimwhite"`, so `jov.ie/tim/tip` is live the moment this ships.

That’s the entire feature: a friction-free, Venmo-only tip funnel that surfaces automatically for profiles with a Venmo handle and stays invisible for everyone else.

## Question

If the user doesnt have a venmo set. Just show "This artist isn't accepting tips yet".  Lets also set a global variable to refer to them as an "artist" if they are an artist and a "creator" if they are a creator. Etc. well need to add this to the db.

## Answer

**Change-list for the tip page**

1. **DB update (Supabase)**  
   - Add a `role` column to `profiles` (ENUM: `'artist' | 'creator'`, default `'creator'`).  
   - Keep `venmo_handle` nullable.

2. **Data fetch**  
   ```ts
   const { data } = await supabase
     .from('profiles')
     .select('avatar_url, display_name, venmo_handle, role')
     .eq('handle', params.handle)
     .single()
   ```

3. **Global helper**  
   ```ts
   export function nounFor(role: 'artist' | 'creator' | null) {
     return role === 'artist' ? 'artist' : 'creator';
   }
   ```

4. **Render logic in `/[handle]/tip/page.tsx`**
   ```tsx
   if (!data.venmo_handle) {
     return (
       <TipShell avatar={...} name={data.display_name}>
         <p className="text-muted">
           This {nounFor(data.role)} isn’t accepting tips yet.
         </p>
       </TipShell>
     );
   }
   // …otherwise render the $3 $5 $10 UI + Venmo CTA
   ```

5. **No more 404s** – users without a Venmo handle see the friendly message instead of a “not found” page.

That’s it: a role-aware message when tipping is disabled, and a reusable helper so the rest of the app can say “artist” or “creator” without hard-coding strings.

## Question

Default is artist for now not creator

## Answer

Understood—default role will be **`'artist'`**.

**Tweaks to the previous plan**

1. **Supabase migration**
   ```sql
   alter table profiles
     add column role text check (role in ('artist','creator')) default 'artist';
   ```
2. **Helper**
   ```ts
   export const nounFor = (role?: string) =>
     role === 'creator' ? 'creator' : 'artist';   // fallback → artist
   ```
3. **No-Venmo message**

```tsx
<p className="text-muted">
  This {nounFor(data.role)} isn’t accepting tips yet.
</p>
```

Everything else stays the same—now anyone without an explicit `role` is treated as an **artist** by default.

## Question

Explain the feature in full detail now in markdoc

## Answer

```markdoc
---
title: Tip Page Feature Specification (`/<handle>/tip`)
status: **approved**
version: 1.0
---

# Overview

Adds a public, Venmo-only tipping endpoint at **`/<handle>/tip`** for every profile.  
If the profile lacks a Venmo handle, the page still renders but displays a polite
message explaining that the *artist* is not yet accepting tips.

# Goals

1. **Friction-free payments** – one tap, deep-link to Venmo with preset amounts.  
2. **Role-aware copy** – dynamically say *artist* or *creator* based on the
   profile’s `role` column.  
3. **Zero dead links** – no more 404s when tipping is disabled.

# Database Changes

```sql
alter table profiles
  add column role text check (role in ('artist','creator')) default 'artist';

-- `venmo_handle` already exists and may be null.
```

| Column        | Type | Default | Purpose                                  |
| ------------- | ---- | ------- | ---------------------------------------- |
| `role`        | enum | `'artist'` | Determines noun used in UI copy.        |
| `venmo_handle`| text | `null`  | Destination handle for Venmo deep-links. |

# Routing & File Structure (Next 15 / App Router)

```
app/
└─ [handle]/
   ├─ page.tsx           ← existing profile
   └─ tip/
      └─ page.tsx        ← **new** tipping page (RSC wrapper)
components/
└─ TipClient.tsx         ← Client component (amounts + CTA)
lib/
└─ nouns.ts              ← `nounFor(role)` helper
```

# Data Fetch & Guard Logic

```ts
// app/[handle]/tip/page.tsx (RSC)
import { nounFor } from '@/lib/nouns';

export default async function TipPage({ params }) {
  const { data } = await supabase
    .from('profiles')
    .select('avatar_url, display_name, venmo_handle, role')
    .eq('handle', params.handle)
    .single();

  if (!data) notFound();                 // invalid handle

  if (!data.venmo_handle) {
    return (
      <TipShell avatar={data.avatar_url} name={data.display_name}>
        <p className="text-muted">
          This {nounFor(data.role)} isn’t accepting tips yet.
        </p>
      </TipShell>
    );
  }

  return <TipClient {...data} />;
}
```

# UI / UX Flow

1. **Avatar & Name** – centered, matches profile styling.  
2. **Amount Grid** – `$3  $5  $10`; `$5` pre-selected.  
3. **CTA** – full-width button:  
   `Pay $<amount> on Venmo` → deep-link.  
4. **Disabled State** – CTA greyed out until an amount is chosen  
   (already satisfied by default selection).

### Tailwind Classes

```html
<button
  class="rounded-lg border px-4 py-2 font-medium
         data-[active=true]:bg-primary data-[active=true]:text-white
         hover:ring-2 hover:ring-primary/50">
```

# Deep-Link Handling

```ts
function handlePay(amount: number, venmo: string) {
  const url =
    `venmo://paycharge?txn=pay&recipients=${venmo}` +
    `&amount=${amount}&note=Thanks%20for%20the%20support`;
  window.location.href = url;
}
```

*If Venmo is not installed, the OS falls back to web; a toast advises the user
to install Venmo for one-tap check

*(Answer truncated — 4306 chars total)*

## Question

Create a prompt for making a new section for the landing page advertising the tipping feature. Feature flag it. Use apple level copywriting and ycombinator best practices

## Answer

**Copy-paste this block into your coding agent (ChatGPT-Code-Interpreter, Claude, etc.) in the repo root.**  
It patches the marketing landing page to showcase the new tipping feature, but only when a feature flag is on.

```text
# ROLE
You are “Landing-Page-Tipping-Marketer,” an autonomous dev/copywriter.

# OBJECTIVE
Add a hero-style section to the public landing page that advertises the Venmo tipping feature with Apple-grade copy and YC-style clarity.  
The section must render only when `process.env.NEXT_PUBLIC_FEATURE_TIPS === 'true'`.

# TASKS
1. **Env flag**
   • In `.env.example` add:
     ```
     NEXT_PUBLIC_FEATURE_TIPS=true
     ```
   • Section is skipped entirely if the flag is not `"true"`.

2. **File edits (Next.js 15 App Router)**
   • Landing page lives at `app/page.tsx`.  
   • Insert a new component `<TipPromo />` just above the footer.

3. **Component: `components/TipPromo.tsx`**
   ```tsx
   'use client';
   import Link from 'next/link';

   if (process.env.NEXT_PUBLIC_FEATURE_TIPS !== 'true') return null;

   export default function TipPromo() {
     return (
       <section className="bg-zinc-900 text-white py-20">
         <div className="mx-auto max-w-4xl px-6 text-center space-y-8">
           <h2 className="text-4xl sm:text-5xl font-semibold tracking-tight">
             Tip, <span className="text-primary">instantly.</span>
           </h2>
           <p className="text-lg sm:text-xl leading-relaxed">
             Fans tap once, you get paid. No sign-ups, no fees, <br className="hidden sm:inline" />
             just pure support—directly in Venmo.
           </p>
           <Link
             href="/tim/tip"
             className="inline-block rounded-lg bg-primary px-8 py-3 text-lg font-medium shadow-lg hover:shadow-xl transition-all duration-200"
           >
             See it live
           </Link>
         </div>
       </section>
     );
   }
   ```

   *Copywriting principles*  
   - **Apple tone:** minimal, punchy, benefits-first.  
   - **YC best practice:** show traction → link to a working example (`/tim/tip`).

4. **Integration**
   ```diff
   // app/page.tsx
   import TipPromo from '@/components/TipPromo';
   ...
   <ExistingSections />
+  <TipPromo />       // ← new section
   <Footer />
   ```

5. **Styles**  
   • Relies only on Tailwind v4 utility classes—no extra CSS.  
   • Uses existing `bg-primary` for brand color.

6. **Tests**
   • **Jest/RTL:** When `FEATURE_TIPS=false`, `TipPromo` renders `null`.  
   • When `true`, component contains “Tip, instantly.” heading.  
   • **Playwright:** Set env flag, visit `/`, assert `See it live` button is visible.

7. **Git workflow**
   • Branch: `feat/tip-landing-section`.  
   • Commit message: “feat: add feature-flagged TipPromo hero to landing page”.  
   • Open PR.

# CONSTRAINTS
* Do not alter copy if the agent is re-run—idempotent.
* No external dependencies beyond current stack.
* Complete ≤ 45 min agent runtime.

# SUCCESS CRITERIA
Landing page dis

*(Answer truncated — 3267 chars total)*
