# Friction protocol — convention

> Cross-cutting rule shared by skills the claw-test harness exercises (setup,
> brain-ops, query, ingest, smoke-test, migrations). Reference via
> `> **Convention:** see [skills/_friction-protocol.md](_friction-protocol.md).`

When you encounter friction running gbrain — anything confusing, missing, surprising, or wrong — log it via `gbrain friction log` so maintainers can see it without you writing a bug report. Friction reports drive the claw-test feedback loop (the harness collects, renders, and re-runs).

## When to log

Log friction when any of these happens:

- A command failed with a non-actionable error message
- A doc said one thing and the tool did another
- You couldn't find the next step
- A setup command needed a manual workaround
- A flag exists but isn't documented in `--help`
- A success condition was unclear (you couldn't tell if the command worked)

Log delight (positive signal) when:

- Something worked on the first try and the docs were exactly right
- An error message handed you the fix
- A flag you guessed at turned out to exist with the obvious name

## How to log

```
gbrain friction log \
  --severity {confused|error|blocker|nit} \
  --phase <which-phase-or-command> \
  --message "<one-line-what-happened>" \
  [--hint "<one-line-what-could-be-better>"]
```

For delight, add `--kind delight` and pick any severity.

The CLI auto-fills `ts`, `cwd`, `gbrain_version`, and resolves `run_id` from `$GBRAIN_FRICTION_RUN_ID` (set by the harness) or falls back to `standalone.jsonl`. So you can call this anywhere — inside a harness run, manually during normal use, or from a scripted test.

## Severity guide

| severity   | meaning |
|------------|---------|
| `blocker`  | Couldn't proceed at all. Hard stop. |
| `error`    | Command failed unexpectedly. |
| `confused` | Docs/tool mismatch, ambiguity, missing pointer. |
| `nit`      | Polish opportunity. Cosmetic or low-impact. |

Be specific: "doctor says `schema_version=0` and points at apply-migrations, but apply-migrations exits 0 with no output" beats "doctor was confusing."

## Inspecting reports

```
gbrain friction list                      # recent runs with counts
gbrain friction render --run-id <id>      # markdown report (default)
gbrain friction render --run-id <id> --json
gbrain friction summary --run-id <id>     # friction + delight side-by-side
```

`render` defaults to `--redact` for markdown (strips `$HOME`/`$CWD` to `<HOME>`/`<CWD>` placeholders) so reports paste safely into PRs and issues.
