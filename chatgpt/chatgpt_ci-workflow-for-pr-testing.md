---
title: "CI workflow for PR testing"
type: guide
created: 2025-07-25
updated: 2025-07-25
source: chatgpt-export
conversation_id: 688334e6-20f8-8333-abc3-e2430f14fda6
message_count: 4
tags: [chatgpt, import, code]
---
# CI workflow for PR testing

> Conversation ID: 688334e6-20f8-8333-abc3-e2430f14fda6
> Created: 2025-07-25T07:40:23Z
> Updated: 2025-07-25T07:41:16Z
> Messages: 4

---

## User

We need a workflow in ci that can look at open prs that aren't dev, preview, or main and run tests before it goes back to our dev branch.  Suggest a workflow based on best practices from top yc companies

---

## Assistant

Here’s a GitHub Actions CI workflow that follows best practices from top YC companies (e.g. linear, retool, zapier) for safe and scalable PR testing **before merging into the `dev` branch**, while skipping system branches like `dev`, `preview`, and `main`.

---

### 🔧 Workflow: `.github/workflows/pr-check.yml`

```yaml
name: PR Checks

on:
  pull_request:
    branches-ignore:
      - main
      - dev
      - preview

jobs:
  pr-check:
    name: Test on Pull Request
    runs-on: macos-latest # or ubuntu-latest if not iOS
    if: github.event.pull_request.base == 'dev'
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set up Node (or your env)
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Set up Ruby (if using Fastlane)
        uses: ruby/setup-ruby@v1
        with:
          ruby-version: 3.2

      - name: Install dependencies
        run: |
          npm ci
          bundle install

      - name: Run tests
        run: npm run test # or your test command

      - name: Lint code
        run: npm run lint # optional

      - name: Report status
        if: ${{ failure() }}
        run: echo "Tests failed on PR to dev" && exit 1
```

---

### ✅ Best Practice Highlights

- **Branch filtering**: Explicitly skips `main`, `preview`, and `dev` in the trigger, then **only runs if merging *into* `dev`**.
- **Fail fast**: Block merges unless tests pass.
- **Modular & fast**: Lean steps, scoped installs, avoids overfetching.
- **Team scale ready**: Ensures only fully tested PRs hit `dev`, aligning with trunk-based flow used by top YC startups.

Want me to auto-trigger `dev` → `preview` merges on green?

---

## User

Look at our existing workflow and then suggest what we need to add or change to implement this

---

## Assistant

You already have a solid modular CI/CD system. To **enforce test runs for PRs into `dev` from feature branches**, while skipping system branches (`main`, `preview`, `dev`), here’s what to add or change:

---

### ✅ What's already in place

- `main-orchestrator.yml` routes PRs to `pr-ios-checks` or `pr-web-checks` if they're not into `main`, `preview`, or `dev`【25†main-orchestrator.yml†L10-L21】.
- `ios-pr-verify.yml` is scoped to PRs into `dev`, and only for iOS files【20†ios-pr-verify.yml†L3-L6】.
- This means **you already test iOS PRs into `dev`**.
- `dependabot-auto-merge.yml` checks test status for Dependabot PRs【18†dependabot-auto-merge.yml†L1-L5】.

---

### 🔧 What to Add

#### 1. **Enforce all PRs into `dev` must pass checks before merging**

In GitHub repo settings:
- Enable **branch protection** on `dev` with:
  - ✅ Require status checks to pass before merging
  - ✅ Required checks: `PR iOS Checks`, `PR Web Checks`, and/or `ci-summary` (if applicable)
  - ✅ Require branches to be up to date before merging

---

#### 2. **Optional: Create a cleaner unified `ci-pr-checks.yml`**

If you want more clarity or need to run iOS + web + shared tests together in one place, create:

```yaml
# .github/workflows/ci-pr-checks.yml
name: PR Branch Checks

on:
  pull_request:
    branches: [dev]
    paths-ignore:
      - '.github/**'
      - '**/*.md'

jobs:
  detect:
    runs-on: ubuntu-latest
    outputs:
      ios: ${{ steps.changes.outputs.ios }}
      web: ${{ steps.changes.outputs.web }}
    steps:
    - uses: dorny/paths-filter@v3
      id: changes
      with:
        filters: |
          ios:
            - 'apps/ios/**'
          web:
            - 'apps/web/**'

  ios:
    if: needs.detect.outputs.ios == 'true'
    uses: ./.github/workflows/ios-pr-verify.yml
    needs: detect
    secrets: inherit

  web:
    if: needs.detect.outputs.web == 'true'
    uses: ./.github/workflows/web-pr-checks.yml
    needs: detect
    secrets: inherit
```

---

### ✅ Summary

You don’t need to rewrite workflows. Just:
- ✅ Enable branch protection on `dev`
- 🧪 Optionally combine PR checks into one dispatcher workflow for visibility

Would you like me to generate a `ci-pr-checks.yml` file tailored for your setup?
