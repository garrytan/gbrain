---
title: "Run Stopping Troubleshooting"
type: note
created: 2026-04-02
updated: 2026-04-02
source: chatgpt-export
conversation_id: 69cedc72-cda0-83e8-b48b-ca04ffe98083
message_count: 3
tags: [chatgpt, import, code]
---
# Run Stopping Troubleshooting

> Conversation ID: 69cedc72-cda0-83e8-b48b-ca04ffe98083
> Created: 2026-04-02T21:15:57Z
> Updated: 2026-04-02T21:23:32Z
> Messages: 3

---

## User

This run keeps stopping. How can I write a prompt that will get this run to not stop? 

---

## Assistant

I’m checking the attached run transcript for where the workflow is halting and what instruction is triggering it. Then I’ll turn that into a prompt pattern that keeps the agent moving.

---

## Assistant

Mr. White, this is only partly a prompt problem.

Your run is stopping because the workflow itself contains explicit stop points. The `browse` skill says that if setup is missing, it must ask for approval and then “STOP and wait.” fileciteturn1file0 The run also drifted into plan mode, where `design-review` stayed on discovery instead of making edits and looping live. fileciteturn2file1 The skill preambles also contain first-run question gates for telemetry, proactive behavior, routing rules, and upgrade handling. fileciteturn2file1

So the best prompt does two things:
1. pre-answers the common gates
2. forces execution mode instead of plan mode

Use this:

```text
Run this end-to-end in execution mode, not plan mode.

Your job:
- use /design-review for actual implementation, not /plan-design-review
- use /browse live after the dev server is up
- keep iterating until the task list is visually polished and verified live

Pre-approvals:
- you are authorized to perform any one-time local setup required for gstack browse/design-review
- you are authorized to run gstack setup, install missing local dependencies, and start the local dev server
- use the recommended default for any first-run gstack prompts
- do not stop to ask me for permission on safe local setup steps

Behavior:
- do not switch into plan mode
- do not stop after inspection
- make the code changes, run the app, inspect it live, fix issues, and repeat
- if a tool is unavailable, use the closest available fallback and continue
- if ripgrep is missing, use grep/find instead of stopping
- only interrupt me if you need irreversible external action, login, CAPTCHA, or a real manual browser handoff
- otherwise continue autonomously until you have code changes, live verification, and a concise summary of what changed
```

A stronger version is to split it into two passes:

```text
First, clear all one-time gstack setup gates using recommended defaults, build browse if needed, and verify browse is ready.

Then immediately run /design-review in execution mode, make the task-list redesign, use /browse to test it live, and keep looping until the UI is polished.
```

What this will fix:
- fewer permission stops
- less chance of getting trapped in plan mode
- less chance of stalling on missing `rg`

What it will not fully fix:
- any branch that is hard-coded to require manual user action can still stop, especially browser auth, CAPTCHA, or explicit AskUserQuestion gates baked into the skill. fileciteturn1file0turn2file1

The cleanest long-term fix is to complete the one-time gstack setup once, so future runs start past those gates.


**Topic:** [[chatgpt-clusters/coding_troubleshoot]]
