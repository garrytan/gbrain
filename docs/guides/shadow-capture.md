# Shadow capture: record your brain's real engine calls on your own machine

Shadow capture records every call your brain makes to its storage engine, reads and writes, into private files on
the brain's own machine. It is the first half of [shadow replay](shadow-replay.md), which replays each night's
recording on private PGLite and Rust copies to find where the Rust engine answers differently. Nothing leaves the
machine. Capture alone replays nothing; run `gbrain engine shadow replay` for that.

**Say to your agent:** *"Turn on shadow capture for my brain."*

**Say to your agent:** *"Is shadow capture on, and how much has it recorded?"*

**Say to your agent:** *"Stop shadow capture and delete what it recorded."*

## What you see

```bash
gbrain engine shadow capture on --yes        # turns capture on and starts a recording
gbrain engine shadow capture status          # on/off, the current recording, recording processes, bytes recorded
gbrain engine shadow capture off             # every recording process stops at its next write; deletes nothing
gbrain engine shadow capture delete --yes    # deletes every recording and lists what it deleted
```

Capture is off by default. A brain that never turned it on loads none of the capture code. After `capture on`,
restart long-running gbrain processes (`gbrain serve`, an MCP server): only engines opened after capture is on
record. `GBRAIN_SHADOW_CAPTURE=off` turns capture off for any process started with it, whatever the setting says.
A call that starts while capture is off is never recorded, even if it ends after capture is on again. Turning capture
off and then on starts a fresh recording, because the calls made while it was off are in no recording; `on` while
capture is already on keeps the current one. A gbrain process that closes its brain stops checking for seals and
removes its `recorders/` file once everything it holds is written.

Answers never change and never wait on capture. A capture fault (a full disk, an unwritable folder) drops records,
counts what it dropped as a gap, and never reaches the brain process.

## What it keeps, and where

Everything lives under `<gbrain home>/shadow/<brain>/capture/`, in owner-only files (mode 0600, folders 0700):

| Path | What it holds |
|---|---|
| `epoch-<id>/<process>.jsonl` | each engine call: the member, its arguments, start and end time, and a SHA-256 of the result (never the result) |
| `recorders/<process>.json` | one file per recording process (its process id) |
| `epoch.json`, `state.json` | the current recording and the on/off setting |

A call's arguments over 1 MiB are recorded only as a gap. A recording stops growing at 4 GiB, or when less than
2 GiB or 5% of the disk is free; what it then drops is counted as a gap. Raw SQL, reserved connections and calls that
take a function are recorded as a gap with the member name only. With no replay yet, a recording only grows (within
those limits) until you delete it or a purge removes it.

## Purge

When you purge a page or fact, gbrain writes a line to its purge log before the purge commits. Any new purge-log
line, or a purge log that cannot be read, deletes every recording at once in the process that purged, whatever state
the recording is in, whether capture is on, off or turned off with `GBRAIN_SHADOW_CAPTURE=off` (as long as the
brain has a capture folder). Other processes check before every write. A record still in memory from before the
purge is dropped, never written into the next recording (each record belongs to the recording that was current when
its call started, not to a clock time). If a deletion stops part way (a crash, a file that cannot be removed), the
next check in any process finishes it, and `capture on` finishes it before it starts a recording; until then
`capture status` shows `purge_cleanup_pending: true`. Every purge path runs one cleanup function, and a test
checks the source so that a new path cannot skip it. No physical secure-erase is claimed.

## Delete and the replay lock

`capture delete` and `gbrain engine shadow stop --delete` share one delete path. It takes the replay lock first and
refuses with `shadow_replay_busy` while a replay holds it. A lock a crashed run left behind is never taken over
automatically; the error names the file to remove. `stop --delete` also takes the restore drill's lock first and refuses
with `drill_running` (exit 1, nothing stopped or deleted) while a drill holds it; see
[engine-shadow-drill](engine-shadow-drill.md).

## Sealing a recording (for the replay release)

The replay seals a recording before it reads it. Every recording process registers itself before it reads which
recording is current. Sealing marks the recording `sealing`: calls that started before then belong to it, later calls
to the next recording. Each live recording process waits for its calls of the sealed recording and any write still in
progress, writes them out under the same checks as any write (capture on, no new purge, disk budget) and
acknowledges. The seal waits for every live process. These are reported, so the replay will say its coverage is
incomplete instead of claiming it complete: a process that does not acknowledge in time, one that acknowledges with
capture off or over budget, and one that died without its exit flush (an exit with nothing left running or unwritten
removes its `recorders/` file; any other exit keeps it, so the seal counts that process).
A process that died after acknowledging marks the next recording `unverified` instead.

## Errors

| Code | Meaning | Fix |
|---|---|---|
| `shadow_capture_off` | the capture command was not understood | use `on --yes`, `off`, `status` or `delete --yes` |
| `shadow_replay_purged` | the purge log cannot be read, so no recording starts | make it a readable file owned by the brain's user |
| `shadow_replay_busy` | a replay holds the lock, or a crashed one left it | wait; for a stale lock remove the file the message names |
