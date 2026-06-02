---
title: "Webpack Dev Performance Issue"
type: note
created: 2026-03-10
updated: 2026-03-10
source: chatgpt-export
conversation_id: 69b0a677-8f50-8329-a638-471e4aa24566
message_count: 4
tags: [chatgpt, import]
---
# Webpack Dev Performance Issue

> Conversation ID: 69b0a677-8f50-8329-a638-471e4aa24566
> Created: 2026-03-10T23:17:48Z
> Updated: 2026-03-10T23:34:33Z
> Messages: 4

---

## User

Codex right now is working on EDE testing, and it does our basic EDE test, which just kind of runs through the main like four or five screens in our dashboard, and you know, logs in and goes through those screens, and it does it headless. It's saying that one pass of that takes roughly 20 minutes under Webpack dev. One, is that, does that sound right, or is that an indication that something is wrong?

---

## Assistant

Mr. White, that sounds too slow. Webpack’s dev server is explicitly a development-only tool, and webpack notes that devtool/source-map choice, extra optimization steps, and general build configuration can materially affect incremental rebuild speed in development. Some slowdown under webpack dev is expected. Twenty minutes for a headless smoke path over 4–5 screens still reads as a red flag rather than normal overhead. That last sentence is an engineering inference, not an official benchmark. citeturn463011view0turn117959view0turn483853view1turn483853view2

The usual causes are straightforward: the app is recompiling more than you think, the dev bundle is heavy or using slow loaders/plugins, login or API calls are slow, or the test code is adding avoidable waits. Webpack’s performance guide specifically calls out minimizing loaders/plugins, keeping compilations small, using cache, and avoiding production-only tooling in development. Cypress also recommends programmatic login and avoiding unnecessary waiting, and Playwright already auto-waits on locators, so very long runs often mean accumulated waits, retries, or slow app behavior rather than the headless browser itself. citeturn120171view4turn120171view5turn483853view2turn483853view4turn483853view6

The fastest sanity check is to time three segments separately: initial compile/startup, login, and each screen transition. Then run the exact same flow once against a production-like build. If the runtime collapses there, webpack dev is the main culprit. If it stays slow, the bottleneck is mostly app/backend/test logic. If you are using Playwright, also inspect custom timeouts, retries, and serial mode, because those can multiply runtime quickly. citeturn463011view0turn483853view3turn483853view5turn935581view0

My direct answer: I would treat 20 minutes as an indication that something is wrong or at least badly tuned.

---

## User

Can we use TurboPack for our EC testing? Is that faster?

---

## Assistant

Mr. White, yes—**if this is a Next.js app**, Turbopack is the first thing I would try for E2E testing backed by a dev server. Next.js says Turbopack is now the default bundler and is intended to provide a much faster local development experience than webpack. The local dev guide also explicitly recommends updating Next.js and using Turbopack because it provides significant performance improvements over webpack in development. citeturn319675view0turn319675view1

The important qualifier is **dev server vs production server**. `next dev` and `next build`/`next start` behave differently: dev compiles routes as you open or navigate to them, while production applies a different build pipeline and optimizations. For E2E tests, that means Turbopack can make **dev-backed** test runs faster, but the cleanest CI signal usually comes from running the suite against a production build instead of any dev server. That recommendation is an engineering judgment based on the documented dev/prod differences. citeturn319675view1

There are a few reasons Turbopack might **not** be a drop-in win. Next.js documents several webpack compatibility gaps: `webpack()` config in `next.config.js` is not recognized by Turbopack, webpack plugins are not supported, custom Sass functions are not supported, and there are some other unsupported features and behavior differences. If your app depends on those, you may need to stay on webpack or adjust config first. citeturn478904view1turn478904view4

For your specific case, my recommendation is:
1. Run the same smoke test once on **`next dev` with Turbopack** and once on **production** (`next build && next start`).
2. Compare total runtime and split out startup, login, and each screen transition.
3. If Turbopack cuts the 20-minute run materially, webpack dev was part of the problem.
4. If production is still slow, the bottleneck is in the app, backend, or test code rather than the bundler. citeturn319675view1turn319675view0

One more detail: Next.js also notes that Turbopack’s filesystem cache can speed up subsequent dev sessions and warm builds, and for fair webpack-vs-Turbopack comparisons you should either clear `.next` for cold runs or compare both in a warm-cache state. citeturn319675view5turn478904view1

My direct answer: **yes, Turbopack is likely faster for your dev-backed E2E testing if you’re on Next.js, and it is worth trying immediately.** For your main regression suite, I would still favor **testing against production**.
