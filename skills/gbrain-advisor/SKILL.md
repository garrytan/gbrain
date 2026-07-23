---
name: gbrain-advisor
version: 1.0.0
description: |
  Proactive "make the most of gbrain" coaching. Runs `gbrain advisor` on a
  cadence and pings the user with the top high-leverage actions for their brain:
  version drift, pending migrations, stalled jobs, low embed coverage, setup
  smells, and uninstalled brain skills. Read-only; always asks before fixing.
triggers:
  - "what should I do to get more out of gbrain"
  - "is my brain set up right"
  - "gbrain advisor"
  - "advise me on my brain"
  - "weekly brain checkup"
tools:
  - advisor
mutating: false
---

# gbrain Advisor

> **Convention:** See `skills/conventions/brain-first.md`. This skill is the
> proactive voice of the brain — it tells the owner how to run it better.

## Contract

This skill guarantees:
- **Read-only.** `gbrain advisor` never mutates. It computes a ranked list of
  actions from existing brain state.
- **Print, never execute.** You SHOW the user the findings and ASK before running
  any fix. The user owns every decision.
- **Bounded nagging.** On a cadence, surface only what changed or what's
  critical; don't repeat an ignored low-severity item every run.

## When to run

- On demand when the user asks "how do I get more out of this brain?"
- On a **weekly** cadence via the cron recipe below (even idle brains get a
  "here's how to run this better" ping).

## How to run it

```bash
gbrain advisor --json
```

Exit code is the severity gate (E2): `0` clean, `1` warn, `2` critical. The JSON
payload is `{ version, generated_at, worst, findings: [...] }`. Each finding has:

- `severity` — `critical` | `warn` | `info`
- `title` — one-line why-it-matters
- `fix.command_argv` — the exact command to fix it (a structured argv)
- `fix.dispatch_id` — present when the fix is safe to run via `--apply`

## What to do with the findings

1. Read the findings, highest severity first.
2. Summarize the top 1-3 to the user in their own channel/voice. Lead with any
   `critical` item (e.g. pending migrations).
3. For each, show the `fix.command_argv` and **ask** whether to run it.
4. If they say yes and the finding has a `fix.dispatch_id`, you may run it
   locally with an explicit confirm:

   ```bash
   gbrain advisor --apply <dispatch_id>
   ```

   `--apply` is local-only, runs the fix as a structured argv (no shell), and
   confirms first. Findings without a `dispatch_id` are not auto-runnable — run
   their `fix.command_argv` yourself after the user agrees.
5. Never run a fix the user didn't approve.

## Cron recipe (weekly checkup)

Install a weekly job via the `cron-scheduler` skill. Keep the prompt THIN — the
job just reads this skill and runs the advisor:

- **Schedule:** weekly, one quiet-hours-respecting slot (e.g. Monday 09:00 local).
- **Job prompt:** `Read skills/gbrain-advisor/SKILL.md and run gbrain advisor --json. If anything is critical or new since last run, ping me with the top items and the exact fix commands. Ask before fixing.`
- **Idempotent:** the advisor is read-only, so a double-fire is harmless.

The advisor records a local run history, so on each fire you can tell the user
what is **new since last run** rather than re-listing everything.

## Output Format

When you surface advisor findings to the user, lead with severity and keep it
scannable:

```
🧠 gbrain checkup — 2 things worth your attention

CRITICAL  Schema migrations are pending.
          Fix: gbrain apply-migrations --yes   (want me to run it?)

WARN      gbrain 0.44 is available (you're on 0.43).
          Fix: gbrain upgrade
```

- One block per finding, highest severity first.
- Always show the exact `fix` command and ASK before running it.
- If nothing is pressing, say so in one line ("brain looks healthy") — don't
  manufacture work.

## Anti-Patterns

- **Running a fix without asking.** The advisor is read-only by contract. Never
  run `--apply` (or any `fix` command) without the user's explicit yes.
- **Dumping the raw JSON at the user.** Translate findings into their voice; lead
  with what matters.
- **Re-nagging ignored low-severity items every run.** Use the "new since last
  run" delta; respect the user's prior non-action.
- **Treating `info` like `critical`.** Only block/insist on `critical` findings
  (pending migrations). `info` is a gentle nudge.
- **Calling the MCP `advisor` op for workspace install state.** Over MCP the
  advisor returns brain-state signals only; uninstalled-skill findings are a
  local-CLI concern.
