---
title: "Playwright Auth Methods"
type: guide
created: 2026-02-04
updated: 2026-02-04
source: chatgpt-export
topic: design-ux
message_count: 8
tags: [chatgpt, knowledge, design-ux]
---
**Topic:** [[chatgpt-knowledge/_topics/design-ux]]

# Playwright Auth Methods

> **Source:** ChatGPT conversation
> **Date:** 2026-02-04T21:36:02Z
> **Messages:** 8
> **Topic:** design-ux

## Question

i want claude to use playwright to visit a website behind auth and compare the dashboard to our development dashboard and work iteratively til they match design for design , same fonts, icon sizes, broder colors and radius etc. how can i best have it authenticate? copy the cookie from my broswer?

## Answer

Mr. White — copying cookies *can* work, but it’s usually **not the best or safest long-term approach**, especially if you want iterative runs.

Here’s the clean breakdown, from most robust → most hacky.

---

## ✅ Best practice: Playwright `storageState` (recommended)

**Why:** Stable, repeatable, least brittle. Works well with Claude or any agent loop.

**How it works**
1. You log in **once** (manually or scripted).
2. Playwright saves cookies + localStorage + sessionStorage.
3. All future runs reuse that authenticated state.

**Flow**
```ts
// auth.ts
import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://your-app.com/login');
  // manually log in OR automate login here

  await context.storageState({ path: 'auth.json' });
  await browser.close();
})();
```

Then reuse:
```ts
const context = await browser.newContext({
  storageState: 'auth.json'
});
```

**Why this beats copying cookies**
- Survives refreshes
- Handles localStorage-based auth
- Less likely to break on minor backend changes

---

## ⚠️ Copying cookies from your browser (works, but brittle)

**When it’s acceptable**
- Internal tool
- Short-lived comparison
- No MFA / device binding

**Problems**
- Cookies expire silently
- SameSite / Secure flags may break
- MFA / SSO often invalidates them
- Easy to leak credentials accidentally

If you *do* this:
- Export **all cookies for the domain**
- Make sure Playwright context matches:
  - same user agent
  - same viewport
  - same HTTPS

But treat this as a **one-off**, not a workflow.

---

## 🔐 If the site uses SSO / OAuth / magic links

Best options:
1. **Service account** with username/password (ideal)
2. **Test-only login bypass** (feature flag, IP allowlist)
3. **Token injection**
   - Grab access token
   - Set via `addInitScript()` into localStorage
4. **Pre-authenticated environment**
   - Staging with auth disabled or simplified

If MFA is involved, cookies will *constantly* break.

---

## 🤖 For “design-for-design” dashboard comparison

For your exact goal (pixel-level parity):

**Recommended setup**
- One `storageState` per environment:
  - `auth-prod.json`
  - `auth-dev.json`
- Same viewport, DPR, fonts loaded
- Disable animations
- Screenshot + DOM diff loop

```ts
await page.emulateMedia({ reducedMotion: 'reduce' });
```

This lets Claude:
- Iterate safely
- Reload pages
- Compare fonts, border radius, icon sizing without auth flakiness

---

## Bottom line

- ❌ **Don’t rely on copied cookies** unless you’re prototyping fast.
- ✅ **Use Playwright `storageState`** — this is the correct solution.
- 🧠 If auth is complex, **add a test-only login path**. It will save you days.

If you want, tell me:
- auth type (email/pass, OAuth, SSO, MFA?)
- prod vs staging availability

I’ll give you the *exact* auth strategy and Playwright config to make this agent lo

*(Answer truncated — 3014 chars total)*

## Question

its emaill and otp or sso. and i just need this for a couple days of design work then we wont use it

## Answer

Got it, Mr. White. Given **email + OTP or SSO**, and a **2-day lifespan**, here’s the *least-pain, highest-success* approach.

---

## Do this: one-time manual login → `storageState`

This is the sweet spot for **short-term design diffing**.

### Why
- Works with **OTP + SSO**
- No reverse-engineering auth flows
- Stable for days (until session expiry)
- Zero security gymnastics

---

## Step-by-step (10 minutes)

### 1. Run Playwright **headed**
```ts
import { chromium } from 'playwright';

(async () => {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://app.example.com/login');

  // YOU manually:
  // - enter email
  // - enter OTP OR complete SSO

  await page.waitForURL('**/dashboard'); // or any post-auth page

  await context.storageState({ path: 'auth.json' });
  await browser.close();
})();
```

This captures:
- cookies
- localStorage
- sessionStorage
- SSO tokens

---

### 2. Reuse everywhere
```ts
const context = await browser.newContext({
  storageState: 'auth.json',
});
```

That’s it. Claude can now reload, navigate, screenshot, diff — no re-auth.

---

## Hard rules so it doesn’t flake

These matter more than people think.

### Match browser fingerprint
```ts
await browser.newContext({
  storageState: 'auth.json',
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  userAgent: 'same as Chrome',
});
```

### Disable animation + randomness
```ts
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.addStyleTag({
  content: `
    * {
      animation: none !important;
      transition: none !important;
    }
  `
});
```

---

## If it expires (likely after ~24h)

Just re-run the login script. That’s expected with OTP/SSO.

**Do NOT**
- copy cookies manually
- try to replay OTP
- attempt SSO automation

All of those waste time.

---

## Design-for-design comparison tips (important)

To avoid false diffs:

- Same viewport + DPR
- Same font loading state
- Wait for fonts explicitly:
```ts
await page.evaluate(() => document.fonts.ready);
```

- Freeze time if charts show timestamps
- Screenshot after idle:
```ts
await page.waitForLoadState('networkidle');
```

---

## TL;DR

✔ Manual login once  
✔ Save `storageState`  
✔ Reuse for 2 days  
✘ Don’t copy cookies  
✘ Don’t automate OTP  

If you want, I can give you:
- a **prod vs dev screenshot diff harness**
- a **CSS token comparison script** (border radius, colors, font sizes)
- or a **Claude prompt** that drives the iteration loop correctly

Just say which.

## Question

ok give me aprompt

our dashbaord compared to linear.app's dashbaord.
we want to clone it pixel for pixel with design tokens in both light and dark mode.
we want sidebar nav items identical padding, and alignment and fonts and icon sizes and hover and active states and transtions. we want the same for the app shell. everytthing outside the main content area should be verticually identical (minus the fact that we have different nav items, nav grouping, user menu placement, etc) but design properties should be identical

## Answer

Mr. White — here’s a **battle-tested agent prompt** you can drop straight into Claude (or any Playwright-capable agent). It’s scoped for **pixel-level cloning**, not vibes.

---

### Prompt: Pixel-Perfect Design Parity Agent

```
You are a senior design systems engineer and frontend QA specialist.

Goal:
Compare OUR dashboard against linear.app’s dashboard and iteratively drive OUR UI to match Linear pixel-for-pixel for all non-content UI.

Scope:
Everything OUTSIDE the main content area must be visually and behaviorally identical to Linear, including:
- App shell
- Sidebar
- Top bar (if present)
- Navigation containers
- Spacing, alignment, sizing, and motion

We explicitly do NOT match:
- Nav item labels
- Nav grouping structure
- User menu placement
- App-specific content

But ALL design properties must match exactly.

Environments:
- Linear dashboard (reference)
- Our dashboard (target)
- Light mode AND dark mode

Method:
1. Use Playwright to authenticate and load both dashboards.
2. Normalize rendering:
   - Same viewport, DPR, and user agent
   - Disable animations during measurement
   - Wait for fonts to load
3. Capture screenshots AND inspect computed styles.
4. Compare and identify differences.
5. Propose precise changes to OUR implementation.
6. Repeat until diffs are eliminated.

Design properties to match EXACTLY:
- Font family, size, weight, line-height, letter-spacing
- Icon size, stroke width, alignment
- Padding and margin (all sides, px-perfect)
- Border width, color, and radius
- Background colors (RGBA / OKLCH if used)
- Hover, active, focus, selected states
- Transition properties (duration, easing, properties)
- Shadow values (including spread and blur)
- Z-index layering
- Sidebar width and internal grid
- Hit target sizes

Sidebar requirements:
- Nav item height
- Icon-to-label spacing
- Left/right padding
- Vertical rhythm
- Hover, active, selected visuals
- Group spacing and separators
- Collapsed/expanded behavior (if applicable)

App shell requirements:
- Overall shell padding
- Content boundary alignment
- Background layering
- Header/footer sizing (if present)

Rules:
- Do not approximate. Use measured values.
- If unsure, inspect computed styles.
- Prefer design tokens over hardcoded values.
- Call out mismatches explicitly.
- Suggest token names and values where appropriate.
- Verify fixes via re-comparison before proceeding.

Output format (repeat each iteration):
1. Summary of mismatches (bullet list)
2. Table of properties:
   - Component
   - Property
   - Linear value
   - Our value
   - Delta
3. Exact recommendations (CSS / tokens)
4. Confirmation steps to verify parity

Success criteria:
A side-by-side screenshot comparison where UI outside the main content area is visually indistinguishable from Linear in both light and dark mode.
```

---

### Optional (strongly recommended)
Add this **system constraint** if the tool supports it:

> *“If visual parity cannot be confirmed by inspection or measurement, state

*(Answer truncated — 3329 chars total)*

## Question

it should spcify to login headed the way you suggested

## Answer

Good catch. Here’s the **corrected, drop-in prompt** with **explicit headed login + `storageState`** baked in. This removes all ambiguity and prevents Claude from trying to automate OTP/SSO.

---

### Prompt: Pixel-Perfect Linear Dashboard Parity Agent (Headed Auth)

```
You are a senior design systems engineer and frontend QA specialist.

Goal:
Compare OUR dashboard against linear.app’s dashboard and iteratively drive OUR UI to match Linear pixel-for-pixel for all non-content UI.

Critical authentication rule (MANDATORY):
- Authentication MUST be done in a HEADED Playwright browser.
- DO NOT attempt to automate OTP, magic links, or SSO.
- Perform manual login once, then persist auth using Playwright storageState.
- Reuse storageState for all subsequent runs.
- If auth expires, repeat the manual headed login and regenerate storageState.

Authentication procedure:
1. Launch Playwright with headless = false.
2. Navigate to the login page.
3. Pause and allow a human to:
   - Enter email
   - Complete OTP or SSO
4. Wait for a confirmed post-auth page (dashboard or app shell).
5. Save storageState to disk (e.g. auth-linear.json or auth-ours.json).
6. Close the browser.
7. Reuse storageState in all future contexts.

Scope:
Everything OUTSIDE the main content area must be visually and behaviorally identical to Linear, including:
- App shell
- Sidebar
- Navigation containers
- Top-level layout chrome

Explicitly excluded from matching:
- Navigation labels
- Navigation grouping structure
- User menu placement
- App-specific content

Design properties must match EXACTLY.

Environments:
- Linear dashboard (reference)
- Our dashboard (target)
- Light mode
- Dark mode

Rendering normalization (REQUIRED):
- Same viewport (1440x900)
- Same device pixel ratio
- Same user agent
- Disable animations and transitions during measurement
- Wait for all fonts to load before comparison
- Wait for network idle

Comparison method:
1. Load Linear using stored auth state.
2. Load Our dashboard using stored auth state.
3. Normalize rendering.
4. Capture:
   - Screenshots
   - Computed styles
   - DOM structure (sidebar + shell only)
5. Identify mismatches.
6. Propose exact changes using measured values.
7. Re-run comparison after changes.
8. Repeat until no diffs remain.

Design properties to match exactly:
- Font family, size, weight, line-height, letter-spacing
- Icon size, stroke width, alignment
- Padding and margin (px-perfect, all sides)
- Border width, color, radius
- Background colors (exact RGBA or OKLCH)
- Hover, active, focus, selected states
- Transition duration, easing, and properties
- Shadow values
- Z-index layering
- Hit target sizes
- Sidebar width and grid
- Vertical rhythm

Sidebar requirements:
- Item height
- Icon-to-label spacing
- Left/right padding
- Hover / active / selected visuals
- Group separators and spacing
- Collapsed and expanded behavior (if applicable)

App shell requirements:
- Overall shell padding
- Content boundary alignment
- Backgro

*(Answer truncated — 3980 chars total)*
