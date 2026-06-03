# GBrain Off-Ramp Runbook

## Purpose

This is the small operator loop for a manual-light GBrain posture.
Use it when you want a current receipt, a quick read on `default`, and a safe
way to run routine upkeep without turning GBrain into an always-on system.

This runbook stays repo-local. No launchd edits. No `~/.gbrain` edits.

## Receipt

Run this first every time:

```bash
bun run offramp:receipt --json
```

Use the receipt to answer four things before you do anything else:

- what source this checkout resolves to
- whether `default` still has unembedded chunks
- whether unacknowledged sync failures are piling up
- whether autopilot is actually running or just installed
- whether the current posture looks like normal backlog or a runtime problem

Proceed only when the receipt matches what you expected.
Stop if the resolved source is surprising or the output looks like a DB/runtime failure.

## Inventory

Run this only when the receipt shows `defaultSource.chunksUnembedded > 0`:

```bash
bun run offramp:inventory
```

This command is only for the `default` backlog. It forces `GBRAIN_SOURCE=default`
and tells you what is sitting in that junk drawer by top-level slug and page type.
Do not use it to reason about non-default sources.

Proceed when you need to decide whether the `default` backlog is acceptable for now
or needs cleanup before maintenance.
Stop if you already know the backlog is outside `default` or the question is really
about another source.

## Maintenance dry-run

Run this before any real upkeep:

```bash
bun run offramp:maintain:dry-run
```

This is the go/no-go gate. It prints the exact maintenance command sequence without
running it.

Proceed when one of these is true:

- `defaultSource.chunksUnembedded` is `0`
- the remaining `default` backlog is intentionally accepted and you are choosing to pass `--allow-default-backlog`

Stop when the dry-run blocks, the receipt still points at an unexpected source, or
the output suggests runtime breakage instead of routine backlog.

## Real maintenance

Run this only after the dry-run says the loop is safe:

```bash
bun run offramp:maintain
```

It runs these three commands in this order:

1. `gbrain sync --all --parallel 4 --workers 4 --skip-failed`
2. `gbrain embed --stale`
3. `gbrain extract all`

If you need to proceed with an intentionally accepted `default` backlog, use the
same allowance you proved in dry-run first. Do not improvise beyond that.

## Stop Conditions

Stop and do not continue when any of these are true:

- the receipt resolves to a source you did not expect
- `defaultSource.chunksUnembedded > 0` and you have not explicitly accepted that backlog
- maintenance dry-run exits non-zero
- command output points to a DB/runtime problem instead of normal backlog

## Proof Gates

Do not call the brain handled until the relevant proof is in hand:

- pre-maintenance receipt captured with `bun run offramp:receipt --json`
- if `default` had backlog, inventory captured with `bun run offramp:inventory`
- dry-run returned the expected command sequence and did not block
- receipt shows `defaultSource.chunksUnembedded: 0` or an explicitly accepted exception
- receipt shows `unacknowledgedFailures: 0` or an explicitly accepted exception
- post-maintenance receipt shows the loop completed on the same checkout and source

If any one of those gates is missing, classify the state as not verified yet.

## Non-Goals

- launchd setup or teardown
- edits under `~/.gbrain`
- Dream, autopilot, or broader workflow redesign
- turning this into a productized control plane
