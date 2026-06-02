
You are a senior DevOps engineer working on a GitHub monorepo.

Goal:
- Standardize CI on the new production branch: `main`.
- Use pnpm + Turborepo for all JS/TS workflows.
- Set up clean, minimal CI:
  - One main PR CI workflow.
  - One main deploy workflow.
- Remove or update outdated CI workflows that reference old branches or old tooling (e.g. npm/yarn, `dev` branch).
- Do NOT break any non-CI automations that are still useful (labelers, codeowners checks, etc).

Repository assumptions:
- Monorepo with `pnpm` as the package manager.
- `pnpm-workspace.yaml` exists with:
  - `apps/*`
  - `packages/*`
- Root `package.json` has scripts:
  - `"lint": "turbo run lint"`
  - `"typecheck": "turbo run typecheck"`
  - `"test": "turbo run test"`
  - `"test:ci": "turbo run test -- --runInBand"`
  - `"build": "turbo run build"`
- `turbo.json` defines `lint`, `typecheck`, `test`, `build` pipelines.
- Layout (at minimum):
  - `apps/web` – web app deployed to Vercel.
  - `apps/ios` – iOS app using Fastlane (optional in CI).
  - `packages/backend`, `packages/shared-*` – libraries/services.
- Stack: Statsig, Supabase, Vercel, Clerk, RevenueCat, Sentry, GitHub Actions.
- Production branch is `main`.

Tasks:

1. Scan existing workflows
   - Inspect `.github/workflows/*.yml`:
     - Identify all workflows.
     - For each, determine:
       - What event triggers it (`on`).
       - Which branch(es) it targets.
       - Whether it uses npm or yarn instead of pnpm.
       - Whether it overlaps with standard CI responsibilities:
         - lint, typecheck, tests, build, deploy.
       - Whether it is a non-CI utility (e.g. labeler, code scanning, etc.).
   - Make a short internal list of:
     - Core CI workflows (build/test/deploy).
     - Non-CI workflows (e.g., labelers, automations) that should be preserved.

2. Standardize PR CI on `main` (`ci.yml`)
   - Create or update `.github/workflows/ci.yml` with:
     - Trigger:
       ```yaml
       on:
         pull_request:
           branches:
             - main
       ```
     - A `js` job that:
       - Checks out the repo.
       - Sets up Node with caching for pnpm:
         - `actions/setup-node@v4` with `cache: 'pnpm'`.
       - Sets up pnpm via `pnpm/action-setup@v4`.
       - Runs:
         - `pnpm install --frozen-lockfile`
         - `pnpm lint`
         - `pnpm typecheck`
         - `pnpm test:ci`
     - An `ios` job (optional) that:
       - Runs only when `apps/ios/` has changes in the PR.
       - Uses `macos-latest`.
       - Checks out repo.
       - Sets up Ruby via `ruby/setup-ruby@v1`.
       - Runs:
         - `cd apps/ios && bundle install`
         - `cd apps/ios && bundle exec fastlane test`
     - Ensure **no npm or yarn commands** exist in this file; all JS/TS workflows must use pnpm.

3. Standardize deploy workflow on `main` (`deploy.yml`)
   - Create or update `.github/workflows/deploy.yml` with:
     - Trigger:
       ```yaml
       on:
         push:
           branches:
             - main
       ```
     - A `web` job that:
       - Checks out the repo.
       - Sets up Node (with pnpm cache) and pnpm (same as in `ci.yml`).
       - Runs:
         - `pnpm install --frozen-lockfile`
         - `pnpm lint`
         - `pnpm typecheck`
         - `pnpm test:ci`
         - `cd apps/web && pnpm build`
       - Deploys to Vercel using `amondnet/vercel-action@v25` (or keeps existing Vercel integration if already wired correctly):
         - Uses secrets:
           - `VERCEL_TOKEN`
           - `VERCEL_ORG_ID`
           - `VERCEL_PROJECT_ID`
         - `working-directory: apps/web`
         - `prod: true`
     - An `ios-beta` job (optional) that:
       - `needs: web`
       - Runs on `macos-latest`.
       - Is **disabled by default** with `if: "false"` or a comment explaining how to enable.
       - Steps:
         - Checkout.
         - Setup Ruby.
         - `cd apps/ios && bundle install`
         - `cd apps/ios && bundle exec fastlane beta`
     - Again, ensure no npm/yarn usage; only pnpm.

4. Update branch targets to `main`
   - In ALL remaining workflows in `.github/workflows`:
     - Replace any `dev` branch targets with `main`, where appropriate.
       - For example:
         - `on: push: branches: [dev]` → `[main]`
         - `on: pull_request: branches: [dev]` → `[main]`
     - If a workflow is clearly specific to a non-prod branch (e.g. old staging logic), leave it or mark it as deprecated with comments so humans know.

5. Clean up outdated CI workflows
   - For workflows whose responsibilities are now fully covered by `ci.yml` and `deploy.yml`:
     - Remove or simplify them.
     - Examples to remove:
       - Old CI files that:
         - use `npm install` / `yarn install` instead of pnpm.
         - run lint/tests/build for JS/TS in a way that duplicates `ci.yml`/`deploy.yml`.
         - target `dev` or other obsolete branches as their main purpose.
     - Keep and **do not modify**:
       - Labeler workflows.
       - Code scanning / security workflows.
       - Any automation not directly about build/test/deploy (unless clearly broken).
   - If you remove a workflow file, do so cleanly (delete the file) and ensure there is no dangling reference to it in docs.

6. Ensure consistency with root scripts
   - Confirm that:
     - `pnpm lint` in CI maps to `"lint": "turbo run lint"` in root `package.json`.
     - `pnpm typecheck` maps to `"typecheck": "turbo run typecheck"`.
     - `pnpm test:ci` maps to `"test:ci": "turbo run test -- --runInBand"`.
     - `pnpm build` maps to `"build": "turbo run build"`.
   - If scripts differ slightly but are functionally equivalent, prefer the standardized ones above and update `package.json` accordingly, without removing other useful scripts.

7. Sanity checks
   - Validate both `ci.yml` and `deploy.yml` as syntactically correct YAML.
   - Ensure:
     - All JS/TS tasks in workflows use pnpm.
     - All CI and deploy triggers reference `main`, not `dev`.
     - No duplicate deploys to Vercel are configured (either use the Vercel GitHub integration OR the `vercel-action`, but not both for the same event unless intentional).
   - Do not actually run CI, but ensure commands are consistent and runnable given the repo’s expected structure.

8. Summary for humans
   - At the end, output a short markdown summary listing:
     - New or updated workflow files (e.g. `ci.yml`, `deploy.yml`).
     - Any workflow files that were deleted as obsolete.
     - Any important notes or TODOs (e.g. “enable ios-beta job when ready”, “add backend deploy step later”, etc.).


Just adjust the prompt also include redoing our repos rulesets (not the old branch rules but the new rulesets) to make sure we require the right ci checks and remove old settings and align everything with the new pattern


Here’s your updated prompt with the repo rulesets / branch protection work baked in, Mr. White:

---

You are a senior DevOps engineer working on a GitHub monorepo.

Goal:
- Standardize CI on the new production branch: `main`.
- Use pnpm + Turborepo for all JS/TS workflows.
- Set up clean, minimal CI:
  - One main PR CI workflow.
  - One main deploy workflow.
- Remove or update outdated CI workflows that reference old branches or old tooling (e.g. npm/yarn, `dev` branch).
- Align GitHub repository rulesets / branch protection with the new `main`-centric, CI-backed workflow.
- Do NOT break any non-CI automations that are still useful (labelers, codeowners checks, etc).

Repository assumptions:
- Monorepo with `pnpm` as the package manager.
- `pnpm-workspace.yaml` exists with:
  - `apps/*`
  - `packages/*`
- Root `package.json` has scripts:
  - `"lint": "turbo run lint"`
  - `"typecheck": "turbo run typecheck"`
  - `"test": "turbo run test"`
  - `"test:ci": "turbo run test -- --runInBand"`
  - `"build": "turbo run build"`
- `turbo.json` defines `lint`, `typecheck`, `test`, `build` pipelines.
- Layout (at minimum):
  - `apps/web` – web app deployed to Vercel.
  - `apps/ios` – iOS app using Fastlane (optional in CI).
  - `packages/backend`, `packages/shared-*` – libraries/services.
- Stack: Statsig, Supabase, Vercel, Clerk, RevenueCat, Sentry, GitHub Actions.
- Production branch is `main`.

Tasks:

1. Scan existing workflows
   - Inspect `.github/workflows/*.yml`:
     - Identify all workflows.
     - For each, determine:
       - What event triggers it (`on`).
       - Which branch(es) it targets.
       - Whether it uses npm or yarn instead of pnpm.
       - Whether it overlaps with standard CI responsibilities:
         - lint, typecheck, tests, build, deploy.
       - Whether it is a non-CI utility (e.g. labeler, code scanning, etc.).
   - Make a short internal list of:
     - Core CI workflows (build/test/deploy).
     - Non-CI workflows (e.g., labelers, automations) that should be preserved.

2. Standardize PR CI on `main` (`ci.yml`)
   - Create or update `.github/workflows/ci.yml` with:
     - Trigger:
       ```yaml
       on:
         pull_request:
           branches:
             - main
       ```
     - A `js` job that:
       - Checks out the repo.
       - Sets up Node with caching for pnpm:
         - `actions/setup-node@v4` with `cache: 'pnpm'`.
       - Sets up pnpm via `pnpm/action-setup@v4`.
       - Runs:
         - `pnpm install --frozen-lockfile`
         - `pnpm lint`
         - `pnpm typecheck`
         - `pnpm test:ci`
     - An `ios` job (optional) that:
       - Runs only when `apps/ios/` has changes in the PR.
       - Uses `macos-latest`.
       - Checks out repo.
       - Sets up Ruby via `ruby/setup-ruby@v1`.
       - Runs:
         - `cd apps/ios && bundle install`
         - `cd apps/ios && bundle exec fastlane test`
     - Ensure **no npm or yarn commands** exist in this file; all JS/TS workflows must use pnpm.

3. Standardize deploy workflow on `main` (`deploy.yml`)
   - Create or update `.github/workflows/deploy.yml` with:
     - Trigger:
       ```yaml
       on:
         push:
           branches:
             - main
       ```
     - A `web` job that:
       - Checks out the repo.
       - Sets up Node (with pnpm cache) and pnpm (same as in `ci.yml`).
       - Runs:
         - `pnpm install --frozen-lockfile`
         - `pnpm lint`
         - `pnpm typecheck`
         - `pnpm test:ci`
         - `cd apps/web && pnpm build`
       - Deploys to Vercel using `amondnet/vercel-action@v25` (or keeps existing Vercel integration if already wired correctly):
         - Uses secrets:
           - `VERCEL_TOKEN`
           - `VERCEL_ORG_ID`
           - `VERCEL_PROJECT_ID`
         - `working-directory: apps/web`
         - `prod: true`
     - An `ios-beta` job (optional) that:
       - `needs: web`
       - Runs on `macos-latest`.
       - Is **disabled by default** with `if: "false"` or a comment explaining how to enable.
       - Steps:
         - Checkout.
         - Setup Ruby.
         - `cd apps/ios && bundle install`
         - `cd apps/ios && bundle exec fastlane beta`
     - Again, ensure no npm/yarn usage; only pnpm.

4. Update branch targets to `main`
   - In ALL remaining workflows in `.github/workflows`:
     - Replace any `dev` branch targets with `main`, where appropriate.
       - For example:
         - `on: push: branches: [dev]` → `[main]`
         - `on: pull_request: branches: [dev]` → `[main]`
     - If a workflow is clearly specific to a non-prod branch (e.g. old staging logic), leave it or mark it as deprecated with comments so humans know.

5. Clean up outdated CI workflows
   - For workflows whose responsibilities are now fully covered by `ci.yml` and `deploy.yml`:
     - Remove or simplify them.
     - Examples to remove:
       - Old CI files that:
         - use `npm install` / `yarn install` instead of pnpm.
         - run lint/tests/build for JS/TS in a way that duplicates `ci.yml`/`deploy.yml`.
         - target `dev` or other obsolete branches as their main purpose.
     - Keep and **do not modify**:
       - Labeler workflows.
       - Code scanning / security workflows.
       - Any automation not directly about build/test/deploy (unless clearly broken).
   - If you remove a workflow file, do so cleanly (delete the file) and ensure there is no dangling reference to it in docs.

6. Ensure consistency with root scripts
   - Confirm that:
     - `pnpm lint` in CI maps to `"lint": "turbo run lint"` in root `package.json`.
     - `pnpm typecheck` maps to `"typecheck": "turbo run typecheck"`.
     - `pnpm test:ci` maps to `"test:ci": "turbo run test -- --runInBand"`.
     - `pnpm build` maps to `"build": "turbo run build"`.
   - If scripts differ slightly but are functionally equivalent, prefer the standardized ones above and update `package.json` accordingly, without removing other useful scripts.

7. Update GitHub rulesets / branch protection for `main`
   - Inspect the repository’s **rulesets** and/or classic branch protection settings:
     - Identify any rules that:
       - Still reference `dev` or other obsolete branches.
       - Require old status checks (from removed/renamed workflows).
       - Allow direct pushes or force-pushes to `main`.
   - Create or update a **ruleset / branch protection** for `main` that enforces:
     - `main` is protected:
       - No direct pushes.
       - No force pushes.
       - Require pull requests for changes to `main`.
     - Required status checks must include:
       - The `js` job from `ci.yml`.
       - The `ios` job from `ci.yml`, **if** it exists and is intended to be mandatory.
     - Require PR reviews:
       - At least one human reviewer is required before merging into `main`.
     - Disallow merging when:
       - Required status checks have not passed.
       - The branch is out of date with `main` (if policy prefers that).
   - Remove or update old protections:
     - Delete/disable any rulesets that primarily target `dev` or other branches that are no longer part of the main flow.
     - Remove required checks that refer to:
       - Old workflow names.
       - Old job names.
       - npm/yarn-based CI that you’ve now deleted.
   - Ensure branch protection / rulesets do **not** block non-CI utility workflows (labelers, codeowners, etc.); they should only enforce:
     - PR requirement.
     - Status checks.
     - Review and push policies.

8. Sanity checks
   - Validate both `ci.yml` and `deploy.yml` as syntactically correct YAML.
   - Ensure:
     - All JS/TS tasks in workflows use pnpm.
     - All CI and deploy triggers reference `main`, not `dev`.
     - No duplicate deploys to Vercel are configured (either use the Vercel GitHub integration OR the `vercel-action`, but not both for the same event unless intentional).
   - Confirm that:
     - The `main` branch now has an up-to-date protection/ruleset attached.
     - The required status checks match the actual workflow/job names exactly.
   - Do not actually run CI, but ensure commands are consistent and runnable given the repo’s expected structure.

9. Summary for humans
   - At the end, output a short markdown summary listing:
     - New or updated workflow files (e.g. `ci.yml`, `deploy.yml`).
     - Any workflow files that were deleted as obsolete.
     - Any rulesets / branch protections that were created or modified (with a brief description of what they enforce).
     - Any important notes or TODOs (e.g. “enable ios-beta job when ready”, “hook backend deploy into deploy.yml later”, etc.).


Now give me a prompt to update our agents.md rule accrodingly


Here’s a prompt you can hand straight to an agent, Mr. White:

---

You are a senior engineering lead and documentation editor.

Goal:  
Update our `agents.md` so ALL AI agents and humans follow our **current** workflow:

- Production branch: `main` (trunk-based)
- Monorepo with `pnpm` + Turborepo
- CI standardized on `main` (PR CI + deploy workflows)
- Branch protection / rulesets require CI checks and PR review
- Feature flags via Statsig for risky changes

Assume:

- Repo layout:
  - `apps/web` – web app (Vercel)
  - `apps/ios` – iOS app (Fastlane)
  - `packages/backend`, `packages/shared-*` – libraries/services
- Root `package.json` scripts:
  - `"lint": "turbo run lint"`
  - `"typecheck": "turbo run typecheck"`
  - `"test": "turbo run test"`
  - `"test:ci": "turbo run test -- --runInBand"`
  - `"build": "turbo run build"`
- CI:
  - `.github/workflows/ci.yml` runs on PRs to `main` and has at least:
    - `js` job: pnpm install + lint + typecheck + test:ci
    - Optional `ios` job for iOS tests
  - `.github/workflows/deploy.yml` runs on pushes to `main`:
    - `web` job: pnpm install + lint + typecheck + test:ci + `apps/web` build + deploy to Vercel
    - Optional `ios-beta` job (usually disabled)
- GitHub rulesets / branch protection:
  - Protect `main`
  - Require PRs, CI checks, and at least one human review

Your tasks:

---

### 1. Open and analyze `agents.md`

- Locate any sections that describe:
  - Branching strategy
  - Commit rules
  - PR / merge workflow
  - Allowed actions for agents vs humans
  - CI expectations
- Identify and plan to remove/replace any references to:
  - `dev` as a primary branch
  - npm/yarn workflows instead of pnpm
  - old CI checks or branch names that no longer exist

---

### 2. Add/Update the “Branching Model” section

Ensure `agents.md` clearly states:

- **Production / trunk branch**
  - `main` is the single trunk / production branch.
  - `main` must always be:
    - Green in CI
    - Deployable

- **Branch types**
  - No long-lived `dev` branch.
  - Work happens on short-lived branches off `main`:
    - Features: `feat/<short-desc>`
      - e.g. `feat/new-onboarding`
    - Fixes: `fix/<short-desc>`
      - e.g. `fix/paywall-crash`
    - Refactors: `refactor/<area>-<short-desc>`
      - e.g. `refactor/metrics-layer`
    - Agent-only scratch branches (if needed):
      - `agent/<agent-name>/<short-desc>`

- **Rules**
  - Agents and humans **never** commit directly to `main`.
  - All changes flow via PRs into `main`.
  - Branches should be small and focused, optimized for quick review and merge.

Replace any old description of a `dev` branch or alternate mainline with this model.

---

### 3. Add/Update “Agents vs Humans” responsibilities

Make a dedicated section explaining:

- **Agents:**
  - Work only on non-`main` branches (`feat/*`, `fix/*`, `refactor/*`, `agent/*`).
  - May make messy/frequent local commits while working.
  - Should attempt to run:
    - `pnpm lint`
    - `pnpm typecheck`
    - `pnpm test` (or `pnpm test:ci` if appropriate)
    before declaring work complete.
  - Must **not**:
    - Push directly to `main`
    - Merge PRs into `main`
    - Change branch protection or CI configuration unless explicitly requested

- **Humans:**
  - Review and curate agent changes.
  - Clean up commit history (squash/rebase) before merging.
  - Open and manage PRs targeting `main`.
  - Decide which changes are merged and when.

Include a short rule of thumb like:  
> “Agents propose; humans dispose. `main` only contains human-reviewed, CI-passing code.”

---

### 4. Add/Update “Commits and PRs” rules

Document:

- **Commit messages:**
  - Use Conventional Commits style:
    - `feat: ...`
    - `fix: ...`
    - `refactor: ...`
    - `chore: ...`
    - `test: ...`
  - Agents can generate these; humans may edit for clarity.

- **Commit shape:**
  - For merge into `main`:
    - Prefer **a small number of meaningful commits**.
    - For large agent work:
      - Squash many agent commits into 1–3 clean commits before merge.

- **PR requirements:**
  - Every change to `main` must come via a PR targeting `main`.
  - PRs must:
    - Be small and focused.
    - Pass CI:
      - `js` job from `ci.yml`
      - `ios` job if required for the change (if iOS job exists and is enabled)
  - At least **one human review** is required before merging.
  - Merge strategy:
    - Prefer **“Squash and merge”** for PRs into `main` to keep history clean.

Mention explicitly that agents must not bypass PR requirements or required checks.

---

### 5. Add/Update “CI and Required Checks” section

Explain to agents:

- **Core CI commands (via pnpm + Turborepo):**
  - `pnpm lint` → runs `turbo run lint`
  - `pnpm typecheck` → runs `turbo run typecheck`
  - `pnpm test` / `pnpm test:ci` → runs `turbo run test`
  - `pnpm build` → runs `turbo run build`

- **CI expectations:**
  - PRs into `main` must pass the `ci.yml` workflow:
    - `js` job (always)
    - `ios` job, when relevant/required
  - Pushes to `main` trigger `deploy.yml` to:
    - Re-run checks
    - Build and deploy `apps/web` to Vercel
  - Agents:
    - Should rely on these commands and **must not introduce npm or yarn usage**.
    - Must keep workflow names and job names stable once they are referenced by branch protection / rulesets.

- **Branch protection context:**
  - `main` is protected:
    - No direct pushes.
    - Required status checks from CI must pass before merge.
  - Agents must assume:
    - Any PR that doesn’t pass `ci.yml` will be rejected.
    - They cannot and should not relax branch protection.

---

### 6. Add/Update “Feature Flags & Safety (Statsig)” section

Ensure there is a clear section describing:

- Any user-visible or risky change **must** be behind a Statsig gate.
- Gate naming examples:
  - `new_onboarding_v2`
  - `new_dashboard_v2`
  - `strict_reminders`
- Pattern for changes:
  1. Implement new logic behind a Statsig gate.
  2. Default gate OFF for production users.
  3. Internal testing via enabling for staff/test users.
  4. Gradual rollout (e.g. 1% → 10% → 50% → 100%), controlled outside code.
- Agents should:
  - Respect existing gates.
  - Add new gates for new behavior rather than rewriting code to bypass gates.
  - Never hard-code permanent “new behavior” without a gate if it is risky or user-facing.

---

### 7. Add/Update “Monorepo + pnpm/Turbo” expectations

Clarify for agents:

- Always use **pnpm**, never npm or yarn.
- Monorepo commands:
  - At root:
    - `pnpm install`
    - `pnpm lint`
    - `pnpm typecheck`
    - `pnpm test` / `pnpm test:ci`
    - `pnpm build`
  - For specific apps/packages, use filters:
    - `pnpm --filter apps/web lint`
    - `pnpm --filter packages/backend test`
- Do not introduce:
  - new package managers
  - conflicting script patterns (e.g. running `eslint` directly instead of via `pnpm lint` for cross-repo logic)

Mention that **agents must align with existing scripts** instead of inventing new command entrypoints for common tasks.

---

### 8. Clean up outdated content

- Remove or rewrite any parts of `agents.md` that:
  - Refer to `dev` as primary or production branch.
  - Describe a different branching model than the one above.
  - Reference npm/yarn-based workflows instead of pnpm.
  - Mention old CI job names or workflows that have been replaced by `ci.yml` / `deploy.yml`.

Keep any still-accurate content (e.g., coding style, API usage) that does not conflict with the new rules.

---

### 9. Final formatting & summary

- Ensure headings are clear (e.g. `## Branching Model`, `## Agents vs Humans`, `## Commits and PRs`, etc.).
- Use bullets and short paragraphs for readability.
- At the end of your run, output a short markdown summary listing:
  - Sections added or updated.
  - Any deprecated rules removed.
  - Any explicit instructions agents should especially pay attention to (e.g. “never push to main”, “always gate risky changes with Statsig”, “always use pnpm”).


Now my app is crashing on account creation. Ive sent in TestFlight reports. How do i get this reports into a format my ai agents can read to fix. Is there an automation we can put in place to automatically open a branch to work on TestFlight crashes and have AI fix em?


You’ve basically just invented “AI on-call for TestFlight,” Mr. White. Totally doable.

Let’s break it into two problems:

1. **Turn TestFlight crash reports into AI-readable input.**  
2. **Automation: when a new crash appears → open branch + task for agents.**

---

## 1. Getting TestFlight crash reports into AI-friendly form

TestFlight crash data ultimately lives in **App Store Connect / Xcode** as:

- Symbolicated stack traces (once dSYMs are uploaded)
- Threads, exception type, signal, app version, OS, device

You want that in **plain text + context**.

### A. Make sure crashes are symbolicated

If you’re not already:

- Upload dSYMs either via Xcode or Fastlane (`upload_symbols_to_app_store` or Sentry upload, etc.).
- Confirm that in Xcode Organizer or App Store Connect you see human-readable method names, not raw addresses.

Without symbolication, AI will be guessing.

### B. Export / pull the crash data

You’ve got a few options:

**Option 1: Sentry as the crash aggregation layer**

Strongly recommend this for your “AI” pipeline:

1. Integrate Sentry iOS SDK (if you haven’t already).
2. In the Fastlane lanes (`beta` / `release`), upload dSYMs to Sentry.
3. Sentry gives you:
   - Fully symbolicated stack trace
   - Issue title
   - Frequency (number of users, events)
   - Tags (app version, OS, device)

Now the AI can work off Sentry’s issue JSON:

- Use Sentry’s API to pull:
  - top crashes in the last N hours
  - stack trace
  - culprit file/line
  - context (breadcrumbs, tags)

**Option 2: Raw Apple crash logs**

If you don’t want Sentry:

- Use Xcode / App Store Connect to **download symbolicated crash logs** as `.crash` files.
- Those are just structured text. You can:
  - save them in `crashes/` in your repo, or
  - paste the relevant sections into an issue.

For automation though, Sentry is a lot easier.

---

## 2. Automation: “New crash → new branch + AI fix”

Yes, you can absolutely automate this. Pattern:

> Crash source (Sentry/TestFlight) → GitHub Issue → GitHub Actions workflow → new branch + AI agent run.

### Step-by-step design

#### Step 1 – Crash → GitHub issue

Use **Sentry → GitHub integration** or your own script:

- Every new Sentry issue **or** every new event that crosses a threshold (e.g. > X users) creates/updates a GitHub Issue:
  - Title: `Crash: <exception> at <symbol>`
  - Body includes:
    - Stack trace (symbolicated)
    - Sentry issue URL
    - App version, device, OS
    - Any relevant breadcrumbs

If you’re not using Sentry, you can have a script that:

- Periodically pulls crash logs from App Store Connect API
- For any new unique signature:
  - Opens a GitHub issue with the stack trace pasted in

#### Step 2 – Issue → branch + AI job

Now wire a GitHub Action that triggers on label or manual dispatch:

- Trigger:
  - `workflow_dispatch` with an input (issue number), or
  - `issues` event when labeled with `crash/testflight`

Workflow logic:

1. **Create a branch**:

   - Branch name like:
     - `fix/crash-<issue-number>-<short-slug>`
   - From `main`.

2. **Generate a context file for the agent**:

   - Create or update something like `ai_tasks/crash_<issue-number>.md`:
     - Include:
       - Issue title + link
       - Stack trace
       - App version, OS, device info
       - “What we think broke” if any heuristics
   - Commit that file to the new branch.

3. **Kick off your AI agent pipeline**:

   However you’re running agents (Cascade/Windsurf/Codex/Codeine):

   - The workflow can:
     - Hit your AI Orchestrator endpoint with:
       - repo URL
       - branch name
       - path to crash context file
     - Or just leave the branch ready and your orchestrator polls/acts on “branches with `fix/crash-*`” naming pattern.

4. **AI agent responsibilities on that branch**:

   In the prompt you give the agent, define:

   - Read `ai_tasks/crash_<issue-number>.md`.
   - Locate the referenced code (by file/line from stack trace).
   - Propose a fix:
     - Modify Swift/SwiftUI code accordingly.
     - Add or update **unit/integration tests** if appropriate.
   - Run:
     - `pnpm lint`
     - `pnpm typecheck`
     - any iOS tests via `bundle exec fastlane test` or `xcodebuild` lane.
   - Create commits with messages like:
     - `fix: handle nil account state in signup flow`
   - Signal completion by pushing the branch.

5. **CI + PR stage**

- Once the branch is pushed:
  - Existing CI runs (from your `ci.yml`).
  - Create a PR:
    - Either automatically via GitHub Action / bot, or
    - Have your agent call the GitHub API.

- PR template can auto-link the Sentry/TestFlight issue:
  - “Fixes crash: #<issue-number>”

- Human reviews, then:
  - “Squash and merge” to `main`.

---

## 3. Concrete sketch of the automation

High-level workflow you’d put in `.github/workflows/crash-fixer.yml`:

- Trigger:
  - `workflow_dispatch` with `issue_number`
  - `issues` when labeled `crash/testflight`

- Steps:
  1. Checkout repo.
  2. Use GitHub API to fetch the issue body.
  3. Generate `ai_tasks/crash_<issue>.md` with that content.
  4. Create branch `fix/crash-<issue>`.
  5. Commit + push.
  6. Call your **AI orchestrator** (Codex/Codeine) with:
     - branch name
     - path to crash file.

Your orchestrator then:

- Pulls that branch.
- Runs the AI agent with a prebuilt prompt:
  - “You are fixing a production TestFlight crash. Crash report: [contents]. Codebase: [monorepo]. Do X, Y, Z.”
- Let the agent commit + push back to that branch.

---

## 4. Prompt template for the “fix this crash” agent

Something like this for your agent:

> You are an iOS engineer working on a monorepo.  
> The branch you’re on was auto-created to fix a real TestFlight crash.  
> Crash context is in `ai_tasks/crash_<issue>.md`.
> 
> **Goals:**
> - Understand the crash from the stack trace and context.
> - Identify the root cause in the Swift/SwiftUI code.
> - Implement the smallest safe fix.
> - Add or update tests if possible.
> - Run:
>   - `pnpm lint`
>   - `pnpm typecheck`
>   - `cd apps/ios && bundle exec fastlane test` (if configured)
> - Commit changes using Conventional Commit style:
>   - `fix: ...`
> 
> **Constraints:**
> - Do not change CI/deploy workflows.
> - Do not touch unrelated features.
> - Prefer guards and safe handling over hiding errors.
> - Keep the diff as small and focused as possible.
> 
> When done, ensure:
> - All tests pass locally (or report clearly which ones fail).
> - The crash context file is updated with a short “Root cause + fix summary”.

---

## 5. Minimal manual fallback for right now

Until you wire all the automation, you can do a low-tech version:

1. From Xcode / App Store Connect:
   - Download one symbolicated crash log.
2. Paste it into:
   - `ai_tasks/crash_YYYYMMDD_account_creation.md`.
3. Create a branch:
   - `fix/crash-account-creation`.
4. Let your favorite agent (Cascade/Windsurf) run on that branch using the prompt above.

That’ll get your **account creation crash** moving today while you build the full pipeline.

---

If you tell me whether you’re already piping crashes into Sentry or only TestFlight, I can outline the exact GitHub Action + API sequence for **that** source specifically.


## See Also
- [[chatgpt/chatgpt_statism-for-product-analytics-part1]]
- [[chatgpt/chatgpt_statism-for-product-analytics-part2]]
- [[chatgpt/chatgpt_statism-for-product-analytics-part3]]
- [[chatgpt/chatgpt_product-analytics-strategy]]
- [[chatgpt/chatgpt_3d-product-video-creation]]
