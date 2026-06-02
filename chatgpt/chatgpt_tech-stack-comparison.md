---
title: "Tech stack comparison"
type: note
created: 2025-07-21
updated: 2025-07-21
source: chatgpt-export
conversation_id: 687ed1d2-c650-8326-b59f-cd0450337014
message_count: 2
tags: [chatgpt, import]
---
# Tech stack comparison

> Conversation ID: 687ed1d2-c650-8326-b59f-cd0450337014
> Created: 2025-07-21T23:48:35Z
> Updated: 2025-07-21T23:49:30Z
> Messages: 2

---

## User

Large scale app that needs multiple native iOS apps and web apps. Eventually an android app. And integrations from 3rd parties. And a public api.

laravel for the back end? Or supasbase and edge functions? Or something else?

---

## Assistant

**TL;DR**

| Pick Laravel 11 | Pick Supabase + Edge Fns | When to add “something else” |
|---|---|---|
| • Need a **full-stack, opinionated MVC** with Eloquent, queues, scheduled jobs, websockets (Reverb) and first-class auth/ACL.  | • Want a **serverless Postgres-first** stack with instant REST/GraphQL, built-in auth, storage, realtime, and global edge functions. | • CPU-heavy streaming / ML tasks → **Go/Rust micro-service** behind a queue.<br>• Ultra-low-latency chat / gaming → **Elixir/Phoenix or LiveKit**.<br>• Enterprise analytics → pin a **separate ClickHouse or BigQuery** pipeline. |
| • Team already knows PHP or the wider Laravel ecosystem (Nova, Vapor, Telescope). | • You’d rather write TypeScript end-to-end and keep infra-ops close to zero. |
| • Complex, multi-tenant business rules that don’t fit easily in RLS policies. | • Need **instant prototypes** for multiple iOS/Web clients with minimal backend code. |
| • Long-running jobs, cron, video processing – Octane/Horizon handle it cleanly. | • Mostly CRUD + realtime; edge functions scale to the region nearest each client. |
| • Want **absolute control** over spending, infra, and vendor lock-in. | • Comfortable paying for convenience & accepting some lock-in to move fast. |

---

### What the facts say

* **Laravel 11**  
  * Ships **Reverb** for WebSockets with horizontal scaling via Redis pub/sub. citeturn0search0  
  * Streamlined app structure, health-check endpoints, and rate-limiting baked in. citeturn0search6  
  * Runs anywhere PHP does; Octane or Vapor give you serverless-ish elasticity.

* **Supabase 2025**  
  * Auto-generates a REST and GraphQL API from your Postgres schema the moment you create a table. citeturn0search2  
  * **Edge Functions** (Deno/TS) now default to the region closest to each user; you can pin them to the DB region for heavy DB work. citeturn0search1  
  * Built-in auth, row-level-security, storage, realtime channels, dashboards—no boilerplate. citeturn0search7  

* **Scalability trade-offs**  
  * Laravel: you manage DB replicas, queues, cache clusters—more ops, more control.  
  * Supabase: autoscaling Postgres and functions handled for you, but cold-starts and quota ceilings kick in if you hammer it with background jobs.

---

### Decision shortcuts

1. **Speed to MVP > everything?**—Supabase. You'll have iOS/web clients hitting the DB in hours, not weeks.  
2. **Custom business logic, heavy workloads, or strict compliance?**—Laravel (or NestJS / Django if your team’s stronger in TS/Python).  
3. **Hybrid path (common at YC-scale)**—ship v1 on Supabase; carve out high-CPU or compliance-sensitive modules into Laravel/Go services behind an API gateway as traffic grows.

---

### Public API & multi-client support

* Both expose REST easily; Supabase also gives GraphQL for free.  
* If you need **rate-limited, key-based** public access, stick an **Envoy/Kong** gateway in front either way.  
* Shared auth tokens across iOS, Android, and web: use JWT (Laravel Sanctum) or Supabase’s baked-in JWT.

---

### Bottom line

- **Small team, need to move insanely fast, mostly CRUD + realtime → Supabase.**  
- **Larger codebase, complex domain logic, desire to own the metal long-term → Laravel.**  
- **Expect hyper-growth?** Start Supabase, budget time to break out hot paths into standalone micro-services when RPS or vendor limits bite.

Either route can scale to millions if engineered sensibly—you’re choosing your **ops burden vs. velocity** slider.
