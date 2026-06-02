---
title: "Guard rails for coding"
type: guide
created: 2025-11-17
updated: 2025-11-17
source: chatgpt-export
conversation_id: 691b484b-aa48-832b-aa75-f94da31f216a
message_count: 2
tags: [chatgpt, import, code, long-form]
---
# Guard rails for coding

> Conversation ID: 691b484b-aa48-832b-aa75-f94da31f216a
> Created: 2025-11-17T16:10:17Z
> Updated: 2025-11-17T16:12:18Z
> Messages: 2

---

## User

Guard rails to keep Claude code and chat gpt codex from undoing work or reverting work. One thing that happens often is it does a bunch of work and then the build fails. Then I ask it to fix build errors and it says “oh we can’t find dashbaordnew.swift so we’ll revert it to use dashboardold.swift so the build succeeds, instead of saying “please add dashboardnew.swift to the Xcode project”. As a result the app gets reverted to the old dashboard despite all the work we just did to build the new one.

---

## Assistant

The core fix is: you have to *explicitly* forbid “revert to old code to make the build green” and tell the model what to do instead when it sees missing files or symbols.

Here’s how I’d set up guard rails for you, Mr. White.

---

## 1. Drop-in “safety header” for any coding chat

Paste something like this at the *start* of the session and remind the model of it if it drifts:

```text
GLOBAL RULES (do not violate):

1. Do NOT undo or revert previous work to “make the build succeed” unless I explicitly say so.
2. Treat build errors as problems to fix while PRESERVING the new design and new files.
3. If a referenced file/class doesn’t exist (e.g. DashboardNew.swift):
   - FIRST assume the file SHOULD exist.
   - Tell me exactly what needs to be done (e.g. “Create DashboardNew.swift with X code” or
     “Add DashboardNew.swift to the Xcode target”).
   - Do NOT silently switch back to older files/classes (e.g. DashboardOld.swift).
4. You are not allowed to reintroduce old screens or old flows as a fallback fix unless I confirm in words.
5. When fixing build errors:
   - Make the smallest possible change.
   - Do NOT rewrite whole files unless necessary.
   - Before deleting/changing large blocks, clearly say what you’re about to remove and why.
6. Always explain your changes and call out explicitly if ANY proposed change affects the new dashboard feature/functionality.
```

You can customize line 3/5/6 with real filenames or features:

```text
Protected feature: the NEW dashboard (DashboardNew.swift, DashboardViewModel.swift).
Never swap back to DashboardOld.swift or the old dashboard flow to fix errors.
```

---

## 2. Special rules for the “missing file” problem

Specifically for the “we can’t find DashboardNew.swift, so we’ll revert to DashboardOld.swift” issue, add this little block:

```text
If the compiler says a Swift file/class referenced in the code cannot be found:

- Assume the reference is correct and the project needs to be updated.
- Preferred actions (in order):
  1) Tell me to create the missing file and show me its full contents, OR
  2) Tell me to add the existing file to the correct target / group in Xcode, OR
  3) Adjust import / module / path issues.

You are NOT allowed to “solve” this by:
- Switching to old classes or old screens (e.g. DashboardOld.swift).
- Commenting out or removing the new feature.
If you believe reverting is the ONLY option, you MUST ask me first.
```

This explicitly teaches the model how to interpret “file not found” in Xcode.

---

## 3. How to phrase “fix the build” safely

Instead of:

> “Fix the build errors.”

Say things like:

```text
Fix these build errors WITHOUT reverting any new dashboard work.
Do not touch DashboardNew.swift or any code that references it, unless there is absolutely no way around it.
If the fix requires changing the dashboard behavior or using the old dashboard, stop and ask me first.
```

or:

```text
You may:
- Add missing files,
- Wire files into the Xcode target,
- Fix imports / types / signatures,
- Adjust references to match the new architecture.

You may NOT:
- Switch back to any old dashboard views/controllers,
- Delete or comment out new dashboard functionality.
```

This makes the constraint part of the instruction, not something the model has to infer.

---

## 4. Use diff-style edits, not “here’s a whole new file”

When you ask it to change code, force it into patch mode:

```text
When you change code, respond with:
- A short explanation of the intent.
- A unified diff (or clearly marked “BEFORE”/“AFTER” snippets) for only the edited sections.
Do not rewrite entire files unless I explicitly request a full rewrite.
```

Why this helps:

- Big full-file rewrites are where “revert to old pattern” sneaks in.
- Diffs make it obvious if it reintroduced `DashboardOld` or removed your new stuff.

---

## 5. Guard rails in your own workflow (Xcode + git)

These are boring but they save you:

1. **Commit after major feature steps**
   - After you get DashboardNew mostly working, `git commit -am "New dashboard wiring"`.
   - Then when the model “fixes” the build, you can quickly see if it nuked that work with `git diff`.

2. **Treat the model like a junior dev**
   - When it proposes a big change, literally answer:  
     “This removes the new dashboard. Propose an alternative that keeps DashboardNew.”
   - If you see it reaching for old files, say:  
     “The old dashboard is deprecated. You’re not allowed to use it. Keep working with DashboardNew.”

3. **Lock critical files verbally**
   - At key moments:  
     “For the next few steps, consider DashboardNew.swift and DashboardViewModel.swift locked. Only propose changes around them (wiring, project setup, call sites), not inside them, unless I say otherwise.”

---

## 6. Concrete example you can reuse

Here’s a compact template you can paste at the start of a session where you’re working on the new dashboard:

```text
Context: We are building a NEW dashboard (DashboardNew.swift and related files). The old dashboard (DashboardOld.swift and related) is DEPRECATED and must NOT be used going forward.

Hard rules:
- Never revert to DashboardOld or old dashboard flows to fix errors.
- If the project can’t find DashboardNew.swift or related files, assume they should exist and tell me to add/create them or add them to the Xcode target.
- Preserve the new dashboard behavior at all costs. If a fix would remove it or bypass it, stop and ask.
- When fixing build errors, make minimal changes and show diffs instead of full-file rewrites.

From now on, every time I say “fix the build” or “fix these errors”, you must obey these rules.
```

You can adapt that per feature (login, onboarding, etc).

---

If you want, next step I can help you craft a super-short personalized header specific to your project (`DashboardNew` plus whatever else you’ve refactored) that you just keep in a text snippet and paste into any new Claude / ChatGPT coding thread.
