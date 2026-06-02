---
conversation_id: 68ae6350-2d6c-8330-8d72-f5ec5d2a4065
created: 2025-08-27
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 4
source: chatgpt-export
tags:
- chatgpt
- import
title: GitHub Actions setup
type: note
updated: 2025-08-27
---

# GitHub Actions setup

> Conversation ID: 68ae6350-2d6c-8330-8d72-f5ec5d2a4065
> Created: 2025-08-27T01:45:53Z
> Updated: 2025-08-27T02:00:09Z
> Messages: 4

---

## User

For our setup with jovie if we have neon and drizzle and neon is connected via vercel marketplace connection and GitHub intergration. Of we need any env keys in the GitHub Actions setup?

---

## Assistant

Good question.  

If you connect **Neon via the Vercel Marketplace** and also enable the **GitHub integration**, then:

- **Vercel → Neon**: Vercel manages the Postgres connection string automatically. In your Vercel project, the `DATABASE_URL` (Neon connection string) is injected as an environment variable at build/runtime. You don’t need to hard-code it in your repo.  
- **GitHub Actions CI**: Actions run in GitHub’s environment, not Vercel’s. That means if your CI workflow runs tests or Drizzle migrations that touch the database, you’ll need a `DATABASE_URL` (or equivalent Neon connection string) present in GitHub Action secrets. Otherwise, the jobs won’t know how to connect.  

### So the rule of thumb:
- **App deployed via Vercel**: no need to configure env manually in GitHub, Vercel handles it.  
- **CI/CD via GitHub Actions (lint, test, drizzle migrations, e2e)**: yes, you’ll need to add at least `DATABASE_URL` (Neon connection string) into GitHub Actions secrets.  

Optional extras:  
- If you’re using Clerk, Supabase, or other external services, their API keys also need to be present in GitHub Action secrets if your CI tests reference them.  
- Drizzle specifically: if you run `drizzle-kit push` or migrations inside CI, it requires `DATABASE_URL`.  

👉 In short:  
**Yes — put your Neon `DATABASE_URL` (and any other runtime keys used in tests/builds) into GitHub Action secrets.** Vercel marketplace connection doesn’t automatically sync envs into GitHub Actions.  

Do you want me to sketch out a minimal GitHub Actions snippet that sets this up cleanly for Jovie (with Drizzle + Neon)?

---

## User

Should our "default" in neon be our preview branch (our default in github) or our production branch

---

## Assistant

Mr. White, set **Neon’s _default_ branch to production (main)**, not preview.

**Why**
- The “default” in Neon is the base for branch clones, roles, and tooling. Keeping it on **prod** prevents accidental preview/dev state from propagating.
- Vercel and CI can target **specific Neon branches** via `DATABASE_URL`; they don’t need Neon’s default to be preview.

**Recommended setup**
- **Neon**
  - `main` = **production** (default branch)
  - `preview` = preview DB branch (or create per-PR branches if you like)
  - (Optional) `dev` = local/dev branch
- **Vercel envs → Neon branches**
  - **Production** env → `DATABASE_URL` points to `main`
  - **Preview** env → `DATABASE_URL` points to `preview` (or the per-PR branch)
  - **Development** env → `DATABASE_URL` points to `dev` (or a local Neon branch)
- **Migrations (Drizzle)**
  - Run on `preview` in CI for PRs.
  - On merge to `main`, run on `main` (prod). If you branch-per-PR, delete the temp branch after deploy.

**Net:** Keep Neon’s default = **prod** and route each Vercel/CI context to the correct Neon branch via env vars.
