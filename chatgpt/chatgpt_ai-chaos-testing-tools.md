---
title: "AI Chaos Testing Tools"
type: guide
created: 2026-04-08
updated: 2026-04-08
source: chatgpt-export
conversation_id: 69d691f9-af10-83e8-8b34-583e03e9338b
message_count: 7
tags: [chatgpt, import, code, long-form]
---
# AI Chaos Testing Tools

> Conversation ID: 69d691f9-af10-83e8-8b34-583e03e9338b
> Created: 2026-04-08T17:37:24Z
> Updated: 2026-04-08T17:44:38Z
> Messages: 7

---

## User

are there any tools on github or anythng that are like optimized ai chaos testing. like something i can unleash on my codebase and just have it loop through every single features, mode, menu, page, view, etc and try to break it til it surfaces every signle bug. crete a tst that would find said bug, then loop til that test is green then continue etc.

---

## Assistant

I’m checking current GitHub and commercial options across autonomous UI testing, API fuzzing, and chaos-style failure injection. If your stack matters, say web, mobile, desktop, or backend and I’ll bias the list.

---

## Assistant

The landscape is fragmented. There are real tools for autonomous browser exploration, API fuzzing, and infra chaos, but I have not found a mature one-stop system that reliably explores an entire product, writes minimal repro tests for each bug, fixes code until green, and then resumes coverage.

---

## Assistant

Yes, pieces of this exist. I did not find a mature open-source tool that fully does your exact loop end to end: autonomously crawl the whole product, discover a bug, write the minimal regression test, patch the code until green, then continue crawling. What exists today is a stack of specialized tools that you can combine into something close. citeturn529082search11turn529082search19turn529082search6turn553212search5turn888718search1

For web apps, the closest open-source options are these:

**Autonomous UI exploration**
- **browser-use**: LLM-driven browser automation for exploring and interacting with sites. Good for “go click around and try flows” behavior. citeturn888718search1turn529082search12
- **Playwright MCP**: gives an LLM structured browser control through Playwright. Good foundation for an agentic tester because it can inspect and act on pages in a repeatable way. citeturn888718search2turn888718search6
- **Skyvern**: AI browser automation with a Playwright-compatible SDK and workflow system. More workflow-oriented than pure chaos testing. citeturn529082search9turn529082search13
- **Hercules / TestZeus**: open-source testing agent that claims UI, API, accessibility, visual, and security validations. This is one of the closest repos to “agentic testing” rather than plain automation. citeturn888718search15turn529082search6turn529082search2

**Randomized / chaos-style UI breakage**
- **gremlins.js**: classic monkey-testing library for web apps. It does random clicks, touches, typing, scrolling, and other chaos-style events. It is useful for surfacing crashes and bad states, but it does not autonomously author durable regression tests or fix code. citeturn553212search0turn553212search7

**API bug discovery**
- **Schemathesis**: generates large numbers of API tests from OpenAPI or GraphQL schemas and is explicitly aimed at finding edge cases and schema violations. citeturn553212search5turn553212search9
- **EvoMaster**: open-source search-based system-level test generation / fuzzing for REST, GraphQL, gRPC, and similar APIs. citeturn888718search3turn888718search13
- **RESTler**: stateful REST API fuzzing from OpenAPI specs. Strong option for reliability and security bugs in APIs. citeturn888718search7

**Infra / backend fault injection**
- **Chaos Mesh**, **LitmusChaos**, **Chaos Monkey**: these are real chaos engineering tools, but they target infrastructure and resilience faults such as pod, network, disk, or instance failures. They are valuable if you mean “break the system under failure,” not “click every product menu and screen.” citeturn553212search3turn553212search6turn553212search1turn553212search8

**Fix-the-bug / write-the-test loop**
- **OpenHands resolver**: can attempt to resolve repo issues automatically and open PRs, including via GitHub Action workflows. This gets you closest to the “once a bug is captured, try to fix it” part. citeturn529082search3turn529082search11turn529082search19
- **Qodo Cover / Cover-Agent** and **CoverUp**: these focus on generating tests and increasing coverage. Useful after a failing repro exists, but they are not autonomous product crawlers. citeturn766685search14turn766685search15turn766685search18turn766685search0

So the direct answer is:

**There is no widely adopted OSS “unleash it on the whole codebase and product, let it discover every bug, write a regression test, self-fix until green, then continue” tool.** The closest practical approach is to compose one yourself from:
1. a browser agent for exploration,
2. a monkey/fuzz layer for adversarial interaction,
3. API fuzzers for backend coverage,
4. a bug deduper + repro recorder,
5. a code agent that attempts fixes,
6. a regression-test generator. citeturn888718search1turn888718search2turn553212search0turn553212search5turn888718search7turn529082search11turn766685search14

For a startup web app, I would build it like this:

**Best current stack**
- **Playwright + Playwright MCP or browser-use** for guided exploration of pages, menus, modals, auth states, and edge flows. citeturn888718search2turn888718search1
- **gremlins.js** injected on selected screens to do high-volume random interaction after the agent reaches a stable page. citeturn553212search0
- **Schemathesis** against every OpenAPI surface. Add **RESTler** or **EvoMaster** if your API complexity justifies it. citeturn553212search5turn888718search7turn888718search3
- **OpenHands resolver** for “issue exists, here is the failing repro, attempt fix in PR.” citeturn529082search11turn529082search3
- **Qodo Cover / CoverUp** to turn confirmed failures into sturdier regression tests and raise coverage around the touched code. citeturn766685search14turn766685search18
- **Chaos Mesh / LitmusChaos** only if you also want resilience testing of your infra. citeturn553212search3turn553212search6

The hard part is not clicking around. The hard part is four engineering problems:
- **state explosion**: “every feature, mode, menu, page, view” grows combinatorially;
- **oracle quality**: the agent must know what counts as a bug versus an acceptable outcome;
- **bug deduping**: hundreds of traces often map to one root cause;
- **repro stability**: random exploration finds bugs, but durable Playwright tests require deterministic setup and assertions.  
That is why most current tools cover pieces of the loop rather than the whole loop. This is an inference from the capabilities those tools publicly describe. citeturn529082search6turn553212search0turn553212search5turn529082search11

If you want the most leverage fast, Mr. White, I would do this:

- Use **Playwright** as the canonical test format. citeturn888718search6
- Add an **agentic crawler** using **browser-use** or **Playwright MCP**.
- On each reachable page, run a short **gremlins.js** burst.
- Capture console errors, network failures, uncaught exceptions, screenshot diffs, accessibility violations, and 4xx/5xx responses as failure signals.
- When a failure appears, auto-save:
  - URL and auth state
  - action trace
  - DOM snapshot / accessibility snapshot
  - network log
  - video / screenshot
- Convert that trace into a **Playwright repro test**.
- Open a GitHub issue automatically.
- Hand the issue to **OpenHands resolver**.
- After the PR, run the repro test plus surrounding suites.
- If green, keep the regression test and resume exploration from the saved frontier.

That is the closest thing to the system you described, and it is buildable today with existing OSS. citeturn529082search3turn529082search11turn888718search2turn553212search0

If you want, I can turn this into a concrete architecture for your stack and give you a starter repo layout with the exact tools, folders, CI jobs, and agent loop.

---

## User

next.js and clerk tailwind drizzle neon pooled connection url. 

---

## Assistant

I’m narrowing this to your exact stack and checking the current official docs for Clerk, Next.js, Drizzle, and Neon pooling so the recommendations match current integration patterns.

---

## Assistant

For **Next.js + Clerk + Tailwind + Drizzle + Neon**, the best practical setup is:

**Playwright + browser-use + gremlins.js + Schemathesis + OpenHands/Qodo Cover**

That gives you stable browser execution, autonomous page exploration, randomized UI abuse, API fuzzing, and a supervised “issue → attempted fix → added tests” loop. It is the closest thing to the workflow you described for a modern TypeScript web app. citeturn288820search0turn288820search4turn288820search1turn288820search2turn288820search3turn764245search3turn764245search1

For your stack specifically, I would use **Next.js App Router**, keep auth in **Clerk middleware**, and use **Route Handlers** for test-only endpoints such as DB reset, fixture setup, and synthetic health checks. Next.js documents App Router and Route Handlers as the current server-side path, and Clerk’s current Next.js docs use `clerkMiddleware()` plus `auth()` / `protect()` for route protection. citeturn334375search0turn334375search4turn334375search1turn334375search5turn334375search9

For the database layer, use **Drizzle’s Neon driver** in the app runtime, and point it at your **Neon pooled connection URL**. Drizzle’s Neon docs say it has native support for Neon via `neon-http` and `neon-websockets`, and Neon’s docs say pooled connections run through PgBouncer and are the right choice for application traffic. citeturn334375search2turn334375search10turn334375search3turn764245search14

For **migrations**, use a **direct, non-pooled Neon URL**. Neon explicitly warns that pooled connections can cause migration errors and recommends a direct connection for migration workflows. citeturn764245search2turn334375search15turn764245search20

Use env vars like this:

```bash
# app runtime
DATABASE_URL=postgres://...-pooler....neon.tech/dbname?sslmode=require&channel_binding=require

# migrations / drizzle-kit
DATABASE_URL_DIRECT=postgres://....neon.tech/dbname?sslmode=require

NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...
```

And wire Drizzle like this:

```ts
// src/db/index.ts
import { drizzle } from "drizzle-orm/neon-http";

export const db = drizzle(process.env.DATABASE_URL!);
```

That matches Drizzle’s documented Neon connection path for app code. citeturn334375search10turn764245search5

For the actual bug-hunting loop, I would do this:

1. **Seed roles** in Clerk and save Playwright auth state for each role.
2. **Enumerate pages** from your nav, sitemap, and known route map.
3. Let an **agentic browser layer** explore each page and flow.
4. After each stable page load, run a short **gremlins.js** burst.
5. Record **console errors, unhandled exceptions, failed network calls, hydration issues, 4xx/5xxs, and broken assertions** as bugs.
6. Convert the trace into a **Playwright repro test**.
7. Open a GitHub issue and let **OpenHands** attempt a fix.
8. Use **Qodo Cover** to extend regression coverage around the changed code.
9. Resume the crawl from the remaining frontier. citeturn288820search0turn288820search12turn288820search1turn288820search2turn764245search3turn764245search18turn764245search1turn764245search10

Minimal repo shape:

```text
app/
  api/
    __test/
      reset/route.ts
      seed/route.ts
      health/route.ts
src/
  db/
    index.ts
    schema.ts
tests/
  e2e/
    smoke.spec.ts
    generated/
  chaos/
    gremlins.ts
  fixtures/
    auth/
playwright.config.ts
drizzle.config.ts
```

Two important notes:

- **Tailwind does not change the testing architecture.** What matters is adding stable selectors and good accessible names so Playwright and the agent can target UI reliably. Playwright recommends resilient locators based on user-facing attributes and explicit contracts. citeturn288820search8
- You will not get “every single bug.” You will get a strong continuous bug-finding system. The full autonomous “find bug, write repro, fix code, verify green, continue” loop still needs supervision, and OpenHands itself describes its resolver as primarily focused on one issue at a time. citeturn764245search3turn764245search18

If you want the highest-ROI starting point for this stack, build **Phase 1** as:

- **Playwright** for canonical tests
- **browser-use** for autonomous exploration
- **gremlins.js** for UI chaos
- **Schemathesis** for your route-handler/API surface
- **Drizzle + Neon pooled URL** at runtime
- **direct Neon URL** for migrations
- **OpenHands + Qodo Cover** only after a bug is confirmed citeturn288820search0turn288820search1turn288820search2turn288820search3turn334375search2turn764245search14turn764245search2turn764245search3turn764245search1

I can turn this into a concrete starter repo for your stack with `proxy.ts`, Drizzle config, Neon env setup, Playwright config, and the chaos runner.
