---
title: "PostHog for mono-repo"
type: guide
created: 2025-11-19
updated: 2025-11-20
source: chatgpt-export
conversation_id: 691e59b8-d8fc-832d-995d-074ba5534a74
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# PostHog for mono-repo

> Conversation ID: 691e59b8-d8fc-832d-995d-074ba5534a74
> Created: 2025-11-19T23:59:02Z
> Updated: 2025-11-20T00:01:02Z
> Messages: 4

---

## User

Is posthog a good idea for logyoutbody which is a mono repo with iOS and web app

---

## Assistant

Short answer: Yes, PostHog can be a very solid choice for a monorepo with iOS + web, as long as you’re okay with its self-hosting / pricing model and you’re intentional about how you structure events.

Let me break it down for *logyoutbody* specifically.

---

## Why PostHog fits a mono-repo with iOS + web

1. **Unified product analytics across platforms**
   - Both iOS (Swift/Obj-C) and web (React/Next/etc.) have official or community SDKs.
   - You can send events from both apps into the **same project**, with a shared event taxonomy (`user_signed_up`, `workout_started`, `meal_logged`, etc.).
   - That lets you answer questions like:
     - “How many users start on web and later use iOS?”
     - “Do iOS users complete onboarding at a higher rate than web users?”

2. **Monorepo isn’t a blocker**
   - PostHog doesn’t care about repo structure – it only cares about:
     - SDK initialization in each client (iOS + web)
     - The project API key and host URL
   - In a monorepo you can:
     - Have a **shared analytics module** (e.g., TypeScript lib for web + maybe a shared event-name schema consumed by iOS via generated code or a JSON file).
     - Enforce consistent event names / properties across both platforms.

3. **Feature set is well suited for a consumer app**
   For something like logyoutbody:
   - Funnels (onboarding, subscription flow)
   - Retention / cohort analysis (e.g., 7-day retention after first workout)
   - A/B tests and feature flags (e.g., new onboarding screen, new macro calculator)
   - Session recording (web; iOS is more limited / trickier privacy-wise)

4. **Good dev-experience story**
   - SDKs are lightweight.
   - You can run PostHog **self-hosted** (Docker/Kubernetes) or use their cloud.
   - Strong TypeScript support on the web side.

---

## Things to think about before committing

1. **Privacy & PHI (if you ever drift into that territory)**
   - If logyoutbody ever touches anything resembling health data that could fall under HIPAA-style concerns, be VERY careful what you send:
     - No names, emails, or medical specifics in free-text event properties.
     - Prefer internal user IDs over emails.
     - Don’t put any sensitive content into session recordings or page titles.

2. **Cost / lock-in**
   - PostHog Cloud can get pricey at scale (events/session recordings).
   - Self-hosting is cheaper in pure dollars but adds infra + ops overhead.
   - If you want something you can easily swap later, keep your analytics behind a thin wrapper (e.g., `trackEvent("workout_started", payload)` in a shared module).

3. **iOS tracking details**
   - Respect ATT (App Tracking Transparency) and local privacy laws.
   - Decide what happens when a user opts out:
     - Either don’t init PostHog
     - Or init but don’t send any identifiable data.
   - Make sure you have a clean “reset identity” flow on logout (clear distinct_id, etc.).

---

## Suggested setup for logyoutbody

### 1. Single PostHog project, multiple “platform” properties

- **One project**: `logyoutbody-production`
- Add a property like:
  - `platform = "ios"` or `"web"`
- Optionally also:
  - `app_version`
  - `build_number`
  - `env = "prod" | "staging"`

This keeps cross-platform analytics easy.

### 2. Shared event schema in the monorepo

In the mono repo, create something like `/packages/analytics-schema`:

- A single source of truth for:
  - Event names
  - Required/optional properties

For example:

```ts
// packages/analytics-schema/src/events.ts
export const Events = {
  USER_SIGNED_UP: "user_signed_up",
  WORKOUT_STARTED: "workout_started",
  WORKOUT_COMPLETED: "workout_completed",
  MEAL_LOGGED: "meal_logged",
  SUBSCRIPTION_PURCHASED: "subscription_purchased",
} as const;
```

- Web app imports this directly.
- iOS app can consume a generated plist / Swift enum from the same source (or from a JSON file committed from this package).
- This avoids the classic “web calls it `workout_started`, iOS calls it `workout_start`” problem.

### 3. Client-side wrappers per platform

- **Web**: `@logyoutbody/analytics-web`
  - Initializes PostHog browser SDK.
  - Exposes `track(event, props)`, `identify(userId, props)`, `setUserProps(props)`.

- **iOS**: `Analytics` service
  - Wraps the iOS PostHog SDK with similar function names.
  - Uses the same event constants / names.

Goal: anywhere in the codebase, calling analytics feels the same conceptually.

---

## When PostHog is *not* a good fit

PostHog might not be ideal if:

- You want **purely server-side, log-based analytics** with no session recording, feature flags, or product analytics UI (then ClickHouse + Metabase / custom might be cleaner).
- You’re extremely constrained on infra/ops and also don’t want per-event SaaS pricing.
- You need **very strict compliance** (e.g., full HIPAA, BAA, etc.) that PostHog doesn’t fully meet for your use case.

---

## TL;DR for you, Mr. White

For a mono-repo with an iOS + web app like logyoutbody, PostHog is usually a strong, pragmatic choice:

- ✅ Good SDK coverage
- ✅ Cross-platform analytics in a single place
- ✅ Built-in funnels, retention, feature flags, experiments

As long as you:
- Centralize your event schema in the monorepo,
- Respect privacy/tracking rules on iOS,
- And optionally wrap it behind your own analytics layer,

it’s a “yes, this is a good idea” from me.

If you want, I can sketch out a concrete folder structure + example integration for both the iOS and web sides based on your current stack.

---

## User

Ist here a better solution? Any disadvantage? What would YCombinator suggest?

---

## Assistant

For *logyoutbody* specifically: there isn’t a clearly “better” default than PostHog for an iOS + web mono-repo. Different tools are better for different priorities, but PostHog is very defensible as the main choice.

I’ll hit your three questions directly, Mr. White.

---

## 1. Is there a better solution?

**Depends what you optimize for:**

### If you want an all-in-one product stack (flags, experiments, replays, analytics)
PostHog is *exactly* that: product analytics + session replay + feature flags + experiments + surveys, all in one platform, with open-source and self-hosting options. citeturn0search1turn0search4  

For a small team shipping fast on iOS + web, it’s hard to beat the combo of:

- Single SDK across platforms
- Feature flags and A/B tests built-in
- Good enough UI for funnels/retention

### If you want **more polished analytics only**
You might prefer:

- **Amplitude** – very strong product analytics / growth features, polished UX, but more expensive at scale. citeturn0search8turn0search28  
- **Mixpanel** – also very strong for funnels/retention, with long history in mobile analytics.

They’re better if your priority is “best possible analytics UI for PMs” and you don’t care about open-source or self-hosting.

### If you want **super simple + cheap web analytics**
Then tools like **Plausible**, **Umami**, or **Matomo** can be “better” – but they’re *web analytics*, not full product analytics across iOS + web. citeturn0search24turn0search31  
Fine for “pageviews and basic events,” not fine for proper funnels, cohorts, or experimentation.

### If you want **warehouse-first, highly modular**
A more advanced stack:

- Event pipeline (RudderStack/Segment)
- Warehouse (BigQuery/Snowflake)
- Dashboarding (Metabase/Hex/Looker Studio)
- Optional product analytics layer (PostHog warehouse mode, Indicative, etc.) citeturn0search16turn0search28  

This can be “better” long-term if you’re huge and data-heavy, but it’s overkill for an early product like logyoutbody.

**For a lean YC-style product with iOS + web, PostHog is in the top 1–2 realistic choices.** The main legitimate contender is “Amplitude / Mixpanel instead,” not some magic clearly-better option.

---

## 2. Real disadvantages of PostHog

Here’s where it can bite you:

1. **Cost at scale (cloud)**  
   - Pricing is usage-based across analytics, feature flags, experiments, etc. A growing startup can easily end up in the hundreds to low thousands per month if you’re not careful. citeturn0search27turn0search30  

2. **Complexity / “too much tool” for very early stage**  
   - It’s a full “Product OS” now. For a tiny MVP, it can feel like bringing Kubernetes to a weekend project. citeturn0search0turn0search23  

3. **Infra burden if self-hosting**  
   - Self-hosting is powerful and cheaper in direct SaaS spend, but you’re now running Postgres + ClickHouse + services yourself. Good if you already have infra chops; annoying if you don’t. citeturn0search4  

4. **UX vs. pure analytics incumbents**  
   - Amplitude/Mixpanel are still slightly ahead in some advanced reporting/workflow ergonomics. If your team is PM-heavy and data-heavy, they might feel nicer.

5. **Event volume discipline required**  
   - Because of usage-based pricing, sloppy event design (spamming too many events, high-cardinality properties) costs you money. This is more a process issue than a PostHog-only flaw, but it’s very visible with them.

None of these are deal-breakers for what you’re doing, but they’re the trade-offs.

---

## 3. What would Y Combinator likely suggest?

We actually have a few signals here:

- PostHog itself is a YC W20 company. citeturn0search6turn0search17  
- A recent research report notes that **~54% of YC’s Winter 2023 batch used PostHog**, making it one of the top three most-used products among YC companies. citeturn0search25  

So in practice, YC founders *do* pick PostHog a lot.

YC’s *general* advice about tools and analytics is roughly:

1. **Don’t overthink tool choice.**  
   Hacker News / YC-adjacent advice repeats: most startups waste time bikeshedding analytics stacks instead of talking to users and shipping. citeturn0search33turn0search14  

2. **Pick something fast, preferably with a free tier, and move on.**  
   YC’s “essential advice” is to focus on building something people want and talking to users; tools are a distant second. citeturn0search7turn0search22  

3. **Keep it simple and replace later if it hurts.**  
   Use one tool (PostHog, Amplitude, Mixpanel – doesn’t matter that much) behind a thin analytics wrapper, keep events sane, and only re-platform when:
   - You’re big enough that cost is actually painful, or
   - You truly hit a feature limit that blocks you.

Given that YC backs PostHog and that more than half of a recent batch uses it, the *revealed preference* from YC world is basically:

> “PostHog is a perfectly good, maybe even default, choice. Just don’t obsess over this decision.”

---

## My blunt recommendation for *logyoutbody*, Mr. White

- **Stay with / choose PostHog** *unless*:
  - You know you want Amplitude/Mixpanel’s specific UI and are fine paying more, **or**
  - You’re committed to a warehouse-first analytics team from day one (rare).

- **Protect yourself against lock-in** by:
  - Having a tiny shared `analytics.ts` / `Analytics.swift` wrapper so you can swap tools later.
  - Defining a small, clean event schema (activation, workout start/finish, subscription events, retention-relevant stuff).

If you want, I can propose an explicit, minimal event schema (10–15 events) and a simple wrapper interface for both iOS and web so you’re tool-agnostic but can still start with PostHog today.


## See Also
- [[chatgpt/chatgpt_codex-integration-with-repo]]
- [[chatgpt/chatgpt_create-readme-for-repo]]
- [[chatgpt/chatgpt_extract-design-system-repo]]
- [[chatgpt/chatgpt_fetch-and-reset-repo-part1]]
- [[chatgpt/chatgpt_fetch-and-reset-repo-part2]]
