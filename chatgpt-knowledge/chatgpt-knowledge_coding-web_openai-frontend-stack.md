---
title: "OpenAI frontend stack"
type: essay
created: 2025-09-17
updated: 2025-09-17
source: chatgpt-export
topic: coding-web
message_count: 10
tags: [chatgpt, knowledge, coding-web]
---
# OpenAI frontend stack

> **Source:** ChatGPT conversation
> **Date:** 2025-09-17T01:25:24Z
> **Messages:** 10
> **Topic:** coding-web

## Question

Does OpenAI's team, when they're coding front-end, they've spoken a little bit about their front-end stack and I'm familiar with some of what they do. I'm curious if they practice atomic design or not.

## Answer

I couldn’t find any credible public source that says OpenAI explicitly uses **Atomic Design** (the atoms-molecules-organisms-templates-pages model) in their frontend stack. The documentation, blog posts, etc., don’t mention it by name as far as I saw.

Here’s what *is* known, and some educated inferences, Mr. White:

---

### What *is* known

From OpenAI’s “Frontend coding with GPT-5” cookbook:  
- Their front-end stack includes **Next.js (TypeScript), React**, with **Tailwind CSS**, **shadcn/ui**, **Radix Themes** for styling. citeturn0search0  
- They use utility-first CSS (Tailwind) and UI component libraries (Radix, shadcn) which tend to favor modular, reusable components. citeturn0search0

---

### Inference: Do they *effectively* follow Atomic-Design-like practices?

While there’s no explicit confirmation of using the atomic design methodology, several of their tools & architecture choices suggest that at least parts of the philosophy align:

- Use of component libraries (Radix, shadcn) implies abstraction of UI bits into smaller reusable pieces (like atoms / molecules)—buttons, form inputs, etc.  
- Tailwind CSS encourages design tokens, utility classes that let you standardize spacing, typography, color across components, which is consonant with “atoms” / basic design tokens.  
- The design system / UI libraries they use suggest layering: base UI primitives, then composed elements.  

So, even if *not in name*, their stack seems compatible with a more flexible / pragmatic version of atomic design.

---

### Conclusion

I think it’s likely OpenAI uses **some mix** of atomic-style componentization (small reusable UI primitives → composed components → pages/layouts). But they do *not* publicly assert a strict Atomic Design process (with the canonical layers) in their tooling or documentation.

If you want, I could try to dig up internal engineering talks, repo structures, or talks by OpenAI engineers to see if there’s more evidence.

## Question

Are there like competing ideologies to atomic design that are like widely practiced? Or is it kind of just like people either have like a lack of an ideology or they use atomic design? Is it like is there like a competing theory and like to atomic design or something or like ideas of like different ways of breaking down your components and stuff?

## Answer

There isn’t one dominant “anti-atomic” camp, but there **are** several other well-defined ways teams structure UI code. Atomic design is just one philosophy; many shops follow different organizing principles or mix and match.

Here are the main *alternatives or competitors* you’ll hear about:

---

### 1. **Feature-Based / Domain-Driven Structure**  
*Also called: “vertical slice,” “feature folder,” or “domain-driven UI.”*  
- **Idea:** Group files by product feature or domain, not by component size.  
- **Example:**  
  ```
  src/
    features/
      checkout/
        components/
        pages/
        hooks/
      profile/
        components/
        pages/
  ```
- **Why:** Keeps everything a feature needs in one place—React components, logic, tests—making refactors and ownership easier.

---

### 2. **Presentational vs. Container (Smart/Dumb)**  
- **Idea:** Separate UI (pure presentational components) from stateful logic (container components).  
- **Popularized by:** Dan Abramov’s early React blog posts.  
- **Status:** Still used conceptually, though many teams now co-locate logic with features instead of a strict “containers” folder.

---

### 3. **Design-System / Token-Driven**  
- **Idea:** Organize around *design tokens* (colors, spacing, typography) and reusable primitives, often with a single “UI” or “components” library.  
- **Looks like:** A Storybook-first monorepo where the hierarchy is “tokens → primitives → patterns,” not atoms/molecules language.  
- **Used by:** Big product companies (Shopify Polaris, Microsoft Fluent) that need strict brand consistency.

---

### 4. **Colocation by Route or Page**  
- **Idea:** Especially in Next.js/Remix, keep everything for a route (data loaders, components, tests) in that folder.  
- **Goal:** Make it trivial to delete or rewrite a page without hunting through global component folders.

---

### 5. **Flat / Pragmatic**  
- **Idea:** Minimal structure—just a `components/` folder with whatever naming makes sense.  
- **Why:** Favored by small teams that iterate fast and refactor later.

---

### 6. **CSS/Styling-Driven Approaches**  
- **BEM (Block-Element-Modifier)** or **SMACSS** originally targeted CSS but still influence component naming and scoping.

---

### Takeaways
* Atomic design is one popular mental model, but many teams skip it for feature-based or design-system approaches.  
* Large companies often blend: design tokens + feature folders, maybe using atomic terminology only inside the design-system team.  
* The “competition” isn’t a single rival theory—it’s a spectrum of structures chosen to match team size, product complexity, and tooling.

That’s why you’ll see big shops like Airbnb, Shopify, or Meta use a hybrid rather than a strict atomic hierarchy.

## Question

So I'd love to know what Airbnb say or Shopify are using and then I'd also like to know what kind of system OpenAI is using. And I would love to dive into that. I'm potentially curious about any other high-velocity Y Combinator companies.

## Answer

Here’s what I was able to dig up on how companies like **Airbnb**, **Shopify**, and **OpenAI** structure their front-end / UI systems, plus some observed trade-offs. Some of it is public, some is inference. If you like, I can try to find internal engineering talks that go deeper.

---

## What Airbnb Does / Has Done

What’s known from various Airbnb engineering blog posts and reports:

- Airbnb used to be heavily Rails / MVC (“monorail”) but over time has shifted toward more client-side rendering (React) and more modular frontend architecture. citeturn0search23turn0search3turn0search0turn0search9  
- In “Rearchitecting Airbnb’s Frontend”, they talk about moving away from Rails‐first toward separating concerns, making transitions between pages/routes more fluid, etc. citeturn0search0  
- They have a **design system** and component libraries; for example, they published “A Deep Dive into Airbnb’s Server-Driven UI System (Ghost Platform)” which lets them reuse UI definitions across platforms (web, iOS, Android) by defining UI via server, then shipping it down. That suggests a system of sharable UI primitives/patterns. citeturn0search9  
- Their style guides are rigorous: e.g. Airbnb React / JSX style guide dictates naming conventions, file / component folder structure, etc. citeturn0search11  

**Structure** (from what’s public / inferred):

- Components are organized by function / feature in many cases, rather than strictly by “atom / molecule / organism” layers.  
- They favour sharing UI primitives (buttons, inputs, cards) across the product and using a design-system discipline.  
- Their server-driven UI suggests they want central control over component definitions / props / layouts, enabling consistency + reuse.  

---

## What Shopify Does / Has Done

From public sources:

- Shopify’s frontends, especially their **Hydrogen** stack: Shopify provides a React-based framework (Hydrogen) + Remix for server-side routing, for building custom storefronts. citeturn0search31turn0search4turn0search24  
- They also have “modular monolithic architecture” in many parts: the codebase is structured in modules/domains, but not split into dozens/hundreds of microservices. The modular structure allows teams to own features or domains. citeturn0search26turn0search27  
- On the UI side, Shopify has Polaris, their design system, which has reusable primitives and component design, themes, etc. While I didn’t see a public write-up explicitly saying “we use atomic design,” the design system approach (with tokens, component library, shared UI primitives) is clearly in place.  

---

## What OpenAI Uses / Seems to Use

What is known (public) plus what can be inferred:

- From *Frontend coding with GPT-5* (OpenAI’s cookbook), they list their recommended stack: **React + Next.js (TypeScript)** plus **Tailwind CSS**, **shadcn/ui**, **Radix Themes** for styling and UI components. citeturn0search10turn1search3  
- This suggests a component-library

*(Answer truncated — 6593 chars total)*

## Question

I mean, I find it interesting the way Airbnb, you talk about the server-driven stuff, and I'd be curious to learn a little bit more about that and how that could apply to RStack. RStack is very close to OpenAIs with Next.js, Tailwind, Shade, Shotzian, which I guess uses Radix. But we are doing a lot of server-side rendering. And I'm kind of curious how that all plays into, like, the server-side UI, how that works, how RStack could take advantage of that, what the benefits would be. If we really should be leaning more on client-side rendering, I'm a little confused by that. It seems like server-side rendering with Next is ideal for us, especially trying to keep performance up. But maybe you can elaborate on that so I have a better understanding. But I would kind of like to define some clear-set rules for how to deal with our code base so that as it expands, it stays organized and optimized.

## Answer

Got you, Mr. White. Here’s the tight breakdown you need.

# SDUI (Server-Driven UI): what Airbnb’s doing & why it matters
**What it is:** the server returns both data **and** a lightweight UI schema (JSON/DSL). The client renders screens from that schema using a catalog of primitives. Ship layout/flows from the server without mobile app releases; A/B safely across web/iOS/Android with one source of truth. citeturn0search0turn0search5

**Why Airbnb uses it:** cross-platform velocity, safer rollouts, and consistency while decoupling product iteration from mobile store releases. Their “Ghost Platform” is the canonical write-up. citeturn0search0

# Where this fits your stack (Next.js + Tailwind + shadcn/ui + Radix)
You already have the perfect primitives layer (Radix) and ownable components (shadcn). That maps cleanly to an SDUI renderer: server emits a schema → React maps nodes to Radix/shadcn primitives → SSR renders HTML, then hydrate where needed. citeturn0search8turn0search9turn0search13

## SDUI benefits for RStack
- **Velocity:** change flows, copy, layouts server-side; instant multivariate experiments. citeturn0search5  
- **Consistency:** one schema → consistent UI across surfaces. citeturn0search0  
- **Guardrails:** restrict client UI to vetted primitives (accessible, keyboard-correct). citeturn0search4

## SDUI gotchas
- **Schema versioning & migrations** (clients must understand new nodes).  
- **Renderer bloat** (keep the node set small; use composition).  
- **Analytics/QA** (log schema versions + experiment IDs on every render).

# SSR vs CSR (and where SDUI lands)
For web, keep **SSR (or RSC) as the default** for speed/SEO; hydrate only the interactive islands. Use CSR when you truly need client-only state or heavy interactivity. Next’s docs still draw these lines clearly. citeturn0search21turn0search12

**Simple decision rules:**
- **Personalized/real-time** (auth dashboards, prices, inventory): **SSR/RSC**. citeturn0search21  
- **Stable marketing/docs**: **SSG/ISR**. citeturn0search12  
- **Highly interactive widgets** (canvas editors, drag-drop): **CSR island** inside an SSR page. citeturn0search12  
- **SDUI pages**: **SSR** the schema → HTML (great FCP/LCP), then hydrate per-node as needed.

# Concrete blueprint for RStack

## 1) Define a tiny SDUI schema
- **Node**: `{ type: 'button'|'card'|'stack'|'text'|'input'|'dialog', props: {...}, children: [...] }`  
- **Design tokens in props**: only allow tokens (spacing/typography/color) rather than arbitrary class names.  
- **Registry**: map `type` → renderer (`ButtonNode → <Button …/>` built from shadcn+Radix). citeturn0search13turn0search8

## 2) Rendering pipeline (Next.js App Router)
1. **Server action / route** fetches schema + data.  
2. **RSC layer** composes schema → React tree (streaming if large).  
3. **Hydration islands**: mark interactive nodes (`dialog`, `popover`, `combobox`) as client components; everything else stays server.  


*(Answer truncated — 5978 chars total)*

## Question

Okay, so like, knowing Rstack and knowing, you know, Next, 15.5, SuperSight Rendering, Neon Database, Drizzle, Tailwind 4.1, ShadCN Primitives, or Components, the Radix, We are using Zod, we're using ESLint, and whatever that other one is. What else is in our stack? We'll eventually probably use UpStash for caching. We're using Qlrk for Auth, but we're using the ShadCN Components for Auth with QlrkElements rather than using the new QlrkElements beta, rather than using the actual Qlrk stuff. And then Stripe for payments. Yeah, just, I don't know, do we? And currently we're just kind of leaning on normal atomic design. What should be our, like, concisely explain, like, what should be our kind of, like, guidelines and best practices and how we should do it, and what would be the benefits.

## Answer

Got it, Mr. White. Here’s a **tight, opinionated playbook** for RStack given Next 15.5, RSC/SSR, Neon + Drizzle, Tailwind 4.1, shadcn + Radix, Zod, ESLint, Clerk(Elements), Stripe, and (soon) Upstash.

# Architecture & Rendering
- **Default**: **RSC/SSR** pages for speed/SEO; **hydrate islands** only where interaction is needed.  
- **Static**: **SSG/ISR** for public marketing/docs.  
- **CSR**: only for heavy client state (canvas, drag/drop, editors).  
- **SDUI**: use a tiny JSON schema for high-iteration flows (onboarding, paywalls, banners). Server emits schema → RSC renders → hydrate interactive nodes.

# Folder Layout (enforce boundaries)
```
/app                    # routes only; thin layouts; server actions
  /(marketing)
  /(app)
/features               # vertical slices (own server/queries/ui/tests)
/ui                     # design system (no feature deps)
  /tokens               # TS tokens; no Tailwind classes here
  /primitives           # Radix wrappers (accessibility baked-in)
  /components           # shadcn-derived, brand-styled
  /patterns             # composed UI (forms, cards, toolbars)
/sdui                   # server-driven UI renderer
  /schemas              # zod node/page schemas
  /nodes                # node renderers
  /registry.ts          # type→renderer map
/lib
  /db                   # Drizzle schema, queries
  /auth                 # Clerk Elements adapters
  /cache                # Upstash helpers
  /payments             # Stripe helpers & webhooks
  /validators           # shared zod schemas
  /analytics            # PostHog/whatever
```
**Rules:**  
- `features/*` can use `/ui/*` and `/lib/*`, never the other way.  
- `/ui/*` is pure UI; no fetch, no feature logic.  
- `/sdui/*` may compose only `/ui/*`.  
- `/app/*` stays thin: compose features, call server actions, wire data.

# Component System
- **Tokens-first**: spacing/typography/radius/shadows in `/ui/tokens`.  
- **Radix for interactivity**, wrapped in `/ui/primitives`.  
- **shadcn components** live in `/ui/components` and use tokens; never fetch.  
- **Patterns** are composed building blocks (multi-field forms, tables); still UI-only.

# Tailwind 4.1
- Keep a **single** global stylesheet. No duplicate `globals.css`.  
- Use **design tokens via CSS variables**; map to Tailwind theme.  
- **No arbitrary values** in features; prefer tokenized classes.  
- Prevent CLS: always set explicit sizes for media, skeletons for async.

# Data & State
- **Drizzle** for schema + typed queries in `/lib/db`.  
- **Neon** primary; short-lived connections; prefer server actions + RSC.  
- **Caching**: Upstash Redis for request-scoped and user-scoped cache helpers (`cacheGet/Set`, tag invalidation).  
- **Zod at the edges**: validate all inputs (server actions, webhooks, SDUI payloads).  
- **No global client state** unless necessary; co-locate state with the island.

# Auth (Clerk Elements)
- All auth UI is **Elements** inside `/features/auth`.  
- **Server** reads fr

*(Answer truncated — 5987 chars total)*
