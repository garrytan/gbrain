---
name: agent-inbox
version: 1.0.0
description: |
  Hand work between agent apps through the brain. Each agent heartbeats,
  checks its delegation inbox, asks the user before taking a task (unless
  auto_ok), claims it with a lease, picks up the linked thread for context,
  works, logs turns, and completes or releases. Also covers delegating,
  fanning out to several agents, finding a thread another app started, and
  saving your place.
triggers:
  - "check my agent inbox"
  - "delegate this to another agent"
  - "hand this off to"
  - "send this to a few agents"
  - "pick up the project from"
  - "save my place"
  - "which agent should take this"
tools:
  - heartbeat
  - inbox
  - claim_task
  - pickup
  - log_turn
  - complete_task
  - release_task
  - delegate
  - route
  - fan_out
  - pick_result
  - find_thread
  - checkpoint
mutating: true
brain_first: exempt
when_to_use: "Use when the user asks: \"check my agent inbox\", \"delegate this to another agent\", \"hand this off to\", \"send this to a few agents\", \"pick up the project from\"."
---

# Agent inbox: delegation, pickup and handoff

Several agent apps (Claude, ChatGPT, Grok Bot, Gemini, your OpenClaw) can
share one brain. This skill is the loop each of them runs so work started in
one app can be picked up in another, and work can be handed to whichever
agent fits best. Everything is a markdown page in the brain: threads in
`threads/`, delegated tasks in `delegations/`, agents in `agents/`, routing
rules in `routing.md`.

## Contract

- Your agent name is fixed for this app (for example `claude`). Pass it on every
  call as `agent`, `name` or `from_agent`. Never act under another agent's name.
- Ask the user before claiming a task unless the task says `auto_ok: true`.
  inbox gives you the question to ask in `ask_user`.
- Claim before you work. A claim is a 15-minute lease; claim again to renew it
  on long work. If the claim is refused, the task is not yours: move on.
- Never claim a task addressed to another agent. inbox never shows you one;
  claim_task refuses with `task_not_addressed`.
- Finish every claimed task: complete_task with the result, or release_task
  with the reason. A lease you abandon reopens the task for its addressee.
- Log a turn after every reply on a thread: one to three lines, plus decisions
  and the current open questions.

## The scheduled check

Run this every N minutes (the schedule the user set up) and at the start of
every chat:

1. `heartbeat(name: "<you>")`. It marks you live, reopens tasks whose lease ran
   out, and returns `inbox_open`. If it is 0, stop here.
2. `inbox(agent: "<you>")`. For each task in `open`:
   - `auto_ok: false`: tell the user the `ask_user` line ("Delegated from
     grok-bot: Build the deck. Want me to take it?") and wait for a yes.
   - `auto_ok: true`: go ahead without asking.
3. After a yes: `claim_task(task_id, agent: "<you>")`. The response has the full
   instructions, context slugs and the thread id.
4. `pickup(thread_id, agent: "<you>")` when the task names a thread. Read the
   summary, next step, decisions, open questions and the last turns before you
   start. Read the context pages with get_page.
5. Do the work. `log_turn` on the thread as you go.
6. `complete_task(task_id, agent, result, files)` with what you produced, or
   `release_task(task_id, agent, reason)` when you cannot finish.

## During normal chats

| The user says | You call |
|---|---|
| "Delegate this to X" | `delegate(from_agent, to_agent: X, title, instructions, context, thread_id)` |
| "Delegate this" (no one named) | `route(tags, task_type, exclude: [<you>])`, suggest the top target and its reason, then `delegate` once the user agrees |
| "Send this to a few of you" | `fan_out(from_agent, agents, title, instructions)`; when results are back, show them side by side and record the user's choice with `pick_result(task_id)` |
| "Pick up the project about Y from <app>" | `find_thread(query: Y, agent: <app>)`, confirm the match with the user, then `pickup(thread_id, agent: <you>)` |
| After every reply on a thread | `log_turn(agent, thread_id or title, summary, decisions, open_questions, entities)` |
| "Save my place" | `checkpoint(thread_id, agent, next_up, summary)` |

Start a thread with `log_turn` and a `title`; continue it with `thread_id`.
Pass the pages the turn touched as `entities` (slugs like
`properties/12-oak-st`, or names the brain can resolve) so the thread links to
them.

## When it fails

Follow the [agent operator protocol](../conventions/agent-operator-protocol.md) for any gbrain error `code`, exit code, `[AGENT]` block or notice block. Specific to this skill:

- `task_claimed`: another agent holds the lease. Do not retry; pick another task.
- `task_not_addressed`: the task belongs to another agent or model. Leave it.
- `task_not_yours`: you no longer hold the task (your lease ran out and someone
  else claimed it). Tell the user; do not complete it.
- `task_closed`: it is already done or failed. Nothing to do.
- `not_found` on a thread: search with `find_thread`, or start one with `log_turn`
  and a `title`.
- `write_pending: true` in a response: the write was accepted and will publish;
  repeat the read in a few seconds before acting on it.

## Anti-Patterns

- Claiming every task in the inbox up front. Claim one, finish it, then the next.
- Working a task without claiming it, or after a refused claim.
- Taking a task without asking when `auto_ok` is false.
- Logging whole transcripts as turns. A turn is a short summary; long material
  belongs in its own page, linked as an entity.
- Delegating without instructions an agent could act on cold. The receiving
  agent sees only the task page, its context pages and the thread.
- Polling more often than the user's schedule. Every check uses the user's plan
  limits even when the inbox is empty.

## Output Format

When you ask about a task, use the `ask_user` line as written, then stop:

```
Delegated from grok-bot: Build the deck. Want me to take it?
```

When you finish one, tell the user in one or two lines what you did and where
the result is, then name the thread so the next agent can pick it up:

```
Done: 10-slide deck at decks/12-oak-st. Logged on thread 12-oak-st-listing-deck (grok-bot -> claude).
```
