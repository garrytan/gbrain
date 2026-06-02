---
title: "Improve cascade workflow"
type: guide
created: 2025-11-25
updated: 2025-11-25
source: chatgpt-export
conversation_id: 692543c2-5a90-832e-9e0d-f6daf88b7b59
message_count: 2
tags: [chatgpt, import, code]
---
# Improve cascade workflow

> Conversation ID: 692543c2-5a90-832e-9e0d-f6daf88b7b59
> Created: 2025-11-25T05:51:11Z
> Updated: 2025-11-25T05:52:26Z
> Messages: 2

---

## User

Improve this workflow for cascade in windsurf for the /alpha slash command:

./apps/ios/run_fastlane.sh alpha

if it fails, fix any build errors and re-run.

---

## Assistant

Here’s a more robust Cascade workflow you can use for `/alpha`. Save this as something like `.windsurf/workflows/alpha.md`:

```markdown
## /alpha

Run the iOS Alpha Fastlane lane, automatically debug build failures, and re-run until it passes or needs manual help.

1. Make sure you’re at the repo root in the terminal for this workspace.
   - If not, `cd` to the project root (the directory that contains `./apps/ios/run_fastlane.sh`).

2. Before running anything, do a quick sanity check:
   - Run `git status` and summarize any uncommitted changes for me.
   - If there are large or suspicious changes that might affect the iOS build, highlight them and ask whether to continue.

3. Run the Alpha lane:
   - In the terminal, execute:
     ```bash
     ./apps/ios/run_fastlane.sh alpha
     ```
   - Stream the output and watch for:
     - Non-zero exit status
     - Common iOS build issues (Swift/Obj-C compile errors, missing modules, Cocoapods issues, code signing/provisioning, Fastlane config errors, etc.).

4. If the command **succeeds** (exit code 0):
   - Parse the Fastlane output to find:
     - The generated IPA / archive path
     - Any dSYM/artifact locations
     - Any upload/distribution summary (TestFlight, internal track, etc.)
   - Summarize for me:
     - Build succeeded ✅
     - Where artifacts live
     - Any warnings that might be worth addressing later (but don’t block).

5. If the command **fails** (non-zero exit):
   - Capture at least the last ~200–300 lines of output and identify the **primary failure cause**:
     - Compiler errors → point to file + line.
     - Missing pods / modules → note required commands (e.g., `bundle exec pod install` or `pod repo update`).
     - Code signing / provisioning issues → describe what’s failing and what config file or Xcode setting is involved.
     - Fastlane configuration errors → point to the relevant `Fastfile`, `Appfile`, or script.
   - For code/config issues that **can** be fixed locally:
     1. Propose a concrete plan (files to edit, commands to run).
     2. Unless the change is obviously safe and small, **show me** the planned edits and ask for confirmation.
     3. Apply the edits using Cascade’s Write mode.
   - For issues that require secrets or Apple account changes (certs, profiles, keychain, etc.):
     - Explain clearly what’s wrong and what I need to do in Xcode/Apple Developer or environment variables.
     - Don’t guess credentials or modify unrelated signing settings.

6. After applying fixes, re-run the build:
   - Execute:
     ```bash
     ./apps/ios/run_fastlane.sh alpha
     ```
   - Repeat the “analyze → fix → re-run” loop up to **3 attempts total**.
   - On each attempt, focus on the **new** root cause rather than repeating the previous analysis.

7. If, after 3 total attempts, the build still fails:
   - Stop making changes.
   - Produce a concise report containing:
     - The final error message and stack trace snippet.
     - The list of files you changed (with a short description of each change).
     - What you recommend I try next (e.g., manual steps, environment setup, or questions you need answered).

8. At the end (success or failure), summarize:
   - Status: ✅ success or ❌ still failing.
   - Commands you ran.
   - Files you modified.
   - Any follow-up tasks or TODOs I should know about.
```

This keeps the core behavior you want (`./apps/ios/run_fastlane.sh alpha`, fix failures, re-run) but makes Cascade:
- Respectful of your repo state.
- Explicit about what it changes.
- Iterative (up to 3 attempts) with a clear final summary.


**Topic:** [[chatgpt-clusters/code_review]]


## See Also
- [[chatgpt/chatgpt_windsurf-cascade-workflow]]
- [[chatgpt/chatgpt_2026-landing-page-workflow]]
- [[chatgpt/chatgpt_admin-workflow-design]]
- [[chatgpt/chatgpt_ai-deal-workflow-explanation]]
- [[chatgpt/chatgpt_ai-dev-workflow-optimization]]
