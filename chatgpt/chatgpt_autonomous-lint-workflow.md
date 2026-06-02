---
title: "Autonomous lint workflow"
type: guide
created: 2025-11-20
updated: 2025-11-20
source: chatgpt-export
conversation_id: 691e78e5-3264-8330-87bf-d7f7fb9f0f35
message_count: 6
tags: [chatgpt, import, code]
---
# Autonomous lint workflow

> Conversation ID: 691e78e5-3264-8330-87bf-d7f7fb9f0f35
> Created: 2025-11-20T02:12:12Z
> Updated: 2025-11-20T02:47:48Z
> Messages: 6

---

## User

Rewrite this windsurf workflow to be autonomous an iteratively resolve all errors and rerun lint and loop til 0 errors

run all:
bundle exec fastlane ios lint       # verify (same as CI)
bundle exec fastlane ios fix_style  # optional: auto-fix, then re-run lint

then fix all errors and rerun

---

## Assistant

Here you go, Mr. White:

```bash
# Autonomous lint + fix loop: keep running until there are 0 errors

while true; do
  echo "Running lint…"
  if bundle exec fastlane ios lint; then
    echo "✅ Lint passed with 0 errors."
    break
  fi

  echo "Lint failed. Attempting auto-fix…"
  bundle exec fastlane ios fix_style

  echo "Re-running lint after auto-fix…"
  if bundle exec fastlane ios lint; then
    echo "✅ Lint passed after auto-fix."
    break
  fi

  echo "Still failing. Looping to try again…"
done
```

If you just want the core loop as short as possible:

```bash
while ! bundle exec fastlane ios lint; do
  bundle exec fastlane ios fix_style
done
```

---

## User

Create a workflow to commit and push

---

## Assistant

Got you, Mr. White. Here’s a simple autonomous workflow that lints, fixes, then commits and pushes if there are changes.

```bash
#!/usr/bin/env bash
set -euo pipefail

# Usage: ./lint_commit_push.sh "chore: ios lint & style fixes"
MSG="${1:-chore: ios lint & style fixes}"

echo "=== Lint + fix loop ==="
while ! bundle exec fastlane ios lint; do
  echo "Lint failed, running auto-fix…"
  bundle exec fastlane ios fix_style
done
echo "✅ Lint clean."

echo "=== Git commit & push ==="
# Check if there’s anything to commit
if git diff --quiet && git diff --cached --quiet; then
  echo "No changes to commit."
  exit 0
fi

git add -A
git commit -m "$MSG"
git push

echo "✅ Changes committed and pushed."
```

Run it like:

```bash
chmod +x lint_commit_push.sh
./lint_commit_push.sh "chore: ios lint & style fixes"
```

---

## User

Its a windsurf workflow so we can write it out as an ai prompt

---

## Assistant

Got it, Mr. White — here’s a Windsurf-style AI workflow prompt you can drop straight in:

---

**Windsurf Workflow Prompt – Lint, Fix, Commit, Push**

You are an autonomous coding agent working in a Ruby/iOS repo.

Your job is to:

1. **Run lint in a loop until it passes**
   - Run:
     - `bundle exec fastlane ios lint`
   - If lint fails:
     - Run: `bundle exec fastlane ios fix_style`
     - Then re-run: `bundle exec fastlane ios lint`
   - Repeat this lint → fix → lint loop until `bundle exec fastlane ios lint` exits with success (0 errors).

2. **Check for changes**
   - After lint passes, check if there are any Git changes (staged or unstaged).
   - If there are **no changes**, output a short message like:
     - `"Lint passed and there are no changes to commit."`
     - Then stop.

3. **Commit and push**
   - If there **are** changes:
     - Stage everything: `git add -A`
     - Commit with a clear, generic message, e.g.:
       - `git commit -m "chore: ios lint & style fixes"`
     - Push to the current branch: `git push`

4. **Output**
   - At the end, print a concise summary of what happened, for example:
     - Whether lint passed immediately or required fixes.
     - Whether a commit was created.
     - The branch that was pushed to.

You must:
- Run commands in the correct order.
- Automatically retry lint after each style fix.
- Only commit and push if there are actual changes.


## See Also
- [[chatgpt/chatgpt_2026-landing-page-workflow]]
- [[chatgpt/chatgpt_admin-workflow-design]]
- [[chatgpt/chatgpt_ai-deal-workflow-explanation]]
- [[chatgpt/chatgpt_ai-dev-workflow-optimization]]
- [[chatgpt/chatgpt_ai-landing-page-workflow]]
