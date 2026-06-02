---
title: "AI Chaos Testing Tools"
type: guide
created: 2026-04-08
updated: 2026-04-08
source: chatgpt-export
topic: coding-general
message_count: 7
tags: [chatgpt, knowledge, coding-general]
---
**Topic:** [[chatgpt-knowledge/_topics/coding-general]]

# AI Chaos Testing Tools

> **Source:** ChatGPT conversation
> **Date:** 2026-04-08T17:37:24Z
> **Messages:** 7
> **Topic:** coding-general

## Question

are there any tools on github or anythng that are like optimized ai chaos testing. like something i can unleash on my codebase and just have it loop through every single features, mode, menu, page, view, etc and try to break it til it surfaces every signle bug. crete a tst that would find said bug, then loop til that test is green then continue etc.

## Answer

I’m checking current GitHub and commercial options across autonomous UI testing, API fuzzing, and chaos-style failure injection. If your stack matters, say web, mobile, desktop, or backend and I’ll bias the list.

## Answer

The landscape is fragmented. There are real tools for autonomous browser exploration, API fuzzing, and infra chaos, but I have not found a mature one-stop system that reliably explores an entire product, writes minimal repro tests for each bug, fixes code until green, and then resumes coverage.

## Answer

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
- **OpenHands resolver**: can attempt to resolve repo issues automatically and open PRs, including via GitHub Action workflows. This gets you closest to the “once a bug is captured, try to fix it” part. citeturn529082search3turn529082search11turn529082

*(Answer truncated — 6834 chars total)*

## Question

next.js and clerk tailwind drizzle neon pooled connection url. 

## Answer

I’m narrowing this to your exact stack and checking the current official docs for Clerk, Next.js, Drizzle, and Neon pooling so the recommendations match current integration patterns.

## Answer

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
9. Resume the crawl from the remaining frontier. ci

*(Answer truncated — 4805 chars total)*
