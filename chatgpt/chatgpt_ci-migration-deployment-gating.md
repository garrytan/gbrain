---
title: "CI Migration Deployment Gating"
type: guide
created: 2025-12-29
updated: 2025-12-29
source: chatgpt-export
conversation_id: 6952c897-e00c-832c-a4d1-e85175dc08a2
message_count: 2
tags: [chatgpt, import, code]
---
# CI Migration Deployment Gating

> Conversation ID: 6952c897-e00c-832c-a4d1-e85175dc08a2
> Created: 2025-12-29T18:30:18Z
> Updated: 2025-12-29T18:30:49Z
> Messages: 2

---

## User

That would be the proper way for us to ensure that if migrations fail on production in our CI, that the CI doesn't deploy. Currently we have migrations as a step in our CI, but it's still deploying even when migrations are failing.

---

## Assistant

Yes — deployments should be *gated* on the migration step’s **process exit code** and/or the **job status**. If you’re seeing deploys even when migrations “fail,” it almost always means one of these is happening:

- the migration command is returning **exit code 0** (so CI thinks it succeeded)
- the step is marked `continue-on-error` / `allow_failure`
- the deploy job doesn’t **depend on** (or isn’t conditioned on) the migrate job
- the shell is swallowing failures (missing `set -e`, using `|| true`, piping without `pipefail`, etc.)

Here’s the checklist that fixes it in basically every CI system:

### 1) Make migrations hard-fail the step
Run migrations in a way that **propagates non-zero exit codes**.

**Bash (common gotchas):**
```bash
set -euo pipefail
your_migrate_command
```

Avoid patterns like:
- `your_migrate_command || true`
- `your_migrate_command | tee logs.txt` (unless you also use `pipefail`)
- wrappers that catch exceptions and still `exit 0`

If migrations are in a script, ensure the script itself exits non-zero on failure.

### 2) Make deploy depend on migrate (job-level gating)
Don’t rely only on “step order.” Make deploy run **only if** the migration job succeeds.

- **GitHub Actions:** deploy job has `needs: migrate`, and `if: ${{ success() }}`
- **GitLab CI:** `deploy` has `needs: ["migrate"]` and deploy is in a later stage (and no `allow_failure`)
- **CircleCI:** use workflows with `requires: [migrate]`
- **Buildkite:** deploy step depends on migration step; no `allow_dependency_failure`
- **Jenkins:** stage will naturally stop on failure unless you’re using `catchError` or `unstable` semantics

### 3) Ensure migrations are not “allowed to fail”
Search your CI config for:
- `continue-on-error: true`
- `allow_failure: true`
- `fail_fast: false` (fine) but with allow-failure semantics elsewhere
- `when: always` / `if: always()` on deploy (this can override failure gating)

### 4) Make the deployment trigger itself conditional
Even with dependencies, also protect deploy with a final condition:

- only deploy on `main`/`release` branch
- only deploy if all required checks passed
- require “successful workflow” status for your environment

### 5) Extra safety (recommended)
Even if CI is perfect, add a *server-side* guard so production can’t deploy if migrations didn’t run:
- deployment pipeline checks a “migration completed” marker (e.g., DB table flag, release record)
- use an orchestration step that runs migrations *as part of* the deploy and aborts the rollout if it fails

---

If you tell me which CI you’re on (GitHub Actions / GitLab / Circle / Jenkins / Buildkite) and paste the relevant YAML around the migrate + deploy parts, I’ll point to the exact line causing the deploy to ignore the failure and show the minimal fix.
