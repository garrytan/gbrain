---
title: "Turbopack Performance Issues"
type: note
created: 2026-02-03
updated: 2026-02-04
source: chatgpt-export
conversation_id: 69824c62-673c-832a-8779-c1b3ddb6ccfa
message_count: 2
tags: [chatgpt, import]
---
# Turbopack Performance Issues

> Conversation ID: 69824c62-673c-832a-8779-c1b3ddb6ccfa
> Created: 2026-02-03T19:28:34Z
> Updated: 2026-02-04T21:51:28Z
> Messages: 2

---

## User

turbopack extremely slow

---

## Assistant

If **Turbopack feels extremely slow** (especially in dev), that’s a known reality for many projects today — it isn’t just your setup:citeturn0search0turn0search2

### 🧠 Why Turbopack can be slow
**1. Cold start times are currently high**  
Turbopack does *incremental builds and lazy bundling*, but it **doesn’t yet persist cache to disk** by default. That means every fresh start re-computes much of the graph from scratch, making initial page loads slow (~10–25+ s).citeturn0search2

**2. Large or complex apps exacerbate it**  
Apps with many modules/routes make Turbopack’s current architecture take longer to traverse and bundle than simpler projects. This is especially noticeable on first navigation or fresh starts.citeturn0search0

**3. Memory use and disk caching**  
Turbopack often uses a lot of RAM to keep incremental caches in memory *but* lacks persistent on-disk caching — so stopping the dev server loses that state. This means repeated restarts each feel like a cold start.citeturn0search2

**4. Compared to alternatives**  
Real-world measurements show Turbopack is often **slower than other dev tools like Vite/Rollup** for things like page navigation or cold start, though it can beat Webpack in some scenarios.citeturn0search5

### 🛠 What you can do right now
**Optimize your local experience**
- Keep components/pages small — smaller scopes are cheaper to rebuild.
- Avoid unnecessarily large bundles during dev navigation.
- Ensure your machine has sufficient RAM — Turbopack caches in memory.

**Try a more current release**
The team is actively improving performance; using the latest canary builds *may help* with cold start improvements.

**If it’s just dev frustration**
Some teams switch to **Vite/RSPack** or custom tooling for extremely snappy reloads.

**If you need predictably fast cold starts**
Wait or use a setup/toolchain with persistent disk caching — Turbopack is working toward this but doesn’t have it widely yet.citeturn0search2

---

If you want actionable steps specific to your project (e.g., Next.js version, router structure), share your config and we can tune it.
