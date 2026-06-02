---
conversation_id: 695dadf8-c984-832b-be02-785f89d13291
created: 2026-01-07
links:
- '[[chatgpt-clusters/design_ux]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Landing Page Design Prompt
type: guide
updated: 2026-01-07
---

# Landing Page Design Prompt

**Related:** [[design_ux]]

> Conversation ID: 695dadf8-c984-832b-be02-785f89d13291
> Created: 2026-01-07T00:51:23Z
> Updated: 2026-01-07T00:53:44Z
> Messages: 4

---

## User

Generate a prompt to turn meetjovie.com into a worldclass ladning page with lienar.app design

---

## Assistant

Mr. White, here’s a **clean, high-signal prompt** you can paste directly into a design or website-generation AI (Framer, Webflow AI, v0, Relume, etc.):

---

**Prompt:**

> Redesign **meetjovie.com** into a **world-class, high-conversion landing page** inspired by **linear.app’s design language**.
>
> **Design system & aesthetics**
> - Ultra-minimal, modern, and confident
> - Dark-mode first with subtle gradients and soft glows
> - High contrast typography, generous whitespace
> - Crisp micro-interactions and smooth transitions
> - Precision layout, no visual clutter
>
> **Brand feel**
> - Calm, premium, technical, and trustworthy
> - Feels like a category-defining SaaS product
> - Clear, direct language — no hype, no fluff
>
> **Layout structure**
> 1. **Hero section**
>    - Sharp one-line value proposition (outcome-focused)
>    - Short supporting subheadline
>    - Primary CTA + secondary CTA
>    - Minimal product visual or abstract UI illustration
>
> 2. **Problem → Solution**
>    - Briefly articulate the core pain
>    - Immediately show how Jovie solves it
>
> 3. **Key benefits (not features)**
>    - 3–5 concise benefit blocks
>    - Each with a short headline and one-sentence explanation
>
> 4. **Product visuals**
>    - Clean screenshots or UI mockups
>    - Framed like Linear’s product sections
>
> 5. **Social proof**
>    - Logos, testimonials, or usage stats (tastefully understated)
>
> 6. **How it works**
>    - Simple 3-step flow
>    - Extremely scannable
>
> 7. **Final CTA**
>    - Clear action
>    - Reinforce main value prop
>
> **Copy guidelines**
> - Short sentences
> - Plain language
> - Confident tone
> - Focus on speed, clarity, and outcomes
>
> **Goal**
> - Maximize clarity and trust
> - Make the product feel inevitable
> - Drive sign-ups or demos with minimal friction

---

If you want, I can also:
- Rewrite the **actual landing copy**
- Generate **headline variants**
- Map this directly to **Framer/Webflow sections**
- Reverse-engineer **Linear-style UI tokens** (spacing, font scale, color ramps)

Just say the word.

---

## User

Reverse-engineer Linear-style UI tokens (spacing, font scale, color ramps)

---

## Assistant

Mr. White, here are **Linear-style UI tokens** you can drop into your design system. They’re **Linear-inspired** (not their private internal tokens), but grounded in what Linear has publicly described about typography + theming. citeturn5view0turn3view0turn1view0turn2search8

```css
/* Linear-inspired design tokens
   - Type: Inter (body) + Inter Display (headings) citeturn5view0
   - Theme approach: derive surfaces/borders from a few base colors; Linear mentions LCH theme generation + contrast control citeturn5view0turn3view0
   - Brand neutrals from Linear brand page citeturn1view0
   - Brand accent commonly referenced as #5E6AD2 (3rd-party brand catalogs) citeturn2search8
*/

:root {
  /* =========================
     Typography
     ========================= */
  --font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial;
  --font-display: "Inter Display", "Inter", ui-sans-serif, system-ui;

  /* Font size scale (tight, UI-forward) */
  --fs-11: 0.6875rem; /* 11 */
  --fs-12: 0.75rem;   /* 12 */
  --fs-13: 0.8125rem; /* 13 */
  --fs-14: 0.875rem;  /* 14 */
  --fs-15: 0.9375rem; /* 15 */
  --fs-16: 1rem;      /* 16 */
  --fs-18: 1.125rem;  /* 18 */
  --fs-20: 1.25rem;   /* 20 */
  --fs-24: 1.5rem;    /* 24 */
  --fs-30: 1.875rem;  /* 30 */
  --fs-36: 2.25rem;   /* 36 */
  --fs-48: 3rem;      /* 48 */
  --fs-60: 3.75rem;   /* 60 */

  /* Line heights (slightly tight like Linear) */
  --lh-tight: 1.15;
  --lh-snug: 1.25;
  --lh-normal: 1.45;
  --lh-relaxed: 1.6;

  /* Letter spacing (subtle tightening for headings) */
  --ls-tight: -0.02em;
  --ls-slight: -0.01em;
  --ls-normal: 0;

  /* =========================
     Spacing (4px-based, dense but breathable)
     ========================= */
  --space-0: 0px;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-7: 32px;
  --space-8: 40px;
  --space-9: 48px;
  --space-10: 64px;
  --space-11: 80px;
  --space-12: 96px;

  /* Layout widths (marketing pages) */
  --container: 1120px;
  --container-wide: 1240px;

  /* =========================
     Radius (soft, modern)
     ========================= */
  --r-1: 8px;
  --r-2: 12px;
  --r-3: 16px;
  --r-pill: 999px;

  /* =========================
     Elevation (subtle)
     ========================= */
  --shadow-1: 0 1px 0 rgba(255,255,255,0.06), 0 8px 24px rgba(0,0,0,0.35);
  --shadow-2: 0 1px 0 rgba(255,255,255,0.08), 0 16px 48px rgba(0,0,0,0.45);

  /* =========================
     Color ramps (semantic)
     ========================= */

  /* Linear brand neutrals: Mercury White + Nordic Gray citeturn1view0 */
  --neutral-0:   #ffffff;
  --neutral-50:  #f4f5f8; /* Mercury White */
  --neutral-900: #222326; /* Nordic Gray */

  /* Dark UI base inspired by Linear’s theme examples citeturn3view0 */
  --bg-0: #0f0f10;   /* Midnight background */
  --bg-1: #151516;   /* elevated surface */
  --bg-2: #1b1b1d;   /* higher elevation (derived) */

  /* Text */
  --text-1: rgba(255,255,255,0.92);
  --text-2: rgba(255,255,255,0.72);
  --text-3: rgba(255,255,255,0.52);

  /* Borders (hairlines) */
  --border-1: rgba(255,255,255,0.10);
  --border-2: rgba(255,255,255,0.16);

  /* Accent (Linear commonly cataloged as #5E6AD2) citeturn2search8 */
  --accent-500: #5e6ad2;
  --accent-400: rgba(94,106,210,0.80);
  --accent-300: rgba(94,106,210,0.60);
  --accent-200: rgba(94,106,210,0.35);
  --accent-100: rgba(94,106,210,0.18);

  /* “Glow” for hero highlights */
  --glow-accent: 0 0 0 1px rgba(94,106,210,0.25), 0 0 40px rgba(94,106,210,0.25);

  /* States */
  --success: #2ecc71;
  --warning: #f1c40f;
  --danger:  #ff5c5c;

  /* =========================
     Motion (snappy, not bouncy)
     ========================= */
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-in: cubic-bezier(0.7, 0, 0.84, 0);
  --dur-1: 120ms;
  --dur-2: 180ms;
  --dur-3: 240ms;
}

/* Light theme (optional) */
[data-theme="light"] {
  --bg-0: #ffffff;
  --bg-1: #f4f5f8;          /* Mercury White citeturn1view0 */
  --bg-2: #eef0f5;

  --text-1: rgba(17,17,19,0.92);
  --text-2: rgba(17,17,19,0.70);
  --text-3: rgba(17,17,19,0.52);

  --border-1: rgba(17,17,19,0.10);
  --border-2: rgba(17,17,19,0.16);
}
```

If you want this to feel *extra* Linear, the key move is: **derive surfaces + borders from just (base, accent, contrast)**, which Linear has described doing via **LCH-based theme generation** for consistent elevation steps. citeturn5view0turn3view0


**Topic:** [[chatgpt-clusters/design_ux]]
