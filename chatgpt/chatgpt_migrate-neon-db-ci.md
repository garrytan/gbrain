---
title: "Migrate Neon DB CI"
type: note
created: 2025-12-05
updated: 2025-12-06
source: chatgpt-export
conversation_id: 693351ab-14c0-8329-899b-3cd5ff4c6e2f
message_count: 2
tags: [chatgpt, import, code]
---
# Migrate Neon DB CI

> Conversation ID: 693351ab-14c0-8329-899b-3cd5ff4c6e2f
> Created: 2025-12-05T21:42:03Z
> Updated: 2025-12-06T20:03:19Z
> Messages: 2

---

## User

drizzle neon migrate db from ci

---

## Assistant

Mr. White, here’s the clean way to **run Drizzle migrations against a Neon Postgres database from CI (GitHub Actions / similar)**.

---

# ✔️ High-Level Flow
1. CI job installs dependencies
2. CI job sets `DATABASE_URL` pointing to Neon
3. Run:  
   ```
   drizzle-kit migrate --config=drizzle.config.ts
   ```
4. Done — Neon applies migrations.

---

# ✔️ Neon Setup
In Neon dashboard:

**Create a database + user**, then copy the connection string:

```
DATABASE_URL=postgres://<user>:<pass>@<host>/<dbname>?sslmode=require
```

> Use `?sslmode=require` or Drizzle will complain in CI.

Store this in CI secrets.

---

# ✔️ Drizzle Config (drizzle.config.ts)

Make sure your config references env:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

---

# ✔️ Migration Script (package.json)

```json
{
  "scripts": {
    "migrate": "drizzle-kit migrate"
  }
}
```

or if you use `drizzle-orm` CLI:

```json
{
  "scripts": {
    "migrate": "drizzle migrate"
  }
}
```

---

# ✔️ GitHub Actions (CI)

```yaml
name: Migrate DB

on:
  workflow_dispatch:
  push:
    branches: [ main ]

jobs:
  migrate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - run: npm ci

      - run: npm run migrate
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
```

---

# ⚠️ Important CI Notes
- **Never use Neon admin key** — create a dedicated migration user.
- **Migrations must be idempotent** (Drizzle handles this).
- **If using branching in Neon**, point CI at your production branch.

---

# ⭐ Want safer deployments?
Use a dedicated *deployment branch* in Neon:

1. CI deploys app
2. CI migrates against Neon `main`
3. Neon instantly branches if rollback is needed

---

If you want, I can give you:
- **rollback strategy**
- **Neon branching best practices for blue-green**
- **How to run migrations only on tag releases instead of every push**

Just tell me which direction you want.


## See Also
- [[chatgpt/chatgpt_clerk-auth-vs-neon-auth]]
- [[chatgpt/chatgpt_cold-starts-neon-vercel]]
- [[chatgpt/chatgpt_cold-starts-on-neon-part1]]
- [[chatgpt/chatgpt_cold-starts-on-neon-part2]]
- [[chatgpt/chatgpt_delete-neon-preview-branches]]
