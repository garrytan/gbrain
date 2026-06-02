---
title: "Sync preview with production"
type: essay
created: 2025-09-01
updated: 2025-09-01
source: chatgpt-export
conversation_id: 68b5d51c-01c4-8332-950a-66ce796b3bd6
message_count: 32
tags: [chatgpt, import, code, long-form]
---
# Sync preview with production

> Conversation ID: 68b5d51c-01c4-8332-950a-66ce796b3bd6
> Created: 2025-09-01T17:17:16Z
> Updated: 2025-09-01T18:08:42Z
> Messages: 32


Okay for our CI, I mean for our whole workflow currently we have a long-lived NEON branch for production. We have a child of it called Preview that matches our staging environment that is also long-lived, and then everything else we're allowing NEON branches to just branch and whatnot. Should there be something in our CI that resets our staging branch against production every time something is auto-deployed to production or at some other interval? How should we go about doing that?


Mr. White — short answer: yes. Treat `preview` as a *fresh child of `production`* after every auto-promotion to `production`. The cleanest way is to **recreate the `preview` branch from `production` and reattach the stable preview endpoint**. That guarantees schema + data stay in lock-step without drift.

# What to do (every prod promotion)
1. **Freeze writes** to preview during the flip (60–120s deploy window).
2. **Create a new Neon branch** from `production` at “now”.
3. **Reattach the stable preview endpoint** to that new branch (keeps the URL stable for Vercel).
4. **Run migrations** (should be no-ops if prod already migrated).
5. **Seed preview-only fixtures** (synthetic users, demo content).
6. **Smoke tests**, then unfreeze.

# Why this over “reset in place”?
- Guarantees no drift (schema or data).
- Keeps preview URL stable (endpoint reassignment) so you don’t touch Vercel env.
- Fast in Neon (copy-on-write).

# CI wiring (GitHub Actions)
Trigger this workflow **after** the “promote preview → production” job succeeds.

**Workflow name:** `sync-preview-db-on-prod-promotion`

```yaml
name: sync-preview-db-on-prod-promotion
on:
  workflow_run:
    workflows: ["promote-preview-to-production"]
    types: [completed]

jobs:
  sync-preview-db:
    if: ${{ github.event.workflow_run.conclusion == 'success' }}
    runs-on: ubuntu-latest
    env:
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      NEON_PROJECT_ID: ${{ secrets.NEON_PROJECT_ID }}
      PREVIEW_ENDPOINT_ID: ${{ secrets.NEON_PREVIEW_ENDPOINT_ID }} # stable endpoint
      PREVIEW_BRANCH_NAME: preview
      PROD_BRANCH_NAME: production
      DATABASE_URL_PREVIEW: ${{ secrets.DATABASE_URL_PREVIEW }}     # points at PREVIEW_ENDPOINT_ID
    steps:
      - name: Install neonctl
        run: npm i -g neonctl

      - name: Create fresh preview branch from production
        id: mkbranch
        run: |
          NEW_BRANCH_JSON=$(neonctl branches create \
            --project-id "$NEON_PROJECT_ID" \
            --name "${PREVIEW_BRANCH_NAME}-$(date +%Y%m%d%H%M%S)" \
            --parent "$PROD_BRANCH_NAME" \
            --format json)
          echo "NEW_BRANCH_ID=$(echo "$NEW_BRANCH_JSON" | jq -r '.branch.id')" >> $GITHUB_OUTPUT
          echo "NEW_BRANCH_NAME=$(echo "$NEW_BRANCH_JSON" | jq -r '.branch.name')" >> $GITHUB_OUTPUT

      - name: Reattach preview endpoint to new branch (URL stays the same)
        run: |
          neonctl endpoints update "$PREVIEW_ENDPOINT_ID" \
            --project-id "$NEON_PROJECT_ID" \
            --branch-id "${{ steps.mkbranch.outputs.NEW_BRANCH_ID }}"

      - name: Run migrations against preview
        run: |
          pnpm i
          pnpm drizzle:check
          pnpm drizzle:push # should be no-ops since prod already migrated
        env:
          DATABASE_URL: ${{ env.DATABASE_URL_PREVIEW }}

      - name: Seed preview-only fixtures (idempotent)
        run: pnpm seed:preview
        env:
          DATABASE_URL: ${{ env.DATABASE_URL_PREVIEW }}

      - name: Preview smoke tests
        run: pnpm test:e2e:smoke
```

# Guardrails
- **Kill-switch:** skip if incident flag is on or if last 60m error budget breached (you already have this pattern in CLAUDE.md).
- **Branch hygiene:** keep `preview` *endpoint* stable; do **not** keep `preview` as a long-lived branch object. Recreate branch; reattach endpoint.
- **Audit:** log the production LSN/timestamp you branched from (store in PostHog or a deploy table).
- **Data minimization:** if you need less data in preview, run a quick **truncate/anonymize** step *after* the branch/reattach (faster than subset cloning).
- **Cron fallback:** if you also want periodic hard refresh, add a weekly run of the same job on a schedule.

# TL;DR policy to add
> On every promotion to `production`, recreate a fresh Neon branch from `production` and reattach the fixed `preview` endpoint to it. Then run no-op migrations, seed preview fixtures, and smoke test. This keeps staging 1:1 with prod with zero URL churn and no drift.


Okay, now our... I'm just like I'm wondering then how... Is it like I guess is it necessary to delete the preview branch and then recreate it on NEON every time rather than just doing a reset? And I guess my concern is that currently we have the preview branch hard-coded in Versal environmental variables for the Versal preview branch that's tied to our staging domain. And I guess my question is how do we make sure that Versal is getting the right URL for the NEON branch? Because if we're doing this on production deploys instead of on preview deploys, that means that Versal is already deployed with the wrong ENV if we change the URL. So then when we change the URL, we would theoretically then have to redeploy on Versal, which seems like not the best way to do it. So I'm just wondering. I don't know. I'm wondering what would be the ideal way to do this. I don't really care where it happens. I want it to happen in a way that is going to be optimal for keeping all of this functioning correctly and keeping us moving quickly without losing data integrity and having things fall out of sync and stuff.


Mr. White — you don’t need to change any URL or redeploy Vercel if you do it the right way.

# The ideal pattern
**Use a stable Neon *endpoint*** for staging and just **reattach that endpoint to a fresh child branch of `production`** after each prod promotion.

- **Endpoint stays the same → URL in Vercel stays the same.**
- You get a brand-new branch (schema + data copied from prod at “now”) with **zero drift**.
- No “reset in place” needed; no redeploy to change envs.

# One-time setup (if you’re currently hard-coding a branch URL)
1. **Create a dedicated Neon endpoint** for staging (if you don’t already have one).
2. **Attach it to your current `preview` branch.**
3. In Vercel, set `DATABASE_URL_PREVIEW` to the **endpoint** connection string (not the branch URL).  
   Do a **one-time redeploy** to lock this in. After that, you’re done.

# Ongoing sync (runs automatically after prod promotion)
1. **Create a new branch from `production`** (name it with a timestamp).
2. **Reattach the staging endpoint** to this new branch (the URL doesn’t change).
3. **Run migrations** (no-op because prod already migrated).
4. **Seed/anonymize preview-only data** (idempotent).
5. **Smoke tests.** No Vercel env changes, no redeploy required.

> Why not “reset” the existing `preview` branch?  
> You *can*, but it’s slower/riskier, and you still don’t solve drift as cleanly as “fresh child + reattach endpoint.” The reattach pattern is copy-on-write fast and deterministic.

# CI secrets to keep
- `NEON_API_KEY`, `NEON_PROJECT_ID`
- `NEON_PREVIEW_ENDPOINT_ID` (the stable endpoint you reattach)
- `DATABASE_URL_PREVIEW` in Vercel points to that endpoint and **never changes**

# Workflow sketch (already aligned with your setup)
- Trigger: after your “promote preview → production” job succeeds.
- Steps:
  - `branches create --parent production`
  - `endpoints update <NEON_PREVIEW_ENDPOINT_ID> --branch-id <newChildBranchId>`
  - `pnpm drizzle:check && pnpm drizzle:push` (against `DATABASE_URL_PREVIEW`)
  - `pnpm seed:preview && pnpm test:e2e:smoke`

# If you prefer to sync *before* staging deploys
Trigger the same routine **on preview deploy pipeline start**, then deploy the app. Because the endpoint URL is constant, both orders work; pick the simpler hookup point in your CI.

# TL;DR
- Don’t delete/recreate a *named* `preview` branch; **recreate a fresh child branch** every time and **reattach a fixed endpoint**.  
- Keep Vercel pointing at that endpoint URL forever.  
- No URL churn, no redeploys, no drift.


Okay, so we already have a production branch in NEON, and then we have a child branch called Preview in NEON, and then the URL, the database URL variable is set in Versal, matching that. The only difference from your recommendation is that it's just database underscore URL, and we told Versal to only apply it to the Preview branch. We didn't add a special underscore Preview suffix to the environmental variable itself. So that's already set. And then, in NEON, I can go ahead and, or rather, for your recommendations on the GitHub Action and stuff, I can go ahead and do all that stuff. Okay. Thank you. And then tell me, should I have connection pooling on for the preview branch, the staging environment?


Mr. White — yes: **enable pooling for staging**.

### What to pool vs not
- **Edge runtime (neon-http + Drizzle):** pooled implicitly via Neon’s HTTP proxy → **nothing to change**.
- **Node runtime (Stripe webhooks, migrations in CI, any `pg`/Node driver):** **use Neon’s pooled connection string** for the *staging endpoint*. This prevents connection blow-ups from Vercel’s concurrency and Playwright runs.

### Practical setup
- In Neon: keep your **stable staging endpoint**, turn on the **Pooler** (PgBouncer, transaction mode).
- In Vercel:
  - Keep your existing `DATABASE_URL` pointing at the **staging endpoint**.
  - For **Node-only code paths** and **CI migrations**, use the **pooled** URL Neon gives you for that same endpoint (Neon shows both a direct and a pooled URL). Put it in `DATABASE_URL_NODE` (or similar) and only read it in Node contexts.
- Drizzle:
  - Edge: `drizzle-orm/neon-http` (unchanged).
  - Node: `drizzle-orm/node-postgres` with the **pooled** URL.

### Safe defaults (staging)
- **Pool mode:** transaction (Neon Pooler default).
- **Max connections:** 20–50 is plenty for staging.
- **Idle timeout:** ~30s.
- **Statement timeout:** 30–60s (guard against hung queries).
- **Prepared statements:** avoid server-side prepared statements behind PgBouncer (most Drizzle/pg usage is fine by default).

### TL;DR
- **Turn on pooling for staging.**
- **Use the pooled URL** anywhere you use Node connections (webhooks, CI/migrations, local dev hitting staging).
- Edge code already benefits from Neon’s proxy; leave it as is.


So, I'm just looking at the dashboard here on Neon, and I don't really see anything related to endpoints. I only see on the branch, but there is a reset from parent option, which I feel like that's all we want to do, is reset from parent. And I feel like that would respect more of the Neon preferences and stuff. And so, I'm just wondering, can we simply use the Neon CLI in GitHub Actions and have it just issue a reset from parent command? And that way, we know the URL is not changing, and we can easily track in the Neon database when the last reset was, and go in there and see clearly when the difference between the schema and stuff to make sure it's in sync and all that.


100%—you can “reset in place.” Neon ships a first-class **Reset from parent** that keeps the **same branch + URL** and records **Last reset at** on the branch.

### The command you want
```bash
# reset your preview branch to its parent (production)
neon branches reset preview --parent
```
This replaces preview’s **schema + data** with the parent’s head (or use `restore` if you ever need a timestamped point). citeturn1view0

### Wire it into CI (after prod promotion)
Minimal GitHub Actions step (no Vercel redeploy needed):
```yaml
- name: Reset Neon preview from parent
  run: neon branches reset preview --parent --project-id "$NEON_PROJECT_ID"
  env:
    NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
    NEON_PROJECT_ID: ${{ secrets.NEON_PROJECT_ID }}

- name: (Optional) verify schema matches prod
  run: neon branches schema-diff preview ^parent --project-id "$NEON_PROJECT_ID"
  env:
    NEON_API_KEY: ${{ secrets.NEON_API_KEY }}

- name: Seed/anonymize preview-only data (idempotent)
  run: pnpm seed:preview
  env:
    DATABASE_URL: ${{ secrets.DATABASE_URL }} # your existing preview URL in Vercel
```
`reset` is purpose-built for this; `schema-diff` is a quick sanity check. citeturn1view0

### Notes
- **No endpoint juggling** required; your **Vercel env stays the same**.
- Reset is fast (copy-on-write) and shows up in the branch details (Last reset at), which gives you an audit trail. citeturn0search0turn0search4
- If you ever need finer control (e.g., restore preview to the parent at 10:30 UTC), use:
  ```bash
  neon branches restore preview ^parent@2025-09-01T10:30:00Z
  ```
  citeturn1view0

### Pooling on staging
Keep pooling **on** for Node paths (webhooks, migrations, local scripts). Edge (`neon-http`) is already proxied.

That’s it: **reset preview from parent after each prod promotion**, then seed + smoke. Clean, deterministic, zero URL churn.


Okay, and then my question would be, if we use that neon reset command, would it be the best practice to reset it when we deploy to production? Or would it be better to reset it every time we deploy a preview branch? What would be optimal? I'm just trying to think through what scenarios could mess up either of those situations, right? If we're doing a lot of schema changes in preview that don't necessarily end up going to production, would we then want to continually reset preview every time we deploy to preview? So that our staging is always working against production data?


Mr. White — optimal policy:

# TL;DR
- **Reset `preview` from `production` only after a successful prod promotion** (and optionally once nightly).  
- **Do NOT reset on every preview deploy.** Use **ephemeral Neon branches per PR** for feature/testing work.

# Why
- **Stability:** Staging should mirror what’s in prod (plus *zero* drift). Resetting on every preview deploy risks breaking staging with in-flight schema that never ships.
- **Clean separation:**  
  - **Staging (`preview`):** sanity checks, smoke, UAT on *prod schema/data*.  
  - **PR environments:** each feature deploy hits **its own Neon branch** (created by your Neon↔GitHub integration), free to run migrations/experiments without polluting staging.

# When to reset
1. **On prod promotion success** → `neon branches reset preview --parent`  
2. **Optional:** **Nightly reset** (cron) to keep staging pristine if it’s used heavily during the day.

# Guardrails (fast checks in CI)
- **Before reset:** if `schema-diff` shows preview has unapplied/experimental migrations that aren’t in prod, *skip resetting on PR deploys* (you aren’t doing those anyway) and only reset after prod promotion:
  ```bash
  neon branches schema-diff preview ^parent --project-id "$NEON_PROJECT_ID"
  ```
- **After reset:** run `pnpm drizzle:check && pnpm drizzle:push` (should be no-ops), then `pnpm seed:preview` and smoke tests.

# Edge cases & playbook
- **Hotfix to prod:** reset staging immediately after the hotfix promotion.
- **Cross-PR integration testing on new schema:** spin up a **temporary shared Neon branch** from prod, apply the new migrations there, point a temporary Vercel env to it; tear down when done. Keep staging untouched.

This keeps staging fast, deterministic, and always compatible with your live schema, while PRs get full freedom to iterate.


Great, give me a little AI prompt I can give to Cloud Code to implement this, include the pre-commands and post-commands, and everything exactly as we discussed it, knowing that I've already set up the API keys and I've already set up the preview branch.


Mr. White — here’s a copy-paste prompt for Cloud Code.

# Prompt for Cloud Code (implement Neon “reset from parent” for staging)

You are working in the **Jovie** repo. Follow **CLAUDE.md** rules (branching, CI, fast checks). Implement a CI workflow that **resets the long-lived Neon `preview` branch from its parent (`production`) after every successful prod promotion**, plus an optional nightly safety reset. We already have:
- Neon: `production` branch (parent) and `preview` branch (child)
- Vercel env: `DATABASE_URL` already points to the **preview branch URL** for the Preview deploy context
- GitHub secrets exist: `NEON_API_KEY`, `NEON_PROJECT_ID`
- Node/PNPM project with scripts:
  - `drizzle:check`, `drizzle:push` (migrations)
  - `seed:preview` (idempotent seed/anonymize)
  - `test:e2e:smoke` (Playwright smoke)

## Deliverables
1. **New GitHub Action** `.github/workflows/sync-preview-on-prod-promotion.yml`:
   - **Trigger**: `workflow_run` on the “promote-preview-to-production” workflow, `conclusion == success`.
   - **Pre-commands**: install `neonctl` and `pnpm` deps.
   - **Main steps** (all idempotent):
     1) **Schema sanity check** (optional):  
        `neon branches schema-diff preview ^parent --project-id "$NEON_PROJECT_ID"`  
        - Log output but don’t fail on differences.
     2) **Reset preview from parent** (keeps the same URL):  
        `neon branches reset preview --parent --project-id "$NEON_PROJECT_ID"`
     3) **Migrations against preview** (should be no-ops since prod already migrated):  
        `pnpm drizzle:check && pnpm drizzle:push` (use preview `DATABASE_URL`)
     4) **Seed/anonymize preview data** (idempotent):  
        `pnpm seed:preview`
     5) **Smoke tests**:  
        `pnpm test:e2e:smoke`
   - **Post-commands**:
     - Emit a concise summary to job output: time of reset (UTC), current git SHA, and a link to Neon branch activity page (print the org/project/branch identifiers if available).
     - (Optional) Emit a small JSON line to logs: `{"env":"preview","action":"reset_from_parent","ts":"<UTC>","sha":"$GITHUB_SHA"}`

2. **Optional nightly job** `.github/workflows/sync-preview-nightly.yml`:
   - **Trigger**: `schedule` (cron) at 08:00 UTC daily.
   - Steps identical to the above (schema-diff → reset → drizzle check/push → seed → smoke).

3. **Guardrails**:
   - Add a boolean repo secret/variable `FREEZE_DB_RESYNC` (default unset/false). If set to `"true"`, **skip the reset** (use `if` guards).
   - Timeout the reset step at 120s and the whole job at 15m.
   - Continue-on-error for `schema-diff` only.

4. **Docs**:
   - Append a short section to `CLAUDE.md` under **Neon Branch Hygiene** documenting this policy (one paragraph, title: “Staging Reset Policy”).

## Exact files & contents

### `.github/workflows/sync-preview-on-prod-promotion.yml`
```yaml
name: sync-preview-on-prod-promotion

on:
  workflow_run:
    workflows: ["promote-preview-to-production"]
    types: [completed]

jobs:
  reset-preview:
    if: ${{ github.event.workflow_run.conclusion == 'success' && vars.FREEZE_DB_RESYNC != 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      NEON_PROJECT_ID: ${{ secrets.NEON_PROJECT_ID }}
      # Preview DATABASE_URL already configured in Vercel; replicate here for CI via GitHub secret:
      DATABASE_URL: ${{ secrets.DATABASE_URL_PREVIEW || secrets.DATABASE_URL }} # use PREVIEW if present
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup PNPM
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Install deps (lockfile respected)
        run: pnpm install --frozen-lockfile

      - name: Install neonctl
        run: npm i -g neonctl

      - name: Schema diff (preview vs parent)
        continue-on-error: true
        run: |
          echo "Running schema diff preview ^parent (non-blocking)..."
          neon branches schema-diff preview ^parent --project-id "$NEON_PROJECT_ID" || true

      - name: Reset preview from parent (keeps URL)
        run: |
          neon branches reset preview --parent --project-id "$NEON_PROJECT_ID"

      - name: Drizzle check & push (should be no-ops)
        run: |
          pnpm drizzle:check
          pnpm drizzle:push

      - name: Seed preview (idempotent)
        run: pnpm seed:preview

      - name: E2E smoke
        run: pnpm test:e2e:smoke

      - name: Summary
        run: |
          echo "✅ Preview reset from parent at $(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> $GITHUB_STEP_SUMMARY
          echo "SHA: $GITHUB_SHA" >> $GITHUB_STEP_SUMMARY
          echo '{"env":"preview","action":"reset_from_parent","ts":"'"$(date -u +"%Y-%m-%dT%H:%M:%SZ")"'","sha":"'"$GITHUB_SHA"'"}'
```

### `.github/workflows/sync-preview-nightly.yml` (optional)
```yaml
name: sync-preview-nightly

on:
  schedule:
    - cron: "0 8 * * *" # 08:00 UTC daily
  workflow_dispatch: {}

jobs:
  nightly-reset:
    if: ${{ vars.FREEZE_DB_RESYNC != 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      NEON_PROJECT_ID: ${{ secrets.NEON_PROJECT_ID }}
      DATABASE_URL: ${{ secrets.DATABASE_URL_PREVIEW || secrets.DATABASE_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - run: pnpm install --frozen-lockfile
      - run: npm i -g neonctl
      - name: Reset preview from parent
        run: neon branches reset preview --parent --project-id "$NEON_PROJECT_ID"
      - name: Drizzle check & push
        run: |
          pnpm drizzle:check
          pnpm drizzle:push
      - name: Seed preview
        run: pnpm seed:preview
      - name: E2E smoke
        run: pnpm test:e2e:smoke
```

### `CLAUDE.md` (add under “Neon Branch Hygiene”) — short text
```
**Staging Reset Policy**  
After each successful promotion to `production`, CI runs `neon branches reset preview --parent` to make `preview` an exact copy of prod (schema + data) without changing the DB URL. Then CI runs drizzle checks/push (no-ops), seeds preview-only data, and runs smoke tests. A nightly reset may also run at 08:00 UTC. Set repo variable `FREEZE_DB_RESYNC="true"` to temporarily skip resets.
```

## Acceptance criteria
- Pushing a prod promotion that finishes **success** triggers the sync job and logs a successful reset.
- The **preview** branch URL does **not** change; Vercel env remains valid.
- `drizzle:push` is a no-op post-promotion; seeding and smoke tests complete.
- Toggling `FREEZE_DB_RESYNC` to `"true"` cleanly skips resets.

Keep it lean, deterministic, and aligned with YC-style velocity.


A few times in here you mention npm commands instead of pnpm commands. Can you confirm that they should be npm commands? Or, if not, can you modify the prompt and give it to me again?


Good catch — in your stack you’ve standardized on **pnpm** (see `CLAUDE.md` → “Stack & Packages”), so anywhere I dropped in `npm` it should be **pnpm**, even for installing global tools.  

Here’s the corrected Cloud Code prompt with **all commands using pnpm** consistently:

---

# Prompt for Cloud Code (final, pnpm-only)

You are working in the **Jovie** repo. Follow **CLAUDE.md** rules (branching, CI, fast checks). Implement a CI workflow that **resets the long-lived Neon `preview` branch from its parent (`production`) after every successful prod promotion**, plus an optional nightly safety reset. We already have:
- Neon: `production` branch (parent) and `preview` branch (child)
- Vercel env: `DATABASE_URL` already points to the **preview branch URL** for the Preview deploy context
- GitHub secrets exist: `NEON_API_KEY`, `NEON_PROJECT_ID`
- Node/PNPM project with scripts:
  - `drizzle:check`, `drizzle:push` (migrations)
  - `seed:preview` (idempotent seed/anonymize)
  - `test:e2e:smoke` (Playwright smoke)

## Deliverables
1. **New GitHub Action** `.github/workflows/sync-preview-on-prod-promotion.yml`:
   - **Trigger**: `workflow_run` on the “promote-preview-to-production” workflow, `conclusion == success`.
   - **Pre-commands**: install `neonctl` and `pnpm` deps.
   - **Main steps** (all idempotent):
     1) **Schema sanity check** (optional):  
        `pnpm exec neon branches schema-diff preview ^parent --project-id "$NEON_PROJECT_ID"`  
        - Log output but don’t fail on differences.
     2) **Reset preview from parent** (keeps the same URL):  
        `pnpm exec neon branches reset preview --parent --project-id "$NEON_PROJECT_ID"`
     3) **Migrations against preview** (should be no-ops since prod already migrated):  
        `pnpm drizzle:check && pnpm drizzle:push` (use preview `DATABASE_URL`)
     4) **Seed/anonymize preview data** (idempotent):  
        `pnpm seed:preview`
     5) **Smoke tests**:  
        `pnpm test:e2e:smoke`
   - **Post-commands**:
     - Emit a concise summary to job output: time of reset (UTC), current git SHA, and a link to Neon branch activity page.
     - (Optional) Emit JSON line to logs: `{"env":"preview","action":"reset_from_parent","ts":"<UTC>","sha":"$GITHUB_SHA"}`

2. **Optional nightly job** `.github/workflows/sync-preview-nightly.yml`:
   - **Trigger**: `schedule` (cron) at 08:00 UTC daily.
   - Steps identical to the above (schema-diff → reset → drizzle check/push → seed → smoke).

3. **Guardrails**:
   - Add repo variable `FREEZE_DB_RESYNC` (default unset/false). If set to `"true"`, skip reset.
   - Timeout reset step at 120s, job at 15m.
   - Continue-on-error for `schema-diff` only.

4. **Docs**:
   - Append a short section to `CLAUDE.md` under **Neon Branch Hygiene** documenting this policy (title: “Staging Reset Policy”).

---

### `.github/workflows/sync-preview-on-prod-promotion.yml`
```yaml
name: sync-preview-on-prod-promotion

on:
  workflow_run:
    workflows: ["promote-preview-to-production"]
    types: [completed]

jobs:
  reset-preview:
    if: ${{ github.event.workflow_run.conclusion == 'success' && vars.FREEZE_DB_RESYNC != 'true' }}
    runs-on: ubuntu-latest
    timeout-minutes: 15
    env:
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      NEON_PROJECT_ID: ${{ secrets.NEON_PROJECT_ID }}
      DATABASE_URL: ${{ secrets.DATABASE_URL_PREVIEW || secrets.DATABASE_URL }}
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - run: pnpm install --frozen-lockfile

      - name: Install neonctl
        run: pnpm dlx neonctl --help

      - name: Schema diff (preview vs parent)
        continue-on-error: true
        run: pnpm dlx neonctl branches schema-diff preview ^parent --project-id "$NEON_PROJECT_ID"

      - name: Reset preview from parent (keeps URL)
        run: pnpm dlx neonctl branches reset preview --parent --project-id "$NEON_PROJECT_ID"

      - name: Drizzle check & push
        run: |
          pnpm drizzle:check
          pnpm drizzle:push

      - name: Seed preview
        run: pnpm seed:preview

      - name: E2E smoke
        run: pnpm test:e2e:smoke

      - name: Summary
        run: |
          echo "✅ Preview reset at $(date -u +"%Y-%m-%dT%H:%M:%SZ")" >> $GITHUB_STEP_SUMMARY
          echo "SHA: $GITHUB_SHA" >> $GITHUB_STEP_SUMMARY
          echo '{"env":"preview","action":"reset_from_parent","ts":"'"$(date -u +"%Y-%m-%dT%H:%M:%SZ")"'","sha":"'"$GITHUB_SHA"'"}'
```

---

Would you like me to also write out the **nightly workflow file** in full `pnpm` form, or is the production-promotion one enough for now?


For Clerk, right now, the only thing we have in our system to manage your password, and your sessions, and all that stuff, and your security preferences and stuff, is that, like, modal that Clerk gives you. That whole modal component that pops up with the account management. Can we embed each one of those individual elements into our app so it doesn't come up as a modal? It would be, like, built into our settings and match our theme. And how much flexibility do we have there? Or would we have to code our own components and use the API?


Mr. White — short version:

- **Yes, you can embed it.** Use `<UserProfile />` as a full page (not the `<UserButton />` modal). Theme it via the `appearance` prop and even add **custom pages/links** inside the profile nav. citeturn0search5turn0search0
- **Granularity is limited.** You can hide/reorder sections and style deeply, but you **can’t reliably extract every sub-pane** (e.g., “only Password” as a standalone atom) from the prebuilt profile. For that level of control, **build your own screens** with Clerk’s APIs (password reset, email/phone, MFA, etc.). citeturn0search5turn0search3turn0search6
- **The modal comes from `<UserButton />`.** Render `<UserProfile />` on `/settings/account` to avoid the modal entirely; keep `<UserButton />` as a menu entry that **navigates** to that route instead of opening a modal. citeturn0search2

### What I’d do
1. **Embed page**
   ```tsx
   // app/(dashboard)/settings/account/page.tsx
   import { UserProfile } from '@clerk/nextjs'

   export default function AccountPage() {
     return (
       <div className="max-w-3xl">
         <UserProfile
           appearance={{
             elements: { /* map to Tailwind classes to match Jovie */ },
             layout: { shimmer: false }
           }}
           // optional: route mounting behavior
           routing="path"
           path="/settings/account"
         />
       </div>
     )
   }
   ```
   Docs for `<UserProfile />` + customization live here. citeturn0search5turn0search0

2. **Theme globally**
   - Set `appearance` on `<ClerkProvider>` to centralize typography, colors, radii, etc., so it matches your Tailwind v4 design. citeturn0search5

3. **If you need per-section pages (true atoms)**
   - Build custom flows using Clerk’s JS/Next APIs:
     - **Password reset / change**: custom UI using Clerk client methods. citeturn0search3turn0search6
     - **Email/phone management, MFA, sessions**: same pattern—call Clerk APIs/hooks and render your own components.
   - This gives you total layout control and perfect brand fit, at the cost of a bit more wiring.

### Rule of thumb
- Want speed + solid theming → **Embed `<UserProfile />`** on your Settings page and style via `appearance` (you can also add **custom pages** into the profile’s sidenav). citeturn0search0turn0search5
- Want pixel-perfect “Apple-level” control with atomic sections → **Build your own pages** with Clerk’s APIs for each setting (password, factors, devices, sessions, emails). citeturn0search3turn0search6

If you want, I can drop a small “Jovie-styled” `appearance` object scaffold that maps to your Tailwind tokens.


All right, I'm going to put Codex on this job. Give me an AI prompt that will have it um, do exactly that, um, with the, um, um, with your, we'll do the, we'll do the Joby styled, um, version. We'll just do the, the first thing you suggested. Well, you already have a sentence menu with a bunch of pages. And so one page can be account management, and then we can put all this stuff in. Can, can we embed that way and kill the, and not have the actual, like, nav bar from clerk?


Mr. White — here’s a tight **Codex prompt** you can drop in. It embeds Clerk’s **`<UserProfile />`** as a full page inside your existing **Settings** UX, **kills Clerk’s built-in sidebar/nav**, applies a **Jovie** theme via `appearance`, and routes via `/settings/account` (no modal).

---

# 🔧 Codex Prompt — Embed Clerk Account Management (Jovie-styled, no Clerk nav)

You are working in the **Jovie** Next.js (App Router) repo. Implement an embedded account management page that uses **Clerk’s `<UserProfile />`** component **without Clerk’s sidebar/navigation**, styled to match Jovie (Tailwind v4, black/white, rounded-2xl, soft shadows). We already have Clerk set up.

## Goals
1. Add a **Settings → Account** page at `/settings/account` that renders `<UserProfile />` (not the `<UserButton />` modal).
2. **Hide Clerk’s internal sidebar/nav** and let our existing Settings left-rail handle navigation.
3. Apply a **Jovie appearance** (Apple-ish, color-agnostic, black/white, large radii, clean typography).
4. Ensure deep linking works (`routing="path"`, `path="/settings/account"`), no modal behavior.
5. Keep everything **Edge/Node safe** per our CLAUDE.md conventions.

## Steps

### 1) Global theming hook (optional but preferred)
Edit `app/providers/ClerkProvider.tsx` (or wherever you wrap `ClerkProvider`) to add a **Jovie** `appearance` baseline that other Clerk UIs inherit:

```tsx
// app/providers/ClerkProvider.tsx
'use client'

import { ClerkProvider } from '@clerk/nextjs'

const jovieAppearance = {
  layout: {
    // reduce default spacing/shimmer to match our minimal style
    shimmer: false,
    socialButtonsVariant: 'iconButton',
    logoPlacement: 'inside',
    logoImageUrl: '/logo.svg',
  },
  variables: {
    colorBackground: 'transparent',
    colorText: 'hsl(0 0% 4%)',     // black-ish
    colorInputBackground: 'white',
    colorPrimary: 'black',
    borderRadius: '1rem',           // ~rounded-2xl
    fontSize: '14px',
  },
  elements: {
    // shared card styles
    card: 'shadow-sm rounded-2xl border border-black/10 bg-white dark:bg-black dark:text-white',
    headerTitle: 'text-xl font-semibold',
    headerSubtitle: 'text-sm text-black/60 dark:text-white/60',
    formButtonPrimary: 'rounded-xl',
    footer: 'hidden',               // hide dev footers etc.
  },
}

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider appearance={jovieAppearance}>
      {children}
    </ClerkProvider>
  )
}
```

### 2) Account page that embeds `<UserProfile />` and **removes Clerk’s nav**
Create `app/(dashboard)/settings/account/page.tsx`:

```tsx
// app/(dashboard)/settings/account/page.tsx
'use client'

import { UserProfile } from '@clerk/nextjs'

export default function AccountSettingsPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <UserProfile
        routing="path"
        path="/settings/account"
        // Local appearance overrides specifically to kill Clerk's internal nav/sidebar
        appearance={{
          elements: {
            // Hide sidebar + any top/breadcrumb bars Clerk renders
            userProfile__sidebar: 'hidden',         // sidebar rail
            userProfile__navbar: 'hidden',          // top nav (when present)
            userProfile__content: 'w-full',         // expand content to full width
            // Tighten content spacing to match Jovie’s density
            pageScrollBox: 'p-0',
            profileSection__content: 'gap-6',
            // Buttons/inputs
            formFieldInput: 'rounded-xl',
            formButtonPrimary: 'rounded-xl',
          },
        }}
      />
    </div>
  )
}
```

> Note: We’re using **appearance.elements** to visually **hide Clerk’s internal sidebar/nav**, letting **our Settings menu** control navigation. If element keys drift, query Clerk’s docs for the latest `appearance.elements` selectors for `UserProfile` and apply `hidden` to the sidebar/nav containers.

### 3) Route Settings menu to this page
In your existing Settings layout/left rail, add an entry that **navigates** to `/settings/account` (don’t open the Clerk modal). Example:

```tsx
// components/dashboard/organisms/SettingsNav.tsx
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/cn'

const items = [
  { href: '/settings/profile', label: 'Profile' },
  { href: '/settings/account', label: 'Account' }, // Clerk UserProfile page
  { href: '/settings/billing', label: 'Billing' },
]

export function SettingsNav() {
  const pathname = usePathname()
  return (
    <nav className="flex flex-col gap-1">
      {items.map(it => (
        <Link
          key={it.href}
          href={it.href}
          className={cn(
            'px-3 py-2 rounded-xl hover:bg-black/5 dark:hover:bg-white/10',
            pathname === it.href && 'bg-black text-white dark:bg-white dark:text-black'
          )}
        >
          {it.label}
        </Link>
      ))}
    </nav>
  )
}
```

### 4) Ensure the User button does **navigation**, not modal
If you have a top-right `<UserButton />`, configure it to **navigate** to the page instead of opening the modal:

```tsx
// components/site/HeaderUser.tsx
'use client'
import { UserButton } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'

export function HeaderUser() {
  const router = useRouter()
  return (
    <UserButton
      userProfileMode="navigation"       // prefer navigation instead of modal
      userProfileUrl="/settings/account" // go to our embedded page
      afterSignOutUrl="/"
    />
  )
}
```

### 5) Keep App Router linking workable
`<UserProfile routing="path" path="/settings/account" />` allows deep links to specific profile sub-routes while staying inside our page shell.

## Acceptance Criteria
- Visiting `/settings/account` shows Clerk’s **account/security UI inside our page** with **no Clerk sidebar/nav visible**; content fills our container.
- Top-right **User button navigates** to `/settings/account` (no modal).
- Jovie look: rounded-2xl, black/white, subtle border/shadow, typography aligned to our system.
- Works in both light/dark; respects our Tailwind v4 tokens.
- No Node-only imports in Edge paths.

## Notes
- If future Clerk updates rename appearance element keys, adjust the `appearance.elements` selectors to continue **hiding the sidebar/nav**.
- If you ever need per-section atoms (e.g., password only) outside `<UserProfile />`, build bespoke screens using Clerk APIs; for now we’re embedding the whole profile page.

---

If you want me to also include a quick **Playwright smoke** that asserts the sidebar is hidden and that password/MFA sections render, say the word.


{'asset_pointer': 'file-service://file-JLufGkNxjm3vyv3EGXPpCD', 'content_type': 'image_asset_pointer', 'fovea': None, 'height': 220, 'metadata': {'asset_pointer_link': None, 'container_pixel_height': None, 'container_pixel_width': None, 'dalle': None, 'emu_omit_glimpse_image': None, 'emu_patches_override': None, 'generation': None, 'gizmo': None, 'is_no_auth_placeholder': None, 'lpe_delta_encoding_channel': None, 'lpe_keep_patch_ijhw': None, 'sanitized': True, 'watermarked_asset_pointer': None}, 'size_bytes': 90733, 'width': 686}
What does this warning mean and what do we do about it?


**Topic:** [[chatgpt-clusters/code_review]]
