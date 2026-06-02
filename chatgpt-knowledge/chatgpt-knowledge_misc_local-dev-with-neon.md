---
title: "Local dev with Neon"
type: guide
created: 2025-08-30
updated: 2025-08-30
source: chatgpt-export
topic: misc
message_count: 6
tags: [chatgpt, knowledge, misc]
---
**Topic:** [[chatgpt-knowledge/_topics/misc]]

# Local dev with Neon

> **Source:** ChatGPT conversation
> **Date:** 2025-08-30T21:37:36Z
> **Messages:** 6
> **Topic:** misc

## Question

We've got NEON and the GitHub integration and it's creating new DBs for each branch. Question is, how do we handle it on local development? I do have the NEON CLI, but how do I, am I supposed to put DB credentials in my ENV file locally, or how does this work, and how do I, or do I just, you know, we have a long-lived main.db, our production DB, and then we have our long-lived preview DB that is a child of it, and then those are the only two long-lived branches and the rest are being created and killed by GitHub Action CI with the NEON integration. How am I supposed to go about local development? Do I just connect it to the preview DB? Or is there, like, a better way to do this?

## Answer

Mr. White — short version:

**Don’t dev on the shared preview DB.** Best practice is **per-dev, per-feature Neon branches** that fork from `preview` (or `main` if you need prod-clean data). Keep only `main` and `preview` long-lived; everything else is ephemeral.

### How to work locally (recommended)
1. **Create a Neon branch for your git branch**
   ```bash
   # from your repo root on feature branch
   neon branches create my-feature --parent preview
   neon connection string my-feature  # grab postgres://... URL
   ```
2. **Put creds in a local, untracked env file**
   - `.env.local` (or `.env.development.local`)  
     ```
     DATABASE_URL=postgres://...
     # if your migrator needs it (e.g., Drizzle):
     SHADOW_DATABASE_URL=postgres://...  # can be same branch or a temp "shadow" branch
     ```
   - Never commit these. Commit only `.env.example` with placeholders.

3. **Migrate + seed**
   ```bash
   pnpm db:migrate   # your drizzle/knex/prisma migrate
   pnpm db:seed      # if you keep seed data
   ```

4. **Run app against that branch**  
   Your app reads `DATABASE_URL` → you’re isolated from teammates and CI.

5. **Clean up**
   ```bash
   neon branches delete my-feature
   ```
   (Do this when the PR closes/merges; you can also wire a GH Action to auto-delete.)

### Why not just use `preview` locally?
- You’ll step on each other’s schema/data.
- Test data pollutes preview deploys.
- Risky migrations if you forget `--dry-run`.

### CI alignment
- Keep GH integration creating per-PR Neon branches from `preview`.
- Locally you mirror that idea manually (or automate via a git hook):
  - On `git switch -c foo`, run `neon branches create foo --parent preview` and write the URL into `.env.local`.

### A note on migrations (Drizzle/Prisma/etc.)
- Use a **shadow DB/branch** for safe diffing:
  - Create a tiny Neon branch (or DB) just for the migrator’s shadow URL.
  - Example:
    ```bash
    neon branches create shadow-<yourname> --parent preview
    # set SHADOW_DATABASE_URL to that; reuse it across features
    ```
- Always run migrations on your feature branch first; CI later runs them on the PR branch; `preview` and `main` only get migrations via your pipeline.

### Credentials & pooling
- Neon URLs are safe to keep in local env files. Don’t commit them.
- If you use Neon’s pooled endpoint (PgBouncer), use it for the app; use the direct (non-pooled) URL for migration tools if required by your ORM.

### Offline option (optional)
- If you truly need offline dev: run local Postgres in Docker and map `DATABASE_URL` to it. But you’ll drift from prod defaults; Neon branches keep you production-like.

### TL;DR
- Long-lived: `main` + `preview`.  
- Local: **create your own Neon branch → put URL in `.env.local` → migrate → build → delete when done.**

## Question

And then, can I pull credentials on that, the DB URL, can I pull that through the CLI?

## Answer

Yes — the **Neon CLI can output connection strings (DB URLs)** for any branch or database you’ve created.  

Typical commands:

```bash
# List branches
neon branches list

# Get connection string for a specific branch
neon connection string my-feature
```

That will print the full `postgres://...` URL you can drop into your `.env.local`.  

If you want just the pooled connection URL (PgBouncer) or a direct connection, you can specify:

```bash
# pooled (for app runtime)
neon connection string my-feature --pooler

# direct (for migrations/ORMs)
neon connection string my-feature --no-pooler
```

And if you need just credentials in JSON for scripting:

```bash
neon connection info my-feature --json
```

From there you can `jq` out `database`, `user`, `password`, `host`, etc., and script injecting them into your local `.env.local`.  

👉 Best practice: create a short script or npm/pnpm task that runs `neon connection string $(git rev-parse --abbrev-ref HEAD)` and writes it to `.env.local` automatically when you switch branches.  

Do you want me to sketch you a simple bash/zsh script that auto-writes `.env.local` with the Neon DB URL for your current git branch?

## Question

Great, so can you add instructions to my Claude.md file for handling that? Because I don't want to have to do that manually every time. So when I use WinSurf on my local machine and I'm using Claude code in the CLI or Cascade, I'd like it to just do this.

## Answer

Done, Mr. White. I added a new section to **CLAUDE.md** with precise agent instructions for **automatic Neon branch creation** and **`.env.local` population** when you’re in Windsurf/Claude/Cascade. It includes:

- The policy (no dev on `preview`).
- Exact CLI commands (`neon branches create …`, `neon connection string …`).
- A reference script showing how to:
  - Mirror the current git branch in Neon,
  - Create a `-shadow` branch,
  - Write `DATABASE_URL` and `SHADOW_DATABASE_URL` into `.env.local` while preserving other keys.
- An optional `post-checkout` git hook snippet.
- Cleanup guidance and clarifications for pooled vs direct URLs.

If you want, I can also drop a ready-to-use `scripts/neon-sync-env.sh` into your repo and wire a Husky hook.
