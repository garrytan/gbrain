---
title: "CI improvement suggestions"
type: note
created: 2025-08-07
updated: 2025-08-07
source: chatgpt-export
conversation_id: 68950432-b190-8327-ab2a-d37eaef0e4f5
message_count: 2
tags: [chatgpt, import]
---
# CI improvement suggestions

> Conversation ID: 68950432-b190-8327-ab2a-d37eaef0e4f5
> Created: 2025-08-07T19:53:24Z
> Updated: 2025-08-07T19:58:27Z
> Messages: 2

---

## User

Identify issues with the ci. Tell me if i should improve anything. Ensure that preview and main only ever get touched if theyve first gone to develop and passed checks.

---

## Assistant

Mr. White — here’s the straight shot.

# What’s broken / brittle
- **Required workflow name mismatch.** Rules require `codeql-analysis.yml`, but your file is `codeql.yml` → the rule will never be satisfied. Fix the filename or the rule. fileciteturn1file3L28-L31 fileciteturn1file6L12-L20  
- **Required status checks that don’t exist.** You require `test`, `lint`, `typecheck`, etc., but your workflows surface job-level checks like `build/deploy/promote`, not separate `test`/`lint` contexts. Either split jobs or change the required contexts to match reality. fileciteturn1file3L15-L22 fileciteturn1file4L11-L35 fileciteturn1file10L11-L35  
- **Environment name mismatch.** Rules require deployment to `preview`, but the workflow deploys to environment `Preview` (different string). Standardize to one. fileciteturn1file3L32-L36 fileciteturn1file10L45-L49  
- **Promotion to main is not idempotent.** `preview → main` always tries to create a new `auto-promote/main` branch/PR; no check for existing PR and no `--force-with-lease` update → flaky on reruns. Mirror the idempotent logic you used for `develop → preview`. fileciteturn1file7L9-L18 fileciteturn1file7L31-L41 fileciteturn1file8L36-L45  
- **Security scans after deploy.** Move dependency audit **before** deploy to actually gate releases. (It currently runs after deploy in both pipelines.) fileciteturn1file2L43-L44 fileciteturn1file5L36-L37  
- **E2E smoke test disabled.** You commented it out; that removes your last-mile validation. Re-enable a tiny Playwright smoke hitting the preview URL. fileciteturn1file2L36-L41  
- **Redundant artifacts.** You upload/download `.next/standalone`, then run `vercel build` and deploy `--prebuilt` from that build. The earlier artifact is unused; drop it (or skip `vercel build` and deploy the artifact you actually built). fileciteturn1file4L37-L43 fileciteturn1file4L74-L84 fileciteturn1file2L11-L27  
- **Secrets exposure.** You inject service-role and Stripe secrets into GH job envs while also doing `vercel pull`. Prefer Vercel envs and keep GH env lean (no service-role in CI). fileciteturn1file4L47-L56 fileciteturn1file4L74-L76 fileciteturn1file10L52-L58  
- **Global build workflow is too broad.** `build.yml` fires on *every* push/PR to *every* branch; likely duplicating checks and slowing the queue. Scope it or delete if redundant. fileciteturn1file1L3-L11  
- **Dependabot gate relies on a check name that may not exist.** It waits for `pr-verify`; make sure that workflow actually runs on those PRs. fileciteturn1file0L38-L47  
- **Ruleset YAMLs are aspirational unless applied.** `branch-protection.yml`, `code-quality.yml`, `security-rules.yml` won’t do anything by simply existing; ensure you’re applying them via rulesets/API or a governance workflow. (They currently reference many non-existent contexts.) fileciteturn1file12L10-L18 fileciteturn1file9L10-L17

# Improvements I’d ship now
1) **Enforce the flow (develop → preview → main).**  
   - Restrict who can push to `preview` and `main` (no direct pushes; merges only).  
   - In your PR-verify workflow (already required), **fail** if:  
     • base=`preview` and head≠`auto-promote/preview`, or base=`main` and head≠`auto-promote/main`. fileciteturn1file3L28-L31  
   - In `develop-ci`, after tests pass, set a commit status like `origin:develop=passed` on the promotion head; make `web-pr-verify` require that for `preview` PRs. Do the same (`origin:preview=passed`) before promoting to `main`. (This guarantees the commit came through the previous stage.) fileciteturn1file4L31-L35 fileciteturn1file8L12-L21  
2) **Fix names.** Rename env `Preview` → `preview` and align required workflow names to actual files (`codeql.yml` or rename file → `codeql-analysis.yml`). fileciteturn1file10L45-L49 fileciteturn1file3L28-L36  
3) **Make promotion idempotent.** In `preview-ci`, check for an existing PR/branch and update it (mirror your develop logic) and use `--force-with-lease`. fileciteturn1file7L9-L18 fileciteturn1file8L36-L45  
4) **Move audits before deploy** and fail the job on high vulns. fileciteturn1file2L43-L44 fileciteturn1file5L36-L37  
5) **Re-enable a tiny Playwright smoke** against `${{ steps.vercel.outputs.url }}`; keep E2E <60s. fileciteturn1file2L36-L41  
6) **Trim redundancy.** Drop the `.next/standalone` artifact in these pipelines or remove `vercel build` and deploy the artifact—pick one path. fileciteturn1file4L37-L43 fileciteturn1file4L74-L84  
7) **Tighten permissions.** Add `permissions:` at the workflow top (read-only by default); grant `contents/pull-requests:write` only in promotion jobs. (Your `dependabot-auto-merge` already scopes perms correctly.) fileciteturn1file0L9-L12  
8) **Scope `build.yml`.** Limit to `[develop, preview, main]` or delete if `_reusable-build.yml` duplicates other jobs. fileciteturn1file1L3-L11

# Answer to your constraint
Yes—you **can** ensure `preview` and `main` only get touched after `develop` passes checks by: locking direct pushes, forcing PRs from `auto-promote/*`, and requiring the “came-from-previous-stage” status in `web-pr-verify`. That enforces the exact flow you want, end-to-end. fileciteturn1file3L28-L36
