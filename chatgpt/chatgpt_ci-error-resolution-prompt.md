---
title: "CI error resolution prompt"
type: note
created: 2025-08-07
updated: 2025-08-07
source: chatgpt-export
conversation_id: 6894ecdf-12a4-8325-b338-866909ba1a82
message_count: 2
tags: [chatgpt, import]
---
# CI error resolution prompt

> Conversation ID: 6894ecdf-12a4-8325-b338-866909ba1a82
> Created: 2025-08-07T18:14:22Z
> Updated: 2025-08-07T18:14:33Z
> Messages: 2

---

## User

Giv eme a prompt to eliminate all concosle log errors, all tests errors, all lint errors, and recursively work on the branch til its all green and deploying through ci perfectly.

---

## Assistant

**Prompt**

> **Mission:** On the current branch, wipe out every console-log warning, test failure, and lint error, then keep iterating until the CI pipeline is 100 % green and the Vercel preview deploys successfully.  
>
> **Rules of engagement**  
> 1. **No-console:** Replace or remove all `console.*` calls. Enforce ESLint `no-console` as `error`.  
> 2. **Lint-first:** Run `pnpm lint --fix`. Resolve every outstanding lint error (style, types, imports, etc.).  
> 3. **Test-next:** Run `pnpm test --watchAll=false`. Repair or rewrite failing tests _or_ application code so tests pass cleanly.  
> 4. **Build & type-check:** Run `pnpm build` and `pnpm tsc --noEmit`; fix any build or type errors.  
> 5. **Commit → push:** Use clear, conventional-commit messages (e.g., `fix: remove console logs & lint issues`). Push to origin.  
> 6. **CI loop:** Wait for the GitHub Actions / Vercel pipeline to finish. If any status check fails, pull the logs, diagnose, fix, commit, and push again. **Repeat until every check is green** (tests, lint, type check, build, deploy).  
> 7. **Finish line:** When the preview URL renders with no runtime errors and all checks pass, open a PR to `main` with the same title as the last commit and assign reviewers.

> **Constraint:** Do **not** stop or ask for clarification until the branch is completely clean and CI + deploy are flawless.
