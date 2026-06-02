---
title: "Test Turborepo Locally"
type: guide
created: 2026-01-03
updated: 2026-01-03
source: chatgpt-export
conversation_id: 6959689b-419c-8328-af1e-91cefbffd514
message_count: 4
tags: [chatgpt, import, code, long-form]
---
# Test Turborepo Locally

> Conversation ID: 6959689b-419c-8328-af1e-91cefbffd514
> Created: 2026-01-03T19:06:23Z
> Updated: 2026-01-03T19:09:37Z
> Messages: 4

---

## User

Turbo repo local server with Doppler. How do I properly test locally

---

## Assistant

Mr. White — the “right” way to test a Turborepo locally with Doppler is to **inject secrets at runtime** (so you’re testing with realistic env vars) and to **separate configs** (dev vs test vs staging) so your tests don’t accidentally hit prod.

## 1) Set up Doppler per app (best for monorepos)
In each runnable app folder (e.g. `apps/web`, `apps/api`), run Doppler setup once so the CLI knows which project+config to use. Doppler supports keeping a `doppler.yaml` in each app directory so you don’t have to re-run setup every time. citeturn0search4

Typical flow:
- `doppler login`
- `cd apps/web && doppler setup`
- `cd apps/api && doppler setup`

Now when you `cd` into that app later, Doppler is already mapped.

## 2) Run Turbo through Doppler (inject env vars into *everything*)
From the repo root, wrap your Turbo command:

```bash
doppler run -- turbo run dev
```

`doppler run` injects secrets as environment variables into the process it launches. citeturn0search0  
This is the cleanest way to ensure **every service started by Turbo** inherits the right env.

### If each app has its own Doppler config
Running from the root can be tricky because Doppler uses the “current directory” config. Two common patterns:

**Pattern A (simple): run per app**
```bash
cd apps/web && doppler run -- pnpm dev
cd apps/api && doppler run -- pnpm dev
```

**Pattern B (one command): make Turbo tasks call Doppler**
In each app’s `package.json`:
```json
{
  "scripts": {
    "dev:secrets": "doppler run -- pnpm dev",
    "test:secrets": "doppler run -- pnpm test"
  }
}
```
Then:
```bash
turbo run dev:secrets
turbo run test:secrets
```
This avoids “root Doppler config vs app Doppler config” confusion.

## 3) Use a real “test” config for automated tests
Create a Doppler config like `test` (separate from `dev`) and point your test runs at it:

```bash
doppler run --config test -- turbo run test
```

Doppler supports selecting configs on the CLI like this. citeturn0search19

What to put in `test` config:
- test DB URL / schema
- fake API keys
- local endpoints (or mocks)
- feature flags set for deterministic behavior

## 4) Verify what your app *actually sees*
Quick sanity checks:
- Print the vars you expect in your app startup (not secrets themselves, just “present/missing”)
- Confirm your process is receiving vars by running:
  ```bash
  doppler run -- printenv | grep SOME_KEY
  ```
- For Node apps, add a tiny “env doctor” script that asserts required vars exist at boot and fails fast.

## 5) When you *must* generate a `.env` file (framework/tooling requirement)
Prefer runtime injection, but if something requires a file, use Doppler to download **into a git-ignored file** (e.g. `.env.local`) and never commit it. (Doppler documents multiple CLI modes; `run` is the primary runtime approach. citeturn0search0)

---

If you tell me your stack (Next.js? Nest? Prisma? Docker compose?), and whether **each app uses a different Doppler project/config** or they share one, I’ll give you the exact `package.json` scripts + a clean Turbo task layout for `dev`, `test`, and “integration-test”.

---

## User

Next.js with drizzle and neon

---

## Assistant

Mr. White — for **Next.js + Drizzle + Neon**, “proper local testing” usually means:

1) your app and your **Drizzle migrations** both run with the *same* env vars (via Doppler), and  
2) tests run against an **isolated Neon branch** (so you can reset freely without nuking dev data).

Below is a clean setup that works well.

## 1) Put *all* DB config behind `DATABASE_URL`
Drizzle’s Neon tutorials assume `DATABASE_URL` (in `.env` / `.env.local`). With Doppler, you still keep the **same variable name**, just injected at runtime. citeturn0search2turn0search10

In Doppler create configs like:
- `dev` → points to a Neon **dev branch**
- `test` → points to a Neon **test branch** (or an ephemeral branch per run)

## 2) Always wrap Next + drizzle-kit with `doppler run`
This avoids the classic “Next sees env but drizzle-kit doesn’t” problem.

**package.json**
```json
{
  "scripts": {
    "dev": "doppler run -- next dev",
    "build": "doppler run -- next build",
    "start": "doppler run -- next start",

    "db:push": "doppler run -- drizzle-kit push",
    "db:migrate": "doppler run -- drizzle-kit migrate",
    "db:studio": "doppler run -- drizzle-kit studio",

    "test": "doppler run --config test -- vitest run"
  }
}
```

Doppler’s CLI is designed to execute a command with secrets injected into that process environment. citeturn0search4turn0search20

### If you’re in a Turborepo
Make Turbo call these scripts (so env injection happens *inside* each task), instead of trying to do one `doppler run -- turbo ...` from the repo root.

Example `turbo.json` idea:
- `dev` runs each package’s `dev`
- `test` runs each package’s `test`

## 3) The best “local test DB” with Neon: branches
Neon’s branching is built for exactly this: testing schema changes / destructive queries safely. citeturn0search3turn0search15

Two good patterns:

### Pattern A: Stable `test` branch (simple)
- Create a Neon branch called `test`
- Doppler config `test` uses that branch’s connection string
- Your test runner can run migrations then tests

Example flow:
```bash
pnpm db:migrate   # uses dev
pnpm test         # uses --config test
```

### Pattern B: Ephemeral branch per test run (most “correct”)
- Create a fresh branch off `dev` (or `main`) before tests
- Run migrations on it
- Run tests
- Delete the branch

Neon explicitly supports branching for testing workflows (CLI/API/GitHub Actions). citeturn0search3

## 4) Next.js + Neon connection gotchas (so tests aren’t flaky)
- If you’re using the **Neon pooled connection string** vs direct: keep it consistent across dev/test (whichever you chose).
- In serverless-style execution (route handlers, server actions), make sure you’re not creating a brand-new client per request in a way that explodes connections. (This is especially important for parallel tests.)

Neon’s Next.js guide covers standard connection setup patterns and storing credentials in env. citeturn0search1

## 5) One quick sanity check: confirm *both* runtime and migrations see the same DB
Run:
```bash
doppler run -- node -e "console.log(!!process.env.DATABASE_URL)"
doppler run -- drizzle-kit status
```
If either fails, your local tests will be lying to you.

---

If you tell me:
1) are you running Next in **node runtime** or **edge** anywhere, and  
2) are you using `pg`, `postgres` (postgres.js), or `@neondatabase/serverless` under Drizzle?

…I’ll give you the exact Drizzle client snippet + the “least flaky” test setup for that runtime.


## See Also
- [[chatgpt/chatgpt_e2e-smoke-test-locally]]
- [[chatgpt/chatgpt_electron-app-turborepo-setup]]
- [[chatgpt/chatgpt_explain-turborepo]]
- [[chatgpt/chatgpt_turborepo-changelog]]
- [[chatgpt/chatgpt_turborepo-env-setup]]
