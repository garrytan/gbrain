---
conversation_id: 688fc830-f324-832d-a6c6-6938aa0c481e
created: 2025-08-03
links:
- '[[chatgpt-clusters/coding_devops]]'
message_count: 2
source: chatgpt-export
tags:
- chatgpt
- import
- code
title: Supabase migration GitHub workflow
type: note
updated: 2025-08-03
---

# Supabase migration GitHub workflow

**Related:** [[coding_devops]]

> Conversation ID: 688fc830-f324-832d-a6c6-6938aa0c481e
> Created: 2025-08-03T20:36:01Z
> Updated: 2025-08-03T20:36:28Z
> Messages: 2

---

## User

For SuperBase, do we need to include a migration step in RCI on GitHub Workflows, or does SuperBase automatically pick up those migration files, or how does this work?

---

## Assistant

Mr. White:

**Short answer:** Supabase won’t auto‑apply your repo’s migrations to your prod/staging DB just because you push to GitHub—unless you enable Supabase’s GitHub “Preview Branch” integration. Otherwise, add an explicit migration step in your GitHub Actions.

**Two options**

1) **Supabase Preview Branches (per‑PR envs):**  
If you connect your repo in the Supabase Dashboard and use Preview Branches, the SQL files under `supabase/migrations/` are **automatically run** for that preview environment. No extra CI step needed for previews. citeturn0search15

2) **Your own CI for staging/prod:**  
Create a workflow step that authenticates the Supabase CLI and **applies migrations** to the linked project. Current docs recommend `supabase db push` to deploy local migrations to the remote project. citeturn0search7turn0search2

**Minimal GitHub Actions example**
```yaml
name: Deploy Supabase Migrations
on:
  push:
    branches: [main] # or your release branch
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: supabase/setup-cli@v1
      - run: supabase link --project-ref ${{ secrets.SUPABASE_PROJECT_REF }}
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
      - run: supabase db push
        env:
          SUPABASE_ACCESS_TOKEN: ${{ secrets.SUPABASE_ACCESS_TOKEN }}
```
This links to your project and applies any new SQL in `supabase/migrations/` to your remote DB. citeturn0search4turn0search7

**Bottom line:**  
- **Previews:** auto‑run if you enable Supabase’s GitHub integration. citeturn0search15  
- **Staging/Prod:** add a **migration step** in your workflow. citeturn0search2turn0search7


**Topic:** [[chatgpt-clusters/coding_devops]]
