
Mr. White—since you created Neon **through the Vercel marketplace**, uninstalling the integration and clicking its “delete” flow can delete the **entire Neon project and all data**. That delete is **permanent** (not recoverable), because project deletion removes all branches/endpoints/databases. citeturn0search0turn0search15

If you need historical recovery in the future, Neon supports **point-in-time restore** (PITR) while a project exists—but **not after the project itself is deleted**. citeturn0search1turn0search11

# Clean rebuild plan (keeps your Option A pipeline)

1) **Recreate the Neon project (manually in Neon)**
   - New project → set region/Postgres version as before. (Neon API also supports `POST /projects` if you prefer infra-as-code.) citeturn0search4
   - Create two **long-lived branches**:
     - `production` (root)
     - `preview` (**parent = production**) citeturn0search19
   - Create roles:
     - **migration** role (DDL)
     - **app** role (runtime, use **pooled** URL in app)
   - Generate a **Neon API key** (for Actions).

2) **Wire GitHub Actions (Neon-owned previews)**
   - Use Neon’s **create-branch** Action for each PR → it returns:
     - `db_url` (non-pooled; use for Drizzle/Migrations)
     - `db_url_pooled` (pooled; use for the app) citeturn0search2
   - Keep your delete/reset jobs as before (deny-list `production`/`preview`).

3) **Deploy to Vercel with per-deployment env (Option A)**
   - In your deploy job, **inject** the DB URL only for that deployment:
     ```bash
     npx vercel deploy --prebuilt \
       --token "$VERCEL_TOKEN" \
       --env DATABASE_URL=${NEON_DB_URL_POOLED}
     ```
   - `--env`/`--build-env` are the official way to set **per-deployment** variables via CLI. You are **not** relying on the old integration anymore. citeturn0search3turn0search13

4) **Secrets/vars to update**
   - GitHub → `NEON_API_KEY`, `NEON_PROJECT_ID`
   - Vercel → keep permanent envs (if any) minimal; most previews get `DATABASE_URL` via the deploy flag now. You can verify with `vercel env ls`/`vercel env pull`. citeturn0search8

5) **Stay under the 10-branch cap**
   - You already delete on PR close—good.
   - (Optional) add a nightly **Neon API cleanup** to delete any `preview-pr-*` without an open PR. citeturn0search9

# Drop-in YAML (concise)

```yaml
name: Preview Deploy
on:
  pull_request:
    types: [opened, reopened, synchronize]
jobs:
  neon_create_and_check:
    if: github.event.pull_request.base.ref == 'preview' && github.event.pull_request.head.repo.fork == false
    runs-on: ubuntu-latest
    outputs:
      DB_URL: ${{ steps.neon.outputs.db_url }}
      DB_URL_POOLED: ${{ steps.neon.outputs.db_url_pooled }}
    steps:
      - uses: actions/checkout@v4

      - name: Create Neon PR branch (parent=preview)
        id: neon
        uses: neondatabase/create-branch-action@v5
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          branch_name: preview-pr-${{ github.event.number }}
          parent: preview
          api_key: ${{ secrets.NEON_API_KEY }}

      - name: Drizzle check (schema ops use NON-pooled URL)
        run: pnpm drizzle:check
        env:
          DATABASE_URL: ${{ steps.neon.outputs.db_url }}

  vercel_deploy:
    needs: neon_create_and_check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile && pnpm build
      - name: Deploy (inject DATABASE_URL for this deploy only)
        run: >
          npx vercel deploy --prebuilt
          --token "$VERCEL_TOKEN"
          --env DATABASE_URL=${{ needs.neon_create_and_check.outputs.DB_URL_POOLED }}
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
```

# Reality check
- **Project deletion is final.** If you lost data, there’s no Neon-side restore for a deleted project (PITR applies only to existing projects/branches). citeturn0search15turn0search1
- Going forward, your pipeline is independent of the marketplace integration and uses official **Neon Actions** + **Vercel CLI env injection**, which is stable and cheap. citeturn0search12turn0search3

Want me to provision the two long-lived branches and update your Actions files to this exact flow?


What region and postgres version do I want? Do I want AWS or Azure?


Mr. White — short and opinionated:

## TL;DR picks
- **Cloud:** **AWS** (unless you’re already an Azure-only shop). Neon runs on both, but AWS gives you the widest ecosystem fit and avoids Azure-only org constraints. citeturn0search0turn0search5  
- **Region:** put Neon **in the same region as your Vercel Functions**. If you don’t set a region for functions, Vercel defaults to east-coast US; either 1) keep both in **US-East** or 2) move both to **US-West** for LA-centric latency. The only rule: **DB and functions should be co-located**. citeturn0search2turn0search7turn0search24  
- **Postgres version:** **Postgres 16 or 17**. Pick the latest Neon-supported major you’re comfortable with (Neon supports 14–17). New majors get ~5 years of official support. Check extension needs before choosing. citeturn0search1turn0search21turn0search11

---

## How to decide (and why)
1) **Keep compute next to data (latency)**
   - Vercel lets you pin **Functions** to a region; choose the **same** region for Neon. That minimizes every query’s round-trip. citeturn0search2turn0search12

2) **AWS vs Azure**
   - Neon supports **multiple AWS & Azure regions**. If you create a Neon org via the **Azure portal**, it’s Azure-only; otherwise you can choose AWS. Unless you need Azure integration specifically, pick **AWS** to keep things simple with Vercel and common tooling. citeturn0search0turn0search5

3) **Which exact region?**
   - If your users and team are mostly US and you don’t plan to change Vercel’s default, **US-East** is fine (low friction).  
   - If you want the lowest latency from LA, pin Vercel Functions to a West region and put Neon there too (US-West). Either way, **match regions**. citeturn0search2turn0search7

4) **Postgres major version**
   - Neon supports **PG 14/15/16/17**. Choose **16/17** for longevity and features; confirm any required extensions are supported for that major in Neon’s list. PG majors are supported ~**5 years** by upstream. citeturn0search1turn0search21turn0search11

---

## Action checklist
- In Neon: create project on **AWS** in your chosen US region (east or west), **PG 16/17**. citeturn0search0turn0search1  
- In Vercel: set **Functions region** to the **same** region you picked for Neon. (You can configure this per project/route.) citeturn0search2  
- Verify any Postgres **extensions** you need are available for that PG major. citeturn0search11

If you tell me where you want your Vercel Functions to run (east vs west), I’ll give you the exact Neon region to pick and we’ll lock it in.


Okay, GitHub integration has been reset on the new project. The new project has a preview branch and the main branch. So I have production branch and preview branch, GitHub integration set. Now we need to ensure that the DB variables get set. They should automatically now, I believe, be getting set in GitHub. And that URL should then be getting passed to Drizzle check. So that should be good. Now we just need to add the thing to add it to Versal. Can you give me an AI prompt to instruct that change?


Here’s a tight **AI prompt** you can hand to your dev/CI agent to implement **Option A** (pass the Neon DB URL to Vercel at deploy time) while keeping your Neon↔GitHub integration for branch creation + Drizzle checks.

---

# AI Prompt — Wire Neon → Drizzle → Vercel (per-deployment env)

**Goal:** In our GitHub Actions workflow for PRs into `preview`, after the Neon GitHub integration creates the PR DB branch and we run **Drizzle check** against its **non-pooled** URL, deploy a Vercel **Preview** and inject the **pooled** DB URL **for that deployment only** using the Vercel CLI `--env` flag (no project-level env churn).

**Requirements & references:**  
- Use the Neon **create-branch** action outputs: `db_url` (non-pooled) for migrations/checks, and `db_url_with_pooler` (runtime). citeturn0search6turn0search7  
- Use **Vercel CLI** to deploy and pass env per deployment with `--env` / `--build-env`. citeturn0search20turn0search3turn0search5  
- This is a **Preview** deploy (not production). citeturn0search8

**Tasks:**

1) **Ensure the Neon job exposes outputs**  
   - From the “Create Neon branch” step (Neon action), expose:
     - `DB_URL`  ← `${{ steps.create.outputs.db_url }}`
     - `DB_URL_POOLED` ← `${{ steps.create.outputs.db_url_with_pooler }}`  
   - Keep Drizzle check using `DB_URL` (non-pooled).

2) **Add a Vercel deploy job that depends on Neon**  
   - Build locally (`pnpm build`) or use `--prebuilt`.  
   - Deploy with:
     ```bash
     npx vercel deploy --prebuilt \
       --token "$VERCEL_TOKEN" \
       --env DATABASE_URL=${{ needs.neon_create_and_check.outputs.DB_URL_POOLED }}
     ```
   - This sets `DATABASE_URL` **only for that deployment**, as documented by Vercel CLI. citeturn0search20

3) **Branch scoping / safety**  
   - Run this workflow only for PRs with **base = `preview`** and **not from forks** (secrets don’t flow to forks).
   - Never touch long-lived Neon branches `production` and `preview`.

4) **Masking**  
   - Never echo the DB URL. If you must log presence, print a masked check only.

**Deliverable:** update `.github/workflows/preview-deploy.yml` (or your CI workflow) with this minimal shape:

```yaml
name: Preview Deploy
on:
  pull_request:
    types: [opened, reopened, synchronize]

jobs:
  neon_create_and_check:
    if: github.event.pull_request.base.ref == 'preview' && github.event.pull_request.head.repo.fork == false
    runs-on: ubuntu-latest
    outputs:
      DB_URL: ${{ steps.neon.outputs.db_url }}
      DB_URL_POOLED: ${{ steps.neon.outputs.db_url_with_pooler }}
    steps:
      - uses: actions/checkout@v4

      - name: Create Neon PR branch (parent=preview)
        id: neon
        uses: neondatabase/create-branch-action@v5
        with:
          project_id: ${{ vars.NEON_PROJECT_ID }}
          branch_name: preview-pr-${{ github.event.number }}
          parent: preview
          api_key: ${{ secrets.NEON_API_KEY }}

      - name: Drizzle check (schema ops use NON-pooled URL)
        run: pnpm drizzle:check
        env:
          DATABASE_URL: ${{ steps.neon.outputs.db_url }}

  vercel_deploy:
    needs: neon_create_and_check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: pnpm install --frozen-lockfile && pnpm build
      - name: Deploy Preview (inject DATABASE_URL for this deploy only)
        run: >
          npx vercel deploy --prebuilt
          --token "$VERCEL_TOKEN"
          --env DATABASE_URL=${{ needs.neon_create_and_check.outputs.DB_URL_POOLED }}
        env:
          VERCEL_TOKEN: ${{ secrets.VERCEL_TOKEN }}
```

**Notes:**  
- The **Neon GitHub guide** shows the create/reset/delete actions and that the create action surfaces connection URLs as outputs—use those exact outputs. citeturn0search2turn0search6  
- The **Vercel CLI deploy docs** + env docs confirm `--env/--build-env` for **per-deployment** variables; you are not editing project-level envs. citeturn0search20turn0search3

**Success criteria:**  
- Every PR to `preview` gets its own Neon branch; Drizzle runs against non-pooled URL in CI.  
- The Vercel **Preview** gets `DATABASE_URL` injected at deploy time (pooled).  
- No reliance on the Vercel↔Neon marketplace integration; no leftover env churn.

--- 

If you want me to tailor the job names and step IDs to your exact workflow filenames, I can do that next.


Should I hard-code into Versal the ENV info for the production and preview branches, the long-lived branches? And then also, with our current CI setup, are we currently duplicating build process on GitHub Actions and on Versal? And should we change that process to speed things up? Do we benefit from that?


Mr. White — crisp answers:

## 1) Should we hard-code env vars in Vercel for long-lived branches?
Yes. For **`production`** and **`preview`** (the two long-lived Neon branches), set static DB URLs in Vercel **Project → Settings → Environment Variables**:

- **Production target:** set `DATABASE_URL` for **Production**.  
- **Preview target (branch-scoped):** set `DATABASE_URL` for **Preview** and scope it to the **`preview` git branch** so all preview deployments of that branch inherit it. Vercel supports env vars per environment **and per git branch**; branch-scoped variables override the generic Preview value. citeturn0search0turn0search13turn0search8turn0search21

For **feature PRs**, keep using your workflow that injects the per-PR URL **only for that one deployment** via `vercel deploy --env …` (Option A). That way, long-lived branches are stable in Vercel settings, and PR previews get one-off injected URLs. citeturn0search1

---

## 2) Are we duplicating builds (GitHub Actions **and** Vercel)? Should we change it?
If you run a full build in GitHub Actions **and** let Vercel build again, yes—that’s duplicate work and adds minutes. Two clean patterns:

- **A. Build in CI, skip Vercel build (recommended for speed):**  
  Use `vercel build` in Actions and deploy the artifacts with `vercel deploy --prebuilt`. This creates the deployment **without** rebuilding on Vercel. Pass your per-deployment env with `--env`. citeturn0search9turn0search1
  
- **B. Let Vercel build, don’t build in CI:**  
  Keep Git checks (lint/type/test/drizzle) in Actions, but don’t run a production build there; let Vercel’s default build handle it. (Simpler, slower.) citeturn0search7

Given your goal (“ship many times/day”) and that you already gate merges in CI, pick **A**. It’s the official flow Vercel documents for using **GitHub Actions as your CI/CD**: build with `vercel build` in CI → `vercel deploy --prebuilt` → no second build. citeturn0search2turn0search9

**Bonus: prevent accidental double deploys**  
If your project is still connected to Vercel’s Git integration, disable auto deploys or switch to deploying only via Actions to avoid duplicate preview deployments. (Vercel’s guide explicitly supports the “deploy from Actions” model.) citeturn0search2turn0search3

---

## What to do now (quick checklist)
1) In Vercel settings, add:
   - `DATABASE_URL` → **Production** (points at Neon `production`).  
   - `DATABASE_URL` → **Preview**, **gitBranch = preview** (points at Neon `preview`). citeturn0search0turn0search8
2) Keep PR previews using your Action: `vercel deploy --prebuilt --env DATABASE_URL=<pooled-PR-url>`. citeturn0search1
3) In Actions, replace any Next build with:
   ```
   vercel build
   vercel deploy --prebuilt --token $VERCEL_TOKEN --env DATABASE_URL=...
   ```
   (No second build on Vercel.) citeturn0search9

That gives you stable envs for long-lived branches, one-off envs for PR previews, and a single build step (faster pipeline).


In addition to the database URL, do we need any other info set in Versal? Like, does Versal need authentication of any kind, API keys, or anything like that?


Mr. White—aside from `DATABASE_URL`, here’s what you need to know about environment variables and Vercel:

---

##  What else might Vercel need?

###  Built-in system variables (auto-provided)
Vercel exposes numerous **system environment variables** automatically. These are useful for build logic, analytics, or debugging.

They include:
- `VERCEL_ENV` (`production`, `preview`, or `development`)
- `VERCEL_URL`, `VERCEL_BRANCH_URL`, and `VERCEL_PROJECT_PRODUCTION_URL`
- Git-related metadata: `VERCEL_GIT_COMMIT_SHA`, `VERCEL_GIT_COMMIT_REF`, `VERCEL_GIT_PULL_REQUEST_ID`, etc.  
- Region and deployment identifiers like `VERCEL_REGION`, `VERCEL_DEPLOYMENT_ID`  
- Other internals (e.g. `CI`, `VERCEL_PROJECT_ID`) citeturn0search0

These are **always available**; you don't need to configure them.

---

###  When you *do* need to add env vars
You must explicitly define any custom variables that your app or integrations rely on. Apart from `DATABASE_URL`, consider:

- **API keys** for services like Clerk, analytics, or AI tools (use secure, non-public naming—no `NEXT_PUBLIC_`).
- **Feature flags** or runtime toggles.
- **Client-side config** (if needed), prefixed with `NEXT_PUBLIC_` (only build-time, inlined into the JS bundle) citeturn0search11.
- If using Vercel’s built-in Postgres or similar, predefined env vars like `POSTGRES_URL` may be auto-provisioned by Vercel (only with selected marketplace integration) citeturn0search6turn0search8.

---

##  Recommended Setup for You

- **Database URLs:**  
  - `production` branch: set `DATABASE_URL` in Vercel project settings.
  - `preview` branch: set branch-scoped `DATABASE_URL`.
  - PR previews: continue using `--env DATABASE_URL=...` in your Action.

- **Other secrets (Clerk, analytics, etc.):**  
  Add them to Vercel project settings, with correct scoping.

- **Access system vars in your app:**  
  E.g., use `process.env.VERCEL_ENV` to detect context (preview vs prod).

---

##  Summary Table

| Purpose               | How Provided / Set        |
|----------------------|---------------------------|
| `DATABASE_URL`       | Self-configured or injected via CLI |
| API keys, external secrets | Define in Vercel project settings |
| `NEXT_PUBLIC_...` vars | Define manually; expose to frontend |
| System variables (metadata) | Automatically injected by Vercel |

---

Let me know if you’d like help structuring your secrets (say, Clerk secret, analytics token) across environments or updating your code to detect `VERCEL_ENV` for behavior toggling.


No, I mean for NEON. Like, how does Versal connect to the database if we're just sending the database URL? Doesn't it need, like, a NEON API key or a password or something like that?


Mr. White—you’re spot-on in highlighting the key question. Let me be crystal:

**Vercel only needs the database connection string (e.g. `DATABASE_URL`)** to connect to your Neon DB. No other Neon credentials like API keys or admin secrets are required for the app to function.

---

###  Why a single connection string is enough

When you provide Vercel with a full connection string, for example:

```
postgresql://user:password@your-neon-host.neon.tech/dbname?sslmode=require
```

- The **username**, **password**, **host**, **database name**, and connection details are embedded right inside that URL.  
- That string authorizes connections at the Postgres protocol level—no additional API key or secret is necessary. ([turn0search2](https://neon.com/docs/guides/vercel-manual))
- The app (or Drizzle/t ORM) uses that string to open an authenticated session with Neon.

---

###  What you *don’t* need to pass to Vercel

- **Neon API Key**: Not required for runtime or Vercel to connect. It’s only needed in GitHub Actions to call Neon APIs or branch actions—not in runtime.  
- **Other PG or Neon environment parts** (like `PGHOST`, `PGUSER`, etc.) can be passed individually, but the single consolidated `DATABASE_URL` is sufficient—and easier.

---

###  Reliable sources confirming this

- Neon’s manual setup guide:
  > Add either:
  > ```
  > Key: DATABASE_URL
  > Value: <your connection string>
  > ```
  > or granular `PG*` vars in Vercel settings to connect.  
  citeturn0search2

- The Vercel-Neon integration shows that the integration injects:
  - `DATABASE_URL` (pooled)
  - `DATABASE_URL_UNPOOLED`
  - `PGHOST`, `PGUSER`, `PGPASSWORD`, etc.  
  Again, these are just exposures of the same connection data—no extra API key.  
  citeturn0search0

---

###  Summary

- **Only `DATABASE_URL`** is needed in Vercel for runtime.
- **Neon API keys** are only needed in GitHub Actions for creating branches or running migrations—but *not* in Vercel deploys.
- Vercel uses that connection string to connect at runtime just like any Postgres client would.

Let me know if you'd like me to audit existing env usage to ensure API keys aren't accidentally exposed or misconfigured in your deployments.


Cannot set Production Branch "preview" for a Preview Environment Variable. Learn More


Mr. White — that error means Vercel thinks **`preview` is your Production Branch**, so you can’t assign a **Preview** env var to it. In Vercel, *Preview* env vars only apply to branches **that are not** the configured Production Branch. citeturn0search2

# Fix (2-minute settings change)
1) In Vercel → **Project → Settings → Git**, set **Production Branch** to your real production branch (e.g., `production` or `main`). citeturn0search1turn0search5  
2) Now add your **Preview** environment variable and scope it to the **`preview`** branch (branch-specific Preview var). This is supported and will work once `preview` is no longer the Production Branch. citeturn0search2turn0search6

# If you intentionally want `preview` to be “production”
- Don’t use a *Preview* env var for it. Use a **Production** env var (or keep using your per-deployment `--env` injection from CI). Preview env vars are explicitly for non-Production branches. citeturn0search2

# Sanity checklist
- **Production Branch** shows your real prod branch (not `preview`). citeturn0search5  
- **Preview env var** → target = *Preview*, **Branch** = `preview`. citeturn0search2turn0search6  
- PR previews continue to get `DATABASE_URL` via `vercel deploy --env …` from CI (no project-level churn). citeturn0search13

If you want, tell me which branch you’re using for live prod, and I’ll write the exact steps (and a screenshot checklist) to lock this in.


How do I tag codegen in github


Absolutely, Mr. White. Here’s how you “tag CodeGen in GitHub”—I’ll cover both common interpretations: **Git tags for versions** and **labels for repository management**.

---

##  1. Tagging with Git (Version Tags)

If by “tag CodeGen” you mean versioning a release in your repo:

### **A. Via Git on the command line:**
```bash
git tag v1.0.0
git push origin v1.0.0
```
- Creates an annotated tag (snapshot) locally and pushes it to GitHub. Learn more in GitHub Docs. citeturn0search10

### **B. Via GitHub UI:**
- Go to **Releases** → **Draft a new release**.
- Provide a **Tag version** (e.g., `v1.0.0`).
- You can **delete the Release later** without deleting the tag. The tag stick around. citeturn0search6

This type of tag is usually used to version releases or important checkpoints—not for organizing issues.

---

##  2. “Tagging” (Labeling) in GitHub Issues & PRs

If you meant **categorizing CodeGen-related issues**, what you want are **labels**.

- In your repo, go to **Issues** or **Pull requests** → find an item.
- On the sidebar, choose **Labels**, then click **“New label”** or pick an existing one like `codegen`.
- You can also create and manage labels under **Settings → Labels** globally. citeturn0search13

Labels help categorize, triage, and filter issues—not version.

---

###  Summary

| What you mean | What to do                      |
|---------------|----------------------------------|
| Tagging a release (version) | Use `git tag …` or GitHub Releases   |
| Categorizing CodeGen-related issues | Create or use **Repository Labels** |

Would you like a PR template or CI check that auto-adds a `codegen` label to issues or PRs referencing “CodeGen”?


Hey, you want to audit RCI now and tell me how we're doing?


Mr. White — here’s a tight CI/CD audit and what I’d change.

# What’s solid
- **Branch policy gates are in place.** PRs must follow `feature/* → preview` and `preview → production` flow, enforced early as a dedicated job. fileciteturn4file12L39-L47  
- **Fast vs full lanes.** CI is scoped to `preview`/`production`, supports merge queue via `merge_group`, and cancels redundant runs. Good defaults for high iteration. fileciteturn4file12L3-L12 fileciteturn4file12L15-L28  
- **Auto-merge brains.** Smart workflow waits on the required checks, inspects mergeable state, and auto-updates behind branches before merging. fileciteturn4file16L39-L49 fileciteturn3file3L39-L50 fileciteturn3file3L67-L76  
- **Preview deploys are health-checked.** Vercel preview is built/deployed from CI, URL captured, and a basic canary runs. fileciteturn4file10L15-L23 fileciteturn4file10L31-L47  
- **Promotion guardrail.** Opening/updating a `preview → production` release PR with a human QA checklist is baked in. fileciteturn3file8L25-L33 fileciteturn3file8L50-L55  
- **Security + synthetic checks.** CodeQL scheduled; golden-path synthetic monitoring runs on cron. fileciteturn4file4L14-L21 fileciteturn4file8L5-L13

# Gaps / risks
1) **`pull_request_target` surface area.** Auto-merge runs on `pull_request_target` with write perms. That’s correct for label/merge automation but you must **never** execute untrusted code from the PR context in that job. Skim shows it’s API-only, which is good; keep it that way and avoid `checkout` there. fileciteturn4file16L7-L20

2) **Required-checks alignment.** The auto-merge wait pattern uses a regexp; make sure your branch protection actually requires the exact checks that CI produces (names must match or auto-merge can “green-light” while the branch rule ignores it). Your regex expects `typecheck|lint|drizzle.check|build|unit.tests|e2e.tests` — confirm your job names/outputs match. fileciteturn3file1L39-L49

3) **Preview canary is too shallow.** It checks HTTP 200 and presence of “Jovie”. Add at least one SSR route and a DB-touched page (e.g., profile read) to catch common failures before merge. fileciteturn4file10L31-L47

4) **Production deploy migration safety.** You run `db:migrate` on `production` from CI; good, but it’s gated only by env and the job graph. Add: snapshot/backup pre-step + `ALLOW_PROD_MIGRATIONS=true` assertion already noted, but enforce a **manual approval** on the environment or required reviewers on the promo PR. fileciteturn3file8L41-L46

5) **Preview/PR DB lifecycle pressure.** You’re on Neon free (10 branches). I don’t see a nightly reaper here; add an **automated cleanup** of Neon branches for closed PRs/stale previews to avoid quota lock. (We discussed this earlier; it’s not in repo yet.)

6) **Signal vs noise from AI review.** Claude review is non-blocking (fine), but it can label blocking issues (`claude:needs-fixes`). Ensure your required-checks ruleset includes a simple **“PR policy”** check you already have, not AI labels. fileciteturn4file11L34-L46 fileciteturn4file12L30-L38

7) **Docs ↔ automations.** The “Plan → Issues → Copilot” 15-min cron is handy but can generate churn. Consider reducing to hourly for MVP week unless you truly need 4×/hour sync. fileciteturn4file0L11-L19

# Quick wins (do these now)
- **Harden auto-merge job:** add an explicit “no checkout” comment and a safeguard step that fails if a `GITHUB_WORKSPACE` checkout is detected (belt-and-suspenders for `pull_request_target`).  
- **Tighten required checks:** in branch protections, require exactly these statuses that your CI emits:  
  `PR Policy`, `PR Up-to-date with Preview`, `typecheck`, `lint`, `drizzle.check`, `build`, `unit.tests`, `e2e.tests`. That aligns with the auto-merge wait regex. fileciteturn3file3L39-L48 fileciteturn4file12L49-L54  
- **Extend preview canary:** hit `/`, `/pricing`, and a profile path; verify HTML contains core elements and that a simple DB read endpoint responds 200. (Same job; 20–30s extra.) fileciteturn4file10L31-L47  
- **Add Neon branch reaper:** nightly cron: list branches; delete any `preview/pr-<num>-<head>` where PR is closed or older than N days. (We can drop in a small `neondatabase/*` action to do this.)  
- **Promotion safety:** mark `Production` environment with required reviewers in GitHub Environments so `deploy-prod` can’t run without approval (keeps your `db:migrate` honest). fileciteturn3file8L67-L74  
- **Merge-queue experience:** your CI listens to `merge_group`; add a short “merge-group smoke” (2–3 min) that re-runs only `typecheck+lint+build` to shorten queue dwell. You already have the scaffolding. fileciteturn4file12L15-L21

# “Ship-many-times-a-day” path (YC-style)
1) **Trunk first:** everything merges to `preview` behind fast required checks (<5 min). (You’ve separated fast and full; keep full reliable but non-blocking for promo.) fileciteturn4file12L29-L38  
2) **Auto-merge by default:** keep your current auto-merge for Dependabot and labeled AI PRs; expand to human PRs when all required checks are green and branch is clean. (Already supported.) fileciteturn4file17L91-L105  
3) **Automated promotion:** keep the promotion PR with a lightweight checklist until post-launch; later you can gate `preview → production` by synthetic + a single approver, then auto-merge. fileciteturn3file8L31-L39 fileciteturn4file8L71-L89

# Nice-to-haves (next)
- **Flake budget:** Capture and quarantine flaky E2Es; keep `continue-on-error: true` on synthetic, but file issues with the failing spec names parsed from JSON (your parser step exists — extend it to open issues). fileciteturn4file8L90-L95  
- **PR comment with preview link:** If not already, have the preview deploy workflow post the URL to the PR (docs say it does; confirm). fileciteturn4file18L11-L13  
- **Observability handoff:** After deploy, ping a “golden path” endpoint that logs version + commit to confirm the right build is live (1 line in deploy step).

If you want, I’ll drop in the Neon reaper and the multi-route canary as PRs.


Um, yeah, give me the Reaper, and then also, uh, performance improvements, suggestions, and then also, um, do we have redundant builds right now, uh, between CI and Versal? Should we be passing the builds from CI to Versal instead of having Versal build independently? Uh, is that not a good idea? Why is that not a good idea? Um, um, what would be the recommended approach? Um, what would be the YC, uh, recommendation? Um, and then, what are the implications?


Got it, Mr. White. Here’s what you asked for—**Reaper**, **perf wins**, and **build strategy** (plus the YC-style recommendation).

---

# Neon “Reaper” (drop-in workflow)
Deletes **stale PR DB branches** on Neon so you don’t hit the 10-branch cap. It keeps `production` and `preview` safe, and only deletes branches that:
- match `preview-pr-<PR#>`
- have **no open PR** targeting `preview`
- (optional) are older than N hours

Add as `.github/workflows/neon-reaper.yml`:

```yaml
name: Neon Branch Reaper
on:
  schedule:
    - cron: "17 7 * * *"   # daily 07:17 UTC
  workflow_dispatch:
    inputs:
      dry_run:
        description: "Set to true to preview deletions"
        required: false
        default: "true"

permissions:
  contents: read
  pull-requests: read

jobs:
  reap:
    runs-on: ubuntu-latest
    env:
      NEON_PROJECT_ID: ${{ vars.NEON_PROJECT_ID }}
      NEON_API_KEY: ${{ secrets.NEON_API_KEY }}
      DRY_RUN: ${{ github.event.inputs.dry_run || 'true' }}
      GH_REPO: ${{ github.repository }}

    steps:
      - name: Install jq
        run: sudo apt-get update && sudo apt-get install -y jq

      - name: Fetch open PR numbers targeting preview
        id: prs
        run: |
          prs=$(gh api repos/$GH_REPO/pulls --paginate -q \
            '.[] | select(.base.ref=="preview" and .state=="open") | .number' | sort -n | xargs)
          echo "open_prs=$prs" >> $GITHUB_OUTPUT
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: List Neon branches
        id: branches
        run: |
          curl -sS -H "Authorization: Bearer $NEON_API_KEY" \
            "https://api.neon.tech/v2/projects/$NEON_PROJECT_ID/branches?include_table_counts=false&limit=200" \
            > branches.json
          cat branches.json | jq '.branches | length as $n | {count:$n, names:[.[].name]}' || true

      - name: Compute deletions
        id: plan
        run: |
          # Build a regex of open PR names: preview-pr-<num>
          OPEN_PRS=(${{ steps.prs.outputs.open_prs }})
          allow=("production" "preview")
          keep_regex="^($(printf 'preview-pr-%s|' "${OPEN_PRS[@]}" | sed 's/|$//'))$"
          [ "${#OPEN_PRS[@]}" -eq 0 ] && keep_regex="^$^" # match nothing if no open PRs

          # Select branches that look like preview-pr-<num>, not in open list, not long-lived
          to_delete=$(jq -r --argjson allow "$(printf '%s\n' "${allow[@]}" | jq -R . | jq -s .)" \
            --arg keep "$keep_regex" '
              [.branches[].name
               | select(startswith("preview-pr-"))
               | select((. as $n | ($allow | index($n)) | not))
               | select(test($keep) | not)
              ] | .[]' branches.json)

          echo "to_delete<<EOF" >> $GITHUB_OUTPUT
          echo "$to_delete" >> $GITHUB_OUTPUT
          echo "EOF" >> $GITHUB_OUTPUT

      - name: Delete branches (or dry-run)
        if: steps.plan.outputs.to_delete != ''
        run: |
          echo "Candidates:"
          echo "${{ steps.plan.outputs.to_delete }}"
          if [ "$DRY_RUN" = "true" ]; then
            echo "Dry run enabled; not deleting."
            exit 0
          fi
          while read -r name; do
            [ -z "$name" ] && continue
            echo "Deleting $name"
            # Look up branch ID
            id=$(jq -r --arg n "$name" '.branches[] | select(.name==$n) | .id' branches.json)
            curl -sS -X DELETE -H "Authorization: Bearer $NEON_API_KEY" \
              "https://api.neon.tech/v2/projects/$NEON_PROJECT_ID/branches/$id" \
              | jq -r '.'
          done <<< "${{ steps.plan.outputs.to_delete }}"
```

**Notes**
- Name pattern assumes your create-step uses `preview-pr-${{ github.event.number }}` (we’ve been standardizing on that).
- Flip `dry_run` to `"false"` when you’re happy.

---

# Performance improvements (quick wins)

1) **Build once, deploy prebuilt** (you already do this): `vercel build` in CI, then `vercel deploy --prebuilt`. That **avoids a second Vercel build**. Keep this. fileciteturn5file16L29-L36  
2) **Inject per-PR DB only at deploy:** add `--env DATABASE_URL=…` to your deploy step so previews don’t need project-level env churn. (Right now your preview workflow pulls envs; add the `--env` line in the deploy step.) fileciteturn5file16L26-L35  
3) **Cache pnpm store for local steps** (when you run any pnpm commands):  
   - `actions/setup-node@v4` with `cache: 'pnpm'` and `pnpm/action-setup@v4` speeds installs.  
4) **Parallelize fast checks:** run `typecheck`, `lint`, `unit` in parallel; keep E2E separate and non-blocking for PRs (block promotion instead).  
5) **Short canary before merge:** hit `/`, `/pricing`, and a **DB-touched route** (e.g., profile read) in the preview canary. It catches most issues in <30s.  
6) **Merge-queue lane:** for `merge_group`, run **only** `typecheck+lint+build` (you have the event wired)—keeps queue dwell tight.  
7) **Playwright perf:** shard tests, use web-first assertions and 1 retry; upload only failed traces/videos to cut artifact size.

---

# Are we duplicating builds? Recommended approach.

- **Your current preview deploy flow builds in CI and uses `--prebuilt`.** That means **no second build on Vercel**—good. Keep it. fileciteturn5file16L29-L36
- **What to tweak now:** add the per-deployment env injection so each preview gets its Neon pooled URL:
  ```bash
  vercel deploy --prebuilt \
    --token $VERCEL_TOKEN \
    --env DATABASE_URL=${{ needs.neon_create_and_check.outputs.DB_URL_POOLED }}
  ```
  (This complements your existing `vercel build`/`deploy` steps.) fileciteturn5file16L29-L36

### YC-style recommendation
- **Single source of truth = CI.** Build once in CI, **deploy prebuilt**, and **inject secrets per deployment**. It’s faster, deterministic, and avoids “works locally on Vercel” drift.  
- Keep PR CI **under ~5 minutes** (typecheck/lint/build + tiny canary). Heavier tests (E2E, synthetic) can run post-merge or on a schedule, and block **promotion** instead of PRs.

### Implications
- **Pros:** Faster previews, fewer flakes, simpler env management; zero duplication of builds; easy to reproduce.  
- **Cons:** CI does more work; if CI is down, deploys wait (mitigate with manual `workflow_dispatch`).  
- **Safety:** With the Reaper + per-PR env injection, you won’t hit Neon’s branch cap, and production/preview long-lived branches stay untouched.

If you want, I’ll also send a tiny patch to your preview deploy workflow adding the `--env DATABASE_URL=...` line right after `vercel deploy --prebuilt` and a guard to fail if the DB URL is empty.


What is the PR policy workflow?


In your CI setup, **“PR Policy”** is a lightweight workflow that enforces repository rules whenever someone opens or updates a pull request. It’s meant to catch structural / procedural problems before you waste cycles on heavy checks.  

Based on the files you shared earlier (`branch-protection.yml`, `auto-merge.yml`, `ci.yml`), the **PR Policy workflow** does things like:

- **Enforce base branch**: only allow PRs into `preview` (from feature branches) or `production` (from `preview`). Anything else fails immediately.  
- **Enforce naming / labels**: e.g. PR title, labels, or branch naming conventions must match your policy (some teams require `feature/...`, `fix/...`).  
- **Fast exit job**: runs in seconds, cancels further jobs if the PR is invalid.  
- **Required status check**: your branch protection rules list `PR Policy` as a required check, so a PR can’t be merged without it passing.  

It’s there to keep your merge queue clean and automated (Dependabot, AI agents, your own commits) without human babysitting.  

If you want, I can pull up your `branch-protection.yml` and show you the exact checks you’re enforcing under “PR Policy.” Would you like me to do that?


## See Also
- [[chatgpt/chatgpt_merge-queue-delay-explanation-part1]]
- [[chatgpt/chatgpt_merge-queue-delay-explanation-part2]]
- [[chatgpt/chatgpt_merge-queue-delay-explanation-part3]]
- [[chatgpt/chatgpt_merge-queue-explanation]]
- [[chatgpt/chatgpt_merge-queue-throughput-explanation]]
