# Exec Output Convention

Buffer command output to a file and read a bounded slice. An empty exec result
usually means truncation, not a broken shell or a crashed process.

Large command output gets truncated by the harness's tool-return budget. The
truncation can read as an empty or failed result, which invites a wrong root
cause ("the shell is broken," "the process crashed," "a restart killed exec").

## The Failure Signature

- `echo alive` works fine
- Any multi-line loop, table, or long pipeline returns nothing
- Failures look intermittent — the tool appears to "flap"
- Some harnesses append a truncation notice; others return nothing at all

**A dead shell does not selectively kill long commands.** If trivial commands
succeed and long ones return empty, it is a size ceiling, not a process failure.

## The Rule

Never dump large output to stdout. Buffer to a file, then read a bounded slice.

```bash
cmd > /tmp/out.txt 2>&1; tail -40 /tmp/out.txt
```

Applies to anything that could exceed roughly a screen of text:

- `for` loops over more than a handful of items
- Per-item or per-day counts
- `ps`, `du`, `find`, `git log` without limits
- Any script invocation that prints a table
- API responses (`curl` without `head -c`)
- Test and typecheck runs (redirect first — the exit code and full failure
  list survive; a pipe through `tail` loses both)

## Patterns

```bash
# Loops — buffer, then slice
for d in $(seq 1 30); do ...; done > /tmp/loop.txt 2>&1
tail -40 /tmp/loop.txt

# Counts — aggregate in the script, print only the summary
python3 -c "..." > /tmp/counts.txt 2>&1; tail -40 /tmp/counts.txt

# API — cap the bytes inline
curl -s "$URL" | head -c 600

# Big JSON — parse to a small summary, never cat the file
python3 -c "import json; d=json.load(open('big.json')); print(len(d['items']))"

# Long-running — background it, then poll the log
nohup cmd > /tmp/job.log 2>&1 &
tail -20 /tmp/job.log
```

## Diagnostic Ladder for an Empty Exec Result

Run in order. Stop at the first one that explains it.

1. **`echo alive`** — if this works, exec is fine and the problem is output size.
2. **Re-run with `| head -20`** — if output appears, it was truncation. Confirmed.
3. **Buffer to a file and check the file's size** — `wc -c /tmp/out.txt`. A
   large file with an empty tool result is definitive.
4. Only after 1–3 fail should you consider process, permission, or
   infrastructure causes.

## Why This Matters

Truncation masquerades as failure. An agent that misreads it burns time
re-running the same oversized command, invents a mechanism ("a restart broke
exec") with no evidence tying cause to symptom, and reports a task as blocked
when it was one `tail -40` away from working. Bounded reads beat re-runs: the
answer is often already sitting in the file.

## Anti-Patterns

- Diagnosing "the tool is broken" after a long command returns empty
- Blaming an unrelated recent event (a restart, a deploy) without evidence
  linking it to the symptom
- Retrying the same oversized command hoping for a different result
- Piping a test run through `tail` instead of redirecting to a file first
- Reporting a task as blocked without walking the diagnostic ladder
