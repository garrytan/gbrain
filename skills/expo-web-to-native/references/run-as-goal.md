# Run the migration as a goal loop

Disclosed reference for [`expo-web-to-native`](../SKILL.md) - the recommended way to drive the whole migration. The migration is a repeat-until-done loop (assess → nativize each screen → verify → check off), which is exactly the shape of a **goal loop**: a single objective re-injected every turn until the worklist is empty. This file carries a ready-shaped, migration-specific objective - and, crucially, the objective **re-reads this skill every iteration**, so the loop keeps following the playbook (and self-bootstraps the assess step if no worklist exists yet).

Use it in one of two modes depending on the agent you're running.

## Mode A — the agent can run a goal loop

Harnesses with a goal/loop command (Claude Code `/goal`, Codex CLI, or any harness of the same shape) can drive this themselves. Fill the template below and hand it to that command — the loop re-runs it until `migration-progress.md` has no unchecked nativize-now items.

## Mode B — the agent can't loop itself

Write the filled-in objective to `migration-goal.md` in the project, then give the user the one-line instruction to launch it (e.g. *"run your agent's goal loop with the objective in `migration-goal.md`"*). The objective is plain text and portable, so the user runs it in whatever harness they have.

## The objective (template)

Fill the two `<…>` slots, then run or hand off verbatim. It is written to survive re-injection — it restates its own worklist, direction, and stop condition every turn.

```
Goal: migrate <APP NAME> from web to a native Expo app by following the expo-web-to-native skill, one screen per iteration, until done.

Each iteration, FIRST re-read the playbook - plugins/expo/skills/expo-web-to-native/SKILL.md (and its references) - then:
1. If migration-progress.md doesn't exist yet, do the skill's step 1 (Assess) to
   create the worklist, then stop. Otherwise open it and take the top unchecked
   item under "nativize-now"; if none are left unresolved (every nativize-now is
   done or blocked), STOP and summarize what shipped + what's blocked and why.
2. Redesign that screen native per the skill's step 4 — reach for @expo/ui FIRST
   (real SwiftUI/Compose), then expo-router (NativeTabs, large titles);
   RN primitives only for custom layouts. NEVER a webview port.
   Use references/native-patterns.md (UX patterns) and references/false-friends.md
   (idioms). Match the web screen's content and behavior.
3. Verify per references/verify-on-device.md: compare the running web original
   (browser agent) against the native screen (simulator / argent) — content and
   behavior parity, NOT pixels (it should look more native). If it's off for reasons
   IN the code, fix it this iteration. If it's blocked by something OUTSIDE the code
   (missing backend/auth/data, or a secret you can't supply), don't loop — mark it
   blocked in step 4 and move on.
4. Check the item off in migration-progress.md, appending one line:
   "<screen> — done", or "<screen> — blocked: <reason> — needs <what would unlock>".
   Either way the item is resolved; never revisit a blocked one.

Rules: one screen per pass; the app builds green each iteration; @expo/ui before RN primitives; never touch "nativize-later" items.
Base API URL for native (no relative paths): <EXPO_PUBLIC_API_URL>
```

## Why a pre-shaped objective

The objective is filled in for this migration — worklist, redesign rules, and self-verification path already wired to the skill's references — so you can launch the loop without authoring one from scratch. Tailor the `<…>` slots and direction when a specific migration needs more than the template covers.
