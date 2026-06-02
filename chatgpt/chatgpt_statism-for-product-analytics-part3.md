
Here you go, Mr. White — copy-paste this into your agent as-is and let it run.

---

**Prompt for AI agent (pnpm + Turborepo + workspaces setup)**

You are operating on a **TypeScript/JavaScript monorepo** that we want to standardize around:

- **pnpm** as the package manager  
- **pnpm workspaces**  
- **Turborepo** for task orchestration  
- Root-level scripts for lint/typecheck/test/build that fan out to apps/packages  

Assume the repo structure is (or should become):

- `apps/web` – Next.js / React app deployed on Vercel  
- `apps/ios` – iOS app (Xcode + Fastlane)  
- `packages/backend` – backend / API code  
- `packages/shared-ui` – shared React components  
- `packages/shared-lib` – shared logic/utilities  

If some of these don’t exist, create minimal placeholders that don’t break anything.

Your job is to **fully set up pnpm workspaces + Turborepo + root scripts** so the repo is ready for CI and Husky hooks.

---

### 1. Ensure pnpm + workspace config

1. At the repo root, create or update `pnpm-workspace.yaml` to:

   ```yaml
   packages:
     - "apps/*"
     - "packages/*"
   ```

2. Ensure there is **no conflicting workspace config** from npm/yarn (if there is a `"workspaces"` field in `package.json`, you can keep it consistent with the above, but the source of truth is `pnpm-workspace.yaml`).

---

### 2. Root package.json setup

At the **repo root**, create or update `package.json` with at least:

- A `"scripts"` section that uses Turborepo to orchestrate tasks across workspaces.
- Dev dependencies for Turborepo, Husky, lint-staged, and commitlint (you do *not* need to configure Husky/commitlint hooks here, just ensure the deps and scripts exist).

Update the root `package.json` so it contains (merge with existing fields; do not delete other necessary fields):

```jsonc
{
  "scripts": {
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "test:ci": "turbo run test -- --runInBand",
    "build": "turbo run build",
    "prepush": "turbo run lint typecheck test --since=origin/main",
    "prepare": "husky install"
  },
  "devDependencies": {
    "turbo": "^2.0.0",
    "husky": "^9.0.0",
    "lint-staged": "^15.0.0",
    "@commitlint/cli": "^19.0.0",
    "@commitlint/config-conventional": "^19.0.0"
  },
  "lint-staged": {
    "apps/web/**/*.{js,jsx,ts,tsx}": [
      "eslint --fix",
      "prettier --write"
    ],
    "packages/**/*.{js,jsx,ts,tsx}": [
      "eslint --fix",
      "prettier --write"
    ],
    "*.{json,md,css,scss}": [
      "prettier --write"
    ]
  }
}
```

- Merge versions safely: if versions already exist, keep the **newest compatible**.
- Do **not** remove other scripts or devDependencies the repo already uses.

---

### 3. Add / update turbo.json

At the repo root, create or update `turbo.json` with a minimal but useful pipeline:

```json
{
  "pipeline": {
    "lint": {
      "outputs": []
    },
    "typecheck": {
      "outputs": []
    },
    "test": {
      "outputs": []
    },
    "build": {
      "dependsOn": ["^build"],
      "outputs": [
        "apps/web/.next/**",
        "dist/**"
      ]
    }
  }
}
```

Notes:

- Keep or merge any existing pipeline config; don’t destroy valid existing steps.
- The idea: every workspace can implement `lint`, `typecheck`, `test`, `build`, and turbo will orchestrate them.

---

### 4. Workspace-level package.json scripts

For each workspace under `apps/*` and `packages/*`, ensure `package.json` has appropriate scripts.

#### apps/web/package.json

If `apps/web` is a Next.js/React app, ensure it has:

```jsonc
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint --ext .js,.jsx,.ts,.tsx src",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

Adjust paths/frameworks as needed (e.g., if it’s not Next.js but still React, update accordingly).

#### packages/backend/package.json

Ensure:

```jsonc
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint --ext .js,.jsx,.ts,.tsx src",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

If the backend uses a different test runner (Jest, etc.), adapt `test` accordingly.

#### packages/shared-ui and packages/shared-lib

For each:

```jsonc
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint --ext .js,.jsx,.ts,.tsx src",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

Create minimal `tsconfig.json` where needed so `tsc --noEmit` and `build` work.

#### apps/ios

Do **not** try to wire iOS into Turborepo JS tasks for now; it’s fine that `apps/ios/package.json` is minimal or even missing. The JS pipeline is mainly for web/backend/packages.

---

### 5. ESLint / Prettier / TS config at root

At the repo root:

1. Create or update `.eslintrc.cjs` with a sane monorepo setup for TypeScript/React. For example:

   ```js
   module.exports = {
     root: true,
     parser: '@typescript-eslint/parser',
     parserOptions: {
       project: ['./tsconfig.base.json'],
       tsconfigRootDir: __dirname
     },
     env: {
       browser: true,
       node: true,
       es2021: true
     },
     plugins: ['@typescript-eslint', 'react', 'react-hooks'],
     extends: [
       'eslint:recommended',
       'plugin:@typescript-eslint/recommended',
       'plugin:react/recommended',
       'plugin:react-hooks/recommended',
       'plugin:import/recommended',
       'plugin:import/typescript',
       'prettier'
     ],
     settings: {
       react: {
         version: 'detect'
       }
     },
     rules: {
       'react/prop-types': 'off'
     }
   };
   ```

2. Create or update `.prettierrc`:

   ```json
   {
     "singleQuote": true,
     "trailingComma": "all",
     "semi": true,
     "printWidth": 100
   }
   ```

3. Create `tsconfig.base.json` at root if it doesn’t exist:

   ```json
   {
     "compilerOptions": {
       "target": "ES2020",
       "module": "ESNext",
       "moduleResolution": "Node",
       "strict": true,
       "jsx": "react-jsx",
       "esModuleInterop": true,
       "skipLibCheck": true,
       "forceConsistentCasingInFileNames": true,
       "baseUrl": ".",
       "paths": {
         "@shared-ui/*": ["packages/shared-ui/src/*"],
         "@shared-lib/*": ["packages/shared-lib/src/*"]
       }
     }
   }
   ```

4. Ensure each TS workspace (`apps/web`, `packages/backend`, `packages/shared-*`) has a `tsconfig.json` that `extends` this base:

   ```json
   {
     "extends": "../../tsconfig.base.json",
     "compilerOptions": {
       "outDir": "dist"
     },
     "include": ["src"]
   }
   ```

   Adjust relative paths depending on folder depth.

---

### 6. Husky minimal wiring

Do **not** add complex hooks here; just ensure Husky is installed and ready.

1. At the root, if `.husky/` does not exist, initialize:

   - Add a note in `README.md` that the developer must run:

     ```bash
     pnpm install
     pnpm prepare
     ```

2. Create `.husky/pre-commit` with:

   ```bash
   #!/usr/bin/env sh
   . "$(dirname "$0")/_/husky.sh"

   echo "Husky: running pre-commit (lint-staged)..."
   npx lint-staged
   ```

3. Create `.husky/pre-push` with:

   ```bash
   #!/usr/bin/env sh
   . "$(dirname "$0")/_/husky.sh"

   echo "Husky: running pre-push (turbo lint/typecheck/test since origin/main)..."
   pnpm prepush
   ```

4. Create `commitlint.config.cjs` at root:

   ```js
   module.exports = {
     extends: ['@commitlint/config-conventional'],
   };
   ```

5. Create `.husky/commit-msg`:

   ```bash
   #!/usr/bin/env sh
   . "$(dirname "$0")/_/husky.sh"

   npx commitlint --edit "$1"
   ```

Do not break existing Husky config if there is any; merge or upgrade it sensibly.

---

### 7. Basic pnpm + turbo usage notes (for humans)

Update `README.md` at the root to include a short section explaining:

- Install: `pnpm install`
- Run web dev: `cd apps/web && pnpm dev`
- Run all linters: `pnpm lint`
- Run typecheck: `pnpm typecheck`
- Run tests: `pnpm test`
- Build: `pnpm build`

Also note that pre-commit and pre-push hooks are powered by Husky and `lint-staged`, and that CI should run `pnpm lint`, `pnpm typecheck`, `pnpm test:ci`, and `pnpm build` at the root.

---

### 8. Final check

After making all changes:

1. Ensure `pnpm-lock.yaml` is up to date (run `pnpm install` if needed).
2. Ensure `pnpm lint`, `pnpm typecheck`, and `pnpm test` run successfully at the root (you can stub tests if none exist yet).
3. Do not introduce breaking changes to existing code; if you must add placeholder configs, keep them minimal and non-intrusive.

When you’re done, summarize the changes (files added/updated) in a short markdown list so a human can review.


Now make a prompt to get our CI inline


Here you go, Mr. White — drop this into your agent.

---

**Prompt for AI agent: bring CI in line with our pnpm + Turborepo monorepo**

You are configuring **GitHub Actions CI** for a **pnpm + Turborepo monorepo**.

Assume the repository already has (or is intended to have):

- `pnpm` as package manager  
- `pnpm-workspace.yaml` with:
  ```yaml
  packages:
    - "apps/*"
    - "packages/*"
  ```
- `turbo.json` with `lint`, `typecheck`, `test`, `build` pipelines  
- Root `package.json` with scripts:
  ```jsonc
  {
    "scripts": {
      "lint": "turbo run lint",
      "typecheck": "turbo run typecheck",
      "test": "turbo run test",
      "test:ci": "turbo run test -- --runInBand",
      "build": "turbo run build",
      "prepush": "turbo run lint typecheck test --since=origin/main"
    }
  }
  ```
- Monorepo layout:
  ```text
  apps/web        # Next.js / React app (Vercel)
  apps/ios        # iOS app (Fastlane)
  packages/backend
  packages/shared-ui
  packages/shared-lib
  ```
- We use: **Statsig, Supabase, Vercel, Clerk, RevenueCat, Sentry, GitHub Actions**.
- Default branch is (or will be) `main`.

Your job: **create/update CI workflows** so that:

- Every PR to `main` runs lint, typecheck, tests (JS/TS, and iOS if relevant).
- Every push to `main` runs the same checks, builds web, and deploys web to Vercel.
- iOS beta builds are wired with Fastlane but can be toggled easily (via condition).

Do not remove any existing workflows if they contain important logic; instead, consolidate or upgrade them to match these requirements.

---

### 1. PR CI workflow (`.github/workflows/ci.yml`)

Create or update `.github/workflows/ci.yml` with:

- Trigger: on `pull_request` targeting `main`.
- Use **pnpm** and **Turbo** for JS/TS parts.
- Separate job for iOS tests that only runs when iOS files change.

The workflow should look conceptually like this (you must produce valid YAML and adapt paths as needed):

```yaml
name: CI

on:
  pull_request:
    branches:
      - main

jobs:
  js:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Install deps
        run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm lint

      - name: Typecheck
        run: pnpm typecheck

      - name: Test
        run: pnpm test:ci

  ios:
    runs-on: macos-latest
    # Only run if something under apps/ios/ changed in this PR
    if: contains(join(github.event.pull_request.changed_files, ','), 'apps/ios/')
    steps:
      - uses: actions/checkout@v4

      - name: Set up Ruby
        uses: ruby/setup-ruby@v1
        with:
          ruby-version: '3.2'

      - name: Install Bundler deps
        run: cd apps/ios && bundle install

      - name: iOS tests
        run: cd apps/ios && bundle exec fastlane test
```

Tasks:

1. If there’s an existing CI workflow, merge these jobs into it or replace it cleanly, preserving any existing *necessary* checks.
2. Ensure `pnpm` caching is configured correctly with `cache: 'pnpm'` and `pnpm/action-setup`.
3. For iOS, if there is no `fastlane test` lane yet, assume it will be added by humans later; keep the job in place.

---

### 2. Deploy workflow for `main` (`.github/workflows/deploy.yml`)

Create or update `.github/workflows/deploy.yml` to:

- Trigger on `push` to `main`.
- Run the **same checks** as CI (`lint`, `typecheck`, `test:ci`) before deployment.
- Build and deploy `apps/web` to Vercel.
- Optionally run iOS beta lane via Fastlane (behind a simple condition we can flip).

The workflow should look conceptually like this:

```yaml
name: Deploy

on:
  push:
    branches:
      - main

jobs:
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'

      - name: Set up pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 9

      - name: Install deps
        run: pnpm install --frozen-lockfile

      - name: Lint
        run: pnpm lint

      - name: Typecheck
        run: pnpm typecheck

      - name: Test
        run: pnpm test:ci

      - name: Build web
        run: cd apps/web && pnpm build

      - name: Deploy to Vercel
        uses: amondnet/vercel-action@v25
        with:
          vercel-token: ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id: ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          working-directory: apps/web
          prod: true

  ios-beta:
    needs: web
    runs-on: macos-latest
    # Set to true/condition later when we want automatic beta builds; off by default.
    if: "false"
    steps:
      - uses: actions/checkout@v4

      - name: Set up Ruby
        uses: ruby/setup-ruby@v1
        with:
          ruby-version: '3.2'

      - name: Install Bundler deps
        run: cd apps/ios && bundle install

      - name: Fastlane beta
        run: cd apps/ios && bundle exec fastlane beta
```

Tasks:

1. If a Vercel GitHub integration is already configured in the repo, avoid duplicating deployment logic; either:
   - keep the GitHub ↔ Vercel integration and **skip** the `vercel-action`, or  
   - remove redundant integration and use the `vercel-action` as the single deployment path.

2. Ensure the workflow expects **Vercel secrets**:
   - `VERCEL_TOKEN`
   - `VERCEL_ORG_ID`
   - `VERCEL_PROJECT_ID`

   Do not create them; just reference them correctly.

3. Keep iOS beta job disabled by default via `if: "false"` or a similar simple condition/comment, so humans can turn it on later.

---

### 3. Root-level alignment: pnpm + Turbo commands

Verify that the CI workflows use **exactly** the same commands as defined in `package.json` scripts at the root:

- `pnpm lint` → `turbo run lint`
- `pnpm typecheck` → `turbo run typecheck`
- `pnpm test:ci` → `turbo run test -- --runInBand`
- `pnpm build` → `turbo run build`

If the root `package.json` scripts are inconsistent, adjust them so that:

```jsonc
{
  "scripts": {
    "lint": "turbo run lint",
    "typecheck": "turbo run typecheck",
    "test": "turbo run test",
    "test:ci": "turbo run test -- --runInBand",
    "build": "turbo run build",
    "prepush": "turbo run lint typecheck test --since=origin/main"
  }
}
```

Do not remove any other existing scripts that may be in use.

---

### 4. Optional: agents/backend job stub

If there is a `packages/backend` or `apps/agents` service that needs its own deploy, add a **placeholder job** (commented or simple) in `deploy.yml`, but:

- Do not implement full infra deployment (since credentials and infra choices might not be known).
- Add clear TODO comments for humans.

Example stub:

```yaml
  backend-deploy:
    needs: web
    runs-on: ubuntu-latest
    if: "false"  # TODO: enable when backend deployment strategy is ready
    steps:
      - uses: actions/checkout@v4
      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
      - uses: pnpm/action-setup@v4
        with:
          version: 9
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter packages/backend build
      # TODO: add deploy step (e.g., to Fly.io/Render/K8s)
```

---

### 5. Final sanity checks

After editing workflows:

1. Validate both YAML files are syntactically correct.
2. Ensure there are **no references to npm/yarn** in the workflows; everything JS/TS uses `pnpm`.
3. Ensure `on.pull_request` and `on.push` branches correctly target `main`.
4. Summarize changes in a short markdown list (files added/modified) so a human can review:

- `.github/workflows/ci.yml`
- `.github/workflows/deploy.yml`
- `package.json` (if adjusted)
- any other touched files

Return that summary at the end of your run.


Actually first we need an ai prompt to get our code moved to main and that set as default. Then we need to explain to the AI our rules for branching and commits so it can modify our agents.md file accordingly.


Here’s a two-step setup you can literally copy-paste into your agent system, Mr. White.

---

## Prompt 1 – Move code to `main` and set `main` as default

Use this first.

```text
You are a senior devops engineer with full access to this git repo and its GitHub remote.

Goal:
- Move our active code from the current default branch (likely "dev") onto "main".
- Make "main" the default branch on GitHub.
- Update configs so everything uses "main" going forward.

Constraints:
- Do NOT lose any commits.
- Do NOT delete any branches without explicit instruction.
- Prefer a clean, simple git history over cleverness.

Tasks:

1. Detect current default branch
   - Inspect the git remotes and branches to determine what branch currently holds the latest production-quality code (likely "dev").
   - Confirm whether a branch named "main" already exists locally or on origin.

2. Create or update "main"
   Case A: "main" does NOT exist yet
   - Create "main" from the current head of the active branch (e.g., "dev"):
     - `git checkout dev`
     - `git checkout -b main`
   - Push it:
     - `git push origin main`

   Case B: "main" already exists
   - Make sure "dev" (or current active branch) is fully merged into "main":
     - `git checkout main`
     - `git pull origin main`
     - `git merge dev` (or the current active branch)
   - Resolve any conflicts safely and conservatively:
     - Prefer keeping the latest working code from dev when in doubt.
   - Push updated main:
     - `git push origin main`

3. Set "main" as default branch on GitHub
   - Using the GitHub API or CLI (if available) or repository settings, set "main" as the default branch for the repository.
   - Double-check that:
     - New PRs default to target "main".
     - The old default (e.g., "dev") is no longer the default.

4. Update CI/config references from "dev" to "main"
   - Search the repo for references to the old branch name (e.g., "dev") in:
     - `.github/workflows/*.yml`
     - Vercel config (if present)
     - Any deployment scripts / docs
   - For GitHub Actions:
     - Update `on.push.branches` and `on.pull_request.branches` to use `main` instead of `dev`.
   - For Vercel:
     - If there is explicit config referring to "dev", update it to "main". Otherwise, leave Vercel to use its default behavior (build on main).

5. Preserve the old branch
   - Do NOT delete "dev" (or the prior default branch).
   - Leave it as a legacy branch for now so humans can verify history.
   - Optionally add a short note to the README or a CHANGES log: “Default branch is now main (was dev).”

6. Sanity checks
   - Ensure:
     - `git checkout main` works locally.
     - `git pull origin main` is clean.
     - CI is configured to run on PRs into main and pushes to main.
   - Summarize the exact commands run and files changed in a short markdown list for human review.
```


---

## Prompt 2 – Update `agents.md` with branching + commit rules

Use this after Prompt 1 is done.

```text
You are a senior engineering lead and documentation editor.

Goal:
- Update our `agents.md` file so that ALL AI agents and human devs follow the same branching and commit rules.
- We now use a trunk-based model with `main` as the single source of truth.

Context:
- Monorepo using pnpm + Turborepo.
- Default branch is now `main`.
- We use multiple concurrent AI agents for code changes and large refactors.
- We want `main` always deployable and clean.
- Tech stack: Statsig, Supabase, Vercel, Clerk, RevenueCat, Sentry, GitHub Actions, pnpm.

Tasks:

1. Open `agents.md`
   - Locate any existing sections that talk about:
     - branches
     - merge strategy
     - commit rules
     - PR process
   - You may replace outdated guidance wholesale if necessary, but preserve any still-relevant non-conflicting content.

2. Write a clear, concise “Branching Model” section
   The rules we want documented are:

   - Branches:
     - `main` is the trunk. It must always be green and deployable.
     - No long-lived `dev` branch. Work happens on short-lived branches off `main`.
     - Use the following naming conventions:
       - Features: `feat/<short-desc>` (e.g. `feat/new-onboarding`)
       - Bug fixes: `fix/<short-desc>`
       - Refactors: `refactor/<area>-<short-desc>`
       - Agent work / scratch: `agent/<agent-name>/<short-desc>`

   - Behavior:
     - All feature and refactor branches must be small and focused.
     - Agents and humans NEVER commit directly to `main`.
     - All changes to `main` go through a Pull Request (PR) into `main`.

3. Write a “Role of Agents vs Humans” section
   Capture these rules for agent behavior:

   - Agents:
     - Work only on non-main branches (`feat/*`, `fix/*`, `refactor/*`, `agent/*`).
     - May make many small or messy local commits while exploring.
     - Should run `pnpm lint`, `pnpm typecheck`, and tests locally where possible before signaling completion.

   - Humans:
     - Are responsible for:
       - Reviewing agent-generated changes.
       - Cleaning up commit history (e.g., squashing or reorganizing).
       - Opening PRs into `main`.
     - Decide what actually gets merged.

   - Rule of thumb:
     - Agents propose; humans dispose.
     - `main` reflects human-reviewed and CI-passing code only.

4. Write a “Commits and PRs” section
   Include the following policies:

   - Commit messages:
     - Use Conventional Commits style:
       - `feat: ...`
       - `fix: ...`
       - `refactor: ...`
       - `chore: ...`
       - `test: ...`
     - Agents may generate the initial commit messages, but humans can adjust them.

   - Commit shape:
     - Prefer a small number of meaningful commits per branch when merging into `main`.
     - For large, noisy agent work:
       - It is acceptable to squash agent commits into 1–3 clean commits before merging.

   - PR rules:
     - Every change to `main` must go through a PR.
     - PRs should be:
       - Small and focused.
       - Passing CI (`pnpm lint`, `pnpm typecheck`, `pnpm test:ci`).
     - At least one human must review the PR before merge.
     - Merge strategy: use **“Squash and merge”** to keep `main` history clean.

5. Write a “Feature Flags & Safety” section
   Explain how agents should treat risky / user-facing changes:

   - Any user-visible or risky behavior change must be behind a Statsig gate.
   - Example gate names:
     - `new_onboarding_v2`
     - `new_dashboard_v2`
     - `strict_reminders`
   - Pattern:
     - Implement new behavior behind a gate.
     - Default gate OFF for production users.
     - Internal testing: enable for staff/test users.
     - Gradual rollout (1% → 10% → 50% → 100%) controlled outside of code.
   - Agents should:
     - Add or respect existing gate checks instead of replacing them.
     - Avoid hard-wiring behavior that bypasses feature flags.

6. Write a “Monorepo + pnpm/Turbo Expectations” section
   Summarize for agents:

   - Always use `pnpm`, not npm or yarn.
   - Commands:
     - `pnpm install` at the root.
     - `pnpm lint` → runs Turborepo lint across workspaces.
     - `pnpm typecheck` → runs TypeScript checks.
     - `pnpm test` / `pnpm test:ci` → runs tests via Turborepo.
   - For workspace-specific commands:
     - `pnpm --filter <package-or-app> <script>` (e.g. `pnpm --filter apps/web lint`).
   - Do not introduce a different package manager.

7. Tone & structure of agents.md
   - Keep it **short, direct, and operational**. This file is for other AIs and human engineers.
   - Use clear headings, bullet points, and examples.
   - Remove any now-incorrect references to `dev` as the main branch.
   - Make sure the document reflects that:
     - `main` is the trunk.
     - Branch names follow the new conventions.
     - Agents don’t touch `main` directly.

8. Final step
   - After editing `agents.md`, ensure the markdown is valid and well-formatted.
   - At the end of the run, output a short summary of:
     - What sections were added or updated.
     - Any old guidance that was removed or replaced.
```

---

If you want, I can also give you a third prompt specifically for “lock our GitHub branch protection settings around `main`” so agents can’t accidentally bypass this.


Whats the production branch now? And write a prompt to setup the ci and clean up outdated ci files


The production branch **now is `main`** — that’s the trunk we’re standardizing on and the one CI/CD should target.

Here’s a prompt you can feed to an AI agent to **set up CI for `main` with pnpm + Turborepo** and **clean up outdated CI files**.

---

### Prompt: Align CI with `main` and clean old workflows

```text
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
```


Now final thing is were gonna move the repo from being itstimwhite/logyourbody to being jovieinc/logyourbody


Production branch is still **`main`** — we’re just changing the GitHub *owner* from `itstimwhite` to `jovieinc`, keeping the same repo name `logyourbody`.

Here’s a clean prompt you can give an AI agent to handle the move + cleanup.

---

## Prompt: Move repo to `jovieinc/logyourbody` and update everything

```text
You are a senior DevOps engineer with access to our GitHub repo and configuration.

Goal:
- Move the repository from `itstimwhite/logyourbody` to `jovieinc/logyourbody`.
- Keep `main` as the production branch.
- Update all local + CI + docs references to the new GitHub location.
- Ensure CI/CD and integrations (Vercel, etc.) still work afterward.

Context:
- Current repo slug: itstimwhite/logyourbody
- Target repo slug: jovieinc/logyourbody
- Production branch: main
- Monorepo using pnpm + Turborepo.
- Stack: Statsig, Supabase, Vercel, Clerk, RevenueCat, Sentry, GitHub Actions.

Assume:
- The GitHub org `jovieinc` already exists.
- We have permission to transfer the repo into that org.

Tasks:

1. Confirm current remote and branch
   - Inspect `.git/config` or run equivalent:
     - Confirm origin URL is something like:
       - `git@github.com:itstimwhite/logyourbody.git` or
       - `https://github.com/itstimwhite/logyourbody.git`
   - Confirm the default branch is `main`:
     - Check locally (HEAD) and via GitHub API if possible.

2. Transfer repo to `jovieinc`
   - Using the GitHub UI or API (recommended: `repos/transfer` endpoint), transfer the repository from user `itstimwhite` to organization `jovieinc`.
     - New full name: `jovieinc/logyourbody`.
   - Ensure:
     - Issues, PRs, branches, tags, branch protections, and Actions settings are preserved (GitHub does this automatically on transfer).
   - After transfer, verify:
     - The repo exists at `https://github.com/jovieinc/logyourbody`.
     - Default branch is still `main`.

3. Update all origin URLs (local + docs)
   - In the repo itself, update any references to the old slug:
     - Search for `itstimwhite/logyourbody` in:
       - README.md
       - docs/* (if any)
       - .github/workflows/*.yml
       - any other markdown or scripts.
     - Replace with `jovieinc/logyourbody`.
   - For example, README badges or links:
     - `https://github.com/itstimwhite/logyourbody/...` → `https://github.com/jovieinc/logyourbody/...`

4. Update Git remotes (instructions for humans)
   - Add or update a short section in the main README for human devs:
     - Show how to update their local origin:
       - For SSH:
         - `git remote set-url origin git@github.com:jovieinc/logyourbody.git`
       - For HTTPS:
         - `git remote set-url origin https://github.com/jovieinc/logyourbody.git`
   - Do not try to modify each developer’s local config; just document the change.

5. Align GitHub Actions with new slug (if needed)
   - Open `.github/workflows/*.yml` and:
     - Ensure all `on:` triggers still reference `main` as the branch:
       - `on: pull_request: branches: [main]`
       - `on: push: branches: [main]`
     - Remove any hard-coded references to `itstimwhite/logyourbody` if present (for example in status badges or curl calls).
   - Confirm workflows still:
     - Use pnpm (not npm/yarn).
     - Use the standardized root scripts:
       - `pnpm lint`
       - `pnpm typecheck`
       - `pnpm test:ci`
       - `pnpm build`

6. Vercel / integration checks
   - If there is a Vercel GitHub integration or an explicit repo reference:
     - Check if any config (vercel.json or project settings references) contains `itstimwhite/logyourbody`.
   - If needed, ensure the Vercel project is still mapped correctly:
     - Either re-link the Vercel project to `jovieinc/logyourbody` in Vercel settings, or
     - Keep existing deploy via `vercel-action` using the new repo path.
   - Do NOT change any secret names or tokens, just make sure Actions still run and Vercel deploys on pushes to `main`.

7. Other integrations (light audit)
   - Quickly grep for `itstimwhite` in the repo:
     - Update any URLs that point to the old GitHub profile or repo.
   - Statsig, Supabase, Clerk, RevenueCat, and Sentry typically do NOT depend on the GitHub slug, so only adjust if you find hard-coded references.

8. Sanity checks
   - After the transfer and code changes:
     - Ensure the repo at `jovieinc/logyourbody` shows `main` as default.
     - Ensure CI is still configured on PRs and pushes to `main`.
     - Confirm at least one workflow run succeeds on the new slug (on next PR or push).

9. Summary for humans
   - At the end of your changes, output a short markdown summary listing:
     - Confirmation that the repo was transferred to `jovieinc/logyourbody`.
     - Files where `itstimwhite/logyourbody` → `jovieinc/logyourbody` was updated.
     - Any remaining manual steps required in GitHub or Vercel UI (for example “verify Vercel project still linked to the new repo slug”).
```

If you want, I can also give you a tiny README snippet you can paste in for your team like: “We moved from `itstimwhite/logyourbody` to `jovieinc/logyourbody`, here’s how to update your remotes.”


## See Also
- [[chatgpt/chatgpt_statism-for-product-analytics-part1]]
- [[chatgpt/chatgpt_statism-for-product-analytics-part2]]
- [[chatgpt/chatgpt_statism-for-product-analytics-part4]]
- [[chatgpt/chatgpt_product-analytics-strategy]]
- [[chatgpt/chatgpt_3d-product-video-creation]]
